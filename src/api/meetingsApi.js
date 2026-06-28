// src/api/meetingsApi.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers for the "meeting remark" backend endpoints.
//
// These were previously defined privately inside ClientMeetingScreen.js. They
// are extracted here so other screens (e.g. LeadDetailScreen's "Client Meeting"
// outcome) can create a meeting on the backend without duplicating the fetch
// logic. The behaviour is identical to the original ClientMeetingScreen copy:
//   • JSON body when there's no media file.
//   • multipart/form-data when a media file is attached (backend multer routes
//     audio → "recording", everything else → "document").
//   • Bearer token pulled from AsyncStorage('auth_token').
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import { BASE_URL } from '../config/config';

async function getAuthToken() {
  try { return await AsyncStorage.getItem('auth_token'); } catch { return null; }
}

// Create a meeting remark for a lead.
//   leadId   – string
//   payload  – { meetingType, outcome, remark, location, followUpDate }
//   mediaFile – optional { uri, name, type } (image/doc/audio)
export async function postMeetingRemark(leadId, payload, mediaFile) {
  const token = await getAuthToken();

  if (mediaFile?.uri) {
    const form = new FormData();
    Object.entries(payload).forEach(([k, v]) => {
      if (v !== null && v !== undefined) form.append(k, String(v));
    });
    const field = (mediaFile.type || '').startsWith('audio') ? 'recording' : 'document';
    form.append(field, {
      uri:  mediaFile.uri,
      name: mediaFile.name || 'upload',
      type: mediaFile.type || 'application/octet-stream',
    });
    const res = await fetch(`${BASE_URL}/lead/${leadId}/meeting-remark`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        // Do NOT set Content-Type — RN sets the multipart boundary itself.
      },
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.message || `HTTP ${res.status}`);
    return body;
  }

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res  = await fetch(`${BASE_URL}/lead/${leadId}/meeting-remark`, {
    method: 'POST', headers, body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message || `HTTP ${res.status}`);
  return body;
}

// Fetch a lead's meeting remarks (returns [] on any failure).
export async function fetchMeetingRemarks(leadId) {
  const token = await getAuthToken();
  const headers = {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(`${BASE_URL}/lead/${leadId}/meeting-remarks`, { headers });
  if (!res.ok) return [];
  const body = await res.json().catch(() => ({}));
  return Array.isArray(body.meetingRemarks) ? body.meetingRemarks : [];
}

export default { postMeetingRemark, fetchMeetingRemarks };