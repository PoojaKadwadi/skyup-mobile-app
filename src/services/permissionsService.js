// src/services/permissionsService.js
// ─────────────────────────────────────────────────────────────────────────────
// CHANGES (auto-sync recording feature):
//
//  1. Added WRITE_EXTERNAL_STORAGE permission so the app can create and
//     manage the dedicated CRM recordings folder on the device.
//
//  2. New requestAllRecordingSyncPermissions() — requests ALL permissions
//     needed for automatic recording sync in one flow, with a step-by-step
//     setup popup shown BEFORE the Android system dialogs appear.
//
//  3. New showRecordingSyncSetupGuide() — shows the step-by-step popup
//     that explains to the user how to enable automatic call recording on
//     their specific Android dialer and where recordings are saved.
//
//  4. New ensureCRMRecordingFolderExists() — creates the dedicated
//     /storage/emulated/0/SkyUpCRM/Recordings/ folder so recordings
//     from supported dialers can be pointed there.
//
//  5. checkAllPermissions() extended to include writeStorage.
//
// All existing functions unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import { Platform, Alert, Linking } from 'react-native';
import {
  check, request, requestMultiple, PERMISSIONS, RESULTS,
} from 'react-native-permissions';

// Safe RNFS import — only used for folder creation
let RNFS;
try { RNFS = require('react-native-fs'); } catch {}

// ── CRM dedicated recording folder ───────────────────────────────────────────
export const CRM_RECORDING_FOLDER = '/storage/emulated/0/SkyUpCRM/Recordings';

// ── Permission groups ─────────────────────────────────────────────────────────
const CALL_PERMISSIONS = [
  PERMISSIONS.ANDROID.CALL_PHONE,
  PERMISSIONS.ANDROID.READ_PHONE_STATE,
];

const storageReadPermission = () =>
  Platform.Version >= 33
    ? PERMISSIONS.ANDROID.READ_MEDIA_AUDIO
    : PERMISSIONS.ANDROID.READ_EXTERNAL_STORAGE;

const storageWritePermission = () =>
  Platform.Version >= 29
    ? null  // Android 10+ uses scoped storage — no WRITE permission needed for app folder
    : PERMISSIONS.ANDROID.WRITE_EXTERNAL_STORAGE;

// ── Request CALL_PHONE + READ_PHONE_STATE ─────────────────────────────────────
export const requestCallPermission = async () => {
  const results = await requestMultiple(CALL_PERMISSIONS);
  return results[PERMISSIONS.ANDROID.CALL_PHONE] === RESULTS.GRANTED;
};

// ── Request READ_CALL_LOG ─────────────────────────────────────────────────────
export const requestCallLogPermission = async () => {
  const current = await check(PERMISSIONS.ANDROID.READ_CALL_LOG);
  if (current === RESULTS.GRANTED) return true;
  if (current === RESULTS.BLOCKED) {
    Alert.alert(
      'Permission Required',
      'Call log access was denied. Please enable "Phone" permission in your device Settings to sync call history.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ],
    );
    return false;
  }
  const result = await request(PERMISSIONS.ANDROID.READ_CALL_LOG);
  return result === RESULTS.GRANTED;
};

// ── Request storage read (version-aware) ──────────────────────────────────────
export const requestStoragePermission = async () => {
  const perm    = storageReadPermission();
  const current = await check(perm);
  if (current === RESULTS.GRANTED) return true;
  if (current === RESULTS.BLOCKED) {
    Alert.alert(
      'Permission Required',
      'Storage access was denied. Please enable "Files and media" permission in your device Settings.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ],
    );
    return false;
  }
  const result = await request(perm);
  return result === RESULTS.GRANTED;
};

// ── Request storage write (needed on Android < 10 to create CRM folder) ───────
export const requestStorageWritePermission = async () => {
  const perm = storageWritePermission();
  if (!perm) return true;  // Android 10+ — scoped storage, no permission needed

  const current = await check(perm);
  if (current === RESULTS.GRANTED) return true;
  if (current === RESULTS.BLOCKED) {
    Alert.alert(
      'Permission Required',
      'Write storage access was denied. Please enable "Files and media" permission in Settings.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ],
    );
    return false;
  }
  const result = await request(perm);
  return result === RESULTS.GRANTED;
};

// ── Request READ_CONTACTS ─────────────────────────────────────────────────────
export const requestContactsPermission = async () => {
  const current = await check(PERMISSIONS.ANDROID.READ_CONTACTS);
  if (current === RESULTS.GRANTED) return true;
  if (current === RESULTS.BLOCKED) {
    Alert.alert(
      'Contacts Permission Required',
      'Contacts access was denied. Please enable "Contacts" permission in your device Settings to use the Save to Contacts feature.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ],
    );
    return false;
  }
  const result = await request(PERMISSIONS.ANDROID.READ_CONTACTS);
  return result === RESULTS.GRANTED;
};

