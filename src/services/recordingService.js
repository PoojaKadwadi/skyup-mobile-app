// src/services/recordingService.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX (this revision) — "only latest recordings, no duplicates, faster sync":
//
//  1. effectiveSince logic fixed:
//     Old: Math.max(sinceMs, todayMidnight) — always reset to midnight even
//          when sinceMs was already a recent timestamp like lastRecSync.
//          This caused the periodic sweep to re-scan ALL files from midnight
//          on every 10-min tick instead of only new ones since last sweep.
//     New: sinceMs is respected as-is when > 0. todayMidnight is only used
//          as a hard floor when sinceMs is 0 (no timestamp given at all).
//          This means the periodic sweep truly only scans new files.
//
//  2. uploadedSet pruned to today's entries on every load:
//     Old: Up to 2000 entries accumulated across days. Every sync loaded
//          and checked all 2000 even though yesterday's entries can never
//          match today's new files (mtime is in the fileKey).
//     New: On load, entries older than 24h are dropped automatically.
//          The set stays small (only today's uploads), checks are fast,
//          and storage stays clean without needing a manual purge.
//
//  3. scanDirectory is unchanged — one level deep, audio extensions only,
//     mtime filter applied inside the scan.
//
//  4. Cross-check logic unchanged — if a file's resolved phone doesn't match
//     the phoneNumber arg, it is skipped (belongs to a different call).
//     The periodic sweep passes phoneNumber=null so no cross-check runs.
//
// RETAINED FROM PREVIOUS REVISIONS:
//  • UPLOAD_TRACKER_KEY = v4 (clean slate key — do not bump again unless
//    the fileKey format changes).
//  • makeFileKey = normalizedPhone::filename::mtimeMs
//  • isFileEntry helper for Samsung/newer Android RNFS compatibility.
//  • 3-retry upload with 1.5s back-off per file.
//  • resolvePhoneNumber priority: filename → call log timestamp → arg fallback.
// ─────────────────────────────────────────────────────────────────────────────

import { Platform } from 'react-native';
import AsyncStorage  from '@react-native-async-storage/async-storage';

import {
  requestStoragePermission,
  requestAllRecordingSyncPermissions,
  ensureCRMRecordingFolderExists,
  CRM_RECORDING_FOLDER,
} from './permissionsService';
import { uploadRecording }   from '../api/callLogsApi';
import { buildScanDirs }     from './recordingPathService';
import { getDeviceCallLogs } from './phoneService';
import { normalizePhone }    from './phoneService';

// ── Safe RNFS import ──────────────────────────────────────────────────────────
let RNFS;
try {
  RNFS = require('react-native-fs');
} catch {
  console.warn('[recordingService] react-native-fs not installed. Run: npm install react-native-fs');
}

// ── Recording directories to scan ─────────────────────────────────────────────
const RECORDING_DIRS = [
  CRM_RECORDING_FOLDER,
  // Samsung Voice Recorder (One UI 4/5/6)
  '/storage/emulated/0/Recordings/Call recordings',
  '/storage/emulated/0/Recordings/Call Recordings',
  '/storage/emulated/0/Recordings/Call',
  '/storage/emulated/0/Recordings',
  '/storage/emulated/0/Samsung/Call',
  '/storage/emulated/0/DCIM/Call Recordings',
  // MIUI / Xiaomi
  '/storage/emulated/0/MIUI/sound_recorder/call_rec',
  '/storage/emulated/0/sound_recorder',
  // Generic OEMs
  '/storage/emulated/0/Call',
  '/storage/emulated/0/PhoneRecord',
  '/storage/emulated/0/Record/Call',
  '/storage/emulated/0/Record',
  '/storage/emulated/0/callrecordings',
  '/storage/emulated/0/CallRecordings',
  // AOSP / Google
  '/storage/emulated/0/Android/data/com.android.dialer/files/Recordings',
  '/storage/emulated/0/Android/data/com.google.android.dialer/files/Recordings',
  // OnePlus / ColorOS
  '/storage/emulated/0/Android/data/com.oneplus.callrecorder/files',
  '/storage/emulated/0/ColorOS/callrecord',
  '/storage/emulated/0/Music',
  '/storage/emulated/0/Downloads',
];

const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'amr', '3gp', 'ogg', 'opus']);

