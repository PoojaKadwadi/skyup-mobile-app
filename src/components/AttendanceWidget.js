// src/components/AttendanceWidget.js
// ─────────────────────────────────────────────────────────────────────────────
// Responsibilities:
//   1. Display clocked-in time, status chip, break time, clock/break buttons.
//   2. Real-time sync via Socket.IO (att:<userId> room).
//   3. Tick worked-time counter every 1s (focused) / 10s (background).
//   4. Ping the server every 60s while active so it knows the app is alive.
//
// What this widget does NOT do:
//   Idle detection has been moved entirely to App.js (useGlobalIdleDetection).
//   That hook covers every screen — Dashboard, Leads, LeadDetail, CallLogs,
//   Profile — and also integrates with call-state detection. The widget simply
//   reflects whatever status the backend reports via attendance:updated.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, AppState, Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useIsFocused }  from '@react-navigation/native';
import { useSelector }   from 'react-redux';
import Icon              from 'react-native-vector-icons/MaterialCommunityIcons';
// PERF FIX: removed `import { io }` — AttendanceWidget no longer opens its own
// socket connection. It reuses the singleton managed by socketService.js via getSocket().
import { getSocket }     from '../services/socketService';
import api               from '../services/api';
import { getDeviceInfo } from '../services/deviceInfoService';
import { cancelClockInReminder } from '../services/notificationService';
import { syncRecordings }        from '../services/recordingService';
import { COLORS, RADIUS, FONT } from '../theme/tokens';
import { isOnCall, subscribeToCallState } from '../services/callStateService';
import moment from 'moment';

const STALE_MS = 30 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtMins(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}
function fmtTime(d) {
  if (!d) return '—';
  // toLocaleTimeString relies on Hermes ICU data which may be incomplete
  // and can throw on real devices — use moment instead.
  return moment(d).format('hh:mm A');
}