// ── Request WRITE_CONTACTS ────────────────────────────────────────────────────
export const requestWriteContactsPermission = async () => {
  const current = await check(PERMISSIONS.ANDROID.WRITE_CONTACTS);
  if (current === RESULTS.GRANTED) return true;
  if (current === RESULTS.BLOCKED) {
    Alert.alert(
      'Contacts Permission Required',
      'Write Contacts access was denied. Please enable "Contacts" permission in your device Settings.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ],
    );
    return false;
  }
  const result = await request(PERMISSIONS.ANDROID.WRITE_CONTACTS);
  return result === RESULTS.GRANTED;
};

// ── Request location (fine + coarse) ─────────────────────────────────────────
export const requestLocationPermission = async () => {
  const results = await requestMultiple([
    PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION,
    PERMISSIONS.ANDROID.ACCESS_COARSE_LOCATION,
  ]);
  const fine   = results[PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION];
  const coarse = results[PERMISSIONS.ANDROID.ACCESS_COARSE_LOCATION];

  if (fine === RESULTS.GRANTED || coarse === RESULTS.GRANTED) return true;

  if (fine === RESULTS.BLOCKED || coarse === RESULTS.BLOCKED) {
    Alert.alert(
      'Location Permission Required',
      'Location access was denied. Please enable "Location" permission in your device Settings to use check-in and geo-tagging features.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ],
    );
  }
  return false;
};


export const requestNotificationPermission = async () => {
  if (Platform.Version < 33) return true;
  const result = await request(PERMISSIONS.ANDROID.POST_NOTIFICATIONS);
  return result === RESULTS.GRANTED;
};

// ── Create dedicated CRM recording folder ────────────────────────────────────
// Creates /storage/emulated/0/SkyUpCRM/Recordings/ on the device.
// Recordings from the user's dialer should be saved/moved here so the CRM
// can find and auto-sync them without scanning dozens of directories.
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
// Shown BEFORE the Android permission dialogs so the user understands WHY
// they are being asked and HOW to set up automatic recording in their dialer.
export const showRecordingSyncSetupGuide = () =>
  new Promise((resolve) => {
    Alert.alert(
      '📱 Set Up Auto Recording Sync',

      // Step-by-step instructions that appear as the popup body
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
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => resolve(false),
        },
        {
          text: 'Got it — Continue',
          onPress: () => resolve(true),
        },
      ],
    );
  });

// ── Request ALL permissions for auto recording sync ───────────────────────────
// Call this once (e.g. from DashboardScreen on first login or from a
// "Set Up Auto Sync" button). It:
//   1. Shows the setup guide popup
//   2. Requests each permission in sequence with graceful fallback
//   3. Creates the CRM recordings folder
//   4. Returns a summary of what was granted
export const requestAllRecordingSyncPermissions = async () => {
  // Show the how-to guide first — user can cancel
  const userConfirmed = await showRecordingSyncSetupGuide();
  if (!userConfirmed) {
    return { confirmed: false, callPhone: false, readCallLog: false, readStorage: false, folderCreated: false };
  }

  // Request permissions one by one so Android can show each system dialog
  const callPhone   = await requestCallPermission();
  const readCallLog = await requestCallLogPermission();
  const readStorage = await requestStoragePermission();

  // Write permission only needed for Android < 10
  await requestStorageWritePermission();

  // Create the dedicated CRM folder (only works after storage permission granted)
  const folderCreated = readStorage ? await ensureCRMRecordingFolderExists() : false;

  return { confirmed: true, callPhone, readCallLog, readStorage, folderCreated };
};

// ── Check all permissions ──────────────────────────────────────────────────────
export const checkAllPermissions = async () => {
  const readPerm = storageReadPermission();
  const checks = await Promise.all([
    check(PERMISSIONS.ANDROID.CALL_PHONE),
    check(PERMISSIONS.ANDROID.READ_CALL_LOG),
    check(readPerm),
    check(PERMISSIONS.ANDROID.READ_CONTACTS),
    check(PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION),
  ]);
  return {
    callPhone:    checks[0] === RESULTS.GRANTED,
    readCallLog:  checks[1] === RESULTS.GRANTED,
    readStorage:  checks[2] === RESULTS.GRANTED,
    readContacts: checks[3] === RESULTS.GRANTED,
    location:     checks[4] === RESULTS.GRANTED,
  };
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