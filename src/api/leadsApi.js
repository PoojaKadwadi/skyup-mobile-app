// src/api/leadsApi.js
// ─────────────────────────────────────────────────────────────────────────────
//  LEADS API
//
//  FIX (this revision) — formatLead callHistory sort removed:
//    The old code sorted the entire callHistory array on every formatLead()
//    call to find the most recent entry:
//      [...callHistory].sort((a,b) => new Date(b.calledAt) - new Date(a.calledAt))[0]
//    With 200 leads × 10 call history entries, this was ~2,000 new Date()
//    calls + array copies on every fetchLeads(). Now we just take the last
//    element — the backend always appends entries with `calledAt: new Date()`
//    so the last entry in the array is always the most recent.
//
//  All previous fixes retained:
//    • getMyLeads simplified — backend returns { leads, total, page, pages }.
//    • addCallRemark does not send calledAt.
//    • followUpDate included in formatLead output.
// ─────────────────────────────────────────────────────────────────────────────

import apiClient from './apiClient';

// ─── Read ─────────────────────────────────────────────────────────────────────

export const getMyLeads = async () => {
  const firstPage = await apiClient.get('/lead/my-leads?page=1&limit=200');
  const { leads: firstLeads, pages } = firstPage.data;

  // Single page — the common case, return immediately
  if (!pages || pages <= 1) {
    return firstLeads.map(formatLead);
  }

  // More than 200 leads: fetch remaining pages in parallel
  const remaining = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) =>
      apiClient
        .get(`/lead/my-leads?page=${i + 2}&limit=200`)
        .then(r => r.data.leads || [])
    )
  );

  const allLeads = [firstLeads, ...remaining].flat();
  return allLeads.map(formatLead);
};

export const getLeadById = async (id) => {
  const response = await apiClient.get(`/lead/${id}`);
  return formatLead(response.data);
};

// ─── Update ───────────────────────────────────────────────────────────────────

export const updateLead = async (id, data) => {
  const response = await apiClient.patch(`/lead/${id}`, data);
  return response.data;
};

// ── Mark a lead Invalid (two-step verification flow) ──────────────────────────
// First Invalid  → backend reassigns to another agent for verification.
// Verifier confirms Invalid → backend closes the lead and removes it from all
//   employee panels (it then lives only in the admin "Closed Leads" view).
// Verifier rejects (reject:true) → lead returns to the original employee.
export const markLeadInvalid = async (leadId, { remark, reject = false } = {}) => {
  const response = await apiClient.patch(`/lead/${leadId}/invalid`, { remark, reject });
  return response.data;
};

// ── AI Action Summary ─────────────────────────────────────────────────────────
// Returns { summary, nextAction, keyPoints[], sentiment, suggestedTemp, basedOn,
//   generatedAt, model, cached }. Pass refresh=true to force regeneration.
export const getLeadActionSummary = async (leadId, { refresh = false } = {}) => {
  const response = await apiClient.get(
    `/lead/${leadId}/action-summary${refresh ? '?refresh=1' : ''}`,
  );
  return response.data;
};

export const addCallRemark = async (leadId, { remark, outcome, followUpDate }) => {
  const payload = { remark, outcome };
  if (followUpDate) payload.followUpDate = followUpDate;
  const response = await apiClient.patch(`/lead/${leadId}`, payload);
  return response.data;
};

