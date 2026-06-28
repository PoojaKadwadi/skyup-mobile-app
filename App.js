// App.js — Root component
//
// PERFORMANCE FIXES:
//  1. enableScreens() called at the top — required for react-native-screens
//     to activate native screen containers. Without this, even native-stack
//     uses JS View wrappers and loses most of its performance benefit.
//
//  2. NavigationContainer theme set explicitly so background color is
//     correct during transitions — prevents white flash between screens.
//
// REAL-TIME SOCKET FIX:
//  3. Socket.IO connection added on login
//  4. Socket disconnected on logout/unmount
//  5. Backend pushes new_lead_assigned events instantly

import React, { useEffect, useRef } from 'react';
import { StatusBar, View, ActivityIndicator, StyleSheet, InteractionManager } from 'react-native';

import { Provider, useSelector, useDispatch } from 'react-redux';

import { PersistGate } from 'redux-persist/integration/react';

import {
  NavigationContainer,
  DarkTheme,
} from '@react-navigation/native';

import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { SafeAreaProvider } from 'react-native-safe-area-context';

import { enableScreens } from 'react-native-screens';

import { store, persistor } from './src/store';

import AppNavigator from './src/navigation/AppNavigator';

import ErrorBoundary from './src/components/ErrorBoundary';

import {
  startBackgroundSync,
  stopBackgroundSync,
} from './src/services/backgroundSyncService';

import {
  setupNotifications,
  registerNotificationHandlers,
  clearNotificationState,
} from './src/services/notificationService';

import {
  startCallStateListener,
  stopCallStateListener,
} from './src/services/callStateService';

import { drainOfflineQueue } from './src/services/callSyncService';

import {
  requestContactsPermission,
  requestWriteContactsPermission,
  requestLocationPermission,
} from './src/services/permissionsService';

import {
  startCallDetector,
  stopCallDetector,
} from './src/services/callDetector';

// ✅ NEW — auto-upload foreground service (keeps app alive for post-call upload)
import { initAutoUploadService, stopAutoUploadService } from './src/services/autoUploadService';

// ✅ NEW — socket service
import {
  connectSocket,
  disconnectSocket,
} from './src/services/socketService';

// ✅ FIX BUG 1 & 2 — FCM token registration
// Obtains the device push token and sends it to the backend so FCM
// notifications (new lead, reassigned lead) can actually reach this device.
import {
  registerFCMToken,
  startFCMTokenRefreshListener,
  startFCMForegroundListener,
  clearFCMToken,
  handleFCMBackgroundMessages,
} from './src/services/fcmTokenService';

// Register background FCM handler at module level (required by Firebase
// BEFORE any component mounts — missing this drops messages when app is killed)
handleFCMBackgroundMessages();

// ✅ Activate native screen containers globally
enableScreens(true);

export const navigationRef = React.createRef();

// ✅ Dark theme prevents white flash during transitions
const NAV_THEME = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: '#0D0F14',
    card: '#1A1D27',
    border: '#262A38',
    text: '#F0F2FA',
  },
};

function PersistLoadingScreen() {
  return (
    <View style={splashStyles.root}>
      <ActivityIndicator
        color="#2563EB"
        size="large"
      />
    </View>
  );
}

const splashStyles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0D0F14',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

