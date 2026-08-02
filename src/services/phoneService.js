// src/services/phoneService.js
// FIXES:
//  1. normalizePhone() helper strips country code (91/+91) so calling
//     works correctly and phone matching is consistent.
//  2. makePhoneCall uses normalizePhone — no more "91XXXXXXXXXX" dialling.
//  3. getCallLogsForNumber normalizes both sides for reliable matching.
//  4. Limits raised to 500 (retained from previous fix).

import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  requestCallPermission,
  requestCallLogPermission,
  showBlockedPermissionAlert,
} from './permissionsService';

// ── Safe import ───────────────────────────────────────────────────────────────
let CallLogs = null;
try {
  const mod = require('react-native-call-log');
  CallLogs = mod?.default ?? mod ?? null;
  if (CallLogs && typeof CallLogs.loadAll !== 'function') {
    CallLogs = CallLogs.default ?? null;
  }
} catch (e) {
  console.warn('[phoneService] react-native-call-log not available:', e.message);
}

export const CALL_TYPES = {
  1: 'incoming',  2: 'outgoing',  3: 'missed',
  4: 'voicemail', 5: 'rejected',  6: 'blocked',
  INCOMING: 'incoming', OUTGOING: 'outgoing', MISSED: 'missed',
  REJECTED: 'rejected', BLOCKED:  'blocked',
};

// ── FIX 1: Strip country code so numbers always compare as 10-digit ───────────
// Handles: "+919876543210", "919876543210", "09876543210", "9876543210"
export function normalizePhone(phone) {
  if (!phone) return '';
  let digits = String(phone).replace(/\D/g, '');
  // Strip leading 0
  if (digits.startsWith('0')) digits = digits.slice(1);
  // Strip country code 91 if 12 digits (91 + 10)
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  // Strip country code 91 if 11 digits (91 + 9) — rare but handle it
  if (digits.length === 11 && digits.startsWith('91')) digits = digits.slice(2);
  return digits.slice(-10);
}

// ── Shared mapper ─────────────────────────────────────────────────────────────
function mapRawLogs(rawArray) {
  return rawArray.map(log => ({
    phoneNumber: log.phoneNumber || log.number || '',
    callType:    CALL_TYPES[log.type] || CALL_TYPES[parseInt(log.type)] || 'unknown',
    duration:    parseInt(log.duration || 0),
    timestamp:   log.timestamp || log.dateAdded || String(Date.now()),
    name:        log.name || log.cachedName || '',
    // Multi-SIM identifiers — react-native-call-log already resolves these
    // from Android's CallLog.Calls.PHONE_ACCOUNT_ID + SubscriptionManager;
    // this file was just discarding them. Used to scope the bulk sync to the
    // employee's own registered work-SIM number (see getWorkSimAccountId
    // below), not their personal SIM if the phone has two.
    phoneAccountId: log.phoneAccountId || null,
    simDisplayName: log.simDisplayName || null,
  }));
}

// ── Sanitise a number for DIALING (not for matching) ──────────────────────────
// IMPORTANT: do NOT use normalizePhone() to build a tel: URI. normalizePhone
// strips the country code and keeps only the last 10 digits — that is correct
// for COMPARING numbers, but wrong for DIALING (it breaks international numbers,
// landlines with long area codes, and short codes). For dialing we keep a single
// leading "+" if present and every digit, and strip only true junk (spaces,
// dashes, parens, dots, slashes, invisible unicode marks, stray "tel:" text).
export function sanitizeForDial(phone) {
  if (!phone) return '';
  const raw     = String(phone);
  const hasPlus = raw.trim().startsWith('+');
  const digits  = raw.replace(/\D/g, '');
  if (digits.length < 3) return '';
  return (hasPlus ? '+' : '') + digits;
}

// ── Make a phone call ─────────────────────────────────────────────────────────
// FIX: dial the real number via sanitizeForDial (was normalizePhone, which
// stripped the country code and could yield a blank/wrong dialer). Also dropped
// the canOpenURL("tel:") guard — it returns false spuriously on Android 11+
// when the dialer package isn't in <queries>, which blocked legitimate calls.
export const makePhoneCall = async (phoneNumber) => {
  const dialNumber = sanitizeForDial(phoneNumber);
  if (!dialNumber) throw new Error('Invalid phone number');

  const granted = await requestCallPermission();
  if (!granted) {
    showBlockedPermissionAlert('Call Phone');
    return false;
  }

  await Linking.openURL(`tel:${dialNumber}`);
  return true;
};

