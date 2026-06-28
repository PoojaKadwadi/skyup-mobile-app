// src/services/callDetector.js
// ─────────────────────────────────────────────────────────────────────────────
// Detects call start/end using the EXISTING native CallStateModule bridge
// (callStateService.js) which emits: "idle" | "ringing" | "offhook"
//
// This replaces the previous react-native-call-detection approach which was
// silently doing nothing because that package is NOT installed.
//
// State machine:
//   idle     → ringing  : incoming call arriving
//   idle     → offhook  : outgoing call started
//   ringing  → offhook  : incoming call answered
//   ringing  → idle     : missed / rejected
//   offhook  → idle     : call ended (recording sync triggered here)
//
// On call end (offhook → idle):
//   1. syncSingleCall()               — uploads call log to CRM immediately
//   2. triggerPostCallRecordingSync() — scans for & uploads the recording file
//
// FIX: Phone number was always 'Unknown' because the native CallStateModule
// only emits call state (idle/ringing/offhook), never the phone number.
// We now resolve the real number from the device call log after the call ends
// (1.5s delay gives the OS time to write the log entry). This resolved number
// is used for both syncSingleCall and triggerPostCallRecordingSync, which
// fixes the recording cross-check that was skipping every file because
// normalizePhone('Unknown') never matched any resolved phone number.
// ─────────────────────────────────────────────────────────────────────────────

import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { subscribeToCallState, startCallStateListener } from './callStateService';
import { syncSingleCall }                from './callSyncService';
import { triggerPostCallRecordingSync }  from './backgroundSyncService';
import { getDeviceCallLogs }             from './phoneService';

const CALL_CACHE_KEY = 'crm_active_call_cache';

// ── Module-level state ────────────────────────────────────────────────────────
let unsubscribe   = null;   // returned by subscribeToCallState()
let appStateSub   = null;
let isStarted     = false;
let activeCall    = null;   // { number, startedAt, type: 'incoming'|'outgoing' }
let prevState     = 'idle'; // track previous state for transition logic

