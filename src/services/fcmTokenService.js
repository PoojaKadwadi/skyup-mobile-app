// src/services/fcmTokenService.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX (this revision) — user-scoped FCM token storage:
//
//   FCM_TOKEN_STORAGE_KEY and FCM_TOKEN_CONFIRMED_KEY were global keys.
//   On a shared device, User B would see User A's confirmed token, skip
//   re-registration, and stay mapped to User A's token on the backend —
//   meaning User A's push notifications could reach User B's device.
//
//   Fix: both keys are now scoped to the current userId (read lazily from
//   the Redux store). clearFCMToken() clears the scoped key for the current
//   user. The legacy global keys are cleared on first use (one-time migration).
//
// ALL OTHER BEHAVIOUR RETAINED (refresh listener, background handler,
//   displayFCMNotification, getFCMNavigationTarget,
//   registerFCMNotificationOpenHandlers).
// ─────────────────────────────────────────────────────────────────────────────

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from './api';

// Legacy global keys — cleared on first use.
const LEGACY_TOKEN_KEY     = 'registered_fcm_token';
const LEGACY_CONFIRMED_KEY = 'registered_fcm_token_confirmed';

// ── User-scoped key helpers ───────────────────────────────────────────────────
function getScopedTokenKey() {
  try {
    const { store } = require('../store');
    const userId = store.getState()?.auth?.user?._id || store.getState()?.auth?.user?.id || 'anon';
    return `fcm_token_${userId}`;
  } catch {
    return LEGACY_TOKEN_KEY;
  }
}
function getScopedConfirmedKey() {
  try {
    const { store } = require('../store');
    const userId = store.getState()?.auth?.user?._id || store.getState()?.auth?.user?.id || 'anon';
    return `fcm_confirmed_${userId}`;
  } catch {
    return LEGACY_CONFIRMED_KEY;
  }
}

// ── Safe import — app will not crash if firebase is not installed yet ─────────
let messaging = null;
try {
  messaging = require('@react-native-firebase/messaging').default;
  // CRASH FIX: if the APK was built WITHOUT android/app/google-services.json,
  // Firebase has no default app and every messaging() call throws
  // "No Firebase App '[DEFAULT]' has been created" — uncaught, that closed the
  // app on launch. Treat that exactly like "Firebase not installed": push
  // notifications are simply off, everything else keeps working.
  try {
    const firebaseApp = require('@react-native-firebase/app').default;
    if (!firebaseApp || !Array.isArray(firebaseApp.apps) || firebaseApp.apps.length === 0) {
      console.warn('[FCMToken] Firebase not configured (google-services.json missing) — push notifications disabled.');
      messaging = null;
    }
  } catch (_) {
    messaging = null;
  }
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
    await AsyncStorage.setItem(getScopedTokenKey(), token);
    await AsyncStorage.setItem(getScopedConfirmedKey(), 'true');
    // Also clear any legacy global keys so they don't confuse future sessions
    await AsyncStorage.multiRemove([LEGACY_TOKEN_KEY, LEGACY_CONFIRMED_KEY]).catch(() => {});
    console.log('[FCMToken] ✅ Token registered with backend:', token.slice(0, 20) + '...');
  } catch (err) {
    console.error(
      '[FCMToken] ❌ Failed to send token to backend.',
      'Status:', err.response?.status,
      'Body:', JSON.stringify(err.response?.data),
      'Message:', err.message,
    );
    // Do NOT set the token/confirmed keys here — forces retry on next call.
  }
}