// ── Read device call logs (UI display use) ────────────────────────────────────
export const getDeviceCallLogs = async (limit = 200) => {
  if (Platform.OS !== 'android') return [];

  if (!CallLogs || typeof CallLogs.loadAll !== 'function') {
    console.warn('[phoneService] react-native-call-log not loaded correctly. Rebuild the app.');
    return [];
  }

  try {
    const granted = await requestCallLogPermission();
    if (!granted) {
      console.warn('[phoneService] READ_CALL_LOG permission not granted');
      return [];
    }

    const raw = await CallLogs.loadAll({ limit: String(limit) });

    if (!Array.isArray(raw)) {
      console.warn('[phoneService] CallLogs.loadAll returned non-array:', typeof raw);
      return [];
    }

    return mapRawLogs(raw);
  } catch (e) {
    console.error('[phoneService] getDeviceCallLogs error:', e.message);
    return [];
  }
};

// ── Read call logs since a timestamp (sync use) ───────────────────────────────
// @param {string} [phoneAccountId] - if provided, scopes the query to only
//   this SIM/phone account (see getWorkSimAccountId). Omit to get all SIMs
//   (previous behavior, unchanged for callers that don't pass it).
export const getCallLogsSince = async (sinceTimestamp, phoneAccountId = null) => {
  if (Platform.OS !== 'android') return [];
  if (!CallLogs || typeof CallLogs.loadAll !== 'function') return [];

  const sinceMs = typeof sinceTimestamp === 'number'
    ? sinceTimestamp
    : new Date(sinceTimestamp).getTime();

  try {
    const granted = await requestCallLogPermission();
    if (!granted) return [];

    try {
      const filter = { limit: '500', minTimestamp: String(sinceMs) };
      if (phoneAccountId) filter.phoneAccountId = phoneAccountId;
      const raw = await CallLogs.loadAll(filter);
      if (Array.isArray(raw)) return mapRawLogs(raw);
    } catch {
      // minTimestamp/phoneAccountId not supported on this device/version —
      // fall through to JS filter.
    }

    const all = await getDeviceCallLogs(500);
    let filtered = all.filter(log => parseInt(log.timestamp) > sinceMs);
    if (phoneAccountId) {
      filtered = filtered.filter(log => log.phoneAccountId === phoneAccountId);
    }
    return filtered;
  } catch (e) {
    console.error('[phoneService] getCallLogsSince error:', e.message);
    return [];
  }
};

// ── Work-SIM selection (multi-SIM devices) ────────────────────────────────────
// An agent's phone may carry two SIMs — a personal number and a designated
// "work" number they use to call leads. The bulk call-log sync should only
// pick up calls made via the WORK SIM, not the personal one, even if the
// personal SIM also happens to call a lead's number sometimes.
//
// phoneAccountId is device/OS-specific (not meaningful server-side), so the
// chosen SIM is stored locally in AsyncStorage, per device.
const WORK_SIM_KEY = 'crm_work_sim_account_id';

export async function getWorkSimAccountId() {
  try {
    return await AsyncStorage.getItem(WORK_SIM_KEY);
  } catch {
    return null;
  }
}

export async function setWorkSimAccountId(phoneAccountId) {
  try {
    if (phoneAccountId) await AsyncStorage.setItem(WORK_SIM_KEY, phoneAccountId);
    else await AsyncStorage.removeItem(WORK_SIM_KEY);
  } catch { /* non-critical */ }
}

// Detect the SIMs available on this device by sampling recent call log
// entries for their distinct phoneAccountId/simDisplayName pairs. The
// underlying native package doesn't expose a dedicated "list SIMs" call, but
// every loaded entry already carries this info, so a small recent sample is
// enough to populate a picker (Settings/Profile screen).
export async function getAvailableSims() {
  if (Platform.OS !== 'android') return [];
  if (!CallLogs || typeof CallLogs.loadAll !== 'function') return [];

  try {
    const granted = await requestCallLogPermission();
    if (!granted) return [];

    const raw = await CallLogs.loadAll({ limit: '100' }).catch(() => CallLogs.loadAll());
    const logs = Array.isArray(raw) ? mapRawLogs(raw) : [];

    const seen = new Map(); // phoneAccountId -> simDisplayName
    for (const log of logs) {
      if (log.phoneAccountId && !seen.has(log.phoneAccountId)) {
        seen.set(log.phoneAccountId, log.simDisplayName || `SIM (${log.phoneAccountId.slice(-4)})`);
      }
    }
    return Array.from(seen.entries()).map(([phoneAccountId, label]) => ({ phoneAccountId, label }));
  } catch (e) {
    console.error('[phoneService] getAvailableSims error:', e.message);
    return [];
  }
}

// ── Read call logs for a specific phone number ────────────────────────────────
// FIX 3: Normalize both sides so "91XXXXXXXXXX" matches "XXXXXXXXXX"
export const getCallLogsForNumber = async (phoneNumber) => {
  const normalized = normalizePhone(phoneNumber);
  const all = await getDeviceCallLogs(200);
  return all.filter(log => normalizePhone(log.phoneNumber) === normalized);
};