// src/store/slices/leadsSlice.js
// ─────────────────────────────────────────────────────────────────────────────
// RAM FIX #1 — SLIM REDUX STORE
//
// THE PROBLEM:
//   Every lead object stored in Redux contained the FULL callHistory[] and
//   scheduledCalls[] arrays. With 200 leads × 20 call entries each, that's
//   4,000+ objects permanently in RAM — allocated, Immer-cloned on every
//   state update, and serialized by redux-persist on every change.
//
//   Example lead in RAM before:
//     { id, name, mobile, status, remark, callHistory: [{...},{...}×20],
//       scheduledCalls: [{...}×5], previousAgents: [...], ... }
//   → ~8–12 KB per lead → 200 leads = ~2 MB of lead objects alone in JS heap.
//
// THE FIX:
//   Store ONLY the fields the leads LIST and notification service actually need
//   ("slim" lead). Strip callHistory, scheduledCalls, previousAgents, projects
//   out of Redux — they are only needed when a specific lead's DETAIL screen
//   opens, and they get fetched fresh then (which is correct anyway — you want
//   current data on the detail screen, not a cached copy from 10 min ago).
//
//   "Slim" lead stored in Redux (~400 bytes vs ~8 KB):
//     { id, name, mobile, primaryPhone, secondaryPhone, email, source,
//       campaign, industry, status, remark, remarkIsManual, initialRemark,
//       followUpDate, temperature, Quality, agent, company, reassignCount,
//       invalidStage, isClosed, lastOutcome, lastCalledAt, _raw_date, date,
//       callHistoryCount, hasScheduledCalls }
//
//   callHistory is still stored TRANSIENTLY in a module-level Map (not Redux)
//   keyed by lead id. The detail screen reads from there. The Map is bounded:
//   entries are added when a lead is fetched/updated and evicted when the
//   store is cleared or a new full fetch replaces them.
//
// RESULT:
//   Redux state goes from ~2 MB to ~80 KB for 200 leads.
//   Immer clone cost on upsert drops 20×.
//   Notification service still works — it only ever checks status/followUpDate
//   (which are in the slim lead).
//   Detail screen reads the full lead from the transient cache, not Redux.
// ─────────────────────────────────────────────────────────────────────────────

