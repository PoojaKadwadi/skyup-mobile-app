// src/services/locationTrackingService.js — NEW (RAM fix #4)
// ─────────────────────────────────────────────────────────────────────────────
// THE PROBLEM:
//   GPS pings ran via setInterval INSIDE AttendanceWidget (a React component).
//   Every interval tick: getCurrentPosition() allocates a new OS callback
//   closure. On a 15-min interval that's 4 closures/hour staying alive while
//   the widget is mounted. When the component re-renders (ANY state change),
//   the useCallback memoisation recreates sendLocationPing, and the stale
//   closure held by the live setInterval can't be collected until clearInterval.
//   On a busy session (status updates, punch-ins) this stacked up 10–20 live
//   closures simultaneously.
//
// THE FIX:
//   Move GPS state entirely out of React. This module-level service owns the
//   interval. React components call start/stop; the interval callback is a
//   stable function reference that never gets recreated.
//
// USAGE (in AttendanceWidget.js):
//   import * as LocationTracking from '../../services/locationTrackingService';
//   LocationTracking.start(15);   // 15 min interval
//   LocationTracking.stop();
//   LocationTracking.isRunning(); // boolean
// ─────────────────────────────────────────────────────────────────────────────

import { Platform, PermissionsAndroid } from 'react-native';
import api from './api';

let _interval   = null;
let _running    = false;
let _Geo        = null;

function _getGeo() {
  if (_Geo) return _Geo;
  try { _Geo = require('@react-native-community/geolocation'); } catch { _Geo = null; }
  return _Geo;
}

// Stable function — created ONCE, never recreated on re-render.
async function _sendPing() {
  try {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      ).catch(() => false);
      if (!granted) { stop(); return; }
    }

    const Geo = _getGeo();
    if (!Geo || typeof Geo.getCurrentPosition !== 'function') return;

    Geo.getCurrentPosition(
      async (pos) => {
        try {
          await api.post('/attendance/location-ping', {
            latitude:  pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy:  pos.coords.accuracy,
          });
        } catch (e) {
          console.warn('[LocationTracking] ping failed:', e.message);
        }
      },
      (err) => console.warn('[LocationTracking] geo error:', err.message),
      // enableHighAccuracy:false — uses cell/WiFi triangulation.
      // For a 15-min attendance ping this is MORE than precise enough and
      // uses ~80% less battery than GPS satellite lock.
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  } catch (e) {
    console.warn('[LocationTracking] sendPing error:', e.message);
  }
}

export function start(intervalMinutes = 15) {
  stop(); // clear any existing
  const ms = Math.max(5, intervalMinutes) * 60 * 1000;
  _sendPing(); // immediate first ping
  _interval = setInterval(_sendPing, ms);
  _running  = true;
  console.log(`[LocationTracking] started — ping every ${intervalMinutes} min`);
}

export function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  _running = false;
}

export function isRunning() { return _running; }