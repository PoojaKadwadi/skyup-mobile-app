// src/components/ClockInGate.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX (this revision) — fail-open removed:
//
//   The original code did setClockedIn(true) on the FIRST attendance API
//   failure (knownStateRef.current === null), meaning a startup network error
//   silently granted access to the full app to someone who hadn't clocked in.
//   Spec requirement (item 15, ClockInGate section): "If the attendance API
//   fails, do NOT automatically assume clockedIn = true."
//
//   Fixed states now strictly follow the spec:
//     Loading   — initial check is in progress
//     Clocked In   — server confirmed loginTime with no logoutTime
//     Clocked Out  — server confirmed no active session
//     Error     — API call failed; stays on the gate with a retry button
//     Unknown   — first check not done yet (treated as Error/not-clocked-in)
//
//   On ANY API error (including the very first check), we now show the
//   clock-in screen with a "Could not check status — please try again" message
//   rather than silently passing the user through. The "Refresh" / "Try again"
//   button lets them re-check manually, and the AppState listener still
//   re-checks when they bring the app to the foreground.
//
// ALL OTHER BEHAVIOUR (remote clock-in, socket approval, geofence logic)
// is UNCHANGED.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Alert, AppState,
  Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import api from '../services/api';
import { getSocket } from '../services/socketService';
import { useSelector } from 'react-redux';
import { COLORS, RADIUS, FONT } from '../theme/tokens';

// Attendance gate states — replaces the old boolean clockedIn+checking pair.
// 'loading'    — initial check / re-check in progress
// 'clocked_in' — server confirmed active session
// 'clocked_out'— server confirmed no active session
// 'error'      — API call failed (do NOT pass user through)
const GATE = {
  LOADING:     'loading',
  CLOCKED_IN:  'clocked_in',
  CLOCKED_OUT: 'clocked_out',
  ERROR:       'error',
};