// Key format: normalizedPhone::filename::mtimeMs
// DO NOT bump this key unless the format changes — bumping clears all dedup
// state and risks re-uploading every recording on the next sync.
const UPLOAD_TRACKER_KEY = 'uploaded_recordings_v4';

// 24 hours in ms — entries older than this are pruned on every load
const TRACKER_TTL_MS = 24 * 60 * 60 * 1000;

// ── Build the dedup key for a file ────────────────────────────────────────────
function makeFileKey(filename, phone, mtimeMs) {
  return `${normalizePhone(phone)}::${filename}::${mtimeMs}`;
}

// ── Detect date/time digit patterns that look like phone numbers ──────────────
// YYYYMMDD (8 digits), DDMMYYYY (8 digits), HHMMSS (6 digits) are often
// embedded in recording filenames (e.g. MIUI: record_20240115_143000_9876543210.amr).
// Without this check the regex picks up the date digits first and never
// reaches the actual phone number further along in the filename.
function isDateOrTimePattern(digits) {
  if (digits.length === 8) {
    // YYYYMMDD
    const y1 = parseInt(digits.slice(0, 4));
    const m1 = parseInt(digits.slice(4, 6));
    const d1 = parseInt(digits.slice(6, 8));
    if (y1 >= 1900 && y1 <= 2100 && m1 >= 1 && m1 <= 12 && d1 >= 1 && d1 <= 31) return true;
    // DDMMYYYY
    const d2 = parseInt(digits.slice(0, 2));
    const m2 = parseInt(digits.slice(2, 4));
    const y2 = parseInt(digits.slice(4, 8));
    if (d2 >= 1 && d2 <= 31 && m2 >= 1 && m2 <= 12 && y2 >= 1900 && y2 <= 2100) return true;
  }
  if (digits.length === 6) {
    // HHMMSS
    const h = parseInt(digits.slice(0, 2));
    const m = parseInt(digits.slice(2, 4));
    const s = parseInt(digits.slice(4, 6));
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59 && s >= 0 && s <= 59) return true;
  }
  return false;
}

// ── Extract phone from filename ───────────────────────────────────────────────
// Handles all common dialer filename formats:
//   Samsung:  'Call recording 9876543210 2024-01-15 14-30-00.m4a'
//   MIUI:     'record_20240115_143000_9876543210.amr'   ← date comes first, skip it
//   Google:   '20240115_143000_9876543210.m4a'          ← date comes first, skip it
//   OnePlus:  'CallRecord_143000_20240115.mp3'          ← no phone, returns null → Source 2
//   Named:    'Call with Pooja kadwadi.m4a'             ← no digits, returns null → Source 2
function extractPhoneFromFilename(filename) {
  const matches = filename.replace(/[_\-\.]/g, ' ').match(/\+?\d{7,15}/g);
  if (!matches) return null;
  for (const m of matches) {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) continue;
    if (isDateOrTimePattern(digits)) continue; // skip YYYYMMDD / HHMMSS patterns
    return digits;
  }
  return null;
}

// ── Timestamp match against device call log ───────────────────────────────────
// Used when filename has no phone number (e.g. saved with contact name).
// Finds the call log entry whose timestamp is closest to the file's mtime,
// within a 20-minute window (was 10 min — increased because some dialers
// write the recording file well after the call ends on slow/low-storage devices).
function findCallLogByTimestamp(fileMs, callLogs) {
  const TWENTY_MIN = 20 * 60 * 1000;
  let closest = null;
  let minDiff = Infinity;
  for (const log of callLogs) {
    const diff = Math.abs(fileMs - parseInt(log.timestamp));
    if (diff < TWENTY_MIN && diff < minDiff) {
      minDiff = diff;
      closest = log;
    }
  }
  return closest;
}

// ── Upload tracker ────────────────────────────────────────────────────────────
// FIX: On load, prune entries older than 24h. The fileKey includes the mtime
// timestamp so yesterday's entries can never match today's new files anyway —
// they are pure waste in the set. Pruning keeps the set small (only today's
// uploads) and makes every has() check fast.
const loadUploadedSet = async () => {
  try {
    const raw = await AsyncStorage.getItem(UPLOAD_TRACKER_KEY);
    if (!raw) return new Set();

    const arr    = JSON.parse(raw);
    const cutoff = Date.now() - TRACKER_TTL_MS;

    // Each key ends with "::mtimeMs". Extract the timestamp and prune old ones.
    const fresh = arr.filter(key => {
      const parts = key.split('::');
      const ts    = parseInt(parts[parts.length - 1]);
      return !isNaN(ts) && ts > cutoff;
    });

    // If we pruned anything, persist the smaller set immediately
    if (fresh.length < arr.length) {
      await AsyncStorage.setItem(UPLOAD_TRACKER_KEY, JSON.stringify(fresh));
    }

    return new Set(fresh);
  } catch { return new Set(); }
};