// ── Status display config ─────────────────────────────────────────────────────
const STATUS_STYLES = {
  active    : { dot: COLORS.green,     label: 'Active',     chipBg: COLORS.greenBg,    chipText: COLORS.greenLight  },
  on_break  : { dot: COLORS.amber,     label: 'On Break',   chipBg: COLORS.amberBg,    chipText: COLORS.amberLight  },
  on_call   : { dot: COLORS.blue,      label: 'On Call',    chipBg: COLORS.blueBg,     chipText: COLORS.blueLight   },
  idle      : { dot: COLORS.red,       label: 'Idle',       chipBg: COLORS.redBg,      chipText: COLORS.redLight    },
  logged_out: { dot: COLORS.textMuted, label: 'Logged Out', chipBg: COLORS.surfaceAlt, chipText: COLORS.textMuted   },
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function AttendanceWidget() {
  const [record,  setRecord]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  // onCall drives the visible "On Call" status chip only.
  const [onCall,  setOnCall]  = useState(isOnCall());

  // ── Meeting permission request state ────────────────────────────────────
  const [showMeetingModal, setShowMeetingModal] = useState(false);

  // ── Live location tracking state ──────────────────────────────────────────
  // Active when: clientMeetingPermission granted + company tracking enabled.
  // locationTrackingRef holds the setInterval handle so we can clear it.
  // trackingConfigRef holds { enabled, intervalMinutes } fetched after clock-in.
  const locationTrackingRef  = useRef(null);
  const trackingConfigRef    = useRef({ enabled: false, intervalMinutes: 15 });
  const [isTracking, setIsTracking] = useState(false);

  const [meetingReason,    setMeetingReason]    = useState('');
  const [meetingLocation,  setMeetingLocation]  = useState('');
  const [requestSending,   setRequestSending]   = useState(false);
  const [requestStatus,    setRequestStatus]    = useState('idle'); // idle|pending|approved|denied

  const isFocused = useIsFocused();
  const userId    = useSelector(state => state.auth?.user?._id || null);

  const tickRef        = useRef(null);
  const pingRef        = useRef(null);
  const lastFetchedRef = useRef(null);
  const lastElapsedRef = useRef(0);
  const socketRef      = useRef(null);

  // ── Initial fetch ─────────────────────────────────────────────────────────
  const fetchRecord = useCallback(async (force = false) => {
    if (!force && lastFetchedRef.current && Date.now() - lastFetchedRef.current < STALE_MS) return;
    try {
      const res = await api.get('/attendance/my-today');
      setRecord(res.data);
      lastFetchedRef.current = Date.now();
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchRecord(); }, [fetchRecord]);

  // ── Socket.IO cross-device sync ───────────────────────────────────────────
  // PERF FIX: Reuse the singleton socket from socketService.js instead of
  // opening a second TCP connection with io(). We join the att:<userId> room
  // on the shared connection so the server can push attendance:updated events.
  useEffect(() => {
    if (!userId) return;
    const socket = getSocket();
    // Listen for admin's response to meeting permission request
    const handleMeetingResponse = ({ approved, grantedAt, adminName }) => {
      setRequestStatus(approved ? 'approved' : 'denied');
      Alert.alert(
        approved ? '✅ Permission Granted' : '❌ Request Denied',
        approved
          ? `${adminName || 'Admin'} approved your remote clock-in. You can now clock in from your current location.`
          : `${adminName || 'Admin'} denied your request. Please return to the office to clock in.`,
      );
      if (approved) setRequestStatus('approved');
    };
    const sock = getSocket();
    if (sock) sock.on('meeting_permission_response', handleMeetingResponse);

    if (!socket) return;
    socketRef.current = socket;

    // Join attendance room on the existing shared connection
    const joinRoom = () => socket.emit('att_join', { userId });
    if (socket.connected) {
      joinRoom();
    } else {
      socket.once('connect', joinRoom);
    }

    const handleAttUpdate = (updatedRecord) => {
      setRecord(updatedRecord);
      lastFetchedRef.current = Date.now();
      // Update refs so tick() picks up new values without triggering re-registration
      recordRef.current = updatedRecord;
    };
    socket.on('attendance:updated', handleAttUpdate);

    return () => {
      socket.off('attendance:updated', handleAttUpdate);
      socket.off('connect', joinRoom);
      socketRef.current = null;
      // Do NOT disconnect — the socket is shared with App.js / socketService
    };
  }, [userId]);

  // ── Stable refs for tick — avoids re-registering interval on every record update ──
  const recordRef = useRef(null);
  useEffect(() => { recordRef.current = record; }, [record]);

  // ── Call-state chip sync ───────────────────────────────────────────────────
  // Updates the "On Call" status chip when phone state changes.
  // Idle detection itself lives in App.js — this is display only.
  useEffect(() => {
    setOnCall(isOnCall());
    const unsub = subscribeToCallState(({ state }) => {
      setOnCall(state !== 'idle');
    });
    return unsub;
  }, []);

  // ── Tick + ping ────────────────────────────────────────────────────────────
  // PERF FIX: Removed `record` from deps. Previously every attendance:updated
  // socket push triggered cleanup + re-registration of setInterval AND
  // AppState listener. Now the interval is registered once per focus change;
  // tick() reads current values from recordRef so it always has fresh data.
  useEffect(() => {
    const tick = () => {
      const rec = recordRef.current;
      if (!rec?.loginTime || rec?.logoutTime) {
        if (lastElapsedRef.current !== 0) {
          lastElapsedRef.current = 0;
          setElapsed(0);
        }
        return;
      }
      const breakMins =
        (rec.totalBreakMinutes || 0) +
        (rec.activeBreakIndex !== null && rec.activeBreakIndex !== undefined
          ? Math.round(
              (Date.now() - new Date(rec.breaks?.[rec.activeBreakIndex]?.startTime || Date.now())) / 60000
            )
          : 0);
      const secs = Math.max(
        0,
        Math.round((Date.now() - new Date(rec.loginTime)) / 1000) - breakMins * 60,
      );
      if (secs !== lastElapsedRef.current) {
        lastElapsedRef.current = secs;
        setElapsed(secs);
      }
    };

    const ping = async () => {
      try { await api.post('/attendance/ping'); } catch { /* silent */ }
    };

    const stopTimers = () => {
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; }
    };

    const startTimers = () => {
      stopTimers();
      tick();
      const tickInterval = isFocused ? 1000 : 10_000;
      tickRef.current = setInterval(tick, tickInterval);
      pingRef.current = setInterval(ping, 60_000);
    };

    if (AppState.currentState === 'active') {
      startTimers();
    }

    return () => { stopTimers(); };
  }, [isFocused]); // PERF FIX: record removed — reads via recordRef instead

  // ── AppState listener registered once (not inside tick useEffect) ──────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        const rec = recordRef.current;
        if (rec?.loginTime && !rec?.logoutTime) {
          const tickInterval = isFocused ? 1000 : 10_000;
          if (tickRef.current) clearInterval(tickRef.current);
          const tick = () => {
            const r = recordRef.current;
            if (!r?.loginTime || r?.logoutTime) return;
            const breakMins = (r.totalBreakMinutes || 0);
            const secs = Math.max(0, Math.round((Date.now() - new Date(r.loginTime)) / 1000) - breakMins * 60);
            if (secs !== lastElapsedRef.current) { lastElapsedRef.current = secs; setElapsed(secs); }
          };
          tickRef.current = setInterval(tick, tickInterval);
        }
      } else {
        if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
        if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; }
      }
    });
    return () => sub.remove();
  }, []); // PERF FIX: registered exactly once

  // ── Actions ───────────────────────────────────────────────────────────────
  const handleClockIn = useCallback(async () => {
    try {
      const deviceInfo = await getDeviceInfo();

      // ── Attempt to get device location for location-restricted companies ──
      // We always try to get location — the backend decides whether to enforce it.
      // If location permission is denied, we send the request without coordinates
      // and let the backend decide (it will return 400 if location is required).
      let locationPayload = {};
      try {
        const { check, request, PERMISSIONS, RESULTS } = require('react-native-permissions');
        const { Platform } = require('react-native');

        const locPerm = Platform.OS === 'android'
          ? PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION
          : PERMISSIONS.IOS.LOCATION_WHEN_IN_USE;

        let status = await check(locPerm);
        if (status === RESULTS.DENIED) {
          status = await request(locPerm);
        }

        if (status === RESULTS.GRANTED) {
          const position = await new Promise((resolve, reject) => {
            const { Geolocation } = require('react-native');
            // Fallback: try @react-native-community/geolocation
            const Geo = Geolocation || require('@react-native-community/geolocation');
            Geo.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: true,
              timeout:            10000,
              maximumAge:         5000,
            });
          });
          locationPayload = {
            latitude:  position.coords.latitude,
            longitude: position.coords.longitude,
          };
        }
      } catch (locErr) {
        // Non-fatal — send without location; backend will gate if needed
        console.warn('[AttendanceWidget] Could not get location:', locErr.message);
      }

      const r = await api.post('/attendance/clock-in', { ...deviceInfo, ...locationPayload });
      setRecord(r.data);
      // Auto-sync any pending recordings after clock-in (runs silently in background).
      // Scans all recording folders for files from today and uploads any not yet synced.
      setTimeout(() => {
        syncRecordings(null, 0).catch(e =>
          console.warn('[AttendanceWidget] post-clock-in recording sync:', e.message)
        );
      }, 2000);
    } catch (e) {
      const code    = e?.response?.data?.code;
      const message = e?.response?.data?.message || e.message;

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
          message + '\n\nYou can request remote clock-in permission from your admin.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Request Permission',
              onPress: () => setShowMeetingModal(true),
            },
          ],
        );
      } else {
        Alert.alert('Clock-in failed', message);
      }
    }
  }, []);

  // ── Live location tracking helpers ──────────────────────────────────────
  const stopLocationTracking = useCallback(() => {
    if (locationTrackingRef.current) {
      clearInterval(locationTrackingRef.current);
      locationTrackingRef.current = null;
      setIsTracking(false);
      console.log('[AttendanceWidget] Location tracking stopped');
    }
  }, []);

  const sendLocationPing = useCallback(async () => {
    try {
      const { check, PERMISSIONS, RESULTS } = require('react-native-permissions');
      const { Platform } = require('react-native');
      const locPerm = Platform.OS === 'android'
        ? PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION
        : PERMISSIONS.IOS.LOCATION_WHEN_IN_USE;
      const status = await check(locPerm);
      if (status !== RESULTS.GRANTED) {
        // Permission was revoked — stop tracking
        stopLocationTracking();
        return;
      }
      const Geo = require('@react-native-community/geolocation');
      Geo.getCurrentPosition(
        async (pos) => {
          try {
            await api.post('/attendance/location-ping', {
              latitude:  pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy:  pos.coords.accuracy,
            });
            console.log('[AttendanceWidget] Location ping sent', pos.coords.latitude, pos.coords.longitude);
          } catch (e) {
            console.warn('[AttendanceWidget] Location ping failed:', e.message);
          }
        },
        (err) => console.warn('[AttendanceWidget] Geolocation error:', err.message),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
      );
    } catch (e) {
      console.warn('[AttendanceWidget] sendLocationPing error:', e.message);
    }
  }, [stopLocationTracking]);

  const startLocationTracking = useCallback(async (intervalMinutes = 15) => {
    stopLocationTracking(); // clear any existing interval first
    const ms = Math.max(5, intervalMinutes) * 60 * 1000;

    // Send first ping immediately, then on interval
    sendLocationPing();
    locationTrackingRef.current = setInterval(sendLocationPing, ms);
    setIsTracking(true);
    console.log(`[AttendanceWidget] Location tracking started — ping every ${intervalMinutes} min`);
  }, [sendLocationPing, stopLocationTracking]);

  // Fetch tracking config + start/stop based on meeting permission
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await api.get('/attendance/meeting-permission-status');
        const { hasPermission, isPending, status } = res.data || {};

        // Reconcile the badge with the SERVER's truth. This is the key fix for
        // "approved in admin but still shows pending": the socket event can be
        // missed (app backgrounded / socket dropped during approval), so we
        // must derive the status from this poll rather than relying solely on
        // the live event.
        if (!cancelled) {
          if (hasPermission || status === 'approved') {
            setRequestStatus('approved');
          } else if (isPending || status === 'pending') {
            setRequestStatus('pending');
          } else if (status === 'denied') {
            setRequestStatus('denied');
          } else {
            setRequestStatus('idle');
          }
        }

        if (!hasPermission) { stopLocationTracking(); return; }

        const cfgRes = await api.get('/attendance/meeting-tracking-config');
        trackingConfigRef.current = cfgRes.data;
        if (!cancelled && cfgRes.data.enabled) {
          startLocationTracking(cfgRes.data.intervalMinutes);
        } else {
          stopLocationTracking();
        }
      } catch { /* silent */ }
    };
    check();

    // Re-check when the app returns to the foreground (covers the case where
    // the admin approved while the app was backgrounded and the socket missed it).
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') check();
    });
    // And poll periodically while pending so the badge clears promptly.
    const poll = setInterval(check, 30000);

    return () => {
      cancelled = true;
      sub.remove();
      clearInterval(poll);
      stopLocationTracking();
    };
  }, [startLocationTracking, stopLocationTracking]);

  // ── Request meeting permission ──────────────────────────────────────────
  const handleSendMeetingRequest = useCallback(async () => {
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
      setShowMeetingModal(false);
      setMeetingReason('');
      setMeetingLocation('');
      Alert.alert(
        '✅ Request Sent',
        'Your admin has been notified. You will be able to clock in once they approve.',
      );
    } catch (e) {
      Alert.alert('Failed', e?.response?.data?.message || e.message);
    } finally {
      setRequestSending(false);
    }
  }, [meetingReason, meetingLocation]);


  const handleClockOut = useCallback(async () => {
    Alert.alert('Clock Out', 'Are you sure you want to clock out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clock Out', style: 'destructive',
        onPress: async () => {
          try {
            const r = await api.post('/attendance/clock-out');
            setRecord(r.data);
          } catch (e) {
            Alert.alert('Clock-out failed', e?.response?.data?.message || e.message);
          }
        },
      },
    ]);
  }, []);

  const handleBreakStart = useCallback(async () => {
    try {
      const r = await api.post('/attendance/break/start', { reason: 'Manual Break' });
      setRecord(r.data);
    } catch (e) {
      Alert.alert('Error', e?.response?.data?.message || e.message);
    }
  }, []);

  const handleBreakEnd = useCallback(async () => {
    try {
      const r = await api.post('/attendance/break/end');
      setRecord(r.data);
    } catch (e) {
      Alert.alert('Error', e?.response?.data?.message || e.message);
    }
  }, []);

  // ── Derived display values ────────────────────────────────────────────────
  const { statusStyle, statusLabel, elapsedStr, breakStr, notClockedIn } = useMemo(() => {
    const notClockedIn = !record?.loginTime;
    let st = record?.status || (notClockedIn ? 'logged_out' : 'active');
    if (st === 'active' && onCall) st = 'on_call';
    const ss = STATUS_STYLES[st] || STATUS_STYLES.logged_out;
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    const elapsedStr = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'00')}`;
    const breakStr = record?.totalBreakMinutes ? fmtMins(record.totalBreakMinutes) : '—';
    return { statusStyle: ss, statusLabel: ss.label, elapsedStr, breakStr, notClockedIn };
  }, [record, elapsed, onCall]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={w.loadWrap}>
        <ActivityIndicator color={COLORS.blue} />
      </View>
    );
  }

  if (notClockedIn) {
    return (
      <View style={w.card}>
        <Text style={w.notClocked}>You haven't clocked in today.</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity style={w.clockInBtn} onPress={handleClockIn}>
            <Icon name="login" size={16} color="#fff" />
            <Text style={w.clockInTxt}>Clock In</Text>
          </TouchableOpacity>
          {requestStatus === 'pending' ? (
            <View style={w.pendingBadge}>
              <Icon name="clock-outline" size={13} color="#FCD34D" />
              <Text style={w.pendingBadgeTxt}>Awaiting approval…</Text>
            </View>
          ) : requestStatus === 'approved' ? (
            <View style={[w.pendingBadge, { borderColor: '#34D399' }]}>
              <Icon name="check-circle-outline" size={13} color="#34D399" />
              <Text style={[w.pendingBadgeTxt, { color: '#34D399' }]}>Remote approved!</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={w.requestBtn}
              onPress={() => setShowMeetingModal(true)}
            >
              <Icon name="map-marker-question-outline" size={15} color="#93C5FD" />
              <Text style={w.requestBtnTxt}>Request Remote</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Meeting permission request modal */}
        <Modal visible={showMeetingModal} transparent animationType="slide" onRequestClose={() => setShowMeetingModal(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={w.modalOverlay}>
            <View style={w.meetingModal}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <Text style={w.meetingModalTitle}>📍 Request Remote Clock-In</Text>
                <TouchableOpacity onPress={() => setShowMeetingModal(false)}>
                  <Icon name="close" size={20} color="#64748B" />
                </TouchableOpacity>
              </View>
              <Text style={w.meetingModalLabel}>Reason for being away from office *</Text>
              <TextInput
                style={w.meetingInput}
                placeholder="e.g. Client meeting at ABC Corp"
                placeholderTextColor="#475569"
                value={meetingReason}
                onChangeText={setMeetingReason}
                multiline
              />
              <Text style={w.meetingModalLabel}>Your current location (optional)</Text>
              <TextInput
                style={w.meetingInput}
                placeholder="e.g. Bandra, Mumbai"
                placeholderTextColor="#475569"
                value={meetingLocation}
                onChangeText={setMeetingLocation}
              />
              <Text style={w.meetingModalHint}>
                Your admin will be notified and can approve your request with one tap.
              </Text>
              <TouchableOpacity
                style={[w.meetingSubmitBtn, requestSending && { opacity: 0.6 }]}
                onPress={handleSendMeetingRequest}
                disabled={requestSending}
              >
                {requestSending
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <>
                    <Icon name="send-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
                    <Text style={w.meetingSubmitTxt}>Send Request to Admin</Text>
                  </>
                }
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </View>
    );
  }

  const isOnBreak = record?.status === 'on_break' || record?.status === 'idle';

  return (
    <View style={w.card}>
      {isTracking && (
        <View style={w.trackingBanner}>
          <View style={w.trackingDot} />
          <Text style={w.trackingTxt}>📍 Location sharing active</Text>
        </View>
      )}
      <View style={w.topRow}>
        <View>
          <Text style={w.elapsedLabel}>Time Worked</Text>
          <Text style={w.elapsed}>{elapsedStr}</Text>
        </View>
        <View style={[w.statusChip, { backgroundColor: statusStyle.chipBg }]}>
          <View style={[w.statusDot, { backgroundColor: statusStyle.dot }]} />
          <Text style={[w.statusTxt, { color: statusStyle.chipText }]}>{statusLabel}</Text>
        </View>
      </View>

      <View style={w.metaRow}>
        <View style={w.metaItem}>
          <Icon name="login" size={12} color={COLORS.textMuted} />
          <Text style={w.metaLabel}>In: {fmtTime(record?.loginTime)}</Text>
        </View>
        <View style={w.metaItem}>
          <Icon name="coffee-outline" size={12} color={COLORS.textMuted} />
          <Text style={w.metaLabel}>Break: {breakStr}</Text>
        </View>
      </View>

      <View style={w.btnRow}>
        {isOnBreak ? (
          <TouchableOpacity style={[w.btn, w.btnGreen]} onPress={handleBreakEnd}>
            <Icon name="play-circle-outline" size={15} color="#fff" />
            <Text style={w.btnTxt}>End Break</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[w.btn, w.btnAmber]} onPress={handleBreakStart}>
            <Icon name="pause-circle-outline" size={15} color="#fff" />
            <Text style={w.btnTxt}>Take Break</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={[w.btn, w.btnRed]} onPress={handleClockOut}>
          <Icon name="logout" size={15} color="#fff" />
          <Text style={w.btnTxt}>Clock Out</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const w = StyleSheet.create({
  loadWrap:     { padding: 24, alignItems: 'center' },
  card:         { backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, padding: 16, borderWidth: 1, borderColor: COLORS.border },
  notClocked:   { fontSize: FONT.sm, color: COLORS.textMuted, marginBottom: 12 },
  clockInBtn:   { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.blue, borderRadius: RADIUS.md, paddingVertical: 10, paddingHorizontal: 16, alignSelf: 'flex-start' },
  clockInTxt:   { color: '#fff', fontWeight: '700', fontSize: FONT.sm },

  // Request remote button
  requestBtn:     { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#1E2236', borderRadius: RADIUS.md, paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1, borderColor: '#2563EB40' },
  requestBtnTxt:  { color: '#93C5FD', fontWeight: '700', fontSize: FONT.sm },
  pendingBadge:   { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 8, borderRadius: RADIUS.md, borderWidth: 1, borderColor: '#CA8A04' },
  pendingBadgeTxt:{ color: '#FCD34D', fontSize: FONT.xs, fontWeight: '700' },

  // Meeting request modal
  modalOverlay:      { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  meetingModal:      { backgroundColor: '#1A1D27', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 36, borderTopWidth: 1, borderColor: '#262A38' },
  meetingModalTitle: { fontSize: 16, fontWeight: '800', color: '#F0F2FA' },
  meetingModalLabel: { fontSize: 11, color: '#94A3B8', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 12 },
  meetingInput:      { backgroundColor: '#0F172A', borderRadius: 10, padding: 12, color: '#F0F2FA', borderWidth: 1, borderColor: '#262A38', minHeight: 72, textAlignVertical: 'top', marginBottom: 4 },
  meetingModalHint:  { fontSize: 11, color: '#64748B', marginTop: 8, marginBottom: 16, lineHeight: 16 },
  meetingSubmitBtn:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 13 },
  meetingSubmitTxt:  { color: '#fff', fontSize: 14, fontWeight: '700' },
  topRow:       { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 },
  elapsedLabel: { fontSize: FONT.xs, color: COLORS.textMuted, marginBottom: 2 },
  elapsed:      { fontSize: 26, fontWeight: '800', color: COLORS.textPrimary, fontVariant: ['tabular-nums'] },
  statusChip:   { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: RADIUS.full },
  statusDot:    { width: 7, height: 7, borderRadius: 4 },
  statusTxt:    { fontSize: FONT.xs, fontWeight: '700' },
  metaRow:      { flexDirection: 'row', gap: 16, marginBottom: 12 },
  metaItem:     { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaLabel:    { fontSize: FONT.xs, color: COLORS.textMuted },
  btnRow:       { flexDirection: 'row', gap: 8 },
  btn:          { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: RADIUS.md, paddingVertical: 9 },
  btnTxt:       { color: '#fff', fontSize: FONT.sm, fontWeight: '700' },
  btnGreen:     { backgroundColor: COLORS.green },
  trackingBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, marginBottom: 10, borderRadius: 8, backgroundColor: '#1C2A1A', borderWidth: 1, borderColor: '#34D39940' },
  trackingDot:    { width: 7, height: 7, borderRadius: 4, backgroundColor: '#34D399' },
  trackingTxt:    { fontSize: 11, color: '#34D399', fontWeight: '700' },
  btnAmber:     { backgroundColor: COLORS.amber },
  btnRed:       { backgroundColor: COLORS.red },
});