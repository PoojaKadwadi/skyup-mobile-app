// src/services/recordingPathService.js
// ─────────────────────────────────────────────────────────────────────────────
//  Stores and retrieves the user-set custom recording folder path.
//  All scanners (LeadRecordingsSection, RecordingsScreen, recordingService)
//  call getCustomRecordingPath() and prepend it to their dir list.
//
//  The user sets this once via ProfileScreen → Recording Folder → Browse.
//  After that, every scan finds their recordings instantly without guessing.
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';

const CUSTOM_PATH_KEY = 'crm_custom_recording_path_v1';

// Returns the saved custom path, or null if not set.
export const getCustomRecordingPath = async () => {
  try {
    const val = await AsyncStorage.getItem(CUSTOM_PATH_KEY);
    return val || null;
  } catch {
    return null;
  }
};

// Saves the custom path. Pass null to clear it.
export const setCustomRecordingPath = async (path) => {
  try {
    if (path) {
      await AsyncStorage.setItem(CUSTOM_PATH_KEY, path);
    } else {
      await AsyncStorage.removeItem(CUSTOM_PATH_KEY);
    }
    return true;
  } catch {
    return false;
  }
};

// Returns all dirs to scan: custom path first (if set), then the standard list.
// Deduplicates so the custom path isn't also scanned again if it's in the standard list.
export const buildScanDirs = async (standardDirs) => {
  const custom = await getCustomRecordingPath();
  if (!custom) return standardDirs;
  // Put custom path at the very top — it will be found first
  const rest = standardDirs.filter(d => d !== custom);
  return [custom, ...rest];
};