// src/services/backgroundSyncService.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX (this revision):
//
//  DUPLICATE UPLOAD PREVENTION (primary fix):
//   • Added _postCallSyncedNumbers Set — tracks phone numbers that have already
//     had a successful post-call auto-upload in this session.
//     If triggerPostCallRecordingSync already uploaded for a number, the
//     periodic 10-min sweep skips that number via skipPhones filter passed to
//     syncRecordings(). This eliminates the race between post-call auto-upload
//     and the periodic sweep running within the same 10-min window.
//   • recordingService's uploadedSet (phone::filename::mtime) remains the hard
//     dedup layer — this is an additional early-exit optimisation.
//
//  MANUAL SYNC BUTTON:
//   • triggerManualSync() now returns { alreadyAutoUploaded: true } if the
//     last post-call auto-upload was within the last 60s. The UI can use this
//     to show "Uploaded automatically — no action needed" instead of re-syncing.
//
//  RETAINED FROM PREVIOUS REVISIONS:
//   • isSyncing guard, upload queue, LAST_SYNC_KEY per-chunk advance.
//   • Post-call retry delays [3s, 10s, 25s], 3 attempts, breaks on success.
//   • MIN_FOREGROUND_WAIT_MS, REC_SYNC_INTERVAL_MS, LOG_BATCH_SIZE = 50.
//   • LAST_SYNC_KEY defaults to now on first run (not todayMidnight).
// ─────────────────────────────────────────────────────────────────────────────

import NetInfo      from '@react-native-community/netinfo';
import { AppState, InteractionManager } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getCallLogsSince } from './phoneService';
import { syncCallLogs }     from '../api/callLogsApi';
import { syncRecordings }   from './recordingService';
import { checkAndNotifyFollowUps } from './notificationService';

import { store }      from '../store';
import { fetchLeads } from '../store/slices/leadsSlice';

const LAST_SYNC_KEY     = 'last_call_log_sync_ts';
const LAST_REC_SYNC_KEY = 'last_recording_sync_ts';
const LAST_RAN_KEY      = 'last_sync_ran_ts';

const INITIAL_SYNC_DELAY_MS  =  5 * 1000;       // 5s delay before first sync (was 2s)
const SYNC_INTERVAL_MS       = 10 * 60 * 1000;  // 10 min interval (was 3 min — too aggressive)
const FOLLOWUP_INTERVAL_MS   =  5 * 60 * 1000;  // 5 min follow-up check (was 2 min)
const MIN_FOREGROUND_WAIT_MS =  5 * 60 * 1000;  // 5 min min between foreground syncs (was 1 min)
const REC_SYNC_INTERVAL_MS   = 15 * 60 * 1000;  // 15 min recording sweep (was 10 min)
const LOG_BATCH_SIZE         = 50;

function getTodayMidnightMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

let syncInterval         = null;
let followUpInterval     = null;
let appStateListener     = null;
let isSyncing            = false;
let isCheckingFollowUps  = false;

// PERF FIX: In-memory cache for LAST_RAN_KEY so the AppState 'active' handler
// never has to hit AsyncStorage (disk I/O on the JS bridge) on every screen-on event.
let _lastRanMs = 0;

// ── FIX: Track phones already auto-uploaded this session ─────────────────────
// When triggerPostCallRecordingSync successfully uploads for a phone number,
// we record it here. The periodic sweep then skips those numbers so the same
// recording is not attempted twice within the same 10-min window.
// The set is cleared on stopBackgroundSync (logout) so it doesn't persist
// stale data across sessions.
const _postCallSyncedNumbers = new Set();

// Track the timestamp of the last successful post-call auto-upload.
// Used by triggerManualSync to return alreadyAutoUploaded: true.
let _lastAutoUploadAt = 0;

// ── Upload queue ──────────────────────────────────────────────────────────────
const _uploadQueue = [];
let _uploadRunning = false;

async function _drainUploadQueue() {
  if (_uploadRunning || _uploadQueue.length === 0) return;
  _uploadRunning = true;
  while (_uploadQueue.length > 0) {
    const task = _uploadQueue.shift();
    try { await task(); } catch (e) { console.warn('[Sync] Upload queue task failed:', e.message); }
  }
  _uploadRunning = false;
}