export async function registerFCMToken() {
  if (!messaging) return;

  try {
    const authStatus = await messaging().requestPermission();
    const enabled =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;

    if (!enabled) {
      console.warn('[FCMToken] Notification permission not granted (status:', authStatus, ')');
    }

    const token = await messaging().getToken();
    if (!token) {
      console.warn('[FCMToken] getToken() returned null — is google-services.json present?');
      return;
    }

    const storedToken = await AsyncStorage.getItem(getScopedTokenKey());
    const confirmed   = await AsyncStorage.getItem(getScopedConfirmedKey());

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

  try {
    const unsubscribe = messaging().onTokenRefresh(async (newToken) => {
      console.log('[FCMToken] Token refreshed — updating backend');
      await AsyncStorage.removeItem(getScopedConfirmedKey()).catch(() => {});
      await sendTokenToBackend(newToken);
    });
    return unsubscribe;
  } catch (e) {
    console.warn('[FCMToken] onTokenRefresh unavailable:', e.message);
    return () => {};
  }
}

export async function clearFCMToken() {
  try {
    await AsyncStorage.multiRemove([
      getScopedTokenKey(),
      getScopedConfirmedKey(),
      LEGACY_TOKEN_KEY,
      LEGACY_CONFIRMED_KEY,
    ]);
  } catch {}
}

// FIX: exported so index.js background handler can call it when app is killed.
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
        data:  { type: data.type, leadId: data.leadId },
        android: {
          channelId:   'new_lead_channel_v2',
          importance:  IMPORTANCE_HIGH,
          smallIcon:   'ic_notification',
          pressAction: { id: 'open_leads' },
        },
        ios: {
          sound: 'default',
          foregroundPresentationOptions: { alert: true, sound: true, badge: false },
        },
      });
    } else if (data.type === 'scheduled_call_reminder') {
      // FOLLOW-UP PING FIX: with the app OPEN, Android does not show FCM
      // notifications by itself — this type used to be silently dropped.
      // Same id as the on-device follow-up check → never shown twice.
      await notifee.displayNotification({
        id:    data.scheduledAt ? `followup_${data.leadId}_${data.scheduledAt}` : `fcm_followup_${data.leadId}`,
        title: data.title || `📞 Call back — "${data.leadName || 'Lead'}"`,
        body:  data.body  || 'Your scheduled follow-up is due.',
        data:  { type: data.type, leadId: data.leadId },
        android: {
          channelId:   'followup_channel_v2',
          importance:  IMPORTANCE_HIGH,
          smallIcon:   'ic_notification',
          pressAction: { id: 'open_lead' },
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
        data:  { type: data.type, leadId: data.leadId },
        android: {
          channelId:   'new_lead_channel_v2',
          importance:  IMPORTANCE_HIGH,
          smallIcon:   'ic_notification',
          pressAction: { id: 'open_leads' },
        },
        ios: {
          sound: 'default',
          foregroundPresentationOptions: { alert: true, sound: true, badge: false },
        },
      });
    }
  } catch (e) {
    console.warn('[FCMToken] displayFCMNotification error:', e.message);
  }
}

export function handleFCMBackgroundMessages() {
  if (!messaging) return;
  console.log('[FCMToken] Background handler is managed by index.js — skipping duplicate registration');
}

export function startFCMForegroundListener() {
  if (!messaging) return () => {};

  try {
    const unsubscribe = messaging().onMessage(async (remoteMessage) => {
      console.log('[FCMToken] Foreground FCM message received:', remoteMessage.data?.type);
      try { await displayFCMNotification(remoteMessage.data); } catch (_) { /* ignore */ }
    });
    return unsubscribe;
  } catch (e) {
    console.warn('[FCMToken] onMessage unavailable:', e.message);
    return () => {};
  }
}

export function getFCMNavigationTarget(data) {
  if (!data?.type) return null;

  switch (data.type) {
    case 'new_lead':
    case 'reassigned_lead':
    case 'lead_reassigned_notify':
      return data.leadId
        ? { screen: 'LeadDetail', params: { leadId: data.leadId } }
        : { screen: 'Leads' };

    case 'scheduled_call_reminder':
      return data.leadId
        ? { screen: 'LeadDetail', params: { leadId: data.leadId, highlightFollowUp: true } }
        : { screen: 'Leads' };

    case 'follow_up_alert':
    case 'no_action_alert':
    case 'no_followup_alert': {
      const ids = String(data.leadIds || '').split(',').map(s => s.trim()).filter(Boolean);
      const isFollowUpRelated = data.type === 'follow_up_alert' || data.type === 'no_followup_alert';
      return ids.length === 1
        ? { screen: 'LeadDetail', params: { leadId: ids[0], ...(isFollowUpRelated ? { highlightFollowUp: true } : {}) } }
        : { screen: 'Leads' };
    }

    case 'wa_inbound_message':
      return data.leadId
        ? { screen: 'LeadDetail', params: { leadId: data.leadId } }
        : { screen: 'Leads' };

    case 'escalation_alert':
      return { screen: 'Leads' };

    default:
      return null;
  }
}

export function registerFCMNotificationOpenHandlers(navigationRef) {
  if (!messaging) return () => {};

  const navigate = (screen, params) => {
    const nav = navigationRef?.current;
    if (!nav) return;
    nav.navigate('Main');
    if (screen !== 'Main') {
      setTimeout(() => nav.navigate(screen, params), 120);
    }
  };

  const handleOpen = (remoteMessage) => {
    const target = getFCMNavigationTarget(remoteMessage?.data);
    if (target) navigate(target.screen, target.params);
  };

  try {
    const unsubscribeOpened = messaging().onNotificationOpenedApp(handleOpen);
    messaging()
      .getInitialNotification()
      .then(remoteMessage => { if (remoteMessage) handleOpen(remoteMessage); })
      .catch(e => console.warn('[FCMToken] getInitialNotification error:', e.message));
    return unsubscribeOpened;
  } catch (e) {
    console.warn('[FCMToken] notification-open handlers unavailable:', e.message);
    return () => {};
  }
}
