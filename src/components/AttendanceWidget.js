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
  ActivityIndicator, Alert, AppState,
} from 'react-native';
import { useIsFocused }  from '@react-navigation/native';
import { useSelector }   from 'react-redux';
import Icon              from 'react-native-vector-icons/MaterialCommunityIcons';
// PERF FIX: removed `import { io }` — AttendanceWidget no longer opens its own
// socket connection. It reuses the singleton managed by socketService.js via getSocket().
import { getSocket }     from '../services/socketService';
import api               from '../services/api';
import { getDeviceInfo } from '../services/deviceInfoService';
import { COLORS, RADIUS, FONT } from '../theme/tokens';
import { isOnCall, subscribeToCallState } from '../services/callStateService';

const STALE_MS = 30 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtMins(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}
function fmtTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
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
      const r = await api.post('/attendance/clock-in', { ...deviceInfo });
      setRecord(r.data);
    } catch (e) {
      Alert.alert('Clock-in failed', e?.response?.data?.message || e.message);
    }
  }, []);

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
        <TouchableOpacity style={w.clockInBtn} onPress={handleClockIn}>
          <Icon name="login" size={16} color="#fff" />
          <Text style={w.clockInTxt}>Clock In</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isOnBreak = record?.status === 'on_break' || record?.status === 'idle';

  return (
    <View style={w.card}>
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
  btnAmber:     { backgroundColor: COLORS.amber },
  btnRed:       { backgroundColor: COLORS.red },
});