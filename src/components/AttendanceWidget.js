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
  const [clockingIn, setClockingIn] = useState(false);
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

  // Office geofence (fetched after clock-in). When the employee is clocked in
  // and moves OUTSIDE this radius, field-work location tracking auto-starts —
  // no button, no admin permission needed. Stops when back inside / clocked out.
  const geofenceRef        = useRef({ enabled: false, latitude: null, longitude: null, radiusMeters: 100, intervalMinutes: 15 });
  const geofenceWatchRef   = useRef(null);
  const [onFieldWork, setOnFieldWork] = useState(false);

  const [meetingReason,    setMeetingReason]    = useState('');
  const [meetingLocation,  setMeetingLocation]  = useState('');
  const [requestSending,   setRequestSending]   = useState(false);
  const [requestStatus,    setRequestStatus]    = useState('idle'); // idle|pending|approved|denied

  // ── Ideal time + remark ───────────────────────────────────────────────────
  // Lets the employee record their planned/ideal working time for the day and
  // a reason/remark explaining it (e.g. "Client visit, will start at 11"). The
  // value is shown on the attendance card and persisted to the backend.
  const [idealTime,       setIdealTime]       = useState('');   // free text e.g. "10:00 AM - 6:00 PM"
  const [idealRemark,     setIdealRemark]     = useState('');   // reason for the ideal time
  const [showIdealModal,  setShowIdealModal]  = useState(false);
  const [idealDraftTime,  setIdealDraftTime]  = useState('');
  const [idealDraftRemark,setIdealDraftRemark]= useState('');
  const [idealSaving,     setIdealSaving]     = useState(false);

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

    // FIX: one handler, one registration, properly cleaned up.
    // The old code called getSocket() TWICE — once as 'socket' and once as 'sock' —
    // and registered meeting_permission_response on the second reference without
    // ever removing it in the cleanup. Every userId change stacked another listener,
    // causing the alert to fire multiple times per response.
    const handleMeetingResponse = ({ approved, adminName }) => {
      setRequestStatus(approved ? 'approved' : 'denied');
      Alert.alert(
        approved ? '✅ Permission Granted' : '❌ Request Denied',
        approved
          ? `${adminName || 'Admin'} approved your remote clock-in. You can now clock in from your current location.`
          : `${adminName || 'Admin'} denied your request. Please return to the office to clock in.`,
      );
    };
    socket.on('meeting_permission_response', handleMeetingResponse);

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
      // FIX: clean up ALL listeners including meeting_permission_response
      socket.off('meeting_permission_response', handleMeetingResponse);
      socket.off('attendance:updated', handleAttUpdate);
      socket.off('connect', joinRoom);
      socketRef.current = null;
      // Do NOT disconnect — the socket is shared with App.js / socketService
    };
  }, [userId]);

  // ── Stable refs for tick — avoids re-registering interval on every record update ──
  const recordRef = useRef(null);
  useEffect(() => { recordRef.current = record; }, [record]);

  // ── Hydrate ideal time / remark from the attendance record ────────────────
  useEffect(() => {
    if (record) {
      setIdealTime(record.idealTime || '');
      setIdealRemark(record.idealRemark || record.idealTimeRemark || '');
    }
  }, [record?.idealTime, record?.idealRemark, record?.idealTimeRemark]);

  // ── Save ideal time + remark ──────────────────────────────────────────────
  const handleSaveIdeal = useCallback(async () => {
    setIdealSaving(true);
    try {
      // Backend endpoint: persists the user's planned working time + reason for
      // today's attendance record. Returns the updated record.
      const r = await api.post('/attendance/ideal-time', {
        idealTime:   idealDraftTime.trim(),
        idealRemark: idealDraftRemark.trim(),
      });
      if (r?.data) setRecord(r.data);
      setIdealTime(idealDraftTime.trim());
      setIdealRemark(idealDraftRemark.trim());
      setShowIdealModal(false);
    } catch (e) {
      Alert.alert('Could not save', e?.response?.data?.message || e.message);
    } finally {
      setIdealSaving(false);
    }
  }, [idealDraftTime, idealDraftRemark]);

  const openIdealModal = useCallback(() => {
    setIdealDraftTime(idealTime);
    setIdealDraftRemark(idealRemark);
    setShowIdealModal(true);
  }, [idealTime, idealRemark]);

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
  // Guards against double-taps / overlapping clock-in attempts. Without this,
  // tapping the button repeatedly (which users do when GPS is slow) queues
  // several clock-in calls and makes the app feel frozen ("not responding").
  const clockingInRef = useRef(false);

  // Get a device location WITHOUT hanging the UI.
  // The old code did a single high-accuracy fix (timeout 10s, maximumAge 5s):
  // indoors that often runs the full 10s, frequently fails, and rejects good
  // recent fixes — so users retried and the app appeared stuck. This tries a
  // quick cached/coarse fix first, then a high-accuracy fix, and ALWAYS resolves
  // (never rejects) so clock-in proceeds even if GPS is slow — the backend
  // decides whether the location is good enough.
  const getLocationSafe = useCallback(() => {
    return new Promise((resolve) => {
      let settled = false;
      const done = (payload) => { if (!settled) { settled = true; resolve(payload); } };

      // Hard ceiling: never let location hold up clock-in more than 12s total.
      const hardStop = setTimeout(() => done({}), 12000);

      let Geo;
      try {
        const RN = require('react-native');
        Geo = RN.Geolocation || require('@react-native-community/geolocation');
      } catch (e) {
        clearTimeout(hardStop);
        return done({});
      }
      if (!Geo || typeof Geo.getCurrentPosition !== 'function') {
        clearTimeout(hardStop);
        return done({});
      }

      const toPayload = (position) => ({
        latitude:  position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy:  position.coords.accuracy,
      });

      // Phase 2: high-accuracy fix (better for the 100m office radius).
      const tryHighAccuracy = () => {
        Geo.getCurrentPosition(
          (pos)  => { clearTimeout(hardStop); done(toPayload(pos)); },
          ()     => { clearTimeout(hardStop); done({}); }, // give up gracefully
          // FIX: timeout 9s → 5s, maximumAge 0 → 30000.
          // maximumAge:0 forced a fresh satellite fix every clock-in (slow).
          // A 30s cached fix is perfectly fine for a 100m office geofence.
          { enableHighAccuracy: true, timeout: 5000, maximumAge: 30000 },
        );
      };

      // Phase 1: fast coarse/cached fix (accepts a recent fix up to 60s old).
      // If it returns a precise-enough fix we use it immediately; otherwise we
      // escalate to high accuracy.
      Geo.getCurrentPosition(
        (pos) => {
          const acc = pos?.coords?.accuracy ?? 9999;
          if (acc <= 50) { clearTimeout(hardStop); done(toPayload(pos)); }
          else tryHighAccuracy(); // coarse fix — try to refine
        },
        ()    => tryHighAccuracy(), // no cached fix — go straight to high accuracy
        { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 },
      );
    });
  }, []);

  const handleClockIn = useCallback(async () => {
    // Block overlapping attempts.
    if (clockingInRef.current) return;
    clockingInRef.current = true;
    setClockingIn(true);
    try {
      const deviceInfo = await getDeviceInfo();

      // ── Attempt to get device location for location-restricted companies ──
      // We always try to get location — the backend decides whether to enforce it.
      // If permission is denied, we send without coordinates and let the backend
      // gate (it returns 400 if location is required).
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
          locationPayload = await getLocationSafe();
        }
      } catch (locErr) {
        // Non-fatal — send without location; backend will gate if needed
        console.warn('[AttendanceWidget] Could not get location:', locErr.message);
      }

      const r = await api.post('/attendance/clock-in', { ...deviceInfo, ...locationPayload });
      setRecord(r.data);
      // Auto-sync any pending recordings after clock-in (runs silently in background).
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
    } finally {
      clockingInRef.current = false;
      setClockingIn(false);
    }
  }, [getLocationSafe]);

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

  // Haversine distance in metres (mirror of the backend geofence check).
  const distanceMetres = useCallback((lat1, lon1, lat2, lon2) => {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }, []);

  // ── Field-work auto-tracking: detect leaving the office geofence ─────────────
  // While clocked in (and the company has a geofence), poll GPS. When the
  // employee moves OUTSIDE the office radius, auto-start location breadcrumbs
  // (the same lat/lng the admin/super-admin attendance page shows). When back
  // inside, stop. Fully automatic — no button, no permission request.
  // NOTE: reliable background capture needs "Allow all the time" location; with
  // only "while using app", breadcrumbs pause when the app is backgrounded.
  const isClockedIn = !!(record && record.loginTime && !record.logoutTime);
  useEffect(() => {
    let cancelled = false;

    const clearWatch = () => {
      if (geofenceWatchRef.current) { clearInterval(geofenceWatchRef.current); geofenceWatchRef.current = null; }
    };

    if (!isClockedIn) {
      clearWatch();
      // Only stop tracking if it was started by field-work (not meeting-permission).
      if (onFieldWork) { stopLocationTracking(); setOnFieldWork(false); }
      return;
    }

    const startWatch = async () => {
      // Fetch the office geofence once per clock-in.
      try {
        const res = await api.get('/attendance/geofence-config');
        geofenceRef.current = res.data || geofenceRef.current;
      } catch { /* if it fails, no geofence → no auto-tracking */ }
      const gf = geofenceRef.current;
      if (!gf.enabled || gf.latitude == null || gf.longitude == null) return; // no geofence configured

      const checkPosition = () => {
        const Geo = require('@react-native-community/geolocation');
        Geo.getCurrentPosition(
          (pos) => {
            if (cancelled) return;
            const dist = distanceMetres(pos.coords.latitude, pos.coords.longitude, gf.latitude, gf.longitude);
            const outside = dist > (gf.radiusMeters || 100);
            if (outside && !onFieldWork) {
              // Left the premises → begin field-work breadcrumbs.
              setOnFieldWork(true);
              startLocationTracking(gf.intervalMinutes || 15);
              console.log('[AttendanceWidget] Left office geofence → field-work tracking ON');
            } else if (!outside && onFieldWork) {
              // Returned to the office → stop breadcrumbs.
              setOnFieldWork(false);
              stopLocationTracking();
              console.log('[AttendanceWidget] Back inside office geofence → field-work tracking OFF');
            }
          },
          (err) => console.warn('[AttendanceWidget] geofence check error:', err.message),
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
        );
      };

      checkPosition(); // immediate
      // Re-check position every 2 minutes (lighter than the breadcrumb interval).
      geofenceWatchRef.current = setInterval(checkPosition, 2 * 60 * 1000);
    };

    startWatch();
    return () => { cancelled = true; clearWatch(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClockedIn, onFieldWork, startLocationTracking, stopLocationTracking, distanceMetres]);

  // Bumped whenever a fresh meeting-permission request is sent, so the
  // polling effect below can restart even if it had already settled+stopped
  // from a previous request (e.g. a prior request was denied, polling
  // stopped, then the employee sends a brand new request).
  const [pollEpoch, setPollEpoch] = useState(0);

  // Fetch tracking config + start/stop based on meeting permission.
  //
  // PERF FIX: this previously polled every 30s for the ENTIRE app session,
  // for every employee, regardless of whether they were clocked in or had
  // ever requested meeting permission — each tick costing a `protect` +
  // `requireFeature("attendance")` round-trip (and a second call to
  // meeting-tracking-config whenever hasPermission was true). Now:
  //   1. The poll only runs while the employee is clocked in (isClockedIn) —
  //      there's nothing to reconcile while logged out.
  //   2. Once status settles to 'pending' (still needs polling to catch the
  //      admin's decision) it keeps going, but once it settles to 'approved'
  //      or 'denied' with no new request in flight, we stop the interval —
  //      a fresh request later re-arms it via pollEpoch.
  useEffect(() => {
    if (!isClockedIn) {
      // Logged out — nothing to reconcile. Don't poll.
      return;
    }

    let cancelled = false;
    let poll = null;

    const check = async () => {
      try {
        const res = await api.get('/attendance/meeting-permission-status');
        const { hasPermission, isPending, status } = res.data || {};

        // Reconcile the badge with the SERVER's truth. This is the key fix for
        // "approved in admin but still shows pending": the socket event can be
        // missed (app backgrounded / socket dropped during approval), so we
        // must derive the status from this poll rather than relying solely on
        // the live event.
        let settled = 'idle';
        if (!cancelled) {
          if (hasPermission || status === 'approved') {
            settled = 'approved';
          } else if (isPending || status === 'pending') {
            settled = 'pending';
          } else if (status === 'denied') {
            settled = 'denied';
          }
          setRequestStatus(settled);
        }

        if (!hasPermission) {
          // No remote-meeting permission. Only stop tracking if it ISN'T being
          // driven by field-work geofence-exit detection (which manages its own
          // start/stop). Otherwise we'd kill field-work breadcrumbs.
          if (!onFieldWork) stopLocationTracking();
        } else {
          const cfgRes = await api.get('/attendance/meeting-tracking-config');
          trackingConfigRef.current = cfgRes.data;
          if (!cancelled && cfgRes.data.enabled) {
            startLocationTracking(cfgRes.data.intervalMinutes);
          } else {
            stopLocationTracking();
          }
        }

        // Stop polling once we've reached a settled, non-pending state —
        // nothing left to reconcile until the employee sends a new request
        // (which bumps pollEpoch and restarts this effect).
        if (settled !== 'pending' && poll) {
          clearInterval(poll);
          poll = null;
        }
      } catch { /* silent */ }
    };
    check();

    // Re-check when the app returns to the foreground (covers the case where
    // the admin approved while the app was backgrounded and the socket missed it).
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') check();
    });
    // Poll periodically while pending so the badge clears promptly; cleared
    // early by check() itself once status settles to approved/denied.
    poll = setInterval(check, 30000);

    return () => {
      cancelled = true;
      sub.remove();
      if (poll) clearInterval(poll);
      // Don't tear down field-work breadcrumbs here; the geofence effect owns them.
      if (!onFieldWork) stopLocationTracking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClockedIn, pollEpoch, startLocationTracking, stopLocationTracking]);

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
      setPollEpoch((e) => e + 1); // re-arm polling in case it had settled+stopped
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
          <TouchableOpacity
            style={[w.clockInBtn, clockingIn && { opacity: 0.6 }]}
            onPress={handleClockIn}
            disabled={clockingIn}
            activeOpacity={0.8}
          >
            <Icon name="login" size={16} color="#fff" />
            <Text style={w.clockInTxt}>{clockingIn ? 'Clocking in…' : 'Clock In'}</Text>
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

      {/* ── Ideal Time & Remark ── */}
      <View style={w.idealBox}>
        <View style={w.idealHeader}>
          <View style={w.idealHeaderLeft}>
            <Icon name="clock-time-four-outline" size={13} color={COLORS.blueLight} />
            <Text style={w.idealTitle}>Ideal Working Time</Text>
          </View>
          <TouchableOpacity onPress={openIdealModal} style={w.idealEditBtn}>
            <Icon name={idealTime || idealRemark ? 'pencil-outline' : 'plus'} size={13} color={COLORS.blueLight} />
            <Text style={w.idealEditTxt}>{idealTime || idealRemark ? 'Edit' : 'Add'}</Text>
          </TouchableOpacity>
        </View>
        {idealTime ? (
          <Text style={w.idealTimeTxt}>{idealTime}</Text>
        ) : (
          <Text style={w.idealEmptyTxt}>No ideal time set for today</Text>
        )}
        {idealRemark ? (
          <View style={w.idealRemarkRow}>
            <Icon name="message-reply-text-outline" size={12} color={COLORS.textMuted} style={{ marginTop: 1 }} />
            <Text style={w.idealRemarkTxt}>{idealRemark}</Text>
          </View>
        ) : null}
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

      {/* ── Ideal Time / Remark editor modal ── */}
      <Modal visible={showIdealModal} transparent animationType="slide" onRequestClose={() => setShowIdealModal(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={w.modalOverlay}>
          <View style={w.meetingModal}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <Text style={w.meetingModalTitle}>🕐 Ideal Working Time</Text>
              <TouchableOpacity onPress={() => setShowIdealModal(false)}>
                <Icon name="close" size={20} color="#64748B" />
              </TouchableOpacity>
            </View>
            <Text style={w.meetingModalLabel}>Ideal time (e.g. 10:00 AM - 6:00 PM)</Text>
            <TextInput
              style={[w.meetingInput, { minHeight: 44 }]}
              placeholder="e.g. 11:00 AM - 7:00 PM"
              placeholderTextColor="#475569"
              value={idealDraftTime}
              onChangeText={setIdealDraftTime}
            />
            <Text style={w.meetingModalLabel}>Reason / Remark</Text>
            <TextInput
              style={w.meetingInput}
              placeholder="e.g. Client visit in the morning, starting late"
              placeholderTextColor="#475569"
              value={idealDraftRemark}
              onChangeText={setIdealDraftRemark}
              multiline
            />
            <Text style={w.meetingModalHint}>
              Your ideal time and reason are saved to today's attendance and visible to your admin.
            </Text>
            <TouchableOpacity
              style={[w.meetingSubmitBtn, idealSaving && { opacity: 0.6 }]}
              onPress={handleSaveIdeal}
              disabled={idealSaving}
            >
              {idealSaving
                ? <ActivityIndicator color="#fff" size="small" />
                : <>
                  <Icon name="content-save-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
                  <Text style={w.meetingSubmitTxt}>Save</Text>
                </>
              }
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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

  // Ideal time + remark
  idealBox:        { backgroundColor: COLORS.surfaceAlt, borderRadius: RADIUS.md, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: COLORS.border },
  idealHeader:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  idealHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  idealTitle:      { fontSize: FONT.xs, color: COLORS.textMuted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  idealEditBtn:    { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 3, borderRadius: RADIUS.full, backgroundColor: COLORS.blueBg },
  idealEditTxt:    { fontSize: FONT.xs, color: COLORS.blueLight, fontWeight: '700' },
  idealTimeTxt:    { fontSize: FONT.md, color: COLORS.textPrimary, fontWeight: '700' },
  idealEmptyTxt:   { fontSize: FONT.sm, color: COLORS.textMuted, fontStyle: 'italic' },
  idealRemarkRow:  { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 6 },
  idealRemarkTxt:  { flex: 1, fontSize: FONT.sm, color: COLORS.textSecondary || COLORS.textMuted, lineHeight: 18 },
});