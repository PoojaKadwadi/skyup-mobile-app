// src/services/callStateService.js
// ─────────────────────────────────────────────────────────────────────────────
//  CALL STATE SERVICE
//
//  Thin wrapper around the native CallStateModule. Exposes:
//    - startCallStateListener() / stopCallStateListener()
//    - subscribeToCallState(fn) → unsubscribe()
//    - isOnCall() / getCallState()
//
//  PERFORMANCE NOTES:
//    - The native module is event-driven (TelephonyCallback / PhoneStateListener).
//      Zero CPU cost when no call is active.
//    - The local `currentState` cache means JS can answer isOnCall() without
//      a bridge call. The bridge is only crossed when the OS reports a state
//      change (typically 1–2 times per call, total of ~4 events per day for
//      a normal user).
//    - Subscribers are stored in a Set, not React state. Adding/removing a
//      subscriber does NOT trigger any React re-render.
// ─────────────────────────────────────────────────────────────────────────────

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

const { CallStateModule } = NativeModules;

// The module is null on iOS (we only built the Android side) and on any
// Android build that hasn't rebuilt with the new package registered. All
// public functions check this and no-op gracefully — JS code that subscribes
// will simply never receive events, and isOnCall() will always return false.
const isAvailable = Platform.OS === 'android' && !!CallStateModule;

let emitter = null;
let nativeSub = null;
let currentState = 'idle';
const subscribers = new Set();

/**
 * Start listening for telephony state changes. Idempotent — calling twice
 * is safe. Should be called once at app start (after login) and matched
 * with stopCallStateListener() on logout.
 */
export function startCallStateListener() {
  if (!isAvailable) return;
  if (nativeSub) return;  // already started

  // Seed local state synchronously so callers asking isOnCall() immediately
  // after start get a correct answer, not a stale "idle" default.
  try {
    currentState = CallStateModule.getCurrentState() || 'idle';
  } catch {
    currentState = 'idle';
  }

  emitter   = new NativeEventEmitter(CallStateModule);
  nativeSub = emitter.addListener('CallStateChanged', (event) => {
    const next = event?.state || 'idle';
    if (next === currentState) return;  // dedupe identical events
    currentState = next;
    // Fire subscribers synchronously — the native side is already throttled
    // by the OS (events only fire on real state transitions), so there's no
    // need to debounce here.
    for (const fn of subscribers) {
      try { fn({ state: next, timestamp: event.timestamp }); }
      catch (e) { /* don't let one bad subscriber block the others */ }
    }
  });

  CallStateModule.start();
}

/** Stop listening. Releases the native telephony listener. */
export function stopCallStateListener() {
  if (!isAvailable) return;
  CallStateModule.stop?.();
  nativeSub?.remove();
  nativeSub = null;
  emitter = null;
  currentState = 'idle';
}

/** Returns the current cached state without crossing the bridge. */
export function getCallState() {
  return currentState;
}

/** True if a call is ringing or in progress. */
export function isOnCall() {
  return currentState !== 'idle';
}

/**
 * Subscribe to call state changes. Returns an unsubscribe function.
 * Usage:
 *   const unsub = subscribeToCallState(({ state }) => { ... });
 *   // later:
 *   unsub();
 */
export function subscribeToCallState(fn) {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}
