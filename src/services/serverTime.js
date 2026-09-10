// src/services/serverTime.js
// ─────────────────────────────────────────────────────────────────────────────
// SERVER TIME OFFSET
//
// THE PROBLEM:
//   Attendance timestamps (loginTime, break start/end, lastActivity) are all
//   generated SERVER-side — which is correct and tamper-proof. But the UI
//   computed elapsed time as:
//       Date.now() - new Date(record.loginTime)
//   mixing DEVICE time with SERVER time. If the phone's clock is off (manually
//   set, drifted, wrong timezone auto-detect), the running timer is wrong by
//   exactly that skew:
//     • phone 20 min fast  → shows "8h 20m" when the server has 8h 00m
//     • phone set behind    → Math.max(0, …) clamps it to a frozen 00:00:00
//   The stored record stayed correct, so reports were fine — but the app and
//   the dashboard disagreed, which reads as a bug to the user.
//
// THE FIX:
//   Every HTTP response already carries an authoritative `Date` header from
//   the server. We read it on each response and keep a rolling offset:
//       offset = serverTime - deviceTime
//   Callers then use serverNow() instead of Date.now(). No extra API calls,
//   no extra battery cost, and it self-corrects continuously as the app makes
//   normal requests.
//
//   Before the first response arrives, offset is 0 — serverNow() === Date.now(),
//   so behaviour is identical to before (never worse).
//
// NOTE ON ACCURACY:
//   The Date header has 1-second resolution and includes network latency, so
//   the offset is accurate to roughly ±1–2s. That is far more than good enough
//   for a work-duration timer, and it eliminates the minutes-to-hours error a
//   skewed device clock produces.
// ─────────────────────────────────────────────────────────────────────────────

// offset = serverEpochMs - deviceEpochMs
let _offsetMs = 0;
let _hasSynced = false;

/**
 * Feed a server `Date` header (or any trusted ISO/epoch value) in to update
 * the offset. Safe to call on every response — invalid values are ignored.
 */
export function recordServerDate(dateHeader) {
  if (!dateHeader) return;
  try {
    const serverMs = new Date(dateHeader).getTime();
    if (!Number.isFinite(serverMs)) return;
    _offsetMs  = serverMs - Date.now();
    _hasSynced = true;
  } catch {
    // Ignore — keep whatever offset we already had.
  }
}

/** Server-corrected "now" in epoch ms. Falls back to device time pre-sync. */
export function serverNow() {
  return Date.now() + _offsetMs;
}

/** Current offset in ms (server - device). 0 when never synced. */
export function getClockOffsetMs() {
  return _offsetMs;
}

/** True once at least one server Date header has been seen. */
export function hasSyncedClock() {
  return _hasSynced;
}

/**
 * True when the device clock is off from the server by more than `thresholdMs`.
 * Useful for showing a one-time "your device clock is wrong" hint.
 */
export function isDeviceClockSkewed(thresholdMs = 60_000) {
  return _hasSynced && Math.abs(_offsetMs) > thresholdMs;
}
