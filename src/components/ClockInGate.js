// src/components/ClockInGate.js
// ─────────────────────────────────────────────────────────────────────────────
// Full lockout until the employee clocks in for the day. While not clocked in,
// the app shows this screen instead of the main tabs. Once clocked in, the
// wrapped children (the tab navigator) render normally.
//
// UI-gate only — mirrors the web ClockInGate. The backend still enforces its
// own rules (geofence, etc.); this just prevents using the app before clock-in.
//
// Remote clock-in support added: employees outside the office geofence can
// request permission from admin directly from this screen.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Alert, AppState,
  Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import api from '../services/api';
import { getSocket } from '../services/socketService';
import { useSelector } from 'react-redux';
import { COLORS, RADIUS, FONT } from '../theme/tokens';

export default function ClockInGate({ children }) {
  const [checking,       setChecking]       = useState(true);
  const [clockedIn,      setClockedIn]      = useState(false);
  const [clocking,       setClocking]       = useState(false);

  // Remote clock-in state (mirrors AttendanceWidget)
  const [showRemoteModal,  setShowRemoteModal]  = useState(false);
  const [requestStatus,    setRequestStatus]    = useState('idle'); // idle|pending|approved|denied
  const [meetingReason,    setMeetingReason]    = useState('');
  const [meetingLocation,  setMeetingLocation]  = useState('');
  const [requestSending,   setRequestSending]   = useState(false);

  const userId = useSelector(state => state.auth?.user?._id || null);

  // ── Check attendance status ─────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    try {
      const res = await api.get('/attendance/my-today');
      const rec = res.data;
      // Clocked in = has a loginTime today and hasn't clocked out yet.
      const isIn = !!rec?.loginTime && !rec?.logoutTime;
      setClockedIn(isIn);
    } catch {
      // On a transient error, fail open so a clocked-in employee isn't trapped.
      setClockedIn(true);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Re-check when the app comes back to the foreground (covers clock-out/in
  // that happened elsewhere, or day rollover).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  // ── Poll remote-request status while not clocked in ──────────────────────
  useEffect(() => {
    if (clockedIn) return; // no need once clocked in
    let cancelled = false;

    const checkRemoteStatus = async () => {
      try {
        const res = await api.get('/attendance/meeting-permission-status');
        const { hasPermission, isPending, status } = res.data || {};
        if (cancelled) return;
        if (hasPermission || status === 'approved') {
          setRequestStatus('approved');
        } else if (isPending || status === 'pending') {
          setRequestStatus('pending');
        } else if (status === 'denied') {
          setRequestStatus('denied');
        } else {
          setRequestStatus('idle');
        }
      } catch { /* silent */ }
    };

    checkRemoteStatus();
    // Poll every 30s so badge updates even if socket event is missed
    const poll = setInterval(checkRemoteStatus, 30000);

    // Also re-check on app foreground
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') checkRemoteStatus();
    });

    return () => {
      cancelled = true;
      clearInterval(poll);
      sub.remove();
    };
  }, [clockedIn]);

  // ── Socket: listen for admin approval / denial ────────────────────────────
  useEffect(() => {
    if (clockedIn || !userId) return;
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
  }, [clockedIn, userId]);

  // ── Clock In ───────────────────────────────────────────────────────────────
  const handleClockIn = useCallback(async () => {
    setClocking(true);
    try {
      let locationPayload = {};
      try {
        const { requestLocationPermission } = require('../services/permissionsService');
        const granted = await requestLocationPermission();
        if (granted) {
          const Geolocation = require('@react-native-community/geolocation').default
            || require('@react-native-community/geolocation');
          try {
            Geolocation.setRNConfiguration({ skipPermissionRequests: true, locationProvider: 'auto' });
          } catch (_) { /* older lib */ }
          const pos = await new Promise((resolve, reject) => {
            Geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: true, timeout: 12000, maximumAge: 10000,
            });
          }).catch(() => null);
          if (pos?.coords) {
            locationPayload = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
          }
        }
      } catch { /* location optional */ }

      await api.post('/attendance/clock-in', locationPayload);
      await refresh();
    } catch (e) {
      const code = e?.response?.data?.code;
      const msg  = e?.response?.data?.message || 'Could not clock in. Please try again.';

      if (code === 'location_required') {
        Alert.alert(
          '📍 Location Required',
          'Your company requires location for clock-in. Please enable Location permission and try again.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => require('react-native').Linking.openSettings() },
          ],
        );
      } else if (code === 'outside_radius') {
        Alert.alert(
          '📍 Too Far from Office',
          msg + '\n\nYou can request remote clock-in from your admin.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Request Remote', onPress: () => setShowRemoteModal(true) },
          ],
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
  if (checking) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={COLORS.blue} size="large" />
        <Text style={s.checkingText}>Checking attendance…</Text>
      </View>
    );
  }

  if (clockedIn) return children;

  // ── Lockout screen ────────────────────────────────────────────────────────
  return (
    <View style={s.center}>
      <View style={s.iconWrap}>
        <Icon name="clock-outline" size={44} color={COLORS.blue} />
      </View>

      <Text style={s.title}>Clock in to get started</Text>
      <Text style={s.subtitle}>
        You need to clock in before you can access your leads, calls and meetings for today.
      </Text>

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
            <Text style={[s.statusBadgeText, { color: '#FCD34D' }]}>
              Awaiting admin approval…
            </Text>
          </View>
        ) : requestStatus === 'approved' ? (
          <TouchableOpacity
            style={[s.statusBadge, { borderColor: '#34D39960' }, clocking && { opacity: 0.6 }]}
            onPress={handleClockIn}
            disabled={clocking}
            activeOpacity={0.8}
          >
            <Icon name="check-circle-outline" size={14} color="#34D399" />
            <Text style={[s.statusBadgeText, { color: '#34D399' }]}>
              Remote approved — tap Clock In
            </Text>
          </TouchableOpacity>
        ) : requestStatus === 'denied' ? (
          <View style={[s.statusBadge, { borderColor: COLORS.red + '60' }]}>
            <Icon name="close-circle-outline" size={14} color={COLORS.redLight} />
            <Text style={[s.statusBadgeText, { color: COLORS.redLight }]}>
              Request denied — contact your admin
            </Text>
          </View>
        ) : (
          /* idle — show the request button */
          <TouchableOpacity
            style={s.remoteBtn}
            onPress={() => setShowRemoteModal(true)}
            activeOpacity={0.8}
          >
            <Icon name="map-marker-question-outline" size={15} color="#93C5FD" />
            <Text style={s.remoteBtnText}>Request Remote Clock-In</Text>
          </TouchableOpacity>
        )}
      </View>

      <TouchableOpacity onPress={refresh} style={{ marginTop: 8 }}>
        <Text style={s.refreshText}>Already clocked in? Refresh</Text>
      </TouchableOpacity>

      {/* ── Remote clock-in request modal ────────────────────────────────── */}
      <Modal
        visible={showRemoteModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowRemoteModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={s.modalOverlay}
        >
          <View style={s.modalSheet}>
            {/* Header */}
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
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0B1120',
    paddingHorizontal: 32,
  },
  checkingText: { marginTop: 12, color: COLORS.textMuted, fontSize: FONT.sm },
  iconWrap: {
    width: 84, height: 84, borderRadius: 42,
    backgroundColor: COLORS.blueBg || '#1E293B',
    alignItems: 'center', justifyContent: 'center', marginBottom: 22,
  },
  title: {
    color: '#F1F5F9', fontSize: 20, fontWeight: '800',
    marginBottom: 8, textAlign: 'center',
  },
  subtitle: {
    color: COLORS.textMuted, fontSize: FONT.sm,
    textAlign: 'center', lineHeight: 20, marginBottom: 28,
  },

  // ── Clock In button ────────────────────────────────────────────────────────
  clockBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: COLORS.green || '#10B981',
    borderRadius: RADIUS.md, paddingVertical: 14, paddingHorizontal: 40,
    alignSelf: 'stretch',
  },
  clockBtnText: { color: '#fff', fontWeight: '800', fontSize: FONT.md },

  // ── Remote clock-in section ────────────────────────────────────────────────
  remoteSection: {
    marginTop: 14,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  remoteBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#1E2236',
    borderRadius: RADIUS.md, paddingVertical: 11, paddingHorizontal: 18,
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

  refreshText: { color: COLORS.textMuted, fontSize: FONT.sm, marginTop: 16 },

  // ── Modal ──────────────────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1, justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  modalSheet: {
    backgroundColor: '#1A1D27',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 36,
    borderTopWidth: 1, borderColor: '#262A38',
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 16,
  },
  modalTitle: { fontSize: 16, fontWeight: '800', color: '#F0F2FA' },
  modalLabel: {
    fontSize: 11, color: '#94A3B8', fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginBottom: 8, marginTop: 12,
  },
  modalInput: {
    backgroundColor: '#0F172A', borderRadius: 10,
    padding: 12, color: '#F0F2FA',
    borderWidth: 1, borderColor: '#262A38',
    minHeight: 72, textAlignVertical: 'top', marginBottom: 4,
  },
  modalHint: {
    fontSize: 11, color: '#64748B',
    marginTop: 8, marginBottom: 16, lineHeight: 16,
  },
  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 13,
  },
  submitBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});