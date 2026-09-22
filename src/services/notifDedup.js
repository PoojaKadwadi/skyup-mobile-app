// src/services/notifDedup.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX (this revision) — user-scoped dedup store keys:
//
//   The three dedup Sets (seenLeads, notified, scheduled) used global
//   AsyncStorage keys. On a device used by multiple employees, User B would
//   inherit User A's seen-lead dedup state and either:
//     (a) miss real new-lead notifications (A's IDs already in the set), or
//     (b) see duplicate notifications (B's IDs not yet in the set but A's
//         leads were sending events for B's session).
//
//   Fix: storage keys are now suffixed with the current userId, computed
//   lazily so this module loads without circular-import issues at boot time.
//   The stores are also reset (in-memory cache cleared) on each call to
//   getSet() when the userId changes — detected by comparing the last-seen
//   suffix to the current one.
//
// ALL OTHER BEHAVIOUR RETAINED (debounced flush, max-set-size cap, pruning).
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';

const MAX_SET_SIZE = 500;

function getCurrentUserSuffix() {
  try {
    const { store } = require('../store');
    const userId = store.getState()?.auth?.user?._id || store.getState()?.auth?.user?.id;
    return userId ? `_${userId}` : '_anon';
  } catch { return '_anon'; }
}

function createDedupStore(baseKey, maxAge = null) {
  let _set         = null;
  let _dirty       = false;
  let _loading     = null;
  let _lastSuffix  = null; // tracks which user's data is loaded

  function _getStorageKey() {
    return `${baseKey}${getCurrentUserSuffix()}`;
  }

  async function _load() {
    try {
      const raw = await AsyncStorage.getItem(_getStorageKey());
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
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
    const currentSuffix = getCurrentUserSuffix();
    // FIX: if the user changed since last load, reset the in-memory cache
    // so we load the new user's data rather than serving the old user's set.
    if (_lastSuffix !== null && _lastSuffix !== currentSuffix) {
      _set     = null;
      _loading = null;
      _dirty   = false;
    }
    _lastSuffix = currentSuffix;

    if (_set !== null) return _set;
    if (_loading) return _loading;
    _loading = _load().then(s => { _set = s; _loading = null; return s; });
    return _loading;
  }

  function add(key) {
    if (!_set) { _set = new Set(); }
    _set.add(String(key));
    _dirty = true;
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

  let _flushTimer = null;
  function _flushDebounced() {
    if (_flushTimer) return;
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      if (_dirty && _set) {
        AsyncStorage.setItem(_getStorageKey(), JSON.stringify([..._set])).catch(() => {});
        _dirty = false;
      }
    }, 2000);
  }

  async function flush() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    if (_dirty && _set) {
      await AsyncStorage.setItem(_getStorageKey(), JSON.stringify([..._set])).catch(() => {});
      _dirty = false;
    }
  }

  return { getSet, add, has, getAll, prune, flush };
}

export const seenLeads = createDedupStore('notif_seen_lead_ids');
export const notified  = createDedupStore('notif_followup_fired_keys');
export const scheduled = createDedupStore('notif_meeting_scheduled_keys');

export async function flushAll() {
  await Promise.allSettled([seenLeads.flush(), notified.flush(), scheduled.flush()]);
}