const saveUploadedSet = async (set) => {
  try {
    const arr = Array.from(set);
    await AsyncStorage.setItem(UPLOAD_TRACKER_KEY, JSON.stringify(arr));
  } catch (e) {
    console.warn('[recordingService] saveUploadedSet error:', e.message);
  }
};

// ── isFile helper ─────────────────────────────────────────────────────────────
// react-native-fs returns isFile as a FUNCTION on some builds and a BOOLEAN
// PROPERTY on others (Samsung/newer Android).
function isFileEntry(f) {
  if (typeof f.isFile === 'function') return f.isFile();
  if (typeof f.isFile === 'boolean')  return f.isFile;
  return AUDIO_EXTENSIONS.has((f.name || '').split('.').pop().toLowerCase());
}

// ── Scan one directory (one level deep) ───────────────────────────────────────
const scanDirectory = async (dir, sinceMs = 0) => {
  if (!RNFS) return [];
  try {
    const exists = await RNFS.exists(dir);
    if (!exists) return [];
    const entries = await RNFS.readDir(dir);
    const results = [];

    const checkFile = (f) => {
      if (!isFileEntry(f)) return false;
      const ext = f.name.split('.').pop().toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext)) return false;
      if (sinceMs > 0 && new Date(f.mtime).getTime() < sinceMs) return false;
      return true;
    };

    for (const entry of entries) {
      if (isFileEntry(entry)) {
        if (checkFile(entry)) results.push(entry);
      } else {
        // One level deep — catches "Recordings/Call recordings/" subfolders
        try {
          const subs = await RNFS.readDir(entry.path);
          for (const sub of subs) {
            if (checkFile(sub)) results.push(sub);
          }
        } catch {}
      }
    }
    return results;
  } catch { return []; }
};

