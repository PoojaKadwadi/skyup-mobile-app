// App.js — Root component
//
// FIXES (this revision):
//  FIX 1 — startup race condition (InteractionManager never cancelled):
//    The `startupTask` from InteractionManager.runAfterInteractions was created
//    but NEVER cancelled. If the user logged out while the interactions were
//    still settling (fast login→logout, or a slow first render), the deferred
//    async function would still fire and start FCM, background sync, socket,
//    and other authenticated services for a user who was already logged out.
//    Fix: store the task ref and cancel it in the else (logout) branch and in
//    the effect cleanup. Also guard the inner async fn with a currentUser check
//    before starting any service.
//
//  FIX 2 — api.js 401 handler needs store & nav references:
//    api.js now exports `_injectStoreAndNav()` so the response interceptor can
//    dispatch forceLogout and navigate to Login on a genuine 401. Both refs are
//    injected once on first render (before any API call can fire).
//
//  ALL PREVIOUS FIXES RETAINED.

import React, { useEffect, useMemo, useRef } from 'react';
import { StatusBar, View, ActivityIndicator, StyleSheet, InteractionManager, AppState, BackHandler } from 'react-native';

import { Provider, useSelector, useDispatch } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enableScreens } from 'react-native-screens';

import { store, persistor } from './src/store';
import { resetLeadFilters } from './src/store/slices/leadsSlice';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import AppNavigator from './src/navigation/AppNavigator';
import ErrorBoundary from './src/components/ErrorBoundary';

import { startBackgroundSync, stopBackgroundSync } from './src/services/backgroundSyncService';
import { setupNotifications, registerNotificationHandlers, clearNotificationState, resetBadgeCount } from './src/services/notificationService';
import { startCallStateListener, stopCallStateListener } from './src/services/callStateService';
import { drainOfflineQueue } from './src/services/callSyncService';
import { warmUpBackend, _injectStoreAndNav } from './src/services/api';
import { requestContactsPermission, requestWriteContactsPermission, requestLocationPermission } from './src/services/permissionsService';
import { startCallDetector, stopCallDetector } from './src/services/callDetector';
import { initAutoUploadService, stopAutoUploadService } from './src/services/autoUploadService';
import { connectSocket, disconnectSocket } from './src/services/socketService';
import {
  registerFCMToken, startFCMTokenRefreshListener, startFCMForegroundListener,
  registerFCMNotificationOpenHandlers, clearFCMToken, handleFCMBackgroundMessages,
} from './src/services/fcmTokenService';

// Register background FCM handler at module level (required BEFORE any component mounts)
handleFCMBackgroundMessages();

enableScreens(true);

export const navigationRef = React.createRef();

function buildNavTheme(colors) {
  return {
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      background: colors.bg,
      card:       colors.surface,
      border:     colors.border,
      text:       colors.textPrimary,
      primary:    colors.blue,
    },
  };
}

function PersistLoadingScreen() {
  const { colors } = useTheme();
  return (
    <View style={[splashStyles.root, { backgroundColor: colors.bg }]}>
      <ActivityIndicator color={colors.blue} size="large" />
    </View>
  );
}