function enqueueUpload(fn) {
  _uploadQueue.push(fn);
  _drainUploadQueue();
}

// ── Timestamp helpers ─────────────────────────────────────────────────────────
const getTs = async (key, fallback) => {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? parseInt(raw) : (fallback ?? Date.now());
  } catch { return fallback ?? Date.now(); }
};

const setTs = async (key, ts = Date.now()) => {
  try { await AsyncStorage.setItem(key, String(ts)); } catch {}
  // PERF FIX: keep in-memory cache in sync so AppState handler avoids disk read
  if (key === LAST_RAN_KEY) _lastRanMs = ts;
};

// ── Follow-Up reminder check ──────────────────────────────────────────────────
const doFollowUpCheck = async () => {
  if (isCheckingFollowUps) return;
  isCheckingFollowUps = true;
  try {
    const authUser = store.getState().auth?.user;
    if (!authUser) return;

    const leadsState = store.getState().leads;
    let leads        = leadsState?.items ?? leadsState?.leads?.items ?? [];

    // FIX: if store is empty (agent never opened Leads tab), fetch first.
    // Without this, follow-up check always runs on [] and fires nothing.
    if (!Array.isArray(leads) || leads.length === 0) {
      console.log('[Sync] Follow-up: store empty — fetching leads first');
      try {
        await store.dispatch(fetchLeads());
        const fresh = store.getState().leads;
        leads = fresh?.items ?? fresh?.leads?.items ?? [];
      } catch (fetchErr) {
        console.warn('[Sync] Follow-up fetchLeads failed:', fetchErr.message);
      }
    }

    if (Array.isArray(leads) && leads.length > 0) {
      await checkAndNotifyFollowUps(leads);
    }
  } catch (err) {
    console.warn('[Sync] Follow-up check error:', err.message);
  } finally {
    isCheckingFollowUps = false;
  }
};

// ── Core call-log + recording sync ────────────────────────────────────────────
const doSync = async ({ forceFullDay = false, fromForeground = false } = {}) => {
  if (isSyncing) return;

  if (fromForeground) {
    const lastRan = await getTs(LAST_RAN_KEY);
    if (Date.now() - lastRan < MIN_FOREGROUND_WAIT_MS) return;
  }

  isSyncing = true;
  try {
    const net = await NetInfo.fetch();
    if (!net.isConnected) return;

    const todayMidnight = getTodayMidnightMs();
    const now           = Date.now();

    // ── Call log sync ─────────────────────────────────────────────────────────
    const lastLogSync = forceFullDay
      ? todayMidnight
      : Math.max(await getTs(LAST_SYNC_KEY, now), todayMidnight);

    const logs = await getCallLogsSince(lastLogSync);
    console.log(`[Sync] Call logs since ${new Date(lastLogSync).toISOString()}: ${logs.length} found`);

    if (logs.length > 0) {
      for (let i = 0; i < logs.length; i += LOG_BATCH_SIZE) {
        const chunk = logs.slice(i, i + LOG_BATCH_SIZE);
        await syncCallLogs(chunk);
        await setTs(LAST_SYNC_KEY);
        console.log(`[Sync] ✅ Chunk ${Math.floor(i / LOG_BATCH_SIZE) + 1}: uploaded ${chunk.length} call log(s)`);
      }
    } else {
      await setTs(LAST_SYNC_KEY);
    }

    await setTs(LAST_RAN_KEY);

    // ── Periodic recording sweep ──────────────────────────────────────────────
    const lastRecSync   = await getTs(LAST_REC_SYNC_KEY, now);
    const shouldSyncRec = forceFullDay || (now - lastRecSync >= REC_SYNC_INTERVAL_MS);

    if (shouldSyncRec) {
      // FIX: pass lastRecSync directly when it already falls today (> midnight).
      // The old Math.max(lastRecSync, todayMidnight) reset a recent "last ran at
      // 10 AM" timestamp back to midnight, causing every sweep to re-walk ALL
      // of today's recordings instead of only files written since the last sweep.
      // recordingService.syncRecordings already respects sinceMs > 0 as-is —
      // this is the matching fix on the caller side.
      const sinceMs = forceFullDay
        ? todayMidnight
        : (lastRecSync > todayMidnight ? lastRecSync : todayMidnight);
      console.log(`[Sync] Recording sweep since ${new Date(sinceMs).toISOString()}`);

      // FIX: Pass skipPhones so the periodic sweep skips numbers that were
      // already handled by post-call auto-upload in this session.
      // recordingService's uploadedSet still catches any edge cases where the
      // same file key appears — this is just an early-exit optimisation.
      const skipPhones = forceFullDay ? new Set() : new Set(_postCallSyncedNumbers);
      if (skipPhones.size > 0) {
        console.log(`[Sync] Periodic sweep skipping already-synced phones: ${[...skipPhones].join(', ')}`);
      }

      const recResult = await syncRecordings(null, sinceMs, skipPhones);
      console.log(`[Sync] Recording sweep done: uploaded=${recResult.uploaded} skipped=${recResult.skipped} failed=${recResult.failed}`);
      await setTs(LAST_REC_SYNC_KEY);
    }

    await doFollowUpCheck();

  } catch (err) {
    console.warn('[Sync] Error:', err.message);
  } finally {
    isSyncing = false;
  }
};

