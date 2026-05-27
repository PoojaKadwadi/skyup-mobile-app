// src/services/phoneService.js
// FIXES:
//  1. normalizePhone() helper strips country code (91/+91) so calling
//     works correctly and phone matching is consistent.
//  2. makePhoneCall uses normalizePhone — no more "91XXXXXXXXXX" dialling.
//  3. getCallLogsForNumber normalizes both sides for reliable matching.
//  4. Limits raised to 500 (retained from previous fix).

import { Linking, Platform } from 'react-native';
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
  }));
}

// ── Make a phone call ─────────────────────────────────────────────────────────
// FIX 2: Use normalizePhone so "919876543210" dials as "9876543210"
export const makePhoneCall = async (phoneNumber) => {
  const normalized = normalizePhone(phoneNumber);
  if (!normalized) throw new Error('Invalid phone number');
  const dialUri = `tel:${normalized}`;

  const canOpen = await Linking.canOpenURL(dialUri);
  if (!canOpen) throw new Error('This device cannot make phone calls');

  const granted = await requestCallPermission();
  if (!granted) {
    showBlockedPermissionAlert('Call Phone');
    return false;
  }

  await Linking.openURL(dialUri);
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
export const getCallLogsSince = async (sinceTimestamp) => {
  if (Platform.OS !== 'android') return [];
  if (!CallLogs || typeof CallLogs.loadAll !== 'function') return [];

  const sinceMs = typeof sinceTimestamp === 'number'
    ? sinceTimestamp
    : new Date(sinceTimestamp).getTime();

  try {
    const granted = await requestCallLogPermission();
    if (!granted) return [];

    try {
      const raw = await CallLogs.loadAll({
        limit:        '500',
        minTimestamp: String(sinceMs),
      });
      if (Array.isArray(raw)) return mapRawLogs(raw);
    } catch {
      // minTimestamp not supported — fall through to JS filter.
    }

    const all = await getDeviceCallLogs(500);
    return all.filter(log => parseInt(log.timestamp) > sinceMs);
  } catch (e) {
    console.error('[phoneService] getCallLogsSince error:', e.message);
    return [];
  }
};

// ── Read call logs for a specific phone number ────────────────────────────────
// FIX 3: Normalize both sides so "91XXXXXXXXXX" matches "XXXXXXXXXX"
export const getCallLogsForNumber = async (phoneNumber) => {
  const normalized = normalizePhone(phoneNumber);
  const all = await getDeviceCallLogs(200);
  return all.filter(log => normalizePhone(log.phoneNumber) === normalized);
};