const splashStyles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function AppManager() {
  const user     = useSelector(state => state.auth.user);
  const dispatch = useDispatch();

  const handlersRegistered  = useRef(false);
  const fcmRefreshUnsub     = useRef(null);
  const fcmForegroundUnsub  = useRef(null);
  const fcmOpenUnsub        = useRef(null);
  // FIX 1: track the startup task so we can cancel it
  const startupTaskRef      = useRef(null);

  // FIX 2: inject store + nav ref into api.js so 401 can dispatch forceLogout
  useEffect(() => {
    _injectStoreAndNav(store, navigationRef);
  }, []);

  // Warm up Render free-tier backend on first launch
  useEffect(() => { warmUpBackend(); }, []);

  // ── Clear Leads search/filters when the app is closed ─────────────────────
  // Filters used to survive "closing" the app because Android rarely kills the
  // process (the auto-upload foreground service keeps it alive), so the Redux
  // search text + status filter were still there on reopen.
  // Cleared when:
  //   1. the app UI starts fresh (swiped away from Recents, or restarted),
  //   2. the user exits with the Back button from the first screen,
  //   3. the app comes back after a long time in the background.
  // A normal phone call (short background) does NOT clear them, so an agent
  // working through a filtered list keeps their place between calls.
  useEffect(() => {
    store.dispatch(resetLeadFilters());                                  // 1
    resetBadgeCount().catch(() => {}); // opening the app clears the stored badge total

    const backSub = BackHandler.addEventListener('hardwareBackPress', () => {
      const nav = navigationRef.current;
      if (nav && !nav.canGoBack()) store.dispatch(resetLeadFilters());  // 2
      return false; // never block the normal back behaviour
    });

    const LONG_BACKGROUND_MS = 30 * 60 * 1000;                           // 3
    let backgroundAt = 0;
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'background') backgroundAt = Date.now();
      if (s === 'active') resetBadgeCount().catch(() => {});
      if (s === 'active' && backgroundAt) {
        if (Date.now() - backgroundAt >= LONG_BACKGROUND_MS) store.dispatch(resetLeadFilters());
        backgroundAt = 0;
      }
    });

    return () => { backSub.remove(); appSub.remove(); };
  }, []);

  useEffect(() => {
    if (user) {
      // FIX 1: cancel any previous task before creating a new one
      if (startupTaskRef.current) {
        startupTaskRef.current.cancel();
        startupTaskRef.current = null;
      }

      // Capture `user` snapshot at dispatch time so the async callback
      // can verify the session is still valid before starting services.
      const capturedUserId = user?._id || user?.id;

      const startupTask = InteractionManager.runAfterInteractions(() => {
        (async () => {
          // FIX 1: guard — if user logged out while interactions were settling,
          // do not start any authenticated service.
          const currentUser = store.getState().auth?.user;
          if (!currentUser) {
            console.log('[App] Startup task aborted — user logged out during interaction wait');
            return;
          }

          try { await setupNotifications(); } catch (e) {
            console.warn('[App] Notification setup failed:', e?.message);
          }

          registerFCMToken().catch(e => console.warn('[App] FCM token registration failed:', e?.message));

          if (fcmRefreshUnsub.current) fcmRefreshUnsub.current();
          fcmRefreshUnsub.current = startFCMTokenRefreshListener();

          if (fcmForegroundUnsub.current) fcmForegroundUnsub.current();
          fcmForegroundUnsub.current = startFCMForegroundListener();

          if (fcmOpenUnsub.current) fcmOpenUnsub.current();
          fcmOpenUnsub.current = registerFCMNotificationOpenHandlers(navigationRef);

          startBackgroundSync();

          requestContactsPermission().catch(() => {});
          requestWriteContactsPermission().catch(() => {});
          requestLocationPermission().catch(() => {});

          if (capturedUserId) connectSocket(capturedUserId, dispatch);
        })();
      });

      // FIX 1: store so we can cancel if user logs out before it fires
      startupTaskRef.current = startupTask;

      startCallStateListener();
      startCallDetector().catch(e => console.warn('[App] callDetector start failed:', e?.message));
      initAutoUploadService().catch(e => console.warn('[App] autoUpload init failed:', e?.message));
      drainOfflineQueue().catch(() => {});

      if (!handlersRegistered.current) {
        registerNotificationHandlers(navigationRef);
        handlersRegistered.current = true;
      }
    } else {
      // User logged out — cancel the pending startup task immediately so it
      // does NOT start authenticated services after we've cleaned up below.
      if (startupTaskRef.current) {
        startupTaskRef.current.cancel();
        startupTaskRef.current = null;
      }

      // Cleanup all authenticated services
      stopBackgroundSync();
      stopCallStateListener();
      stopCallDetector();
      stopAutoUploadService().catch(() => {});
      clearNotificationState().catch(() => {});
      clearFCMToken().catch(() => {});

      if (fcmRefreshUnsub.current) {
        fcmRefreshUnsub.current();
        fcmRefreshUnsub.current = null;
      }
      if (fcmForegroundUnsub.current) {
        fcmForegroundUnsub.current();
        fcmForegroundUnsub.current = null;
      }
      if (fcmOpenUnsub.current) {
        fcmOpenUnsub.current();
        fcmOpenUnsub.current = null;
      }

      disconnectSocket();
      handlersRegistered.current = false;
    }

    return () => {
      // FIX 1: cancel on effect cleanup (component unmount or user change)
      if (startupTaskRef.current) {
        startupTaskRef.current.cancel();
        startupTaskRef.current = null;
      }
      stopBackgroundSync();
      stopCallStateListener();
      stopCallDetector();
      disconnectSocket();

      if (fcmRefreshUnsub.current) {
        fcmRefreshUnsub.current();
        fcmRefreshUnsub.current = null;
      }
    };
  }, [user, dispatch]);

  return null;
}

function RootNavigation() {
  const { dark, colors } = useTheme();
  const navTheme = useMemo(() => buildNavTheme(colors), [colors]);

  return (
    <NavigationContainer
      ref={navigationRef}
      theme={navTheme}
      onReady={() => {
        // Handle notification taps when app was closed
        try {
          const notifee = require('@notifee/react-native').default;
          notifee.getInitialNotification().then(initial => {
            if (!initial?.notification) return;
            const n = initial.notification;
            const nav = navigationRef.current;
            if (!nav) return;
            nav.navigate('Main');
            if (n.id?.startsWith('followup_')) {
              const leadId = n.data?.leadId;
              if (leadId) {
                setTimeout(() => nav.navigate('LeadDetail', { leadId }), 150);
              } else {
                setTimeout(() => nav.navigate('Leads'), 150);
              }
            } else {
              setTimeout(() => nav.navigate('Leads'), 150);
            }
          }).catch(() => {});
        } catch {}
      }}
    >
      <StatusBar
        barStyle={dark ? 'light-content' : 'dark-content'}
        backgroundColor={colors.surface}
      />
      <AppManager />
      <ErrorBoundary>
        <AppNavigator />
      </ErrorBoundary>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <Provider store={store}>
            <PersistGate loading={<PersistLoadingScreen />} persistor={persistor}>
              <RootNavigation />
            </PersistGate>
          </Provider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