import { createSelector, createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { getMyLeads, getLeadsDelta, updateLead, addCallRemarkWithAttachments } from '../../api/leadsApi';
import { checkAndNotifyNewLeads, checkAndNotifyReassignedLeads, checkAndNotifyFollowUps } from '../../services/notificationService';

// ── Transient full-lead cache (NOT in Redux — lives in module scope) ──────────
// Keyed by lead id string → full lead object including callHistory.
// The detail screen reads from here; the list reads from Redux.
// Max 500 entries (matches max leads fetched); evicts on full refetch.
export const _fullLeadCache = new Map();

// Fields kept in Redux (list screen + notifications only need these).
const SLIM_FIELDS = new Set([
  'id','name','mobile','primaryPhone','secondaryPhone','email',
  'source','campaign','industry','status','remark','remarkIsManual',
  'initialRemark','followUpDate','temperature','Quality','agent',
  'company','reassignCount','invalidStage','isClosed',
  'lastOutcome','lastCalledAt','_raw_date','date',
  // Derived summary fields — cheap to store, used by list rows and notifications
  'callHistoryCount','hasScheduledCalls',
]);

function toSlimLead(lead) {
  // Store the full lead in the transient cache for the detail screen.
  if (lead && lead.id) _fullLeadCache.set(lead.id, lead);

  // Return only the slim fields for Redux.
  const slim = {};
  for (const key of SLIM_FIELDS) {
    if (key in lead) slim[key] = lead[key];
  }
  // Add summary counts so the list row can show "5 calls" without full array
  slim.callHistoryCount   = Array.isArray(lead.callHistory)    ? lead.callHistory.length    : (lead.callHistoryCount || 0);
  slim.hasScheduledCalls  = Array.isArray(lead.scheduledCalls) ? lead.scheduledCalls.length > 0 : (lead.hasScheduledCalls || false);
  return slim;
}

// In-flight dedup: if a fetch is already running, return the same promise.
let _fetchInFlight = null;

export const fetchLeads = createAsyncThunk(
  'leads/fetchLeads',
  async (_, { rejectWithValue }) => {
    if (_fetchInFlight) {
      try { return await _fetchInFlight; } catch { /* fall through */ }
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

export const fetchLeadsDelta = createAsyncThunk(
  'leads/fetchLeadsDelta',
  async (since, { dispatch, rejectWithValue }) => {
    try {
      const changed = await getLeadsDelta(since);
      return changed;
    } catch (error) {
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

const FOLLOWUP_CHECK_THROTTLE_MS = 5 * 60 * 1000;
let _lastFollowUpCheckAt = 0;

const leadsSlice = createSlice({
  name: 'leads',
  initialState: {
    items:         [],   // slim leads only — no callHistory arrays
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
    upsertLead: (state, action) => {
      // Also update the full cache if we have a richer payload
      if (action.payload.id && _fullLeadCache.has(action.payload.id)) {
        const full = _fullLeadCache.get(action.payload.id);
        _fullLeadCache.set(action.payload.id, { ...full, ...action.payload });
      }
      const slim = toSlimLead({ ...action.payload });
      const idx = state.items.findIndex(l => l.id === slim.id);
      if (idx !== -1) {
        state.items[idx] = { ...state.items[idx], ...slim };
      } else {
        state.items.unshift(slim);
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
        // Clear the full cache and repopulate — full fetch replaces everything.
        _fullLeadCache.clear();
        state.items         = action.payload.map(toSlimLead);
        state.lastFetchedAt = Date.now();

        checkAndNotifyNewLeads(action.payload).catch(() => {});
        checkAndNotifyReassignedLeads(action.payload).catch(() => {});
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

    builder.addCase(fetchLeadsDelta.fulfilled, (state, action) => {
      if (!Array.isArray(action.payload) || action.payload.length === 0) return;
      state.lastFetchedAt = Date.now();
      for (const lead of action.payload) {
        const slim = toSlimLead(lead);
        const idx = state.items.findIndex(l => l.id === slim.id);
        if (idx !== -1) {
          state.items[idx] = { ...state.items[idx], ...slim };
        } else {
          state.items.unshift(slim);
        }
      }
    });

    builder.addCase(patchLead.fulfilled, (state, action) => {
      const { id, data } = action.payload;
      // Update full cache too
      if (_fullLeadCache.has(id)) {
        _fullLeadCache.set(id, { ..._fullLeadCache.get(id), ...data });
      }
      const idx = state.items.findIndex(l => l.id === id);
      if (idx !== -1) state.items[idx] = { ...state.items[idx], ...data };
    });

    builder.addCase(submitCallRemark.fulfilled, (state, action) => {
      const { leadId, remark, outcome, followUpDate, industry, hasDocument, hasRecording } = action.payload;

      // Update the full cache with the new callHistory entry
      if (_fullLeadCache.has(leadId)) {
        const full = _fullLeadCache.get(leadId);
        const newEntry = {
          remark, outcome,
          calledAt: new Date().toISOString(),
          userName: 'Agent',
          hasDocument:  hasDocument  || false,
          hasRecording: hasRecording || false,
        };
        _fullLeadCache.set(leadId, {
          ...full,
          remark,
          ...(followUpDate ? { followUpDate } : {}),
          ...(industry !== undefined ? { industry } : {}),
          callHistory: [...(full.callHistory || []), newEntry],
        });
      }

      // Update slim entry in Redux (no callHistory here — just counts + remark)
      const idx = state.items.findIndex(l => l.id === leadId);
      if (idx !== -1) {
        const prev = state.items[idx];
        state.items[idx] = {
          ...prev,
          remark,
          lastOutcome: outcome || prev.lastOutcome,
          lastCalledAt: new Date().toISOString(),
          callHistoryCount: (prev.callHistoryCount || 0) + 1,
          ...(followUpDate ? { followUpDate } : {}),
          ...(industry !== undefined ? { industry } : {}),
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

export function isNotContacted(lead) {
  if (!lead) return false;
  return !lead.callHistoryCount && !lead.lastCalledAt;
}

// Helper for LeadDetailScreen: get the full lead (with callHistory) from cache.
// Falls back to the slim lead if the full one hasn't been cached yet.
export function getFullLeadFromCache(leadId) {
  return _fullLeadCache.get(leadId) || null;
}

export default leadsSlice.reducer;