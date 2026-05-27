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

export const addCallRemark = async (leadId, { remark, outcome, followUpDate }) => {
  const payload = { remark, outcome };
  if (followUpDate) payload.followUpDate = followUpDate;
  const response = await apiClient.patch(`/lead/${leadId}`, payload);
  return response.data;
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

  return {
    id:             String(lead._id),
    name:           lead.name           || 'Unknown',
    mobile:         lead.mobile         || lead.phone || '',
    email:          lead.email          || '',
    source:         lead.source         || 'Web Form',
    campaign:       lead.campaign       || '—',
    status:         lead.status         || 'New',
    date:           lead.date,
    _raw_date:      lead.date           || lead.createdAt || null,
    remark:         lead.remark         || '',
    followUpDate:   lead.followUpDate   || null,
    temperature:    lead.temperature    || lead.Quality || null,
    Quality:        lead.temperature    || lead.Quality || null,
    agent:          lead.user?.name     || 'Unknown',
    company:        lead.company,
    callHistory,
    scheduledCalls: Array.isArray(lead.scheduledCalls) ? lead.scheduledCalls : [],
    reassignCount:  lead.reassignCount  || 0,
    lastOutcome:    lastCall?.outcome   || null,
    lastCalledAt:   lastCall?.calledAt  || null,
  };
}