// src/services/permissionsService.js
// ─────────────────────────────────────────────────────────────────────────────
//  FIX (call button hangs / "app stuck on tap"):
//    This service previously used `react-native-permissions`. On a device with
//    no permissions yet granted, tapping Call awaited that library's
//    requestMultiple() before doing anything else — and any hiccup in its
//    native module left the tap hanging with no dialog and no dialer.
//
//    It now uses React Native's built-in `PermissionsAndroid`, which is part of
//    core RN, is always linked, and cannot hang on a missing/mislinked native
//    module. Every exported function name, argument, and return shape is kept
//    identical, so no other file needs to change.
//
//    PermissionsAndroid result strings:
//      'granted' | 'denied' | 'never_ask_again'
//    `check()` returns a boolean (true = granted). We map 'never_ask_again' to
//    the old "BLOCKED" behaviour (offer to open Settings).
// ─────────────────────────────────────────────────────────────────────────────

import { Platform, Alert, Linking, PermissionsAndroid } from 'react-native';

// Safe RNFS import — only used for folder creation
let RNFS;
try { RNFS = require('react-native-fs'); } catch {}

// ── CRM dedicated recording folder ───────────────────────────────────────────
export const CRM_RECORDING_FOLDER = '/storage/emulated/0/SkyUpCRM/Recordings';

const P = PermissionsAndroid.PERMISSIONS;
const R = PermissionsAndroid.RESULTS;

// Some permission constants only exist on newer Android API levels. Guard every
// lookup so a missing constant on an older OS can never throw at call time.
const has = perm => typeof perm === 'string' && perm.length > 0;

// Version-aware storage-read permission.
const storageReadPermission = () =>
  Platform.Version >= 33 ? P.READ_MEDIA_AUDIO : P.READ_EXTERNAL_STORAGE;

// Android 10+ uses scoped storage — no WRITE permission needed for the app folder.
const storageWritePermission = () =>
  Platform.Version >= 29 ? null : P.WRITE_EXTERNAL_STORAGE;

// ── Low-level helpers ─────────────────────────────────────────────────────────

// Request a single permission. Returns 'granted' | 'denied' | 'never_ask_again'.
// Never throws — a thrown native error resolves to 'denied' so the caller (and
// the UI) keeps moving instead of hanging.
async function requestOne(perm) {
  if (Platform.OS !== 'android' || !has(perm)) return R.GRANTED;
  try {
    return await PermissionsAndroid.request(perm);
  } catch (e) {
    console.warn('[permissionsService] request failed:', perm, e?.message);
    return R.DENIED;
  }
}

// Request several permissions at once. Returns a { perm: result } map.
async function requestMany(perms) {
  const list = perms.filter(has);
  if (Platform.OS !== 'android' || list.length === 0) {
    return list.reduce((acc, p) => ((acc[p] = R.GRANTED), acc), {});
  }
  try {
    return await PermissionsAndroid.requestMultiple(list);
  } catch (e) {
    console.warn('[permissionsService] requestMultiple failed:', e?.message);
    return list.reduce((acc, p) => ((acc[p] = R.DENIED), acc), {});
  }
}

// Check a single permission → boolean. Never throws.
async function checkOne(perm) {
  if (Platform.OS !== 'android' || !has(perm)) return true;
  try {
    return await PermissionsAndroid.check(perm);
  } catch {
    return false;
  }
}

// Shared "denied permanently → open Settings" prompt.
function promptOpenSettings(title, message) {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open Settings', onPress: () => Linking.openSettings() },
  ]);
}

// ── Request CALL_PHONE + READ_PHONE_STATE ─────────────────────────────────────
export const requestCallPermission = async () => {
  if (Platform.OS !== 'android') return true;
  const results = await requestMany([P.CALL_PHONE, P.READ_PHONE_STATE]);
  return results[P.CALL_PHONE] === R.GRANTED;
};

// ── Request READ_CALL_LOG ─────────────────────────────────────────────────────
export const requestCallLogPermission = async () => {
  if (Platform.OS !== 'android') return true;
  if (await checkOne(P.READ_CALL_LOG)) return true;
  const result = await requestOne(P.READ_CALL_LOG);
  if (result === R.NEVER_ASK_AGAIN) {
    promptOpenSettings(
      'Permission Required',
      'Call log access was denied. Please enable "Phone" permission in your device Settings to sync call history.',
    );
    return false;
  }
  return result === R.GRANTED;
};

// ── Request storage read (version-aware) ──────────────────────────────────────
export const requestStoragePermission = async () => {
  if (Platform.OS !== 'android') return true;
  const perm = storageReadPermission();
  if (await checkOne(perm)) return true;
  const result = await requestOne(perm);
  if (result === R.NEVER_ASK_AGAIN) {
    promptOpenSettings(
      'Permission Required',
      'Storage access was denied. Please enable "Files and media" permission in your device Settings.',
    );
    return false;
  }
  return result === R.GRANTED;
};

// ── Request storage write (needed on Android < 10 to create CRM folder) ───────
export const requestStorageWritePermission = async () => {
  if (Platform.OS !== 'android') return true;
  const perm = storageWritePermission();
  if (!perm) return true; // Android 10+ — scoped storage, no permission needed
  if (await checkOne(perm)) return true;
  const result = await requestOne(perm);
  if (result === R.NEVER_ASK_AGAIN) {
    promptOpenSettings(
      'Permission Required',
      'Write storage access was denied. Please enable "Files and media" permission in Settings.',
    );
    return false;
  }
  return result === R.GRANTED;
};

