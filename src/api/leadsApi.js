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

// Render's free tier sleeps after inactivity and cold-starts in 30–60s. The
// FIRST leads fetch after the app has been idle is the slowest thing the user
// sees ("page speed issue"). Give the first page a long, cold-start-tolerant
// timeout and one automatic retry so a sleeping backend doesn't surface as a
// timeout error the user has to pull-to-refresh past. Subsequent pages use the
// default timeout (by then the backend is already awake).
const COLD_START_TIMEOUT = 60000; // 60s — long enough to outlast a full cold start

export const getMyLeads = async() => {
    let firstPage;
    try {
        firstPage = await apiClient.get('/lead/my-leads?page=1&limit=200', {
            timeout: COLD_START_TIMEOUT,
        });
    } catch (err) {
        // One retry: a timeout/network error here is almost always the backend
        // still waking. The first request usually warms it, so the retry lands.
        const aborted = err.code === 'ECONNABORTED' || !err.response;
        if (!aborted) throw err;
        firstPage = await apiClient.get('/lead/my-leads?page=1&limit=200', {
            timeout: COLD_START_TIMEOUT,
        });
    }
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

export const getLeadById = async(id) => {
    const response = await apiClient.get(`/lead/${id}`);
    return formatLead(response.data);
};

// ─── Update ───────────────────────────────────────────────────────────────────

export const updateLead = async(id, data) => {
    const response = await apiClient.patch(`/lead/${id}`, data);
    return response.data;
};

// ── Mark a lead Invalid (two-step verification flow) ──────────────────────────
// First Invalid  → backend reassigns to another agent for verification.
// Verifier confirms Invalid → backend closes the lead and removes it from all
//   employee panels (it then lives only in the admin "Closed Leads" view).
// Verifier rejects (reject:true) → lead returns to the original employee.
export const markLeadInvalid = async(leadId, { remark, reject = false } = {}) => {
    const response = await apiClient.patch(`/lead/${leadId}/invalid`, { remark, reject });
    return response.data;
};

// ── Mark a lead Not Interested (two-step verification / reassign flow) ─────────
// Mirrors the Invalid flow and the website's /not-interested endpoint.
// First Not Interested → backend reassigns to another agent for verification
//   (lead.status becomes "Verification") and schedules follow-up calls.
// A remark/reason is REQUIRED by the backend (400 otherwise).
// Response includes { message, outcome, reassignedTo? } when a verifier was found.
export const markNotInterested = async(leadId, { remark } = {}) => {
    const response = await apiClient.patch(`/lead/${leadId}/not-interested`, { remark });
    return response.data;
};

// ── AI Action Summary ─────────────────────────────────────────────────────────
// Returns { summary, nextAction, keyPoints[], sentiment, suggestedTemp, basedOn,
//   generatedAt, model, cached }. Pass refresh=true to force regeneration.
export const getLeadActionSummary = async(leadId, { refresh = false } = {}) => {
    const response = await apiClient.get(
        `/lead/${leadId}/action-summary${refresh ? '?refresh=1' : ''}`,
    );
    return response.data;
};

export const addCallRemark = async(leadId, { remark, outcome, followUpDate, industry }) => {
    const payload = { remark, outcome };
    if (followUpDate) payload.followUpDate = followUpDate;
    if (industry !== undefined) payload.industry = industry;
    const response = await apiClient.patch(`/lead/${leadId}`, payload);
    return response.data;
};

// ── Add remark with optional file attachments (doc + recording) ───────────────
// Uses native fetch() — NOT the shared axios instance — because axios bleeds
// its 'Content-Type: application/json' default into multipart requests,
// breaking the boundary string and causing a server-side parse failure.
// fetch() derives Content-Type + boundary from the FormData automatically.
export const addCallRemarkWithAttachments = async(
    leadId, { remark, outcome, followUpDate, document, recording, industry },
) => {
    // If neither attachment is provided, fall back to the plain JSON patch
    if (!document && !recording) {
        return addCallRemark(leadId, { remark, outcome, followUpDate, industry });
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
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        // Audio
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        aac: 'audio/aac',
        wav: 'audio/wav',
        amr: 'audio/amr',
        '3gp': 'audio/3gpp',
        ogg: 'audio/ogg',
        opus: 'audio/ogg',
    };

    const toUri = (path) =>
        path.startsWith('content://') || path.startsWith('file://') ? path : `file://${path}`;

    const mimeFor = (path) => {
        const ext = (path.split('.').pop() || '').toLowerCase();
        return MIME_MAP[ext] || 'application/octet-stream';
    };

    const form = new FormData();
    form.append('remark', remark);
    form.append('outcome', outcome);
    if (followUpDate) form.append('followUpDate', followUpDate);
    if (industry !== undefined) form.append('industry', industry);

    if (document) {
        const name = document.name || document.uri.split('/').pop();
        form.append('document', {
            uri: toUri(document.uri),
            name,
            type: document.type || mimeFor(document.uri),
        });
    }

    if (recording) {
        const name = recording.name || recording.uri.split('/').pop();
        form.append('recording', {
            uri: toUri(recording.uri),
            name,
            type: recording.type || mimeFor(recording.uri),
        });
    }

    let token = null;
    try { token = await AsyncStorage.getItem('auth_token'); } catch {}

    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    let response;
    try {
        response = await fetch(`${BASE_URL}/lead/${leadId}/remark`, {
            method: 'POST',
            headers,
            body: form,
            signal: controller.signal,
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
        const msg = (body && body.message) || (body && body.error) || '';
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
    const lastCall = callHistory.length > 0 ?
        callHistory[callHistory.length - 1] :
        null;

    // Decide which remark to SHOW and whether it's a manual agent remark or the
    // original lead-source (form/ad) remark, so the UI can mark them differently.
    //   • If the LATEST GENUINE agent-typed call-history entry has a remark,
    //     prefer it and flag it manual.
    //   • Otherwise fall back to lead.remark, which is the source/form remark.
    //
    // FIX: the previous code took `callHistory[last].remark` unconditionally,
    // but the last entry is usually an AUTO-LOGGED dialer entry (created the
    // instant the agent taps Call) whose remark is the boilerplate
    // "Outgoing/Incoming Call from mobile app". That made the leads list AND the
    // Lead Detail "Last Remark" row show a call log instead of the real remark.
    // Walk backwards to the newest entry that has a remark, is NOT a synced call
    // log (no callType/duration/timestamp), and is NOT that boilerplate text.
    const isCallLogEntry = h =>
        !h ||
        h.callType != null ||
        h.duration != null ||
        h.timestamp != null ||
        (typeof h.remark === 'string' && /call from mobile app/i.test(h.remark));
    let lastManualRemark = '';
    for (let i = callHistory.length - 1; i >= 0; i--) {
        const h = callHistory[i];
        if (h && h.remark && String(h.remark).trim() !== '' && !isCallLogEntry(h)) {
            lastManualRemark = String(h.remark).trim();
            break;
        }
    }
    const sourceRemark = lead.remark ? String(lead.remark).trim() : '';
    const displayRemark = lastManualRemark || sourceRemark;
    const remarkIsManual = !!lastManualRemark;

    // INITIAL REMARK (campaign / lead-source remark). The backend now stores the
    // creation-time remark in `initialRemark` (set once, never overwritten). For
    // leads created before that field existed we fall back to `lead.remark` ONLY
    // when there is no call history yet — in that case the top-level remark is
    // still the original campaign remark (it only gets overwritten once an agent
    // adds a call/meeting remark). For already-worked legacy leads the original
    // campaign remark is unrecoverable, so we leave it blank rather than showing a
    // later remark mislabelled as the initial one.
    const initialRemark = (lead.initialRemark && String(lead.initialRemark).trim())
      || (callHistory.length === 0 ? sourceRemark : '');

    return {
        id: String(lead._id),
        name: lead.name || 'Unknown',
        // `mobile` stays the canonical/primary number for backward compatibility.
        // Prefer the explicit primaryPhone when present, else fall back to mobile/phone.
        mobile: lead.primaryPhone || lead.mobile || lead.phone || '',
        primaryPhone: lead.primaryPhone || lead.mobile || lead.phone || '',
        secondaryPhone: lead.secondaryPhone || '',
        email: lead.email || '',
        source: lead.source || 'Web Form',
        campaign: lead.campaign || '—',
        industry: lead.industry || '',
        status: lead.status || 'New',
        date: lead.date,
        // FIX (Leads list ordering): previously this was just lead.date — the
        // ORIGINAL creation date, which never changes. A lead reassigned to
        // this agent today, or one an agent just called, still had a
        // months-old `date` and sank to the bottom of "Newest first" even
        // though it's genuinely the most relevant lead to look at right now.
        // Now it's the most recent of: creation date, or the last logged
        // call/remark — whichever is later — so recently-active leads
        // actually surface first, not just recently-created ones.
        _raw_date: (() => {
            const created = lead.date ? new Date(lead.date).getTime() : 0;
            const lastCalledAt = lastCall?.calledAt ? new Date(lastCall.calledAt).getTime() : 0;
            const mostRecent = Math.max(created, lastCalledAt);
            return mostRecent > 0 ? new Date(mostRecent) : (lead.date || null);
        })(),
        remark: displayRemark,
        remarkIsManual,
        initialRemark,
        followUpDate: lead.followUpDate || null,
        temperature: lead.temperature || lead.Quality || null,
        Quality: lead.temperature || lead.Quality || null,
        agent: (lead.user && lead.user.name) || 'Unknown',
        company: lead.company,
        callHistory,
        scheduledCalls: Array.isArray(lead.scheduledCalls) ? lead.scheduledCalls : [],
        reassignCount: lead.reassignCount || 0,
        invalidStage: lead.invalidStage || null,
        isClosed: lead.isClosed || false,
        lastOutcome: (lastCall && lastCall.outcome) || null,
        lastCalledAt: (lastCall && lastCall.calledAt) || null,
    };
}