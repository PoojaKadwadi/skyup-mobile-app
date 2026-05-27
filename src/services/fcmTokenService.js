// src/services/fcmTokenService.js


import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from './api';

const FCM_TOKEN_STORAGE_KEY   = 'registered_fcm_token';
// Separate flag that marks the token was CONFIRMED saved on the backend.
// If sendTokenToBackend() fails (e.g. 403), we never set this flag, so the
// next app launch will retry instead of silently skipping.
const FCM_TOKEN_CONFIRMED_KEY = 'registered_fcm_token_confirmed';

// ── Safe import — app will not crash if firebase is not installed yet ─────────
let messaging = null;
try {
  messaging = require('@react-native-firebase/messaging').default;
} catch (e) {
  console.warn(
    '[FCMToken] @react-native-firebase/messaging not installed.\n' +
    'Run: npm install @react-native-firebase/app @react-native-firebase/messaging\n' +
    'Then add google-services.json to android/app/ and apply the google-services plugin.\n' +
    'Error:', e.message
  );
}

// ── Register FCM token with backend ──────────────────────────────────────────
async function sendTokenToBackend(token) {
  try {
    await api.patch('/auth/update-device', { fcmToken: token });
    await AsyncStorage.setItem(FCM_TOKEN_STORAGE_KEY, token);
    await AsyncStorage.setItem(FCM_TOKEN_CONFIRMED_KEY, 'true');
    console.log('[FCMToken] ✅ Token registered with backend:', token.slice(0, 20) + '...');
  } catch (err) {
    // ── Detailed error log so you can see the exact HTTP status in Logcat ────
    // If you see 403 here → the JWT role is not "user"/"employee" — fix
    //   authMiddleware.js to allow your role, or check the user's role in DB.
    // If you see 401 → token expired or not attached — check api.js interceptor.
    // If you see Network Error → backend is unreachable.
    console.error(
      '[FCMToken] ❌ Failed to send token to backend.' ,
      'Status:', err.response?.status,
      'Body:', JSON.stringify(err.response?.data),
      'Message:', err.message,
    );
    // Do NOT set FCM_TOKEN_STORAGE_KEY or FCM_TOKEN_CONFIRMED_KEY here.
    // This forces a retry on the next registerFCMToken() call instead of
    // silently assuming the backend has the token when it doesn't.
  }
}


export async function registerFCMToken() {
  if (!messaging) return;

  try {
    // ── Request permission (required on iOS and Android 13+) ────────────────
    const authStatus = await messaging().requestPermission();
    const enabled =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;

    if (!enabled) {
      console.warn('[FCMToken] Notification permission not granted (status:', authStatus, ')');
      // Don't return — on Android < 13 permission is implicitly granted and
      // requestPermission() may return AUTHORIZED even without a user prompt.
    }

    // ── Get FCM token ────────────────────────────────────────────────────────
    const token = await messaging().getToken();
    if (!token) {
      console.warn('[FCMToken] getToken() returned null — is google-services.json present?');
      return;
    }

    // ── Only send if token changed AND was previously confirmed on backend ───
    // Old logic: skip if storedToken === token (even if backend never got it).
    // New logic: also require FCM_TOKEN_CONFIRMED_KEY === 'true', so a previous
    // failed sendTokenToBackend() always retries on next login.
    const storedToken = await AsyncStorage.getItem(FCM_TOKEN_STORAGE_KEY);
    const confirmed   = await AsyncStorage.getItem(FCM_TOKEN_CONFIRMED_KEY);

    if (storedToken === token && confirmed === 'true') {
      console.log('[FCMToken] Token confirmed on backend — skipping update');
      return;
    }

    await sendTokenToBackend(token);
  } catch (err) {
    console.warn('[FCMToken] registerFCMToken error:', err.message);
  }
}


export function startFCMTokenRefreshListener() {
  if (!messaging) return () => {};

  const unsubscribe = messaging().onTokenRefresh(async (newToken) => {
    console.log('[FCMToken] Token refreshed — updating backend');
    // Clear confirmed flag so sendTokenToBackend runs unconditionally
    await AsyncStorage.removeItem(FCM_TOKEN_CONFIRMED_KEY).catch(() => {});
    await sendTokenToBackend(newToken);
  });

  return unsubscribe;
}


export async function clearFCMToken() {
  try {
    await AsyncStorage.multiRemove([FCM_TOKEN_STORAGE_KEY, FCM_TOKEN_CONFIRMED_KEY]);
  } catch {}
}


// FIX: exported so index.js background handler can call it when app is killed.
// Previously private (_displayFCMNotification) — background handler had no way
// to call it, so killed-app notifications were silently dropped.
export async function displayFCMNotification(data) {
  if (!data?.type) return;
  try {
    let notifee = null;
    let AndroidImportance = null;
    try {
      const mod = require('@notifee/react-native');
      notifee = mod.default ?? mod;
      AndroidImportance = mod.AndroidImportance ?? mod.default?.AndroidImportance;
    } catch { return; }

    if (typeof notifee?.displayNotification !== 'function') return;

    const IMPORTANCE_HIGH = AndroidImportance?.HIGH ?? 4;

    if (data.type === 'new_lead') {
      await notifee.displayNotification({
        id:    `fcm_new_lead_${data.leadId}`,
        title: '🎯 New Lead Assigned',
        body:  `${data.leadName}${data.leadSource ? ' via ' + data.leadSource : ''}`,
        android: {
          channelId:    'new_lead_channel_v2',
          importance:   IMPORTANCE_HIGH,
          smallIcon:    'ic_notification',
          pressAction:  { id: 'open_leads' },
        },
        ios: {
          sound: 'default',
          foregroundPresentationOptions: { alert: true, sound: true, badge: false },
        },
      });
    } else if (data.type === 'reassigned_lead') {
      await notifee.displayNotification({
        id:    `fcm_reassigned_${data.leadId}`,
        title: '🔄 Lead Reassigned to You',
        body:  `${data.leadName} has been assigned to you`,
        android: {
          channelId:    'new_lead_channel_v2',
          importance:   IMPORTANCE_HIGH,
          smallIcon:    'ic_notification',
          pressAction:  { id: 'open_leads' },
        },
        ios: {
          sound: 'default',
          foregroundPresentationOptions: { alert: true, sound: true, badge: false },
        },
      });
    }
  } catch (e) {
    console.warn('[FCMToken] _displayFCMNotification error:', e.message);
  }
}

export function handleFCMBackgroundMessages() {
  // ✅ FIX ISSUE 3: Background handler is now registered in index.js at the
  // module level — that is the ONLY place Firebase allows it to be registered.
  // Calling setBackgroundMessageHandler() here (inside a component or service)
  // would silently overwrite the index.js handler with a no-op, causing
  // background notifications to stop working.
  // This function is kept as a no-op so existing App.js call doesn't break.
  if (!messaging) return;
  console.log('[FCMToken] Background handler is managed by index.js — skipping duplicate registration');
}


export function startFCMForegroundListener() {
  if (!messaging) return () => {};

  const unsubscribe = messaging().onMessage(async (remoteMessage) => {
    console.log('[FCMToken] Foreground FCM message received:', remoteMessage.data?.type);
    // Display via notifee — same as background handler
    await displayFCMNotification(remoteMessage.data);
  });

  return unsubscribe;
}