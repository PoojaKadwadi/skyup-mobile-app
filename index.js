// ── 1. Notifee background handler — MUST be first ────────────────────────────
try {
  const notifee = require('@notifee/react-native').default;
  const { EventType } = require('@notifee/react-native');
  notifee.onBackgroundEvent(async ({ type, detail }) => {
    if (type === EventType.PRESS) {
      const notification = detail.notification;
      if (!notification) return;
      try {
        const { navigationRef } = require('./App');
        const nav = navigationRef?.current;
        if (!nav) return;
        const id = notification.id || '';
        nav.navigate('Main');
        if (id.startsWith('followup_')) {
          const leadId = notification.android?.pressAction?.input;
          if (leadId) setTimeout(() => nav.navigate('LeadDetail', { leadId }), 200);
          else        setTimeout(() => nav.navigate('Leads'), 200);
        } else if (id.startsWith('new_leads_') || id.startsWith('reassigned_') || id.startsWith('socket_lead_')) {
          setTimeout(() => nav.navigate('Leads'), 200);
        }
      } catch { /* navigation not ready — ignore */ }
    }
  });
} catch {
  // @notifee/react-native not installed — silently skip
}

// ── 1b. Firebase background message handler — MUST be registered here ────────
// Firebase requires setBackgroundMessageHandler to be called at the module
// level BEFORE any component mounts. Skipping this means FCM messages received
// while the app is killed are silently dropped on Android.
//
// FIX BUG 5: The previous implementation used a dynamic require() to import
// displayFCMNotification from fcmTokenService at handler call-time. This is
// unreliable in Firebase's headless JS context (the separate thread that runs
// when the app is fully killed): the module may not be in the headless bundle,
// causing the require() to throw, which was silently swallowed by the catch —
// meaning killed-app FCM notifications were never shown.
//
// Fix: inline the notifee display logic directly here. The headless context
// always has access to modules that are require()'d at the top level of index.js,
// but NOT to lazily-loaded app modules. Keeping the logic self-contained in
// this file is the only reliable approach.
try {
  const messaging = require('@react-native-firebase/messaging').default;

  // Pre-load notifee at module level so it is guaranteed to be in the bundle
  // when the headless handler fires (dynamic require inside the handler is risky).
  const _notifee = (() => {
    try {
      const mod = require('@notifee/react-native');
      const n = mod.default ?? mod;
      return typeof n?.displayNotification === 'function' ? n : null;
    } catch { return null; }
  })();

  const _AndroidImportance = (() => {
    try {
      const mod = require('@notifee/react-native');
      return mod.AndroidImportance ?? mod.default?.AndroidImportance ?? null;
    } catch { return null; }
  })();

  const IMPORTANCE_HIGH = _AndroidImportance?.HIGH ?? 4;
  const CHANNEL_ID = 'new_lead_channel_v2';

  messaging().setBackgroundMessageHandler(async (remoteMessage) => {
    console.log('[FCM] Background message received:', remoteMessage.data?.type);

    if (!_notifee || !remoteMessage?.data?.type) return;

    const data = remoteMessage.data;

    try {
      // Ensure the channel exists — createChannel is idempotent (safe to call
      // multiple times; Android ignores duplicate registrations).
      await _notifee.createChannel({
        id:         CHANNEL_ID,
        name:       'New Lead Assigned',
        importance: IMPORTANCE_HIGH,
        sound:      'default',
        vibration:  true,
      });

      if (data.type === 'new_lead') {
        await _notifee.displayNotification({
          id:    `fcm_new_lead_${data.leadId || Date.now()}`,
          title: '🎯 New Lead Assigned',
          body:  `${data.leadName || 'New Lead'}${data.leadSource ? ' via ' + data.leadSource : ''}`,
          android: {
            channelId:   CHANNEL_ID,
            importance:  IMPORTANCE_HIGH,
            smallIcon:   'ic_notification',
            pressAction: { id: 'open_leads' },
          },
          ios: {
            sound: 'default',
            foregroundPresentationOptions: { alert: true, sound: true, badge: false },
          },
        });
      } else if (data.type === 'reassigned_lead') {
        await _notifee.displayNotification({
          id:    `fcm_reassigned_${data.leadId || Date.now()}`,
          title: '🔄 Lead Reassigned to You',
          body:  `${data.leadName || 'Lead'} has been assigned to you`,
          android: {
            channelId:   CHANNEL_ID,
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
      console.warn('[FCM] Background display error:', e.message);
    }
  });
} catch {
  // @react-native-firebase/messaging not installed — silently skip
  // (Run: npm install @react-native-firebase/app @react-native-firebase/messaging)
}

// ── 2. App registration ───────────────────────────────────────────────────────
const { AppRegistry } = require('react-native');
const App = require('./App').default;
const { name: appName } = require('./app.json');
AppRegistry.registerComponent(appName, () => App);

// ── 3. Background sync headless task ─────────────────────────────────────────
try {
  const { headlessTask } = require('./src/services/backgroundSyncService');
  if (typeof headlessTask === 'function') {
    AppRegistry.registerHeadlessTask('BackgroundFetch', () => headlessTask);
  }
} catch {
  // backgroundSyncService may not export headlessTask — safe to skip
}