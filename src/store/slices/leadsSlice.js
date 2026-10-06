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
import AsyncStorage from '@react-native-async-storage/async-storage';
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
  'source','campaign','industry','service','status','remark','remarkIsManual','lastManualRemarkAt',
  'initialRemark','followUpDate','temperature','Quality','agent',
  'company','reassignCount','invalidStage','isClosed',
  'lastOutcome','lastCalledAt','_raw_date','date',
  // Derived summary fields — cheap to store, used by list rows and notifications
  'callHistoryCount','hasScheduledCalls','pendingScheduledCalls',
]);

function toSlimLead(lead, { populateCache = true } = {}) {
  // Store the full lead in the transient cache for the detail screen.
  //
  // FIX — do NOT do this unconditionally. toSlimLead() is called from two
  // very different contexts:
  //   1. fetchLeads.fulfilled — `lead` is the FULL raw lead from the server.
  //      Populating the cache here is correct and necessary.
  //   2. The `upsertLead` reducer — `lead` is often a tiny PATCH object like
  //      {id, status} or {id, temperature, Quality} (e.g. an optimistic
  //      status/temperature update fired right before a call remark saves).
  //      That reducer ALREADY merges this patch into the cache correctly
  //      itself, just before calling toSlimLead() to compute the slim Redux
  //      view. This line used to run AFTERWARD and unconditionally overwrite
  //      the cache with the bare patch object — silently destroying mobile,
  //      email, source, date, and every other field the correct merge had
  //      just preserved. Symptom: after adding a call remark (which also
  //      fires an optimistic status update), the lead detail screen showed
  //      the new remark and status correctly, but Primary Phone, Email,
  //      Source, and Date all went blank — because the "full" cache had been
  //      reduced to just {id, status}.
  //  `populateCache: false` is passed by the upsertLead reducer specifically
  //  to skip this, since it already owns the correct cache merge.
  if (populateCache && lead && lead.id) _fullLeadCache.set(lead.id, lead);

  // Return only the slim fields for Redux.
  const slim = {};
  for (const key of SLIM_FIELDS) {
    if (key in lead) slim[key] = lead[key];
  }
  // Add summary counts so the list row can show "5 calls" without full array
  slim.callHistoryCount   = Array.isArray(lead.callHistory)    ? lead.callHistory.length    : (lead.callHistoryCount || 0);
  slim.hasScheduledCalls  = Array.isArray(lead.scheduledCalls) ? lead.scheduledCalls.length > 0 : (lead.hasScheduledCalls || false);

  // ── FIX: keep a minimal projection of PENDING scheduled calls ──────────────
  // scheduledCalls was stripped entirely to save RAM, but
  // services/notificationService.js checkAndNotifyFollowUps() reads
  // lead.scheduledCalls to build its reminder candidates. That worked when
  // called from fetchLeads.fulfilled (which passes the raw full leads), but
  // backgroundSyncService.js passes state.leads.items — the SLIM leads — so
  // the background follow-up check found no candidates at all and silently
  // never fired a single reminder. (The other candidate source,
  // lead.followUpDate, is always undefined: it is not a top-level field on
  // the backend Lead schema, only a field inside meetingRemarks.)
  //
  // Keeping only NOT-done entries, with only the 3 fields notifications
  // actually use, preserves the RAM win — a lead normally has 0–2 pending
  // follow-ups, vs the full array of every call ever scheduled.
  slim.pendingScheduledCalls = Array.isArray(lead.scheduledCalls)
    ? lead.scheduledCalls
        .filter(sc => sc && !sc.done && sc.scheduledAt)
        .map(sc => ({ scheduledAt: sc.scheduledAt, type: sc.type, note: sc.note }))
    : (Array.isArray(lead.pendingScheduledCalls) ? lead.pendingScheduledCalls : []);

  return slim;
}

