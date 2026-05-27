// mobile-app/src/services/callSyncService.js
// ─────────────────────────────────────────────────────────────────────────────
// Call Sync Service
// Responsible for uploading a single completed call (detected in real-time
// by callDetector.js) to the CRM backend.
//
// Differs from backgroundSyncService (bulk history sync) — this handles
// individual calls immediately after they end, so the CRM is updated
// within seconds rather than on the next 15-minute sync cycle.
//
// Features:
//   - Retry logic with exponential back-off (3 retries)
//   - Offline queue: calls are saved to AsyncStorage if offline,
//     then uploaded when connectivity returns
//   - Lead auto-mapping (handled server-side via normalizedPhone)
//   - Deduplication is handled server-side (compound unique index)
// ─────────────────────────────────────────────────────────────────────────────

import NetInfo      from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api          from './api';

const OFFLINE_QUEUE_KEY = 'crm_call_sync_offline_queue';
const MAX_RETRIES       = 3;
const BASE_RETRY_MS     = 2000;   // 2s, 4s, 8s

// ── Internal helpers ──────────────────────────────────────────────────────────

async function isOnline() {
  try {
    const state = await NetInfo.fetch();
    return state.isConnected && state.isInternetReachable !== false;
  } catch {
    return false;
  }
}

async function loadOfflineQueue() {
  try {
    const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveOfflineQueue(queue) {
  try {
    // Cap queue at 1000 entries to prevent unbounded growth
    const capped = queue.slice(-1000);
    await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(capped));
  } catch { /* non-critical */ }
}

async function addToOfflineQueue(callData) {
  const queue = await loadOfflineQueue();
  queue.push({ ...callData, _queuedAt: Date.now() });
  await saveOfflineQueue(queue);
}

// ── Core API call ─────────────────────────────────────────────────────────────

/**
 * Upload a single call record to the backend.
 * Returns { success: boolean, data?: any, error?: string }
 */
async function uploadCallRecord(callData) {
  // api.js already attaches the Bearer token via its interceptor
  const payload = {
    logs: [
      {
        phoneNumber: callData.phoneNumber,
        callType:    callData.callType || 'outgoing',
        duration:    callData.duration || 0,
        timestamp:   callData.timestamp || Date.now(),
        name:        callData.name || '',
      },
    ],
  };

  const response = await api.post('/call-logs/sync', payload);
  return { success: true, data: response.data };
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────

async function uploadWithRetry(callData, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await uploadCallRecord(callData);
      return result;
    } catch (err) {
      const isLast = attempt === retries;
      if (isLast) {
        return { success: false, error: err.userMessage || err.message };
      }
      // Exponential back-off: 2s, 4s, 8s
      const delay = BASE_RETRY_MS * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sync a single call to the CRM immediately after it ends.
 *
 * @param {object} callData
 * @param {string} callData.phoneNumber  - raw phone number as dialled
 * @param {string} callData.callType     - 'incoming' | 'outgoing' | 'missed'
 * @param {number} callData.duration     - call duration in seconds
 * @param {number} callData.timestamp    - call start time as Unix ms
 * @param {string} [callData.name]       - contact name from device (optional)
 */
export async function syncSingleCall(callData) {
  if (!callData?.phoneNumber) {
    console.warn('[callSyncService] syncSingleCall: phoneNumber is required');
    return;
  }

  const online = await isOnline();

  if (!online) {
    // Save for later — drainOfflineQueue() will pick this up
    await addToOfflineQueue(callData);
    console.log('[callSyncService] Offline — queued call:', callData.phoneNumber);
    return;
  }

  const result = await uploadWithRetry(callData);

  if (result.success) {
    console.log('[callSyncService] ✅ Call synced:', callData.phoneNumber, `(${callData.duration}s)`);
  } else {
    // All retries failed — save to offline queue for next connectivity event
    await addToOfflineQueue(callData);
    console.warn('[callSyncService] All retries failed, queued:', result.error);
  }
}

/**
 * Drain the offline queue — call this whenever connectivity is restored.
 * Safe to call multiple times concurrently (internal guard prevents double-drain).
 */
let _drainingQueue = false;

export async function drainOfflineQueue() {
  if (_drainingQueue) return;
  _drainingQueue = true;

  try {
    const queue = await loadOfflineQueue();
    if (queue.length === 0) {
      _drainingQueue = false;
      return;
    }

    console.log(`[callSyncService] Draining ${queue.length} queued call(s)…`);

    const succeeded = [];
    const failed    = [];

    for (const callData of queue) {
      const online = await isOnline();
      if (!online) {
        // Network dropped again — put remainder back and stop
        failed.push(...queue.slice(queue.indexOf(callData)));
        break;
      }

      const result = await uploadWithRetry(callData, 1); // 1 retry per queued item
      if (result.success) {
        succeeded.push(callData);
      } else {
        failed.push(callData);
      }
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
 * Set up a NetInfo listener that automatically drains the offline queue
 * when the device reconnects to the internet.
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
 * Return the number of calls currently in the offline queue.
 * Useful for showing a "pending sync" badge in the UI.
 */
export async function getOfflineQueueLength() {
  const queue = await loadOfflineQueue();
  return queue.length;
}
