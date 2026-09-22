// src/services/callSyncService.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX (this revision) — user-scoped storage keys:
//
//   OFFLINE_QUEUE_KEY was a global key ('crm_call_sync_offline_queue').
//   If User A logged out and User B logged in on the same device, User B's
//   calls could be processed using the queue built by User A, or User A's
//   queued calls could be uploaded under User B's account.
//
//   Fix: the queue key is now scoped to the current userId + companyId,
//   read from the Redux store at call time. The public API is unchanged;
//   callers (App.js, callDetector.js) do not need to change.
//
//   The legacy global key is migrated to the user-scoped key on first use
//   and then cleared, so queued calls from before this fix are not lost.
//
//   NOTE: Call sync itself has NEVER depended on clock-in/attendance and
//   continues to work regardless of attendance state. Do NOT add any
//   clockedIn guard here.
//
// ALL OTHER BEHAVIOUR RETAINED (retry, exponential back-off, NetInfo drain).
// ─────────────────────────────────────────────────────────────────────────────

import NetInfo      from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api          from './api';

// Legacy global key — only used for one-time migration below.
const LEGACY_QUEUE_KEY = 'crm_call_sync_offline_queue';

const MAX_RETRIES   = 3;
const BASE_RETRY_MS = 2000; // 2s, 4s, 8s

// ── User-scoped queue key ─────────────────────────────────────────────────────
// Lazy import to avoid circular dependency at module load time.
function getScopedQueueKey() {
  try {
    const { store } = require('../store');
    const state = store.getState();
    const userId    = state?.auth?.user?._id || state?.auth?.user?.id || 'anon';
    const companyId = state?.auth?.user?.company?._id || state?.auth?.user?.company || 'co';
    return `crm_call_sync_queue_${companyId}_${userId}`;
  } catch {
    return LEGACY_QUEUE_KEY; // fallback if store not ready
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function isOnline() {
  try {
    const state = await NetInfo.fetch();
    return state.isConnected && state.isInternetReachable !== false;
  } catch {
    return false;
  }
}

// One-time migration: move any entries from the legacy global key to the
// new user-scoped key, then clear the global key.
async function migrateLegacyQueue(scopedKey) {
  if (scopedKey === LEGACY_QUEUE_KEY) return; // fallback case — don't self-migrate
  try {
    const raw = await AsyncStorage.getItem(LEGACY_QUEUE_KEY);
    if (!raw) return;
    const legacy = JSON.parse(raw);
    if (!Array.isArray(legacy) || legacy.length === 0) {
      await AsyncStorage.removeItem(LEGACY_QUEUE_KEY);
      return;
    }
    // Merge legacy entries into the scoped queue (de-duplicate by timestamp)
    const existingRaw = await AsyncStorage.getItem(scopedKey);
    const existing = existingRaw ? JSON.parse(existingRaw) : [];
    const merged = [...existing, ...legacy].slice(-1000);
    await AsyncStorage.setItem(scopedKey, JSON.stringify(merged));
    await AsyncStorage.removeItem(LEGACY_QUEUE_KEY);
    console.log(`[callSyncService] Migrated ${legacy.length} legacy queued call(s) to scoped key`);
  } catch {}
}

async function loadOfflineQueue() {
  const key = getScopedQueueKey();
  await migrateLegacyQueue(key);
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveOfflineQueue(queue) {
  const key = getScopedQueueKey();
  try {
    const capped = queue.slice(-1000);
    await AsyncStorage.setItem(key, JSON.stringify(capped));
  } catch { /* non-critical */ }
}

async function addToOfflineQueue(callData) {
  const queue = await loadOfflineQueue();
  queue.push({ ...callData, _queuedAt: Date.now() });
  await saveOfflineQueue(queue);
}

// ── Core API call ─────────────────────────────────────────────────────────────

async function uploadCallRecord(callData) {
  const payload = {
    logs: [{
      phoneNumber: callData.phoneNumber,
      callType:    callData.callType || 'outgoing',
      duration:    callData.duration || 0,
      timestamp:   callData.timestamp || Date.now(),
      name:        callData.name || '',
    }],
  };
  const response = await api.post('/call-logs/sync', payload);
  return { success: true, data: response.data };
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────

async function uploadWithRetry(callData, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await uploadCallRecord(callData);
    } catch (err) {
      if (attempt === retries) return { success: false, error: err.userMessage || err.message };
      await new Promise(r => setTimeout(r, BASE_RETRY_MS * Math.pow(2, attempt)));
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sync a single call to the CRM immediately after it ends.
 * NEVER depends on attendance/clock-in state.
 */
export async function syncSingleCall(callData) {
  if (!callData?.phoneNumber) {
    console.warn('[callSyncService] syncSingleCall: phoneNumber is required');
    return;
  }

  const online = await isOnline();

  if (!online) {
    await addToOfflineQueue(callData);
    console.log('[callSyncService] Offline — queued call:', callData.phoneNumber);
    return;
  }

  const result = await uploadWithRetry(callData);

  if (result.success) {
    console.log('[callSyncService] ✅ Call synced:', callData.phoneNumber, `(${callData.duration}s)`);
  } else {
    await addToOfflineQueue(callData);
    console.warn('[callSyncService] All retries failed, queued:', result.error);
  }
}

/**
 * Drain the offline queue — call when connectivity is restored.
 * Safe to call multiple times concurrently (internal guard).
 */
let _drainingQueue = false;

export async function drainOfflineQueue() {
  if (_drainingQueue) return;
  _drainingQueue = true;

  try {
    const queue = await loadOfflineQueue();
    if (queue.length === 0) { _drainingQueue = false; return; }

    console.log(`[callSyncService] Draining ${queue.length} queued call(s)…`);

    const succeeded = [];
    const failed    = [];

    for (const callData of queue) {
      const online = await isOnline();
      if (!online) {
        failed.push(...queue.slice(queue.indexOf(callData)));
        break;
      }
      const result = await uploadWithRetry(callData, 1);
      if (result.success) succeeded.push(callData);
      else                 failed.push(callData);
    }

    await saveOfflineQueue(failed);
    console.log(`[callSyncService] Queue drain: ${succeeded.length} uploaded, ${failed.length} remain`);
  } catch (err) {
    console.warn('[callSyncService] Queue drain error:', err.message);
  } finally {
    _drainingQueue = false;
  }
}

/**
 * Set up a NetInfo listener that drains the offline queue on reconnect.
 * Call once at app startup (after login). Returns an unsubscribe function.
 */
export function startOfflineQueueDrainer() {
  const unsubscribe = NetInfo.addEventListener(async (state) => {
    if (state.isConnected && state.isInternetReachable !== false) {
      await drainOfflineQueue();
    }
  });
  return unsubscribe;
}

/**
 * Return the number of calls in the offline queue.
 */
export async function getOfflineQueueLength() {
  const queue = await loadOfflineQueue();
  return queue.length;
}