// ── One row per lead id ─────────────────────────────────────────────────────
// FIX ("same lead shown twice in My Leads"): fetchLeadsDelta used to unshift
// new leads INSIDE its loop without updating byId. Every unshift shifts all
// indices by one, so for the next changed lead in the same delta, byId pointed
// at the WRONG row — its data was merged over a neighbouring lead. Result: two
// rows with the same id (the card shown twice) and the overwritten lead gone.
// The broken list was then saved to the AsyncStorage cache, so it survived
// restarts. Every path that builds the list now goes through this helper.
let _cacheHadDuplicates = false;
function dedupeAndIndex(state) {
  const seen = new Set();
  const before = state.items.length;
  state.items = state.items.filter(l => {
    const k = String(l?.id ?? '');
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  state.byId = {};
  state.items.forEach((l, i) => { state.byId[l.id] = i; });
  return before - state.items.length;
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
      _lastFullAt = Date.now();
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

// ── Local leads cache (per user) ──────────────────────────────────────────────
// Leads are saved on the phone after every fetch, so re-opening the app shows
// them instantly and only the CHANGES are downloaded (delta), instead of the
// whole list every time. Cleared on logout.
const LEADS_CACHE_PREFIX = 'leads_cache_v1_';
const FULL_REFRESH_MS    = 6 * 60 * 60 * 1000; // safety full refresh every 6 h
const CACHE_MAX_CHARS    = 1500000;            // Android AsyncStorage row limit safety
let _saveTimer = null;
let _lastFullAt = 0;

function _cacheKey(state) {
  const u = state?.auth?.user;
  const id = u?._id || u?.id || u?.userId;
  return id ? `${LEADS_CACHE_PREFIX}${id}` : null;
}

export function scheduleLeadsCacheSave(getState) {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try {
      const st  = getState();
      const key = _cacheKey(st);
      const { items, lastFetchedAt } = st.leads || {};
      if (!key || !lastFetchedAt || !Array.isArray(items)) return;
      const json = JSON.stringify({ v: 1, items, lastFetchedAt, lastFullAt: _lastFullAt });
      if (json.length > CACHE_MAX_CHARS) { await AsyncStorage.removeItem(key); return; }
      await AsyncStorage.setItem(key, json);
    } catch { /* cache is best-effort */ }
  }, 2500);
}

export async function clearLeadsCache() {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter(k => k.startsWith(LEADS_CACHE_PREFIX));
    if (mine.length) await AsyncStorage.multiRemove(mine);
  } catch { /* ignore */ }
  _lastFullAt = 0;
}

/**
 * The ONE way screens should load leads:
 *   • first time ever (no cache)  → full download
 *   • otherwise                   → show cached leads instantly, then fetch only changes
 *   • force / every 6 h           → full download (safety net)
 */
export const loadLeadsSmart = createAsyncThunk(
  'leads/loadLeadsSmart',
  async ({ force = false } = {}, { getState, dispatch }) => {
    // Several screens/services may ask at once — share one request.
    if (_smartInFlight && !force) return _smartInFlight;
    _smartInFlight = _loadSmart(force, getState, dispatch).finally(() => { _smartInFlight = null; });
    return _smartInFlight;
  },
);
let _smartInFlight = null;
async function _loadSmart(force, getState, dispatch) {
    let st = getState();
    if (!st.leads?.lastFetchedAt) {
      const key = _cacheKey(st);
      if (key) {
        try {
          const raw = await AsyncStorage.getItem(key);
          if (raw) {
            const c = JSON.parse(raw);
            if (c && Array.isArray(c.items) && c.lastFetchedAt) {
              _lastFullAt = Number(c.lastFullAt) || 0;
              dispatch(leadsSlice.actions.leadsHydrated({ items: c.items, lastFetchedAt: c.lastFetchedAt }));
            }
          }
        } catch { /* corrupt cache → full fetch below */ }
      }
      st = getState();
    }
    const needFull = force || _cacheHadDuplicates || !st.leads?.lastFetchedAt || (Date.now() - _lastFullAt > FULL_REFRESH_MS);
    _cacheHadDuplicates = false;
    if (needFull) await dispatch(fetchLeads());
    else          await dispatch(fetchLeadsDelta(st.leads.lastFetchedAt));
    scheduleLeadsCacheSave(getState);
}

