// src/services/deviceInfoService.js
// ─────────────────────────────────────────────────────────────────────────────
//  DEVICE / APP INFO SERVICE
//
//  Collects device + app metadata to send to the CRM backend on login and
//  clock-in. Hardened against release-build crashes:
//
//   • NO dynamic require() of optional native packages. Metro bundles every
//     require() statically at build time — wrapping it in try/catch does NOT
//     prevent the module from being loaded in release builds, and native
//     crashes (e.g. Firebase initialising without google-services.json) bypass
//     the JS try/catch entirely.
//
//   • FCM token is read ONLY from AsyncStorage cache. If/when Firebase
//     Messaging is wired up properly, do it ONCE at app startup in App.js
//     with a top-level static import, and write the resulting token into
//     AsyncStorage under the key 'fcm_token'. This file then reads the cache.
//
//   • Every Platform.* access is wrapped — survives unexpected RN versions
//     and never throws. The function returns sensible defaults on any failure
//     so loginUser() can always proceed.
// ─────────────────────────────────────────────────────────────────────────────

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { name as appName, version as appVersion } from '../../app.json';

const FCM_TOKEN_KEY = 'fcm_token';


async function getCachedFcmToken() {
  try {
    return await AsyncStorage.getItem(FCM_TOKEN_KEY);
  } catch (e) {
    console.warn('[deviceInfo] AsyncStorage read failed:', e?.message);
    return null;
  }
}


export async function getDeviceInfo() {
  // Safe defaults — returned as-is if every later step somehow fails.
  const info = {
    appName    : appName    || 'SkyUp CRM',
    appVersion : appVersion || '1.0.0',
    platform   : 'unknown',
    deviceModel: null,
    osVersion  : '',
    fcmToken   : null,
  };

  // Each Platform.* call wrapped — defensive against future RN changes.
  try {
    info.platform = Platform.OS;                                 // 'android' | 'ios'
  } catch (e) {
    console.warn('[deviceInfo] Platform.OS read failed:', e?.message);
  }

  try {
    info.deviceModel =
      Platform.constants?.Model ||                               // Android: "Pixel 7"
      Platform.constants?.systemName ||                          // iOS: "iPhone OS"
      Platform.OS;
  } catch (e) {
    console.warn('[deviceInfo] deviceModel read failed:', e?.message);
  }

  try {
    info.osVersion = String(
      Platform.Version ??                                        // Android: 33, iOS: "17.4"
      Platform.constants?.osVersion ??
      ''
    );
  } catch (e) {
    console.warn('[deviceInfo] osVersion read failed:', e?.message);
  }

  // getCachedFcmToken() swallows its own errors — safe to await directly.
  info.fcmToken = await getCachedFcmToken();

  return info;
}