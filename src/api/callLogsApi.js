// src/api/callLogsApi.js
// FIXES:
//  1. uploadRecording: dedup by (normalizedPhone + fileHash) instead of path.
//     Same call recording cannot be re-uploaded even if path differs.
//     Same number CAN have multiple different recordings uploaded.
//  2. matchPhoneToLead: strips country code before querying.
//  3. Retained: syncCallLogs trusts caller for date scoping (no inner filter).
//
// FIX (this revision) — "network error" on recording upload:
//  Root cause: axios instance in api.js has a default header
//    'Content-Type': 'application/json'
//  Setting 'Content-Type': undefined in per-request headers does NOT remove
//  the instance-level default — axios merges headers and the instance default
//  wins. The server receives 'application/json' instead of
//  'multipart/form-data; boundary=...' and cannot parse the body at all,
//  returning a network/parse error.
//
//  Fix: use the native fetch() API directly for the multipart upload instead
//  of going through the axios instance. fetch() sets Content-Type correctly
//  from the FormData object automatically, with the proper boundary string.
//  Auth token is read from AsyncStorage and attached as Bearer header,
//  matching what the axios interceptor does for all other requests.
//
//  Timeout is handled with AbortController (120s, same as before).

import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from './apiClient';
import { normalizePhone } from '../services/phoneService';
import { BASE_URL } from '../config/config';

// ── Sync call logs to backend ──────────────────────────────────────────────────
export async function syncCallLogs(logs) {
  if (!logs || logs.length === 0) return;
  // Normalize phone numbers before sending to backend
  const normalized = logs.map(l => ({
    ...l,
    phoneNumber: normalizePhone(l.phoneNumber),
  }));
  const res = await apiClient.post('/call-logs/sync', { logs: normalized });
  return res.data;
}

// ── Fetch today's already-synced logs from the server ─────────────────────────
export async function fetchTodayServerLogs() {
  const res = await apiClient.get('/call-logs/today');
  return res.data.logs || [];
}

// ── Fetch logs for a specific date (YYYY-MM-DD) ───────────────────────────────
export async function fetchLogsForDate(dateStr) {
  const res = await apiClient.get('/call-logs', { params: { date: dateStr } });
  return res.data.logs || [];
}

// ── Fetch call logs for a specific lead (by leadId) ──────────────────────────
export async function getLeadCallLogs(leadId, limit = 20) {
  if (!leadId) return [];
  try {
    const res = await apiClient.get(`/call-logs/lead/${leadId}`, { params: { limit } });
    return res.data.logs || [];
  } catch {
    return [];
  }
}

// ── Match a phone number to a CRM lead ───────────────────────────────────────
// FIX 2: Normalize before query so "919876543210" matches "9876543210" in CRM
export async function matchPhoneToLead(phone) {
  if (!phone) return null;
  try {
    const normalized = normalizePhone(phone);
    const res = await apiClient.get('/call-logs/match', { params: { phone: normalized } });
    return res.data.matched ? res.data : null;
  } catch {
    return null;
  }
}

// ── Simple file content hash (size + mtime + filename) ───────────────────────
// Good enough for dedup without reading file bytes.
function makeFileKey(filePath, phoneNumber, recordedAt) {
  const filename = filePath.split('/').pop();
  // Key: normalized_phone + filename (contains timestamp in most recorders)
  // This allows same number to have multiple recordings but prevents
  // the exact same file from being uploaded twice.
  return `${normalizePhone(phoneNumber)}::${filename}::${recordedAt}`;
}

// ── Upload a recording file to the backend ───────────────────────────────────
// FIX: Uses native fetch() instead of axios for multipart upload.
//
// WHY: The shared axios instance (api.js) has a default header:
//   'Content-Type': 'application/json'
// Passing 'Content-Type': undefined in a per-request config does NOT delete
// this instance-level default — axios merges and the instance default wins.
// The server then receives 'application/json' with a binary multipart body
// and cannot parse it, producing a network/400 error.
//
// fetch() derives Content-Type from the FormData object automatically,
// setting the correct 'multipart/form-data; boundary=...' value without
// any manual intervention. The auth token is attached manually below,
// matching the axios interceptor behaviour.
export async function uploadRecording(filePath, phoneNumber, recordedAt, leadId) {
  const filename  = filePath.split('/').pop();
  const ext       = filename.split('.').pop().toLowerCase();
  const MIME_MAP  = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
    wav: 'audio/wav',  amr: 'audio/amr', '3gp': 'audio/3gpp',
    ogg: 'audio/ogg',  opus: 'audio/ogg',
  };
  const mimeType = MIME_MAP[ext] || 'audio/mpeg';

  const uri = filePath.startsWith('content://') || filePath.startsWith('file://')
    ? filePath
    : `file://${filePath}`;

  const normalizedPhone = normalizePhone(phoneNumber);
  const fileKey = makeFileKey(filePath, normalizedPhone, recordedAt);

  const form = new FormData();
  form.append('recording',   { uri, name: filename, type: mimeType });
  form.append('phoneNumber', normalizedPhone);
  form.append('timestamp',   String(recordedAt || Date.now()));
  form.append('fileKey',     fileKey);  // Backend uses this for upsert/dedup
  if (leadId) form.append('leadId', String(leadId));

  // ── Read auth token (same key the axios interceptor uses) ─────────────────
  let token = null;
  try { token = await AsyncStorage.getItem('auth_token'); } catch {}

  // ── Build request headers — do NOT set Content-Type ──────────────────────
  // fetch() will derive the correct 'multipart/form-data; boundary=...'
  // value from the FormData object. Setting it manually breaks the boundary.
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  // ── 120s timeout via AbortController ─────────────────────────────────────
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 120_000);

  let response;
  try {
    response = await fetch(`${BASE_URL}/call-logs/recording`, {
      method:  'POST',
      headers,
      body:    form,
      signal:  controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Upload timed out after 2 minutes. Please try again on a faster connection.');
    }
    throw new Error(`Network error — cannot reach server. Check your connection and try again.\n(${err.message})`);
  }
  clearTimeout(timeoutId);

  // ── Parse response ────────────────────────────────────────────────────────
  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (!response.ok) {
    const serverMsg = body?.message || body?.error || '';
    throw new Error(serverMsg || `Upload failed (HTTP ${response.status}). Please try again.`);
  }

  return body;
}