// ── Add remark with optional file attachments (doc + recording) ───────────────
// Uses native fetch() — NOT the shared axios instance — because axios bleeds
// its 'Content-Type: application/json' default into multipart requests,
// breaking the boundary string and causing a server-side parse failure.
// fetch() derives Content-Type + boundary from the FormData automatically.
export const addCallRemarkWithAttachments = async (
  leadId,
  { remark, outcome, followUpDate, document, recording },
) => {
  // If neither attachment is provided, fall back to the plain JSON patch
  if (!document && !recording) {
    return addCallRemark(leadId, { remark, outcome, followUpDate });
  }

  const { BASE_URL } = require('../config/config');
  const AsyncStorage = require('@react-native-async-storage/async-storage').default;

  const MIME_MAP = {
    // Documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    // Audio
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
    wav: 'audio/wav',  amr: 'audio/amr', '3gp': 'audio/3gpp',
    ogg: 'audio/ogg',  opus: 'audio/ogg',
  };

  const toUri = (path) =>
    path.startsWith('content://') || path.startsWith('file://') ? path : `file://${path}`;

  const mimeFor = (path) => {
    const ext = (path.split('.').pop() || '').toLowerCase();
    return MIME_MAP[ext] || 'application/octet-stream';
  };

  const form = new FormData();
  form.append('remark',  remark);
  form.append('outcome', outcome);
  if (followUpDate) form.append('followUpDate', followUpDate);

  if (document) {
    const name = document.name || document.uri.split('/').pop();
    form.append('document', {
      uri:  toUri(document.uri),
      name,
      type: document.type || mimeFor(document.uri),
    });
  }

  if (recording) {
    const name = recording.name || recording.uri.split('/').pop();
    form.append('recording', {
      uri:  toUri(recording.uri),
      name,
      type: recording.type || mimeFor(recording.uri),
    });
  }

  let token = null;
  try { token = await AsyncStorage.getItem('auth_token'); } catch {}

  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 120_000);

  let response;
  try {
    response = await fetch(`${BASE_URL}/lead/${leadId}/remark`, {
      method:  'POST',
      headers,
      body:    form,
      signal:  controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError')
      throw new Error('Upload timed out. Please try on a faster connection.');
    throw new Error(`Network error — check your connection.\n(${err.message})`);
  }
  clearTimeout(timeoutId);

  let body;
  try { body = await response.json(); } catch { body = {}; }

  if (!response.ok) {
    const msg = body?.message || body?.error || '';
    throw new Error(msg || `Upload failed (HTTP ${response.status}). Please try again.`);
  }

  return body;
};

// ─── Format helper ────────────────────────────────────────────────────────────
function formatLead(lead) {
  const callHistory = Array.isArray(lead.callHistory) ? lead.callHistory : [];

  // FIX: Use last array entry instead of sorting the entire array.
  // The backend always appends with calledAt: new Date() so the last element
  // is always the most recent. Sorting was O(n log n) with new Date() calls
  // on every entry — for 200 leads this was thousands of allocations per fetch.
  const lastCall = callHistory.length > 0
    ? callHistory[callHistory.length - 1]
    : null;

  // Decide which remark to SHOW and whether it's a manual agent remark or the
  // original lead-source (form/ad) remark, so the UI can mark them differently.
  //   • If the latest call-history entry has a remark, that's an agent-typed
  //     (manual) remark → prefer it and flag it manual.
  //   • Otherwise fall back to lead.remark, which is the source/form remark.
  const lastManualRemark = lastCall && lastCall.remark ? String(lastCall.remark).trim() : '';
  const sourceRemark     = lead.remark ? String(lead.remark).trim() : '';
  const displayRemark    = lastManualRemark || sourceRemark;
  const remarkIsManual   = !!lastManualRemark;

  return {
    id:             String(lead._id),
    name:           lead.name           || 'Unknown',
    // `mobile` stays the canonical/primary number for backward compatibility.
    // Prefer the explicit primaryPhone when present, else fall back to mobile/phone.
    mobile:         lead.primaryPhone   || lead.mobile || lead.phone || '',
    primaryPhone:   lead.primaryPhone   || lead.mobile || lead.phone || '',
    secondaryPhone: lead.secondaryPhone || '',
    email:          lead.email          || '',
    source:         lead.source         || 'Web Form',
    campaign:       lead.campaign       || '—',
    status:         lead.status         || 'New',
    date:           lead.date,
    _raw_date:      lead.date           || lead.createdAt || null,
    remark:         displayRemark,
    remarkIsManual,
    followUpDate:   lead.followUpDate   || null,
    temperature:    lead.temperature    || lead.Quality || null,
    Quality:        lead.temperature    || lead.Quality || null,
    agent:          lead.user?.name     || 'Unknown',
    company:        lead.company,
    callHistory,
    scheduledCalls: Array.isArray(lead.scheduledCalls) ? lead.scheduledCalls : [],
    reassignCount:  lead.reassignCount  || 0,
    invalidStage:   lead.invalidStage   || null,
    isClosed:       lead.isClosed        || false,
    lastOutcome:    lastCall?.outcome   || null,
    lastCalledAt:   lastCall?.calledAt  || null,
  };
}