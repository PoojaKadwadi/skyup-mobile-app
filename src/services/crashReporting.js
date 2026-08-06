// src/services/crashReporting.js
// ─────────────────────────────────────────────────────────────────────────────
//  FIX: this file was empty (0 bytes), so `import crash from
//  '../services/crashReporting'` resolved to `undefined`. Any call like
//  `crash.setUser(...)` then threw "undefined is not a function" / "Cannot
//  read property 'setUser' of undefined" — this is what broke login.
//
//  This is currently a safe no-op logger. If/when a real crash reporting SDK
//  (e.g. Sentry, Firebase Crashlytics) is wired in, replace the bodies below
//  with real calls — keep the same exported function names so nothing else
//  needs to change.
// ─────────────────────────────────────────────────────────────────────────────

const IS_DEV = typeof __DEV__ !== 'undefined' ? __DEV__ : false;

function setUser(userId) {
  if (IS_DEV) {
    console.log('[crashReporting] setUser:', userId);
  }
  // TODO: wire to real crash reporting SDK, e.g.:
  // crashlytics().setUserId(String(userId ?? ''));
}

function clearUser() {
  if (IS_DEV) {
    console.log('[crashReporting] clearUser');
  }
  // crashlytics().setUserId('');
}

function log(message) {
  if (IS_DEV) {
    console.log('[crashReporting] log:', message);
  }
  // crashlytics().log(message);
}

function recordError(error) {
  if (IS_DEV) {
    console.error('[crashReporting] recordError:', error);
  }
  // crashlytics().recordError(error);
}

export default { setUser, clearUser, log, recordError };