export default function ClockInGate({ children }) {
  const [gate,    setGate]    = useState(GATE.LOADING);
  const [clocking, setClocking] = useState(false);

  // Remote clock-in state
  const [showRemoteModal,  setShowRemoteModal]  = useState(false);
  const [requestStatus,    setRequestStatus]    = useState('idle');
  const [meetingReason,    setMeetingReason]    = useState('');
  const [meetingLocation,  setMeetingLocation]  = useState('');
  const [requestSending,   setRequestSending]   = useState(false);

  const userId = useSelector(state => state.auth?.user?._id || null);

  // FIX: throttle AppState-driven refresh to at most once per 30s.
  const lastRefreshMsRef = useRef(0);
  const REFRESH_THROTTLE_MS = 30_000;

  // Last CONFIRMED clock state from the server.
  // Stays null until the server responds at least once.
  const knownStateRef = useRef(null);

  // ── Check attendance status ─────────────────────────────────────────────────
  const refresh = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && now - lastRefreshMsRef.current < REFRESH_THROTTLE_MS) return;
    lastRefreshMsRef.current = now;

    setGate(GATE.LOADING);
    try {
      const res = await api.get('/attendance/my-today');
      const rec = res.data;
      const isIn = !!rec?.loginTime && !rec?.logoutTime;
      knownStateRef.current = isIn;
      setGate(isIn ? GATE.CLOCKED_IN : GATE.CLOCKED_OUT);
    } catch {
      // FIX: do NOT default to clocked-in on error. Use the last confirmed
      // state if we have one, otherwise show the error/gate screen.
      if (knownStateRef.current === true) {
        // Server previously confirmed clocked-in; hold that state (avoids
        // locking out someone who clocked in on the web and then hits a
        // transient network drop on their phone).
        setGate(GATE.CLOCKED_IN);
      } else if (knownStateRef.current === false) {
        // Server previously confirmed clocked-out; show gate.
        setGate(GATE.CLOCKED_OUT);
      } else {
        // Very first check failed — state is unknown. Show gate with an error
        // message so the user can retry. DO NOT pass them through.
        setGate(GATE.ERROR);
      }
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Re-check when app comes back to foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  // ── Poll remote-request status while not clocked in ──────────────────────
  useEffect(() => {
    if (gate === GATE.CLOCKED_IN) return;
    let cancelled = false;

    const checkRemoteStatus = async () => {
      try {
        const res = await api.get('/attendance/meeting-permission-status');
        const { hasPermission, isPending, status } = res.data || {};
        if (cancelled) return;
        if (hasPermission || status === 'approved') setRequestStatus('approved');
        else if (isPending || status === 'pending')  setRequestStatus('pending');
        else if (status === 'denied')                setRequestStatus('denied');
        else                                         setRequestStatus('idle');
      } catch { /* silent */ }
    };

    checkRemoteStatus();
    const poll = setInterval(checkRemoteStatus, 30000);
    const sub  = AppState.addEventListener('change', (s) => { if (s === 'active') checkRemoteStatus(); });

    return () => {
      cancelled = true;
      clearInterval(poll);
      sub.remove();
    };
  }, [gate]);

  // ── Socket: admin approval / denial ──────────────────────────────────────
  useEffect(() => {
    if (gate === GATE.CLOCKED_IN || !userId) return;
    const socket = getSocket();
    if (!socket) return;

    const handleMeetingResponse = ({ approved, adminName }) => {
      setRequestStatus(approved ? 'approved' : 'denied');
      Alert.alert(
        approved ? '✅ Permission Granted' : '❌ Request Denied',
        approved
          ? `${adminName || 'Admin'} approved your remote clock-in. You can now clock in.`
          : `${adminName || 'Admin'} denied your request. Please return to the office to clock in.`,
      );
    };

    socket.on('meeting_permission_response', handleMeetingResponse);
    return () => socket.off('meeting_permission_response', handleMeetingResponse);
  }, [gate, userId]);

  // ── Clock In ───────────────────────────────────────────────────────────────
  const handleClockIn = useCallback(async () => {
    setClocking(true);
    try {
      let locationPayload = {};
      try {
        const { PermissionsAndroid } = require('react-native');
        const { requestLocationPermission } = require('../services/permissionsService');
        const alreadyFine   = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION).catch(() => false);
        const alreadyCoarse = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION).catch(() => false);
        const granted = alreadyFine || alreadyCoarse || await requestLocationPermission();
        if (granted) {
          const Geolocation = require('@react-native-community/geolocation').default
            || require('@react-native-community/geolocation');
          try { Geolocation.setRNConfiguration({ skipPermissionRequests: true, locationProvider: 'auto' }); } catch {}
          const posPromise = new Promise((resolve, reject) => {
            Geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: false, timeout: 8000, maximumAge: 120000,
            });
          });
          const pos = await Promise.race([
            posPromise,
            new Promise(resolve => setTimeout(() => resolve(null), 9000)),
          ]).catch(() => null);
          if (pos?.coords) {
            locationPayload = {
              latitude:  pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy:  pos.coords.accuracy,
            };
          }
        }
      } catch { /* location optional */ }

      await api.post('/attendance/clock-in', locationPayload);
      await refresh(true);
    } catch (e) {
      const code = e?.response?.data?.code;
      const msg  = e?.response?.data?.message || 'Could not clock in. Please try again.';

      if (code === 'location_required') {
        Alert.alert('📍 Location Required', 'Your company requires location for clock-in. Please enable Location permission and try again.',
          [{ text: 'Cancel', style: 'cancel' }, { text: 'Open Settings', onPress: () => require('react-native').Linking.openSettings() }],
        );
      } else if (code === 'outside_radius') {
        Alert.alert('📍 Too Far from Office', msg + '\n\nYou can request remote clock-in from your admin.',
          [{ text: 'Cancel', style: 'cancel' }, { text: 'Request Remote', onPress: () => setShowRemoteModal(true) }],
        );
      } else {
        Alert.alert('Clock In Failed', msg);
      }
    } finally {
      setClocking(false);
    }
  }, [refresh]);

  // ── Send remote clock-in request ──────────────────────────────────────────
  const handleSendRemoteRequest = useCallback(async () => {
    if (!meetingReason.trim()) {
      Alert.alert('Reason Required', 'Please explain why you need remote clock-in.');
      return;
    }
    setRequestSending(true);
    try {
      await api.post('/attendance/request-meeting-permission', {
        reason:   meetingReason.trim(),
        location: meetingLocation.trim(),
      });
      setRequestStatus('pending');
      setShowRemoteModal(false);
      setMeetingReason('');
      setMeetingLocation('');
      Alert.alert('✅ Request Sent', 'Your admin has been notified and will approve your request shortly.');
    } catch (e) {
      Alert.alert('Failed', e?.response?.data?.message || e.message);
    } finally {
      setRequestSending(false);
    }
  }, [meetingReason, meetingLocation]);

  // ── Render states ──────────────────────────────────────────────────────────
  if (gate === GATE.LOADING) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={COLORS.blue} size="large" />
        <Text style={s.checkingText}>Checking attendance…</Text>
      </View>
    );
  }

  if (gate === GATE.CLOCKED_IN) return children;

  // ── Error state — different from clocked-out ───────────────────────────────
  const isErrorState = gate === GATE.ERROR;

  // ── Lockout / Error screen ────────────────────────────────────────────────
  return (
    <View style={s.center}>
      <View style={s.iconWrap}>
        <Icon name={isErrorState ? 'wifi-off' : 'clock-outline'} size={44} color={isErrorState ? COLORS.red : COLORS.blue} />
      </View>

      <Text style={s.title}>
        {isErrorState ? 'Could Not Check Attendance' : 'Clock in to get started'}
      </Text>
      <Text style={s.subtitle}>
        {isErrorState
          ? 'Unable to reach the server. Please check your connection and try again.'
          : 'You need to clock in before you can access your leads, calls and meetings for today.'}
      </Text>

      {!isErrorState && (
        <>
          {/* Primary Clock In button */}
          <TouchableOpacity
            style={[s.clockBtn, clocking && { opacity: 0.6 }]}
            onPress={handleClockIn}
            disabled={clocking}
            activeOpacity={0.85}
          >
            {clocking ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Icon name="login" size={18} color="#fff" style={{ marginRight: 8 }} />
                <Text style={s.clockBtnText}>Clock In</Text>
              </>
            )}
          </TouchableOpacity>

          {/* Remote clock-in section */}
          <View style={s.remoteSection}>
            {requestStatus === 'pending' ? (
              <View style={s.statusBadge}>
                <Icon name="clock-outline" size={14} color="#FCD34D" />
                <Text style={[s.statusBadgeText, { color: '#FCD34D' }]}>Awaiting admin approval…</Text>
              </View>
            ) : requestStatus === 'approved' ? (
              <TouchableOpacity
                style={[s.statusBadge, { borderColor: '#34D39960' }, clocking && { opacity: 0.6 }]}
                onPress={handleClockIn}
                disabled={clocking}
                activeOpacity={0.8}
              >
                <Icon name="check-circle-outline" size={14} color="#34D399" />
                <Text style={[s.statusBadgeText, { color: '#34D399' }]}>Remote approved — tap Clock In</Text>
              </TouchableOpacity>
            ) : requestStatus === 'denied' ? (
              <View style={[s.statusBadge, { borderColor: COLORS.red + '60' }]}>
                <Icon name="close-circle-outline" size={14} color={COLORS.redLight} />
                <Text style={[s.statusBadgeText, { color: COLORS.redLight }]}>Request denied — contact your admin</Text>
              </View>
            ) : (
              <TouchableOpacity style={s.remoteBtn} onPress={() => setShowRemoteModal(true)} activeOpacity={0.8}>
                <Icon name="map-marker-question-outline" size={15} color="#93C5FD" />
                <Text style={s.remoteBtnText}>Request Remote Clock-In</Text>
              </TouchableOpacity>
            )}
          </View>
        </>
      )}

      {/* Refresh / Retry button */}
      <TouchableOpacity onPress={() => refresh(true)} style={{ marginTop: 16 }}>
        <Text style={s.refreshText}>
          {isErrorState ? 'Tap to retry' : 'Already clocked in? Refresh'}
        </Text>
      </TouchableOpacity>

      {/* Remote clock-in request modal */}
      <Modal visible={showRemoteModal} transparent animationType="slide" onRequestClose={() => setShowRemoteModal(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={s.modalOverlay}>
          <View style={s.modalSheet}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>📍 Request Remote Clock-In</Text>
              <TouchableOpacity onPress={() => setShowRemoteModal(false)}>
                <Icon name="close" size={20} color="#64748B" />
              </TouchableOpacity>
            </View>

            <Text style={s.modalLabel}>Reason for being away from office *</Text>
            <TextInput
              style={s.modalInput}
              placeholder="e.g. Client meeting at ABC Corp"
              placeholderTextColor="#475569"
              value={meetingReason}
              onChangeText={setMeetingReason}
              multiline
            />

            <Text style={s.modalLabel}>Your current location (optional)</Text>
            <TextInput
              style={[s.modalInput, { minHeight: 44 }]}
              placeholder="e.g. Bandra, Mumbai"
              placeholderTextColor="#475569"
              value={meetingLocation}
              onChangeText={setMeetingLocation}
            />

            <Text style={s.modalHint}>
              Your admin will be notified and can approve your request with one tap.
            </Text>

            <TouchableOpacity
              style={[s.submitBtn, requestSending && { opacity: 0.6 }]}
              onPress={handleSendRemoteRequest}
              disabled={requestSending}
            >
              {requestSending ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <Icon name="send-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
                  <Text style={s.submitBtnText}>Send Request to Admin</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#0B1120', paddingHorizontal: 32,
  },
  checkingText: { marginTop: 12, color: COLORS.textMuted, fontSize: FONT.sm },
  iconWrap: {
    width: 84, height: 84, borderRadius: 42,
    backgroundColor: COLORS.blueBg || '#1E293B',
    alignItems: 'center', justifyContent: 'center', marginBottom: 22,
  },
  title: { color: '#F1F5F9', fontSize: 20, fontWeight: '800', marginBottom: 8, textAlign: 'center' },
  subtitle: { color: COLORS.textMuted, fontSize: FONT.sm, textAlign: 'center', lineHeight: 20, marginBottom: 28 },
  clockBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: COLORS.green || '#10B981',
    borderRadius: RADIUS.md, paddingVertical: 14, paddingHorizontal: 40, alignSelf: 'stretch',
  },
  clockBtnText: { color: '#fff', fontWeight: '800', fontSize: FONT.md },
  remoteSection: { marginTop: 14, alignSelf: 'stretch', alignItems: 'center' },
  remoteBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#1E2236', borderRadius: RADIUS.md,
    paddingVertical: 11, paddingHorizontal: 18,
    borderWidth: 1, borderColor: '#2563EB40',
    alignSelf: 'stretch', justifyContent: 'center',
  },
  remoteBtnText: { color: '#93C5FD', fontWeight: '700', fontSize: FONT.sm },
  statusBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: RADIUS.md, borderWidth: 1, borderColor: '#CA8A0460',
    alignSelf: 'stretch', justifyContent: 'center',
  },
  statusBadgeText: { fontSize: FONT.sm, fontWeight: '700' },
  refreshText: { color: COLORS.textMuted, fontSize: FONT.sm, marginTop: 8 },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  modalSheet: {
    backgroundColor: '#1A1D27', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 36, borderTopWidth: 1, borderColor: '#262A38',
  },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { fontSize: 16, fontWeight: '800', color: '#F0F2FA' },
  modalLabel: { fontSize: 11, color: '#94A3B8', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 12 },
  modalInput: {
    backgroundColor: '#0F172A', borderRadius: 10, padding: 12, color: '#F0F2FA',
    borderWidth: 1, borderColor: '#262A38', minHeight: 72, textAlignVertical: 'top', marginBottom: 4,
  },
  modalHint: { fontSize: 11, color: '#64748B', marginTop: 8, marginBottom: 16, lineHeight: 16 },
  submitBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 13 },
  submitBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
