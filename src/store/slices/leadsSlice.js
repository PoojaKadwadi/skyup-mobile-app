// src/store/slices/leadsSlice.js
// CHANGE: fetchLeads.fulfilled now calls checkAndNotifyNewLeads() after
//         updating the store — detects newly assigned leads and fires a
//         local notification. All previous optimistic-update fixes retained.

import { createSelector, createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { getMyLeads, updateLead, addCallRemark } from '../../api/leadsApi';
import { checkAndNotifyNewLeads, checkAndNotifyReassignedLeads, checkAndNotifyFollowUps } from '../../services/notificationService';

export const fetchLeads = createAsyncThunk(
  'leads/fetchLeads',
  async (_, { rejectWithValue }) => {
    try {
      return await getMyLeads();
    } catch (error) {
      return rejectWithValue(
        error.userMessage || error.response?.data?.message || 'Failed to fetch leads',
      );
    }
  },
);

// Optimistic patch — updates local store instantly, no refetch
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
  async ({ leadId, remark, outcome, followUpDate }, { rejectWithValue }) => {
    try {
      await addCallRemark(leadId, { remark, outcome, followUpDate });
      return { leadId, remark, outcome, followUpDate };
    } catch (error) {
      return rejectWithValue(
        error.userMessage || error.response?.data?.message || 'Remark failed',
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

    // Optimistic local update — no network refetch
    builder.addCase(patchLead.fulfilled, (state, action) => {
      const { id, data } = action.payload;
      const idx = state.items.findIndex(l => l.id === id);
      if (idx !== -1) state.items[idx] = { ...state.items[idx], ...data };
    });

    // Optimistic remark — add to callHistory locally so count updates instantly
    builder.addCase(submitCallRemark.fulfilled, (state, action) => {
      const { leadId, remark, outcome, followUpDate } = action.payload;
      const idx = state.items.findIndex(l => l.id === leadId);
      if (idx !== -1) {
        const lead     = state.items[idx];
        const newEntry = {
          remark,
          outcome,
          calledAt: new Date().toISOString(),
          userName: 'Agent',
        };
        state.items[idx] = {
          ...lead,
          remark,
          // If a follow-up date was set, surface it on the lead for UI display
          ...(followUpDate ? { followUpDate } : {}),
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

export default leadsSlice.reducer;