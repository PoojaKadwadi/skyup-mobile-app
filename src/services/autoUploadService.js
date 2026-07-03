// src/services/autoUploadService.js
// ─────────────────────────────────────────────────────────────────────────────
// IN-APP AUTO-UPLOAD FOREGROUND SERVICE
//
// WHY THIS EXISTS:
//   On aggressive OEMs (ColorOS / Realme UI, MIUI, etc.) the OS freezes or kills
//   a backgrounded app within seconds of a call ending. That kills the post-call
//   recording auto-upload (callDetector → triggerPostCallRecordingSync) and the
//   periodic sweep before they can run — which is why recordings only upload when
//   the user opens the app and taps Upload manually.
//
//   A FOREGROUND SERVICE (an ongoing notification) tells Android the app is doing
//   user-visible work, so the OS keeps the process alive. With it running, the
//   call-state listener and the post-call upload reliably execute without the
//   user having to whitelist the app in battery settings.
//
// USER CONTROL:
//   This is exposed as an in-app toggle ("Auto-upload recordings"). The choice is
//   persisted in AsyncStorage and re-applied on app start. Default = ON.
//
// IMPLEMENTATION:
//   Uses @notifee/react-native's registerForegroundService. The service task
//   simply stays alive (the actual upload work is driven by callDetector and
//   backgroundSyncService, which keep running because the process is alive).
//
// ── CRASH FIX (Android 14/15) ──────────────────────────────────────────────
//   Without an explicit `foregroundServiceTypes` value, Notifee defaults this
//   service to Android's "shortService" type, which has a HARD 3-minute
//   execution limit enforced by the OS. Since this service is designed to run
//   for the entire session (not just 3 minutes), Android was force-killing the
//   process with ForegroundServiceDidNotStopInTimeException once the 3-minute
//   mark passed — this was the app crash.
//
//   Fix: declare this as a "dataSync" type foreground service, which is meant
//   for exactly this kind of long-running background sync/upload work. This
//   also requires the FOREGROUND_SERVICE_DATA_SYNC permission in
//   AndroidManifest.xml (see android/app/src/main/AndroidManifest.xml).
// ─────────────────────────────────────────────────────────────────────────────

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import notifee, { AndroidImportance, AndroidForegroundServiceType } from '@notifee/react-native';

const PREF_KEY      = 'auto_upload_enabled_v1';
const CHANNEL_ID    = 'auto_upload_service';
const CHANNEL_NAME  = 'Auto-Upload Service';
const NOTIF_ID      = 'auto-upload-fgs';

let _running   = false;
let _registered = false;

// ── Preference helpers ────────────────────────────────────────────────────────
// Default ON — most users want auto-upload; they can turn it off in settings.
export async function isAutoUploadEnabled() {
  try {
    const raw = await AsyncStorage.getItem(PREF_KEY);
    if (raw === null) return true;          // default ON
    return raw === 'true';
  } catch {
    return true;
  }
}

async function setAutoUploadPref(enabled) {
  try { await AsyncStorage.setItem(PREF_KEY, enabled ? 'true' : 'false'); } catch {}
}

// ── Channel ───────────────────────────────────────────────────────────────────
async function ensureChannel() {
  if (Platform.OS !== 'android') return;
  await notifee.createChannel({
    id:         CHANNEL_ID,
    name:       CHANNEL_NAME,
    importance: AndroidImportance.LOW,   // LOW = no sound, minimal intrusion
  });
}

// ── Register the foreground-service runner ONCE ───────────────────────────────
// notifee requires a single registered task. It must stay alive until the
// service is stopped; we resolve only when _running flips to false.
function registerRunnerOnce() {
  if (_registered) return;
  _registered = true;

  notifee.registerForegroundService((notification) => {
    return new Promise((resolve) => {
      // Poll our own running flag; when stopForegroundService() flips it,
      // resolve so notifee can tear the service down cleanly.
      const interval = setInterval(() => {
        if (!_running) {
          clearInterval(interval);
          resolve();
        }
      }, 1000);
    });
  });
}

// ── Start the foreground service ──────────────────────────────────────────────
export async function startAutoUploadService() {
  if (Platform.OS !== 'android') return false;
  if (_running) return true;

  try {
    await ensureChannel();
    registerRunnerOnce();

    _running = true;

    await notifee.displayNotification({
      id:    NOTIF_ID,
      title: 'SkyUp CRM — Auto-upload active',
      body:  'Call recordings upload automatically after each call.',
      android: {
        channelId:            CHANNEL_ID,
        asForegroundService:  true,
        // ✅ FIX — explicit long-running type instead of Notifee's default
        // "shortService" (which force-kills the app after 3 minutes).
        foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
        ongoing:              true,
        smallIcon:            'ic_launcher',   // falls back to app icon
        importance:           AndroidImportance.LOW,
        pressAction:          { id: 'default' },
        // Keep it quiet & non-removable so the OS treats the app as active.
        onlyAlertOnce:        true,
      },
    });

    console.log('[autoUpload] ✅ Foreground service started');
    return true;
  } catch (e) {
    _running = false;
    console.warn('[autoUpload] Failed to start foreground service:', e.message);
    return false;
  }
}

// ── Stop the foreground service ───────────────────────────────────────────────
export async function stopAutoUploadService() {
  if (Platform.OS !== 'android') return;
  try {
    _running = false;               // lets the registered runner resolve
    await notifee.stopForegroundService();
    try { await notifee.cancelNotification(NOTIF_ID); } catch {}
    console.log('[autoUpload] 🛑 Foreground service stopped');
  } catch (e) {
    console.warn('[autoUpload] Failed to stop foreground service:', e.message);
  }
}

// ── Public toggle used by the in-app setting ──────────────────────────────────
// Persists the choice AND applies it immediately.
export async function setAutoUpload(enabled) {
  await setAutoUploadPref(enabled);
  if (enabled) await startAutoUploadService();
  else         await stopAutoUploadService();
  return enabled;
}

// ── Init on app start — apply the saved preference ────────────────────────────
// Call this once after login/startup (App.js). Starts the service only if the
// user has it enabled (default ON).
export async function initAutoUploadService() {
  if (Platform.OS !== 'android') return;
  const enabled = await isAutoUploadEnabled();
  if (enabled) await startAutoUploadService();
}

export function isAutoUploadServiceRunning() {
  return _running;
}