const doSyncDeferred = (opts, extraDelayMs = 0) => {
  // FIX: optional extra delay before queuing — gives screen transitions time
  // to finish painting before we start heavy sync work. Without this the
  // app-foreground sync competed with the app-resume animation, occasionally
  // producing an ANR ("SkyUp CRM isn't responding") if heavy file scanning
  // landed on the JS thread just as the OS was expecting a draw frame.
  if (extraDelayMs > 0) {
    setTimeout(() => {
      InteractionManager.runAfterInteractions(() => { doSync(opts); });
    }, extraDelayMs);
  } else {
    InteractionManager.runAfterInteractions(() => { doSync(opts); });
  }
};

// ── Public API ────────────────────────────────────────────────────────────────
export const startBackgroundSync = () => {
  // PERF FIX: Guard against duplicate registrations on re-login.
  // Without this, every logout/login cycle stacks another setInterval pair
  // and another AppState listener — background work grows unbounded.
  if (syncInterval) {
    console.log('[Sync] Already running — skipping duplicate startBackgroundSync()');
    return;
  }

  setTimeout(() => doSyncDeferred(), INITIAL_SYNC_DELAY_MS);
  syncInterval     = setInterval(() => doSyncDeferred(), SYNC_INTERVAL_MS);
  followUpInterval = setInterval(() => doFollowUpCheck(), FOLLOWUP_INTERVAL_MS);

  appStateListener = AppState.addEventListener('change', (nextState) => {
    if (nextState !== 'active') return;
    // PERF FIX: use in-memory _lastRanMs — no async, no AsyncStorage bridge call
    if (_lastRanMs > 0 && Date.now() - _lastRanMs >= MIN_FOREGROUND_WAIT_MS) {
      // FIX: 1500ms extra delay — the app-resume transition (shared-element,
      // stack animation) runs for ~300-600ms. Deferring 1.5s ensures we don't
      // start a directory scan or API call while the animator is fighting for
      // the JS thread, which was a primary cause of the "app not responding" dialog.
      doSyncDeferred({ fromForeground: true }, 1500);
    } else {
      // FIX: wrap follow-up check in InteractionManager so it doesn't race
      // with screen-open animations either.
      InteractionManager.runAfterInteractions(() => { doFollowUpCheck(); });
    }
  });
};

export const stopBackgroundSync = () => {
  if (syncInterval)     { clearInterval(syncInterval);     syncInterval     = null; }
  if (followUpInterval) { clearInterval(followUpInterval); followUpInterval = null; }
  if (appStateListener) { appStateListener.remove();       appStateListener = null; }
  // Clear session-scoped dedup state on logout
  _postCallSyncedNumbers.clear();
  _lastAutoUploadAt = 0;
};