export const fetchLeadsDelta = createAsyncThunk(
  'leads/fetchLeadsDelta',
  async (since, { dispatch, rejectWithValue }) => {
    try {
      const changed = await getLeadsDelta(since);
      return changed;
    } catch (error) {
      // Only a too-big change set needs a full download. A network blip just
      // keeps the current list (it used to re-download everything).
      if (error?.code === 'DELTA_OVERFLOW') {
        console.warn('[leadsSlice] Many leads changed — doing one full fetch');
        await dispatch(fetchLeads());
      }
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
  async ({ leadId, remark, outcome, followUpDate, document, recording, industry, service, status }, { rejectWithValue }) => {
    try {
      // Read the full updated lead the backend returns — previously this was
      // thrown away (bare `await`), so the reducer never got server-confirmed
      // values. Now we propagate them so status/industry/service reflect what
      // the backend actually saved, not just what the client hoped it would save.
      const updatedLead = await addCallRemarkWithAttachments(leadId, {
        remark, outcome, followUpDate, document, recording, industry, service, status,
      });
      return {
        leadId,
        remark,
        outcome,
        followUpDate,
        hasDocument:  !!document,
        hasRecording: !!recording,
        // Prefer server-confirmed values; fall back to locally-sent values
        // (e.g. multipart upload path returns the full lead; plain JSON path
        // returns the updated lead doc — both have industry/service/status).
        industry:     updatedLead?.industry     ?? industry,
        service:      updatedLead?.service      ?? (Array.isArray(service) ? (service[0] || '') : service),
        services:     updatedLead?.services     ?? (Array.isArray(service) ? service : undefined),
        status:       updatedLead?.status       ?? status,
        followUpDate: updatedLead?.followUpDate ?? followUpDate,
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
    items:         [],   // slim leads only — no callHistory arrays — ordered for FlatList
    byId:          {},   // id → index map for O(1) upsert lookup (avoids O(n) findIndex)
    loading:       false,
    error:         null,
    lastFetchedAt: null,
    searchQuery:   '',
    filterStatus:  'all',
    // Bumped by resetLeadFilters; LeadsScreen watches it to clear its local
    // (temperature/industry/source/date/sort/follow-up) filters as well.
    filtersResetAt: 0,
  },
  reducers: {
    setSearchQuery:  (state, action) => { state.searchQuery  = action.payload; },
    setFilterStatus: (state, action) => { state.filterStatus = action.payload; },
    // Clear search + every Leads filter (fired when the app is closed/reopened).
    resetLeadFilters: (state) => {
      state.searchQuery    = '';
      state.filterStatus   = 'all';
      state.filtersResetAt = Date.now();
    },
    clearLeadsError: (state)         => { state.error        = null; },
    leadsHydrated: (state, action) => {
      const { items, lastFetchedAt } = action.payload || {};
      if (!Array.isArray(items)) return;
      state.items = items;
      // Cache saved by the old buggy delta may contain duplicates (and is
      // missing the leads they overwrote) → dedupe now, full re-download next.
      if (dedupeAndIndex(state) > 0) _cacheHadDuplicates = true;
      state.lastFetchedAt = lastFetchedAt || null;
      state.loading = false;
    },
    upsertLead: (state, action) => {
      // Also update the full cache if we have a richer payload
      if (action.payload.id && _fullLeadCache.has(action.payload.id)) {
        const full = _fullLeadCache.get(action.payload.id);
        _fullLeadCache.set(action.payload.id, { ...full, ...action.payload });
      }
      // populateCache: false — this reducer already merged the cache
      // correctly above; toSlimLead() must NOT also write to it here, or it
      // overwrites that correct merge with the (often partial) action.payload
      // directly. See the long comment on toSlimLead() for the exact bug
      // this caused.
      const slim = toSlimLead({ ...action.payload }, { populateCache: false });
      const idx = state.byId[slim.id] ?? -1;
      if (idx !== -1) {
        state.items[idx] = { ...state.items[idx], ...slim };
      } else {
        state.items.unshift(slim);
        // Rebuild O(1) map after insert (indices shifted)
        dedupeAndIndex(state);
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
        // Rebuild O(1) lookup map (and drop any duplicate ids, e.g. a lead
        // returned on two pages when the list shifted mid-pagination).
        dedupeAndIndex(state);
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
      const p = action.payload;
      const changed = Array.isArray(p) ? p : (p?.leads || []);
      const ids     = Array.isArray(p) ? null : p?.ids;
      // Always move the marker forward — even when nothing changed — so the
      // next delta asks only for newer changes.
      state.lastFetchedAt = Date.now();
      let rebuild = false;
      // Update existing rows in place first (byId stays valid because nothing
      // is inserted yet), collect genuinely new leads, then prepend them once.
      const fresh = new Map();
      for (const lead of changed) {
        const slim = toSlimLead(lead);
        const idx = state.byId[slim.id] ?? -1;
        if (idx !== -1 && String(state.items[idx]?.id) === String(slim.id)) {
          state.items[idx] = { ...state.items[idx], ...slim };
        } else {
          fresh.set(String(slim.id), { ...(fresh.get(String(slim.id)) || {}), ...slim });
        }
      }
      if (fresh.size) {
        state.items = [...fresh.values(), ...state.items];
        rebuild = true;
      }
      // Drop leads that are no longer mine (reassigned / closed / merged).
      if (Array.isArray(ids)) {
        const keep = new Set(ids);
        const before = state.items.length;
        state.items = state.items.filter(l => keep.has(String(l.id)));
        if (state.items.length !== before) rebuild = true;
      }
      if (rebuild) dedupeAndIndex(state);
    });

    // Logout → forget the previous user's leads immediately.
    builder.addMatcher(
      (a) => a.type === 'auth/logout/fulfilled' || a.type === 'auth/forceLogout/fulfilled' || a.type === 'auth/logout/pending',
      (state) => {
        _fullLeadCache.clear();
        state.items = [];
        state.byId = {};
        state.lastFetchedAt = null;
        state.loading = false;
        state.error = null;
      },
    );

    builder.addCase(patchLead.fulfilled, (state, action) => {
      const { id, data } = action.payload;
      // Update full cache too
      if (_fullLeadCache.has(id)) {
        _fullLeadCache.set(id, { ..._fullLeadCache.get(id), ...data });
      }
      const idx = state.byId[id] ?? -1;
      if (idx !== -1) state.items[idx] = { ...state.items[idx], ...data };
    });

    builder.addCase(submitCallRemark.fulfilled, (state, action) => {
      const { leadId, remark, outcome, followUpDate, industry, service, services, status, hasDocument, hasRecording } = action.payload;

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
          // Write all server-confirmed fields back into the cache so the
          // lead detail screen shows correct values without a full refetch.
          ...(status       !== undefined ? { status }      : {}),
          ...(followUpDate !== undefined ? { followUpDate } : {}),
          ...(industry     !== undefined ? { industry }    : {}),
          ...(service      !== undefined ? { service  }    : {}),
          ...(services     !== undefined ? { services }    : {}),
          callHistory: [...(full.callHistory || []), newEntry],
        });
      }

      // Update slim entry in Redux (no callHistory here — just counts + remark)
      const idx = state.byId[leadId] ?? -1;
      if (idx !== -1) {
        const prev = state.items[idx];
        state.items[idx] = {
          ...prev,
          remark,
          remarkIsManual:     true,
          lastManualRemarkAt: Date.now(),
          lastOutcome:      outcome || prev.lastOutcome,
          lastCalledAt:     new Date().toISOString(),
          callHistoryCount: (prev.callHistoryCount || 0) + 1,
          // Status: use server-confirmed value — previously this was never
          // updated here (status came from a separate patchLead dispatch),
          // causing a stale status to persist until the next delta fetch.
          ...(status       !== undefined ? { status }       : {}),
          ...(followUpDate ? { followUpDate } : {}),
          // Show the new follow-up in the Follow-ups list immediately and keep
          // it after slim refreshes until the server's scheduledCalls arrive.
          ...(followUpDate ? {
            pendingScheduledCalls: [{ scheduledAt: followUpDate, type: 'follow_up', note: remark }],
            hasScheduledCalls: true,
          } : {}),
          ...(industry     !== undefined ? { industry } : {}),
          ...(service      !== undefined ? { service  } : {}),
        };
      }
    });
  },
});

