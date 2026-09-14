// src/services/secureScreen.js
// ─────────────────────────────────────────────────────────────────────────
// SECURITY (Screen & UI security): blocks screenshots, screen recording,
// and the Recent Apps thumbnail (Android FLAG_SECURE) while a sensitive
// screen is focused — call recordings (RecordingsScreen) and lead PII
// (LeadDetailScreen). Disabled again on blur so the rest of the app is
// unaffected (screenshots/sharing still work everywhere else).
//
// Safe by design:
//   - No-ops silently on iOS / if the native module isn't linked yet, so a
//     stale JS bundle or a build that hasn't picked up the native module
//     never crashes or blocks a screen.
//   - Pure client-side privacy hardening. It has no bearing on server-side
//     authorization and enforces nothing by itself.
// ─────────────────────────────────────────────────────────────────────────

import { NativeModules, Platform } from 'react-native';

const { SecureScreenModule } = NativeModules;

const available =
  Platform.OS === 'android' &&
  !!SecureScreenModule &&
  typeof SecureScreenModule.enable === 'function';

/** Call when a sensitive screen gains focus. */
export function enableSecureScreen() {
  if (!available) return;
  try { SecureScreenModule.enable(); } catch { /* never break the screen */ }
}

/** Call when a sensitive screen loses focus / unmounts. */
export function disableSecureScreen() {
  if (!available) return;
  try { SecureScreenModule.disable(); } catch { /* never break the screen */ }
}

export default { enableSecureScreen, disableSecureScreen };
