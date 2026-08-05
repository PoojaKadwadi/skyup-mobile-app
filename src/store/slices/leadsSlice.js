// src/store/slices/leadsSlice.js
// CHANGE: fetchLeads.fulfilled now calls checkAndNotifyNewLeads() after
//         updating the store — detects newly assigned leads and fires a
//         local notification. All previous optimistic-update fixes retained.

import { createSelector, createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { getMyLeads, getLeadsDelta, updateLead, addCallRemark, addCallRemarkWithAttachments } from '../../api/leadsApi';
import { checkAndNotifyNewLeads, checkAndNotifyReassignedLeads, checkAndNotifyFollowUps } from '../../services/notificationService';

// In-flight dedup: if a fetch is already running, return the same promise
// instead of firing a second network request. This prevents the common case
// of Dashboard + LeadsScreen both mounting and both dispatching fetchLeads
// within the same tick — previously that launched two simultaneous full-list
// requests. Now the second dispatch just waits for the first to resolve.
let _fetchInFlight = null;

export const fetchLeads = createAsyncThunk(
  'leads/fetchLeads',
  async (_, { rejectWithValue }) => {
    if (_fetchInFlight) {
      try { return await _fetchInFlight; } catch { /* fall through to fresh fetch */ }
    }
    _fetchInFlight = getMyLeads();
    try {
      const result = await _fetchInFlight;
      return result;
    } catch (error) {
      return rejectWithValue(
        error.userMessage || error.response?.data?.message || 'Failed to fetch leads',
      );
    } finally {
      _fetchInFlight = null;
    }
  },
);

// Delta refresh — only downloads leads modified since lastFetchedAt.
// Used by the stale-check on screen focus so tab switches don't re-download
// the entire leads list when only 0–5 leads have changed.
// Falls back to full fetchLeads if the delta fetch fails.
export const fetchLeadsDelta = createAsyncThunk(
  'leads/fetchLeadsDelta',
  async (since, { dispatch, rejectWithValue }) => {
    try {
      const changed = await getLeadsDelta(since);
      return changed; // array of updated leads to upsert
    } catch (error) {
      // Delta failed (server error, network, etc.) — fall back to full fetch
      console.warn('[leadsSlice] Delta fetch failed, falling back to full fetch:', error.message);
      dispatch(fetchLeads());
      return rejectWithValue('delta_failed');
    }
  },
);
export const patchLead = createAsyncThunk(
  'leads/patchLead',
  async ({ id, data }, { rejectWithValue }) => {
    try {
      await updateLead(id, data);
      return { id, data };
    } catch (error) {
      return rejectWithValue(
        error.userMessage || error.response?.data?.message || 'Update failed',
      );
    }
  },
);

// Optimistic remark — adds entry to callHistory locally, no refetch
export const submitCallRemark = createAsyncThunk(
  'leads/submitCallRemark',
  async ({ leadId, remark, outcome, followUpDate, document, recording, industry }, { rejectWithValue }) => {
    try {
      await addCallRemarkWithAttachments(leadId, { remark, outcome, followUpDate, document, recording, industry });
      return {
        leadId, remark, outcome, followUpDate, industry,
        hasDocument:  !!document,
        hasRecording: !!recording,
      };
    } catch (error) {
      return rejectWithValue(
        error.userMessage || error.message || 'Remark failed',
      );
    }
  },
);

// PERF FIX: module-level throttle so checkAndNotifyFollowUps runs at most
// once per 5 minutes regardless of how many fetchLeads calls fire.
const FOLLOWUP_CHECK_THROTTLE_MS = 5 * 60 * 1000;
let _lastFollowUpCheckAt = 0;

const leadsSlice = createSlice({
  name: 'leads',
  initialState: {
    items:         [],
    loading:       false,
    error:         null,
    lastFetchedAt: null,
    searchQuery:   '',
    filterStatus:  'all',
  },
  reducers: {
    setSearchQuery:  (state, action) => { state.searchQuery  = action.payload; },
    setFilterStatus: (state, action) => { state.filterStatus = action.payload; },
    clearLeadsError: (state)         => { state.error        = null; },
    // PERF FIX: optimistic single-lead upsert used by socketService.js on
    // new_lead_assigned events — avoids re-downloading all leads.
    upsertLead: (state, action) => {
      const idx = state.items.findIndex(l => l.id === action.payload.id);
      if (idx !== -1) {
        state.items[idx] = { ...state.items[idx], ...action.payload };
      } else {
        state.items.unshift(action.payload); // new lead → prepend
      }
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchLeads.pending, (state) => {
        state.loading = true;
        state.error   = null;
      })
      .addCase(fetchLeads.fulfilled, (state, action) => {
        state.loading       = false;
        state.items         = action.payload;
        state.lastFetchedAt = Date.now();

        // ── NEW LEAD + REASSIGNMENT NOTIFICATIONS ────────────────────────────
        checkAndNotifyNewLeads(action.payload).catch(() => {});
        checkAndNotifyReassignedLeads(action.payload).catch(() => {});
        // PERF FIX: throttle follow-up check to once per 5 min — previously it
        // fired on every fetchLeads (socket events, tab focus, pull-to-refresh),
        // causing up to 20+ redundant full-array scans per hour.
        const now = Date.now();
        if (now - _lastFollowUpCheckAt > FOLLOWUP_CHECK_THROTTLE_MS) {
          _lastFollowUpCheckAt = now;
          checkAndNotifyFollowUps(action.payload).catch(() => {});
        }
      })
      .addCase(fetchLeads.rejected, (state, action) => {
        state.loading = false;
        state.error   = action.payload;
      });

    // Delta upsert — merge changed leads into existing store, preserving unseen leads
    builder.addCase(fetchLeadsDelta.fulfilled, (state, action) => {
      if (!Array.isArray(action.payload) || action.payload.length === 0) return;
      state.lastFetchedAt = Date.now();
      for (const lead of action.payload) {
        const idx = state.items.findIndex(l => l.id === lead.id);
        if (idx !== -1) {
          state.items[idx] = { ...state.items[idx], ...lead };
        } else {
          state.items.unshift(lead); // newly assigned lead
        }
      }
    });

    // Optimistic local update — no network refetch
    builder.addCase(patchLead.fulfilled, (state, action) => {
      const { id, data } = action.payload;
      const idx = state.items.findIndex(l => l.id === id);
      if (idx !== -1) state.items[idx] = { ...state.items[idx], ...data };
    });

    // Optimistic remark — add to callHistory locally so count updates instantly
    builder.addCase(submitCallRemark.fulfilled, (state, action) => {
      const { leadId, remark, outcome, followUpDate, industry, hasDocument, hasRecording } = action.payload;
      const idx = state.items.findIndex(l => l.id === leadId);
      if (idx !== -1) {
        const lead     = state.items[idx];
        const newEntry = {
          remark,
          outcome,
          calledAt:    new Date().toISOString(),
          userName:    'Agent',
          hasDocument:  hasDocument  || false,
          hasRecording: hasRecording || false,
        };
        state.items[idx] = {
          ...lead,
          remark,
          // If a follow-up date was set, surface it on the lead for UI display
          ...(followUpDate ? { followUpDate } : {}),
          ...(industry !== undefined ? { industry } : {}),
          callHistory: [...(lead.callHistory || []), newEntry],
        };
      }
    });
  },
});

export const { setSearchQuery, setFilterStatus, clearLeadsError, upsertLead } = leadsSlice.actions;

export const selectFilteredLeads = createSelector(
  (state) => state.leads.items,
  (state) => state.leads.searchQuery,
  (state) => state.leads.filterStatus,
  (items, searchQuery, filterStatus) => {
    const q = (searchQuery || '').toLowerCase();
    // FIX: also search campaign field — was missing, causing confusion when
    // users search by campaign name and get no results.
    return items.filter(lead => {
      const matchSearch =
        !q ||
        (lead.name     || '').toLowerCase().includes(q) ||
        (lead.mobile   || '').includes(q) ||
        (lead.email    || '').toLowerCase().includes(q) ||
        (lead.campaign || '').toLowerCase().includes(q);
      const matchStatus = filterStatus === 'all' || lead.status === filterStatus;
      return matchSearch && matchStatus;
    });
  },
);

// FIX: isNotContacted was imported by DashboardScreen but never defined/exported,
// causing "undefined is not a function" crash on the Dashboard screen.
// A lead is "not contacted" when it has no call history entries and no lastCalledAt.
export function isNotContacted(lead) {
  if (!lead) return false;
  const hasCallHistory = Array.isArray(lead.callHistory) && lead.callHistory.length > 0;
  return !hasCallHistory && !lead.lastCalledAt;
}

export default leadsSlice.reducer;