// ── AsyncStorage helpers ──────────────────────────────────────────────────────
async function saveCache(call) {
  try { await AsyncStorage.setItem(CALL_CACHE_KEY, JSON.stringify(call)); } catch {}
}
async function loadCache() {
  try {
    const raw = await AsyncStorage.getItem(CALL_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
async function clearCache() {
  try { await AsyncStorage.removeItem(CALL_CACHE_KEY); } catch {}
}

// ── Resolve the real phone number from the device call log ───────────────────
// The native CallStateModule never gives us the phone number — only the state.
// After a call ends, we wait 1.5s for the OS to write the call log entry, then
// find the entry whose timestamp is closest to callStartedAt (within 10 min).
// Returns { number, name } — name is the cached contact name (may be ''), used
// by the recording sync to match name-saved recording files.
// Falls back to { number: 'Unknown', name: '' } if nothing matches.
async function resolvePhoneNumber(callStartedAt) {
  try {
    await new Promise(r => setTimeout(r, 1500)); // wait for OS to write call log
    let logs = await getDeviceCallLogs(25);       // FIX: 10 → 25 for better coverage

    const TEN_MIN = 10 * 60 * 1000;
    const pick = (entries) => {
      let best = null, minDiff = Infinity;
      for (const log of entries) {
        if (!log?.phoneNumber) continue;
        const diff = Math.abs(parseInt(log.timestamp) - callStartedAt);
        if (diff < TEN_MIN && diff < minDiff) { minDiff = diff; best = log; }
      }
      return best;
    };

    let best = pick(logs);

    // FIX: the call-log row can lag the call end by a few seconds, especially
    // for saved contacts. If nothing matched on the first read, wait once more
    // and retry rather than returning 'Unknown' (which makes the downstream
    // recording sync skip the file).
    if (!best) {
      await new Promise(r => setTimeout(r, 2000));
      logs = await getDeviceCallLogs(25);
      best = pick(logs);
    }

    if (best?.phoneNumber) {
      console.log(`[callDetector] ✅ Resolved phone number from call log: ${best.phoneNumber} (name: ${best.name || '—'})`);
      return { number: best.phoneNumber, name: best.name || '' };
    }
  } catch (e) {
    console.warn('[callDetector] Could not resolve phone from call log:', e.message);
  }
  return { number: 'Unknown', name: '' };
}

// ── Core state-change handler ─────────────────────────────────────────────────
// Called every time the native bridge fires a CallStateChanged event.
// state: "idle" | "ringing" | "offhook"
async function onCallStateChange({ state }) {
  const now = Date.now();

  // ── ringing: incoming call arriving ────────────────────────────────────────
  if (state === 'ringing' && prevState === 'idle') {
    // Phone number is not available at ringing time via TelephonyManager.
    // We resolve it from the call log after the call ends (see idle block).
    activeCall = { number: 'Unknown', startedAt: now, type: 'incoming' };
    await saveCache(activeCall);
  }

  // ── offhook: call in progress ───────────────────────────────────────────────
  if (state === 'offhook') {
    if (!activeCall) {
      // No prior ringing event — this is an outgoing call
      activeCall = { number: 'Unknown', startedAt: now, type: 'outgoing' };
      await saveCache(activeCall);
    } else if (activeCall.type === 'incoming') {
      // Ringing → offhook: incoming was answered — update startedAt to answer time
      activeCall = { ...activeCall, startedAt: now };
      await saveCache(activeCall);
    }
  }

  // ── idle: call ended ────────────────────────────────────────────────────────
  if (state === 'idle' && prevState !== 'idle') {
    const cached = activeCall || (await loadCache());
    await clearCache();
    activeCall = null;

    if (!cached) {
      prevState = state;
      return;
    }

    const duration = Math.max(0, Math.round((now - cached.startedAt) / 1000));

    if (prevState === 'ringing') {
      // ringing → idle without going through offhook = missed/rejected
      // FIX: resolve real number from call log before syncing
      const resolved = await resolvePhoneNumber(cached.startedAt);
      syncSingleCall({
        phoneNumber: resolved.number,
        callType:    'missed',
        duration:    0,
        timestamp:   cached.startedAt,
      }).catch(() => {});

    } else if (prevState === 'offhook' && duration > 0) {
      // offhook → idle = call completed
      // FIX: resolve real number from call log — 'Unknown' was causing
      // triggerPostCallRecordingSync to skip every recording file because
      // the cross-check in syncRecordings never matched 'Unknown' to any
      // real phone number extracted from the filename or call log.
      const resolved = await resolvePhoneNumber(cached.startedAt);

      // 1. Sync call log to CRM
      syncSingleCall({
        phoneNumber: resolved.number,
        callType:    cached.type,
        duration,
        timestamp:   cached.startedAt,
      }).catch(() => {});

      // 2. Auto-sync the recording file — triggerPostCallRecordingSync
      //    adds its own delays (3s, 10s, 25s, 45s) internally so we pass
      //    the resolved number AND contact name straight through. The name
      //    lets syncRecordings match name-saved files like "pooja 1057.mp3"
      //    (the exact files that only uploaded manually before).
      triggerPostCallRecordingSync(resolved.number, cached.startedAt, resolved.name);
      console.log(`[callDetector] ✅ Call ended (${resolved.number}), recording sync scheduled`);
    }
  }

  prevState = state;
}

// ── Recovery: handle calls that ended while app was in background/killed ──────
async function recoverInterruptedCall() {
  const cached = await loadCache();
  if (!cached) return;

  const age = Date.now() - cached.startedAt;
  // Discard caches older than 4 hours — clearly stale
  if (age > 4 * 60 * 60 * 1000) {
    await clearCache();
    return;
  }

  const duration = Math.max(0, Math.round(age / 1000));
  await clearCache();

  // FIX: resolve real number from call log on recovery too
  const resolved = await resolvePhoneNumber(cached.startedAt);

  syncSingleCall({
    phoneNumber: resolved.number,
    callType:    cached.type,
    duration,
    timestamp:   cached.startedAt,
  }).catch(() => {});

  // Also try to sync recording — file may still be on disk
  triggerPostCallRecordingSync(resolved.number, cached.startedAt, resolved.name);
  console.log('[callDetector] 🔄 Recovered interrupted call');
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function startCallDetector() {
  if (Platform.OS !== 'android') return;
  if (isStarted) return;

  // Recover any call that ended while app was away
  await recoverInterruptedCall();

  // callStateService must already be started (App.js calls startCallStateListener
  // before startCallDetector). Subscribe to its events.
  unsubscribe = subscribeToCallState(onCallStateChange);
  isStarted   = true;
  console.log('[callDetector] ✅ Started (using native CallStateModule)');

  // Also recover on app foreground — catches calls that ended while backgrounded
  appStateSub = AppState.addEventListener('change', async (next) => {
    if (next === 'active') await recoverInterruptedCall();
  });
}

export function stopCallDetector() {
  if (!isStarted) return;
  unsubscribe?.();
  appStateSub?.remove?.();
  unsubscribe  = null;
  appStateSub  = null;
  activeCall   = null;
  prevState    = 'idle';
  isStarted    = false;
  console.log('[callDetector] Stopped');
}

export function isCallActive()  { return !!activeCall; }
export function getActiveCall() { return activeCall ? { ...activeCall } : null; }