// FIX: triggerManualSync returns { alreadyAutoUploaded: true } when a
// post-call auto-upload happened within the last 60 seconds, so the UI
// can show "Uploaded automatically" instead of triggering a redundant sync.
export const triggerManualSync = async (forceFullDay = false) => {
  const AUTO_UPLOAD_GRACE_MS = 60_000; // 60s grace window
  if (!forceFullDay && Date.now() - _lastAutoUploadAt < AUTO_UPLOAD_GRACE_MS) {
    console.log('[Sync] Manual sync skipped — auto-upload just ran');
    return { alreadyAutoUploaded: true };
  }
  await doSync({ forceFullDay });
  return { alreadyAutoUploaded: false };
};

// ── Post-call recording auto-upload ──────────────────────────────────────────
// Called by callDetector immediately after a call ends.
// On success, records the phone number in _postCallSyncedNumbers so the
// periodic sweep doesn't re-attempt the same file within the same 10-min window.
export const triggerPostCallRecordingSync = (phoneNumber, callStartedAt, leadName = '') => {
  console.log(`[Sync] 📞 Post-call sync queued for ${phoneNumber} startedAt=${new Date(callStartedAt).toISOString()}`);

  enqueueUpload(async () => {
    const delays = [3_000, 10_000, 25_000, 45_000]; // FIX: added 45s for slow dialers / saved contacts

    for (let attempt = 0; attempt < delays.length; attempt++) {
      const waitMs = delays[attempt];
      console.log(`[Sync] Attempt ${attempt + 1}/${delays.length} — waiting ${waitMs / 1000}s for dialer to write file…`);
      await new Promise(r => setTimeout(r, waitMs));

      try {
        const sinceMs = (callStartedAt || Date.now()) - 30_000;
        console.log(`[Sync] Scanning for ${phoneNumber} since ${new Date(sinceMs).toISOString()}`);

        // FIX: pass leadName so name-saved recordings ("pooja 1057....mp3")
        // are matched — this is what the manual Upload button uses and is why
        // those files uploaded manually but never automatically.
        //
        // ANR FIX ("SkyUp CRM isn't responding"): the scan does synchronous
        // per-file work. If it runs while the user is interacting (e.g. the
        // post-call remark modal / follow-up date picker is open and
        // animating), it competes for the single JS thread and freezes the UI.
        // Defer the scan until active interactions/animations have finished so
        // it never blocks a gesture or transition.
        const result = await new Promise((resolve) => {
          InteractionManager.runAfterInteractions(() => {
            syncRecordings(phoneNumber, sinceMs, new Set(), leadName)
              .then(resolve)
              .catch((err) => resolve({ uploaded: 0, skipped: 0, failed: 0, error: err?.message }));
          });
        });
        console.log(`[Sync] Scan result: uploaded=${result.uploaded} skipped=${result.skipped} failed=${result.failed}`);

        if (result.uploaded > 0) {
          console.log(`[Sync] ✅ Auto-uploaded ${result.uploaded} recording(s) for ${phoneNumber} on attempt ${attempt + 1}`);
          // FIX: Mark this number as handled so the periodic sweep skips it
          _postCallSyncedNumbers.add(phoneNumber);
          _lastAutoUploadAt = Date.now();
          return; // stop retrying
        }

        if (result.failed > 0) {
          console.warn(`[Sync] ⚠️ ${result.failed} recording(s) failed to upload on attempt ${attempt + 1}`);
        }

        if (attempt < delays.length - 1) {
          console.log(`[Sync] No recording found yet for ${phoneNumber} — will retry…`);
        } else {
          console.warn(`[Sync] ❌ No recording found for ${phoneNumber} after ${delays.length} attempts — periodic sweep will catch it`);
        }
      } catch (e) {
        console.warn(`[Sync] Attempt ${attempt + 1} error:`, e.message);
        if (attempt === delays.length - 1) {
          console.warn('[Sync] All post-call attempts failed for', phoneNumber);
        }
      }
    }
  });
};

export const initBackgroundSync = startBackgroundSync;
export default { startBackgroundSync, stopBackgroundSync, triggerManualSync, triggerPostCallRecordingSync };