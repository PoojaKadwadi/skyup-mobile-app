// src/services/tokenStorage.js — NEW
// ─────────────────────────────────────────────────────────────────────────────
// FIXES S-1 (High): the JWT was stored in PLAINTEXT AsyncStorage under
// 'auth_token', readable on any rooted/compromised device. This module is the
// single source of truth for the auth token and keeps it in the Android
// Keystore via react-native-keychain (already a dependency) instead.
//
// WHY A WRAPPER
//   • Every API request reads the token. Hitting the native Keychain on every
//     request would add a bridge call per request, so we cache the token in
//     memory after the first read and keep the cache in sync on set/remove.
//   • ONE-TIME MIGRATION: on first read, if the Keychain is empty but the old
//     plaintext 'auth_token' still exists in AsyncStorage (upgrading users),
//     we move it into the Keychain and DELETE the plaintext copy. So existing
//     logged-in users are migrated transparently — no forced re-login.
//   • GRACEFUL FALLBACK: if Keychain is somehow unavailable on a device, we
//     fall back to AsyncStorage so auth never hard-breaks. This is strictly
//     better than today (where it's ALWAYS plaintext) and logs a warning.
//
// PUBLIC API (all async):
//   getToken()        -> string | null
//   setToken(token)   -> void   (call on login)
//   removeToken()     -> void   (call on logout / forced 401 logout)
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';

// Legacy plaintext key — kept only so we can migrate & then purge it.
const LEGACY_KEY = 'auth_token';
const KEYCHAIN_SERVICE = 'com.skyupcrm.auth';
const KEYCHAIN_USER    = 'skyup';

// Safe Keychain import — never let a missing/unlinked native module crash JS.
let Keychain = null;
try {
  Keychain = require('react-native-keychain');
} catch (e) {
  Keychain = null;
}
const keychainAvailable = !!(Keychain && typeof Keychain.setGenericPassword === 'function');

// In-memory cache so repeated getToken() calls don't cross the native bridge.
// `undefined` = not hydrated yet; `null` = confirmed no token; string = token.
let _cache = undefined;

async function _keychainGet() {
  try {
    const creds = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
    return creds ? creds.password : null;
  } catch {
    return null;
  }
}

async function _keychainSet(token) {
  try {
    await Keychain.setGenericPassword(KEYCHAIN_USER, token, { service: KEYCHAIN_SERVICE });
    return true;
  } catch {
    return false;
  }
}

async function _keychainRemove() {
  try {
    await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
  } catch { /* ignore */ }
}

/** Read the auth token. Hydrates + migrates on first call, then serves cache. */
export async function getToken() {
  if (_cache !== undefined) return _cache;

  if (!keychainAvailable) {
    // Fallback path — still better than nothing, but warn once.
    console.warn('[tokenStorage] Keychain unavailable — falling back to AsyncStorage.');
    try { _cache = await AsyncStorage.getItem(LEGACY_KEY); } catch { _cache = null; }
    return _cache;
  }

  // Primary: Keychain
  let token = await _keychainGet();

  // One-time migration from the old plaintext store.
  if (!token) {
    let legacy = null;
    try { legacy = await AsyncStorage.getItem(LEGACY_KEY); } catch {}
    if (legacy) {
      const ok = await _keychainSet(legacy);
      if (ok) {
        try { await AsyncStorage.removeItem(LEGACY_KEY); } catch {}
        console.log('[tokenStorage] Migrated auth token from AsyncStorage → Keychain.');
        token = legacy;
      } else {
        // Keychain write failed — keep serving the legacy value this session.
        token = legacy;
      }
    }
  }

  _cache = token || null;
  return _cache;
}

/** Persist the auth token (call on login). */
export async function setToken(token) {
  _cache = token || null;
  if (!token) return removeToken();

  if (keychainAvailable) {
    const ok = await _keychainSet(token);
    // Belt-and-suspenders: if Keychain write fails, don't silently lose the
    // session — fall back to AsyncStorage for this device.
    if (!ok) {
      try { await AsyncStorage.setItem(LEGACY_KEY, token); } catch {}
    } else {
      // Make sure no stale plaintext copy lingers.
      try { await AsyncStorage.removeItem(LEGACY_KEY); } catch {}
    }
  } else {
    try { await AsyncStorage.setItem(LEGACY_KEY, token); } catch {}
  }
}

/** Clear the auth token (call on logout / forced logout). */
export async function removeToken() {
  _cache = null;
  if (keychainAvailable) await _keychainRemove();
  // Always also clear any legacy plaintext copy.
  try { await AsyncStorage.removeItem(LEGACY_KEY); } catch {}
}

/** Test/utility: reset the in-memory cache (does not touch storage). */
export function _resetTokenCache() { _cache = undefined; }

export default { getToken, setToken, removeToken };