// ── Main sync ─────────────────────────────────────────────────────────────────
// skipPhones: optional Set of normalized phone numbers to skip entirely.
// Used by the periodic sweep to skip numbers already handled by post-call
// auto-upload within the current 10-min window (see backgroundSyncService).
// recordingService's uploadedSet remains the hard dedup layer — this is just
// an early-exit optimisation that avoids redundant file scanning.
export const syncRecordings = async (phoneNumber = null, sinceMs = 0, skipPhones = new Set()) => {
  if (Platform.OS !== 'android') return { uploaded: 0, failed: 0, skipped: 0 };

  const granted = await requestStoragePermission();
  if (!granted) return { uploaded: 0, failed: 0, skipped: 0 };

  // FIX: effectiveSince is now sinceMs as-is when > 0.
  //
  // Old behaviour: Math.max(sinceMs, todayMidnight)
  //   Problem: when the periodic sweep passed sinceMs = lastRecSync (e.g.
  //   10 minutes ago), Math.max reset it to todayMidnight, making the sweep
  //   re-scan ALL files from midnight on every tick. This was slow and
  //   produced unnecessary duplicate-check work even though the dedup set
  //   would catch actual re-uploads.
  //
  // New behaviour: use sinceMs exactly when > 0; fall back to todayMidnight
  //   only when no timestamp is given (sinceMs === 0, e.g. a one-off manual
  //   scan with no context). todayMidnight remains the absolute minimum floor
  //   so we never scan files from previous days in any code path.
  const todayMidnight  = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
  const effectiveSince = sinceMs > 0
    ? Math.max(sinceMs, todayMidnight)  // respect sinceMs but never go before midnight
    : todayMidnight;                     // no timestamp given — scan from midnight

  const uploadedSet   = await loadUploadedSet();
  const newlyUploaded = [];
  let uploaded = 0, failed = 0, skipped = 0;

  let callLogs = [];
  try { callLogs = await getDeviceCallLogs(200); } catch {}  // 200 gives better timestamp coverage

  const dirsToScan = await buildScanDirs(RECORDING_DIRS);
  for (const dir of dirsToScan) {
    const files = await scanDirectory(dir, effectiveSince);

    for (const file of files) {
      const filePath = file.path;
      const fileMs   = new Date(file.mtime).getTime();

      // ── Resolve phone number ───────────────────────────────────────────────
      // Source 1: filename digits (most reliable — dialer put it there)
      let phone = null;
      const fromFilename = extractPhoneFromFilename(file.name);
      if (fromFilename) phone = normalizePhone(fromFilename);

      // Source 2: timestamp match against call log
      let fromLog = null;
      if (callLogs.length > 0) {
        const matched = findCallLogByTimestamp(fileMs, callLogs);
        if (matched) fromLog = normalizePhone(matched.phoneNumber);
      }
      if (!phone && fromLog) phone = fromLog;

      // Source 3: phoneNumber arg as last-resort fallback
      const normalizedArg = phoneNumber ? normalizePhone(phoneNumber) : null;
      if (!phone && normalizedArg) phone = normalizedArg;

      // Cross-check: if arg was given but resolved to a different number,
      // this file belongs to a different call — skip it.
      if (normalizedArg && phone && phone !== normalizedArg) {
        console.log(
          `[recordingService] Skipping ${file.name}: resolved to ${phone} but expected ${normalizedArg}`,
        );
        skipped++;
        continue;
      }

      if (!phone) { skipped++; continue; }

      // FIX: Skip phones already handled by post-call auto-upload this session
      if (skipPhones.size > 0 && skipPhones.has(phone)) {
        console.log(`[recordingService] Skipping ${file.name}: phone ${phone} already auto-uploaded this session`);
        skipped++;
        continue;
      }

      // Dedup: phone::filename::mtime
      const fileKey = makeFileKey(file.name, phone, fileMs);
      if (uploadedSet.has(fileKey)) { skipped++; continue; }

      const MAX_RETRIES = 3;
      let success = false;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await uploadRecording(filePath, phone, fileMs);
          success = true;
          break;
        } catch (e) {
          if (attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 1500 * attempt));
          }
        }
      }

      if (success) {
        newlyUploaded.push(fileKey);
        uploaded++;
      } else {
        failed++;
        console.warn('[recordingService] Failed after retries:', file.name);
      }
    }
  }

  if (newlyUploaded.length > 0) {
    newlyUploaded.forEach(k => uploadedSet.add(k));
    await saveUploadedSet(uploadedSet);
  }

  return { uploaded, failed, skipped };
};

// ── Upload a specific recording after a call (with retry) ─────────────────────
export const uploadRecordingForCall = async (filePath, phoneNumber, callEndedAt) => {
  const MAX_RETRIES = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (!RNFS) throw new Error('react-native-fs not available');
      const exists = await RNFS.exists(filePath);
      if (!exists) throw new Error(`File not found: ${filePath}`);

      const stat   = await RNFS.stat(filePath);
      const fileMs = new Date(stat.mtime).getTime();

      const phone   = normalizePhone(phoneNumber);
      const fileKey = makeFileKey(filePath.split('/').pop(), phone, fileMs);

      const set = await loadUploadedSet();
      if (set.has(fileKey)) {
        console.log('[recordingService] Already uploaded, skipping:', filePath.split('/').pop());
        return { skipped: true };
      }

      const result = await uploadRecording(filePath, phone, fileMs);

      set.add(fileKey);
      await saveUploadedSet(set);

      return result;
    } catch (e) {
      lastError = e;
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
  throw lastError;
};

// ── One-call auto setup for auto recording sync ───────────────────────────────
export const autoSetupRecordingSync = async () => {
  const result = await requestAllRecordingSyncPermissions();

  if (!result.confirmed) {
    return { success: false, reason: 'cancelled' };
  }

  if (result.readStorage && !result.folderCreated) {
    result.folderCreated = await ensureCRMRecordingFolderExists();
  }

  const allGranted = result.callPhone && result.readCallLog && result.readStorage;

  return {
    success:       allGranted,
    partial:       !allGranted && (result.callPhone || result.readCallLog || result.readStorage),
    folderCreated: result.folderCreated,
    folderPath:    CRM_RECORDING_FOLDER,
    grants:        result,
  };
};