export const { setSearchQuery, setFilterStatus, resetLeadFilters, clearLeadsError, upsertLead, leadsHydrated } = leadsSlice.actions;

export const selectFilteredLeads = createSelector(
  (state) => state.leads?.items ?? [],
  (state) => state.leads?.searchQuery ?? '',
  (state) => state.leads?.filterStatus ?? 'all',
  (items, searchQuery, filterStatus) => {
    const q = (searchQuery || '').toLowerCase();
    return items.filter(lead => {
      const matchSearch =
        !q ||
        (lead.name     || '').toLowerCase().includes(q) ||
        (lead.mobile   || '').includes(q) ||
        (lead.email    || '').toLowerCase().includes(q) ||
        (lead.campaign || '').toLowerCase().includes(q);
      // FIX: "New" used to match the literal backend status string, which is
      // the default for almost every lead and doesn't mean "not yet worked".
      // Now mirrors isNotContacted() below — zero call history — so this
      // filter, the Dashboard's "New Leads" KPI, and the deep-link from its
      // card all agree on what "New" means.
      const matchStatus =
        filterStatus === 'all' ? true :
        filterStatus === 'New' ? isNotContacted(lead) :
        lead.status === filterStatus;
      return matchSearch && matchStatus;
    });
  },
);

export function isNotContacted(lead) {
  if (!lead) return false;
  return !lead.callHistoryCount && !lead.lastCalledAt;
}