function AppManager() {
  const user = useSelector(
    state => state.auth.user
  );

  // ✅ NEW
  const dispatch = useDispatch();

  const handlersRegistered = useRef(false);
  // ✅ FIX BUG 1 — store unsubscribe fn for token refresh listener
  const fcmRefreshUnsub = useRef(null);
  // ✅ FIX — store unsubscribe fn for FCM foreground listener
  const fcmForegroundUnsub = useRef(null);

  useEffect(() => {
    if (user) {
      // PERF: defer heavy startup work (notifications, FCM, background sync,
      // socket, permission prompts) until AFTER the first screen has painted.
      // Running it all synchronously on mount competed with the initial render
      // and made the app feel slow to open. InteractionManager lets the UI show
      // first, then these services spin up a tick later.
      const startupTask = InteractionManager.runAfterInteractions(() => {
      (async () => {
        try {
          // ✅ Notifications MUST finish first
          await setupNotifications();
        } catch (e) {
          console.warn(
            '[App] Notification setup failed:',
            e?.message
          );
        }

        // ✅ FIX BUG 1 & 2 — Register FCM token with backend after login
        // This is what makes sendNewLeadNotification / sendReassignedLeadNotification
        // actually reach this device. Without this, fcmService.js finds
        // user.fcmToken === null and silently returns without sending anything.
        registerFCMToken().catch(e =>
          console.warn('[App] FCM token registration failed:', e?.message)
        );

        // ✅ FIX BUG 1 — Keep token fresh if Firebase rotates it
        if (fcmRefreshUnsub.current) {
          fcmRefreshUnsub.current(); // clean up any previous listener
        }
        fcmRefreshUnsub.current = startFCMTokenRefreshListener();

        // ✅ FIX — Start FCM foreground listener so push notifications display
        // while the app is open. Without this, arriving FCM messages while in
        // foreground are silently dropped — no banner, no sound, nothing.
        if (fcmForegroundUnsub.current) {
          fcmForegroundUnsub.current();
        }
        fcmForegroundUnsub.current = startFCMForegroundListener();

        // ✅ Start background sync after notifications
        startBackgroundSync();

        // ✅ Request Contacts & Location permissions
        requestContactsPermission().catch(() => {});
        requestWriteContactsPermission().catch(() => {});
        requestLocationPermission().catch(() => {});

        // ✅ NEW — Connect socket for real-time lead updates
        const userId =
          user?._id || user?.id;

        if (userId) {
          connectSocket(userId, dispatch);
        }
      })();
      });

      // ✅ Call state listener before detector
      startCallStateListener();

      startCallDetector().catch(e =>
        console.warn(
          '[App] callDetector start failed:',
          e?.message
        )
      );

      // ✅ Auto-upload foreground service — keeps the app alive so post-call
      // recording upload runs reliably on aggressive OEMs (ColorOS etc.).
      // Honors the user's in-app toggle (default ON); no-op if they turned it off.
      initAutoUploadService().catch(e =>
        console.warn('[App] autoUpload init failed:', e?.message)
      );

      // ✅ Drain queued offline calls
      drainOfflineQueue().catch(() => {});

      // ✅ Register notification handlers once
      if (!handlersRegistered.current) {
        registerNotificationHandlers(
          navigationRef
        );

        handlersRegistered.current = true;
      }
    } else {
      // ✅ Cleanup on logout
      stopBackgroundSync();

      stopCallStateListener();

      stopCallDetector();

      // Stop the auto-upload foreground service (removes the ongoing notification)
      stopAutoUploadService().catch(() => {});

      clearNotificationState().catch(() => {});

      // ✅ FIX BUG 1 — clear stored FCM token so next login re-registers
      clearFCMToken().catch(() => {});

      // ✅ FIX BUG 1 — stop token refresh listener
      if (fcmRefreshUnsub.current) {
        fcmRefreshUnsub.current();
        fcmRefreshUnsub.current = null;
      }

      // ✅ FIX — stop FCM foreground listener
      if (fcmForegroundUnsub.current) {
        fcmForegroundUnsub.current();
        fcmForegroundUnsub.current = null;
      }

      // ✅ NEW — disconnect socket
      disconnectSocket();

      handlersRegistered.current = false;
    }

    // ✅ Cleanup on unmount
    return () => {
      stopBackgroundSync();

      stopCallStateListener();

      stopCallDetector();

      // ✅ NEW
      disconnectSocket();

      // ✅ FIX BUG 1 — stop token refresh listener on unmount
      if (fcmRefreshUnsub.current) {
        fcmRefreshUnsub.current();
        fcmRefreshUnsub.current = null;
      }
    };
  }, [user, dispatch]);

  return null;
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <Provider store={store}>
          <PersistGate
            loading={<PersistLoadingScreen />}
            persistor={persistor}
          >
            <NavigationContainer
              ref={navigationRef}
              theme={NAV_THEME}
              onReady={() => {
                // Handle notification taps when app was closed
                try {
                  const notifee =
                    require('@notifee/react-native')
                      .default;

                  notifee
                    .getInitialNotification()
                    .then(initial => {
                      if (!initial?.notification)
                        return;

                      const n =
                        initial.notification;

                      const nav =
                        navigationRef.current;

                      if (!nav) return;

                      nav.navigate('Main');

                      if (
                        n.id?.startsWith(
                          'followup_'
                        )
                      ) {
                        const leadId =
                          n.data?.leadId;

                        if (leadId) {
                          setTimeout(() => {
                            nav.navigate(
                              'LeadDetail',
                              { leadId }
                            );
                          }, 150);
                        } else {
                          setTimeout(() => {
                            nav.navigate(
                              'Leads'
                            );
                          }, 150);
                        }
                      } else {
                        setTimeout(() => {
                          nav.navigate('Leads');
                        }, 150);
                      }
                    })
                    .catch(() => {});
                } catch {}
              }}
            >
              <StatusBar
                barStyle="light-content"
                backgroundColor="#0F172A"
              />

              <AppManager />

              <ErrorBoundary>
                <AppNavigator />
              </ErrorBoundary>
            </NavigationContainer>
          </PersistGate>
        </Provider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}