// src/services/callDetector.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX (this revision) — user-scoped call cache key:
//
//   CALL_CACHE_KEY was global ('crm_active_call_cache').
//   If User A had an in-progress call, logged out, and User B logged in on the
//   same device, User B's startup would see User A's call cache and attempt to
//   sync it under User B's account.
//
//   Fix: the cache key is now scoped to userId+companyId, loaded lazily from
//   the Redux store so it never causes a circular import. The cache is also
//   cleared in stopCallDetector() which is called on logout.
//
// ALL OTHER BEHAVIOUR RETAINED (race condition fix, AppState recovery,
// call-log resolution, duration fix, triggerPostCallRecordingSync).
//
// NOTE: Call detection NEVER depends on clock-in/attendance state.
// ─────────────────────────────────────────────────────────────────────────────

import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { subscribeToCallState, startCallStateListener, getCallState } from './callStateService';
import { syncSingleCall }               from './callSyncService';
import { triggerPostCallRecordingSync } from './backgroundSyncService';
import { getDeviceCallLogs }            from './phoneService';

// ── User-scoped cache key ─────────────────────────────────────────────────────
const LEGACY_CALL_CACHE_KEY = 'crm_active_call_cache';

function getCallCacheKey() {
  try {
    const { store } = require('../store');
    const state = store.getState();
    const userId    = state?.auth?.user?._id || state?.auth?.user?.id || 'anon';
    const companyId = state?.auth?.user?.company?._id || state?.auth?.user?.company || 'co';
    return `crm_call_cache_${companyId}_${userId}`;
  } catch {
    return LEGACY_CALL_CACHE_KEY;
  }
}

// ── Module-level state ────────────────────────────────────────────────────────
let unsubscribe   = null;
let appStateSub   = null;
let isStarted     = false;
let activeCall    = null;
let prevState     = 'idle';
let isProcessingCallEnd = false;

// ── AsyncStorage helpers ──────────────────────────────────────────────────────
async function saveCache(call) {
  try { await AsyncStorage.setItem(getCallCacheKey(), JSON.stringify(call)); } catch {}
}
async function loadCache() {
  try {
    // FIX: clear any legacy global cache so it can't bleed across users
    const legacyRaw = await AsyncStorage.getItem(LEGACY_CALL_CACHE_KEY);
    if (legacyRaw) {
      await AsyncStorage.removeItem(LEGACY_CALL_CACHE_KEY);
      // Migrate to user-scoped key only if we don't have one already
      const existing = await AsyncStorage.getItem(getCallCacheKey());
      if (!existing) {
        await AsyncStorage.setItem(getCallCacheKey(), legacyRaw);
      }
    }
    const raw = await AsyncStorage.getItem(getCallCacheKey());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
async function clearCache() {
  try {
    await AsyncStorage.removeItem(getCallCacheKey());
    await AsyncStorage.removeItem(LEGACY_CALL_CACHE_KEY); // belt-and-suspenders
  } catch {}
}

// ── Resolve the real phone number from the device call log ───────────────────
async function resolvePhoneNumber(callStartedAt) {
  try {
    await new Promise(r => setTimeout(r, 1500));
    let logs = await getDeviceCallLogs(25);

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

    if (!best) {
      await new Promise(r => setTimeout(r, 2000));
      logs = await getDeviceCallLogs(25);
      best = pick(logs);
    }

    if (best?.phoneNumber) {
      console.log(`[callDetector] ✅ Resolved phone: ${best.phoneNumber} (name: ${best.name || '—'})`);
      const durationSecs = Number.isFinite(best.duration) ? best.duration : parseInt(best.duration);
      return { number: best.phoneNumber, name: best.name || '', duration: Number.isFinite(durationSecs) ? durationSecs : null };
    }
  } catch (e) {
    console.warn('[callDetector] Could not resolve phone from call log:', e.message);
  }
  return { number: 'Unknown', name: '', duration: null };
}

// ── Core state-change handler ─────────────────────────────────────────────────
async function onCallStateChange({ state }) {
  const now = Date.now();

  if (state === 'ringing' && prevState === 'idle') {
    activeCall = { number: 'Unknown', startedAt: now, type: 'incoming' };
    await saveCache(activeCall);
  }

  if (state === 'offhook') {
    if (!activeCall) {
      activeCall = { number: 'Unknown', startedAt: now, type: 'outgoing' };
      await saveCache(activeCall);
    } else if (activeCall.type === 'incoming') {
      activeCall = { ...activeCall, startedAt: now };
      await saveCache(activeCall);
    }
  }

  if (state === 'idle' && prevState !== 'idle') {
    if (isProcessingCallEnd) { prevState = state; return; }
    isProcessingCallEnd = true;

    try {
      const cached = activeCall || (await loadCache());
      await clearCache();
      activeCall = null;

      if (!cached) { prevState = state; return; }

      const estimatedDuration = Math.max(0, Math.round((now - cached.startedAt) / 1000));

      if (prevState === 'ringing') {
        const resolved = await resolvePhoneNumber(cached.startedAt);
        syncSingleCall({
          phoneNumber: resolved.number,
          callType:    'missed',
          duration:    0,
          timestamp:   cached.startedAt,
        }).catch(() => {});
      } else if (prevState === 'offhook' && estimatedDuration > 0) {
        const resolved = await resolvePhoneNumber(cached.startedAt);
        const duration = resolved.duration != null ? resolved.duration : estimatedDuration;

        syncSingleCall({
          phoneNumber: resolved.number,
          callType:    cached.type,
          duration,
          timestamp:   cached.startedAt,
        }).catch(() => {});

        triggerPostCallRecordingSync(resolved.number, cached.startedAt, resolved.name);
        console.log(`[callDetector] ✅ Call ended (${resolved.number}), recording sync scheduled`);
      }
    } finally {
      isProcessingCallEnd = false;
    }
  }

  prevState = state;
}

// ── Recovery: calls that ended while app was in background/killed ─────────────
async function recoverInterruptedCall() {
  if (isProcessingCallEnd) return;
  if (getCallState() !== 'idle') {
    console.log('[callDetector] Skipping recovery — a call is still in progress');
    return;
  }

  isProcessingCallEnd = true;
  try {
    const cached = await loadCache();
    if (!cached) return;

    const age = Date.now() - cached.startedAt;
    if (age > 4 * 60 * 60 * 1000) { await clearCache(); return; }

    const estimatedDuration = Math.max(0, Math.round(age / 1000));
    await clearCache();

    const resolved = await resolvePhoneNumber(cached.startedAt);
    const duration = resolved.duration != null ? resolved.duration : estimatedDuration;

    syncSingleCall({
      phoneNumber: resolved.number,
      callType:    cached.type,
      duration,
      timestamp:   cached.startedAt,
    }).catch(() => {});

    triggerPostCallRecordingSync(resolved.number, cached.startedAt, resolved.name);
    console.log('[callDetector] 🔄 Recovered interrupted call');
  } finally {
    isProcessingCallEnd = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function startCallDetector() {
  if (Platform.OS !== 'android') return;
  if (isStarted) return;

  await recoverInterruptedCall();

  unsubscribe = subscribeToCallState(onCallStateChange);
  isStarted   = true;
  console.log('[callDetector] ✅ Started (using native CallStateModule)');

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
  // FIX: clear the user-scoped cache on stop (logout) so next user
  // doesn't see stale data from the previous session.
  clearCache().catch(() => {});
  console.log('[callDetector] Stopped');
}

export function isCallActive()  { return !!activeCall; }
export function getActiveCall() { return activeCall ? { ...activeCall } : null; }