// ── Request READ_CONTACTS ─────────────────────────────────────────────────────
export const requestContactsPermission = async () => {
  if (Platform.OS !== 'android') return true;
  if (await checkOne(P.READ_CONTACTS)) return true;
  const result = await requestOne(P.READ_CONTACTS);
  if (result === R.NEVER_ASK_AGAIN) {
    promptOpenSettings(
      'Contacts Permission Required',
      'Contacts access was denied. Please enable "Contacts" permission in your device Settings to use the Save to Contacts feature.',
    );
    return false;
  }
  return result === R.GRANTED;
};

// ── Request WRITE_CONTACTS ────────────────────────────────────────────────────
export const requestWriteContactsPermission = async () => {
  if (Platform.OS !== 'android') return true;
  if (await checkOne(P.WRITE_CONTACTS)) return true;
  const result = await requestOne(P.WRITE_CONTACTS);
  if (result === R.NEVER_ASK_AGAIN) {
    promptOpenSettings(
      'Contacts Permission Required',
      'Write Contacts access was denied. Please enable "Contacts" permission in your device Settings.',
    );
    return false;
  }
  return result === R.GRANTED;
};

// ── Request location (fine + coarse) ─────────────────────────────────────────
export const requestLocationPermission = async () => {
  if (Platform.OS !== 'android') return true;
  const results = await requestMany([
    P.ACCESS_FINE_LOCATION,
    P.ACCESS_COARSE_LOCATION,
  ]);
  const fine   = results[P.ACCESS_FINE_LOCATION];
  const coarse = results[P.ACCESS_COARSE_LOCATION];

  if (fine === R.GRANTED || coarse === R.GRANTED) return true;

  if (fine === R.NEVER_ASK_AGAIN || coarse === R.NEVER_ASK_AGAIN) {
    promptOpenSettings(
      'Location Permission Required',
      'Location access was denied. Please enable "Location" permission in your device Settings to use check-in and geo-tagging features.',
    );
  }
  return false;
};

// ── Request POST_NOTIFICATIONS (Android 13+) ─────────────────────────────────
export const requestNotificationPermission = async () => {
  if (Platform.OS !== 'android' || Platform.Version < 33) return true;
  const result = await requestOne(P.POST_NOTIFICATIONS);
  return result === R.GRANTED;
};

// ── Create dedicated CRM recording folder ────────────────────────────────────
export const ensureCRMRecordingFolderExists = async () => {
  if (!RNFS) return false;
  try {
    const exists = await RNFS.exists(CRM_RECORDING_FOLDER);
    if (!exists) {
      await RNFS.mkdir(CRM_RECORDING_FOLDER);
    }
    return true;
  } catch (e) {
    console.warn('[permissionsService] Could not create CRM folder:', e.message);
    return false;
  }
};

// ── Step-by-step setup guide popup ───────────────────────────────────────────
export const showRecordingSyncSetupGuide = () =>
  new Promise((resolve) => {
    Alert.alert(
      '📱 Set Up Auto Recording Sync',
      [
        '✅ STEP 1 — Allow Permissions',
        'We will ask for Phone, Call Log, and Storage permissions.',
        'Tap "Allow" on each system dialog.',
        '',
        '✅ STEP 2 — Enable Call Recording in Your Dialer',
        '• Open your Phone / Dialer app',
        '• Go to Settings → Recording (varies by brand)',
        '• Enable "Record calls automatically"',
        '',
        '✅ STEP 3 — Point Recordings to CRM Folder (optional)',
        'For supported dialers, set the save path to:',
        'SkyUpCRM/Recordings',
        '(We also scan all common recording folders automatically)',
        '',
        '✅ STEP 4 — Done!',
        'Recordings will sync to your CRM automatically after each call.',
      ].join('\n'),
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Got it — Continue', onPress: () => resolve(true) },
      ],
    );
  });

// ── Request ALL permissions for auto recording sync ───────────────────────────
export const requestAllRecordingSyncPermissions = async () => {
  const userConfirmed = await showRecordingSyncSetupGuide();
  if (!userConfirmed) {
    return { confirmed: false, callPhone: false, readCallLog: false, readStorage: false, folderCreated: false };
  }

  const callPhone   = await requestCallPermission();
  const readCallLog = await requestCallLogPermission();
  const readStorage = await requestStoragePermission();

  await requestStorageWritePermission();

  const folderCreated = readStorage ? await ensureCRMRecordingFolderExists() : false;

  return { confirmed: true, callPhone, readCallLog, readStorage, folderCreated };
};

// ── Check all permissions ──────────────────────────────────────────────────────
export const checkAllPermissions = async () => {
  const readPerm = storageReadPermission();
  const [callPhone, readCallLog, readStorage, readContacts, location] =
    await Promise.all([
      checkOne(P.CALL_PHONE),
      checkOne(P.READ_CALL_LOG),
      checkOne(readPerm),
      checkOne(P.READ_CONTACTS),
      checkOne(P.ACCESS_FINE_LOCATION),
    ]);
  return { callPhone, readCallLog, readStorage, readContacts, location };
};

export const openAppSettings = () => Linking.openSettings();

export const showBlockedPermissionAlert = (permissionName) => {
  Alert.alert(
    `${permissionName} Permission Required`,
    `Please enable "${permissionName}" in your device Settings.`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Open Settings', onPress: openAppSettings },
    ],
  );
};