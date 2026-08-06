// src/services/notifDedup.js — NEW (RAM fix #3)
// ─────────────────────────────────────────────────────────────────────────────
// THE PROBLEM:
//   notificationService.js called AsyncStorage.getItem + JSON.parse on every
//   single sync cycle (every 10 min × 3 dedup sets = 36 AsyncStorage calls/hr).
//   Each JSON.parse of a 50-entry dedup array allocates a brand-new Set and
//   discards the old one — that's heap churn every sync. On a 200-lead account
//   with active follow-ups, this was the #2 RAM consumer after Redux.
//
// THE FIX:
//   This module is the single source of truth for all three dedup Sets.
//   It loads from AsyncStorage ONCE on first access and caches in memory.
//   Writes flush to AsyncStorage asynchronously (fire-and-forget) so the
//   sync cycle never waits for storage I/O.
//
// USAGE (in notificationService.js):
//   import { seenLeads, notified, scheduled } from './notifDedup';
//   const seen = await seenLeads.getSet();
//   seenLeads.add('123');
//
//   Full sync flush (call before app background if needed):
//   import { flushAll } from './notifDedup';
//   await flushAll();
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';

const MAX_SET_SIZE = 500; // cap each set so it can't grow without bound

function createDedupStore(storageKey, maxAge = null) {
  let _set       = null;   // null = not yet loaded
  let _dirty     = false;
  let _loading   = null;   // Promise<Set> while loading

  async function _load() {
    try {
      const raw = await AsyncStorage.getItem(storageKey);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      // If entries have timestamps (for maxAge pruning), filter old ones
      if (maxAge && Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object') {
        const cutoff = Date.now() - maxAge;
        return new Set(parsed.filter(e => e.ts > cutoff).map(e => e.k));
      }
      return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      return new Set();
    }
  }

  async function getSet() {
    if (_set !== null) return _set;
    if (_loading) return _loading;
    _loading = _load().then(s => { _set = s; _loading = null; return s; });
    return _loading;
  }

  function add(key) {
    if (!_set) { _set = new Set(); }
    _set.add(String(key));
    _dirty = true;
    // Evict oldest entries when over the cap (convert to array, slice, re-Set)
    if (_set.size > MAX_SET_SIZE) {
      const arr = [..._set];
      _set = new Set(arr.slice(arr.length - MAX_SET_SIZE));
    }
    _flushDebounced();
  }

  function has(key) {
    return _set ? _set.has(String(key)) : false;
  }

  function getAll() {
    return _set ? [..._set] : [];
  }

  function prune(keepFn) {
    if (!_set) return;
    const before = _set.size;
    for (const k of _set) {
      if (!keepFn(k)) _set.delete(k);
    }
    if (_set.size !== before) _dirty = true;
  }

  // Debounced async flush — batches multiple add() calls into one write.
  let _flushTimer = null;
  function _flushDebounced() {
    if (_flushTimer) return;
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      if (_dirty && _set) {
        AsyncStorage.setItem(storageKey, JSON.stringify([..._set])).catch(() => {});
        _dirty = false;
      }
    }, 2000); // 2s debounce — batches a full sync cycle's worth of adds
  }

  async function flush() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    if (_dirty && _set) {
      await AsyncStorage.setItem(storageKey, JSON.stringify([..._set])).catch(() => {});
      _dirty = false;
    }
  }

  return { getSet, add, has, getAll, prune, flush };
}

// The three dedup stores that notificationService uses.
// Pruning rules match what notificationService already does:
//   seenLeads — checked at startup to detect newly assigned leads
//   notified  — follow-up fire dedup (key = leadId_isoDate)
//   scheduled — meeting reminder dedup

export const seenLeads = createDedupStore('notif_seen_lead_ids');
export const notified  = createDedupStore('notif_followup_fired_keys');
export const scheduled = createDedupStore('notif_meeting_scheduled_keys');

export async function flushAll() {
  await Promise.allSettled([seenLeads.flush(), notified.flush(), scheduled.flush()]);
}