// ── Shared follow-up logic ────────────────────────────────────────────────
// Previously duplicated in DashboardScreen.js (full auto-follow-up logic)
// AND LeadsScreen.js (a simplified version that only checked the explicit
// followUpDate field). That mismatch was the root cause of the "Followups"
// card showing a count > 0 on the Dashboard but the Leads screen it deep-links
// to showing an empty list — the two screens disagreed on which leads counted
// as "due". Both screens now import isFollowUpDue from here so they can never
// drift apart again.
//
// Works out the follow-up date that actually governs a lead:
//   • If an agent explicitly set followUpDate, that wins (auto: false).
//   • Otherwise, a lead that's still "New" (not yet called) or "In Progress"
//     automatically becomes a follow-up the day AFTER it was last touched —
//     an untouched lead should never just sit there with no follow-up date
//     and quietly fall off everyone's radar. Basis = last call time if the
//     agent has called before, else the lead's creation date. (auto: true)
// FIX ("follow-up added but not in the Follow-ups list"): the backend does
// NOT keep a top-level followUpDate on the lead — a follow-up set in a call
// remark is stored as a scheduledCalls[] entry (see the note above
// pendingScheduledCalls in slimLead). This function only read followUpDate,
// so after any refresh the agent's "Demo at 1 PM" follow-up vanished from the
// list (and the lead only showed up, if at all, via the auto next-day rule).
// The agent-set follow-up is now the EARLIEST pending scheduled call, or
// followUpDate when present (set optimistically right after saving).
// When several are pending: the earliest one from TODAY onward wins (so a
// newly set "today 1 PM" isn't hidden behind an old, never-closed entry from
// last week); if all are in the past, the most recent one (overdue) is used.
export function getScheduledFollowUp(lead) {
  if (!lead) return null;
  const dates = [];
  const add = (v) => {
    if (!v) return;
    const d = new Date(v);
    if (!isNaN(d.getTime())) dates.push(d);
  };
  const arr = Array.isArray(lead.pendingScheduledCalls) ? lead.pendingScheduledCalls
            : (Array.isArray(lead.scheduledCalls) ? lead.scheduledCalls : []);
  for (const sc of arr) if (sc && !sc.done) add(sc.scheduledAt);
  add(lead.followUpDate);
  if (!dates.length) return null;
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const fromToday = dates.filter(d => d.getTime() >= startOfToday.getTime())
                         .sort((a, b) => a - b);
  if (fromToday.length) return fromToday[0];
  return dates.sort((a, b) => b - a)[0];
}

export function getEffectiveFollowUp(lead) {
  const scheduled = getScheduledFollowUp(lead);
  if (scheduled) return { date: scheduled, auto: false };
  if (isNotContacted(lead) || lead?.status === 'In Progress') {
    const basis = lead.lastCalledAt || lead._raw_date || lead.date;
    if (!basis) return null;
    const b = new Date(basis);
    if (isNaN(b.getTime())) return null;
    const due = new Date(b);
    due.setDate(due.getDate() + 1);
    due.setHours(0, 0, 0, 0);
    return { date: due, auto: true };
  }
  return null;
}

// Returns true when a lead's effective follow-up (explicit or auto-assigned,
// see getEffectiveFollowUp above) is today or earlier.
export function isFollowUpDue(lead) {
  const info = getEffectiveFollowUp(lead);
  if (!info) return false;
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  return info.date.getTime() <= endOfToday.getTime();
}

// Returns true when a lead's remark/call history was updated within the
// given window (default 24h). Powers the Leads screen's "Recent Remark" filter.
export function hasRecentRemark(lead, windowMs = 24 * 60 * 60 * 1000) {
  if (!lead?.remark) return false;
  const basis = lead.lastCalledAt || lead._raw_date || lead.date;
  if (!basis) return false;
  const t = new Date(basis).getTime();
  if (isNaN(t)) return false;
  return Date.now() - t <= windowMs;
}

// Helper for LeadDetailScreen: get the full lead (with callHistory) from cache.
// Falls back to the slim lead if the full one hasn't been cached yet.
export function getFullLeadFromCache(leadId) {
  return _fullLeadCache.get(leadId) || null;
}

export default leadsSlice.reducer;