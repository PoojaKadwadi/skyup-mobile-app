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

// FIX (clock/timezone bug): "today's midnight" must be IST midnight, not the
// device's local midnight — see the same fix in backgroundSyncService.js.
// On a device whose timezone isn't Asia/Kolkata, computing this with
// d.setHours(0,0,0,0) would offset the "scan since midnight" window from
// the real IST day boundary the backend/website use.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +05:30
function getISTMidnightMs() {
  const now            = Date.now();
  const istNow         = new Date(now + IST_OFFSET_MS);
  const istMidnightUTC = new Date(istNow.getTime());
  istMidnightUTC.setUTCHours(0, 0, 0, 0);
  return istMidnightUTC.getTime() - IST_OFFSET_MS; // back to a real UTC instant
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

// ── Extract a trailing LAST-4-DIGITS pattern from the filename ────────────────
// Some dialers / manual saves name files as "<Lead Name> <last4>.m4a", e.g.
//   "Pooja Kadwadi 3210.m4a"  → "3210"
//   "Rahul-9988.amr"          → "9988"
// A 4-digit group is NOT a full phone number, so extractPhoneFromFilename (which
// needs 7-15 digits) returns null for these and they were previously skipped.
//
// We only return a 4-digit group when the filename has NO full (7-15 digit)
// number — otherwise the full number wins. We also reject groups that look like
// a time/date fragment (e.g. a 4-digit year "2024" or "1430" hour-min) by
// preferring the LAST 4-digit run and letting the call-log cross-check confirm.
function extractLast4FromFilename(filename) {
  // If there's already a full number, don't bother with last-4.
  if (extractPhoneFromFilename(filename)) return null;

  const base = filename.replace(/\.[^.]+$/, '');           // strip extension
  const groups = base.replace(/[_\-\.]/g, ' ').match(/\d{3,6}/g);
  if (!groups) return null;

  // Walk groups from the end — the contact-number suffix is almost always the
  // LAST numeric run in these "Name 3210" filenames.
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    // Take the last 4 digits of a 4-6 digit run (handles "03210" etc.)
    if (g.length >= 3 && g.length <= 6) {
      const last4 = g.slice(-4);
      if (last4.length === 4) return last4;
    }
  }
  return null;
}

// ── Contact-name matching (mirrors LeadRecordingsSection manual path) ─────────
// This is the signal that makes the MANUAL "Upload" button succeed on files
// named after the contact (e.g. "pooja 1057-26....mp3"). The auto path was
// missing it entirely, which is why files uploaded manually but never
// automatically. We normalise the filename (strip dialer boilerplate, digits,
// separators) and check whether the lead-name tokens appear inside it.
const FILENAME_NOISE = /\b(call|calls|recording|recordings|rec|record|voice|audio|incoming|outgoing|outgoingcall|incomingcall|with|to|from)\b/gi;

function normaliseForNameMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[_\-.+()]+/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(FILENAME_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function filenameMatchesName(filename, leadName) {
  if (!leadName || String(leadName).trim().length < 2) return false;
  const nameNoExt = filename.replace(/\.[^.]+$/, '');
  const haystack  = normaliseForNameMatch(nameNoExt);
  const needle    = normaliseForNameMatch(leadName);
  if (haystack.length < 2 || needle.length < 2) return false;

  if (haystack === needle) return true;
  if (haystack.includes(needle) || needle.includes(haystack)) return true;

  const hTokens = new Set(haystack.split(' ').filter(t => t.length >= 2));
  const nTokens = needle.split(' ').filter(t => t.length >= 2);
  if (nTokens.length === 0) return false;
  const matched = nTokens.filter(t => hTokens.has(t));
  if (matched.length === nTokens.length) return true;
  // One distinctive (≥4 char) token in common is enough — handles
  // "Ramesh Kumar" lead vs a "ramesh" recording.
  if (matched.some(t => t.length >= 4)) return true;
  return false;
}

// ── Resolve a 4-digit suffix to a full phone number ───────────────────────────
// Given the last-4 digits from a filename, find the full number it belongs to:
//   1. If a target number (preferPhone) is given and its last 4 match → use it
//      directly. This is the per-call / per-lead case and is unambiguous.
//   2. Otherwise look at the call log: collect entries whose number ends in the
//      same 4 digits, then pick the one CLOSEST IN TIME to the file's mtime.
//      The timestamp disambiguates when two different numbers share a suffix.
// Returns a normalized full number, or null if nothing matches confidently.
function resolveLast4ToPhone(last4, fileMs, callLogs, preferPhone = null) {
  if (!last4 || last4.length !== 4) return null;

  // 1. Direct match against the target number.
  if (preferPhone) {
    const want = normalizePhone(preferPhone);
    if (want && want.slice(-4) === last4) return want;
  }

  // 2. Call-log match by suffix, disambiguated by time proximity.
  const WINDOW = 20 * 60 * 1000;
  let best = null, minDiff = Infinity;
  for (const log of callLogs || []) {
    const norm = normalizePhone(log.phoneNumber || '');
    if (!norm || norm.length < 4) continue;
    if (norm.slice(-4) !== last4) continue;
    const diff = Math.abs(fileMs - parseInt(log.timestamp));
    if (diff < WINDOW && diff < minDiff) { minDiff = diff; best = norm; }
  }
  return best;
}

// ── Timestamp match against device call log ───────────────────────────────────
// Used when filename has no phone number (e.g. saved with contact name).
//
// FIX: previously this returned the TIME-CLOSEST call log entry regardless of
// which number was called. During a per-lead post-call sync, that mis-attributed
// recordings — a name-saved file for lead A would resolve to lead B simply
// because B's call was a few seconds closer in time, then either upload under
// the wrong lead or get discarded by the cross-check. When the call was placed
// to a specific number, that number's call-log entry should win even if another
// call sits slightly closer in time.
//
// New behaviour:
//   - If preferPhone is given, first look ONLY at entries whose number matches
//     preferPhone within the window, and return the closest of those.
//   - Only if no number-matched entry exists (or no preferPhone given) do we
//     fall back to the plain time-closest entry.
function findCallLogByTimestamp(fileMs, callLogs, preferPhone = null) {
  const TWENTY_MIN = 20 * 60 * 1000;
  // Tight window for the NUMBER-MATCHED path. A recording file's mtime is
  // written within a couple of minutes of its own call ending; using the full
  // 20-min window here would let the target's call "claim" a nameless file that
  // actually belongs to a different lead called a few minutes earlier/later.
  const TIGHT_WIN  = 12 * 60 * 1000; // FIX: was 4 min — name-saved files drift past it
  const wantNorm   = preferPhone ? normalizePhone(preferPhone) : null;

  let closest = null,       minDiff = Infinity;
  let closestMatch = null,  minDiffMatch = Infinity;

  for (const log of callLogs) {
    const diff = Math.abs(fileMs - parseInt(log.timestamp));
    if (diff < TWENTY_MIN && diff < minDiff) { minDiff = diff; closest = log; }

    if (wantNorm && diff < TIGHT_WIN) {
      const logNorm = normalizePhone(log.phoneNumber || '');
      if (logNorm && logNorm === wantNorm && diff < minDiffMatch) {
        minDiffMatch = diff;
        closestMatch = log;
      }
    }
  }

  // When a target phone was given:
  //   1. Prefer the number-matched entry (closestMatch).
  //   2. FIX (saved-contact auto-fetch): if none matched but the time-closest
  //      call within the generic 20-min window IS to the target number, use it.
  //      This recovers recordings saved under a CONTACT NAME (no digits in the
  //      filename) whose mtime drifted just past the matched window — they were
  //      previously skipped entirely, so calls to saved contacts never synced.
  if (wantNorm) {
    if (closestMatch) return closestMatch;
    if (closest && normalizePhone(closest.phoneNumber || '') === wantNorm) return closest;
    return null;
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
export const syncRecordings = async (phoneNumber = null, sinceMs = 0, skipPhones = new Set(), leadName = '') => {
  if (Platform.OS !== 'android') return { uploaded: 0, failed: 0, skipped: 0 };

  const granted = await requestStoragePermission();
  if (!granted) return { uploaded: 0, failed: 0, skipped: 0 };

  // FIX: effectiveSince now respects sinceMs as-is when > 0 (matches the file
  // header comment, which the old code contradicted).
  //
  // Old behaviour: Math.max(sinceMs, todayMidnight)
  //   Problem: when a post-call sync passed sinceMs = callStartedAt - 30s, OR
  //   the periodic sweep passed sinceMs = lastRecSync, Math.max reset it to
  //   todayMidnight, making every scan re-walk ALL of today's files. Slow, and
  //   it widened the time window so unrelated files were considered.
  //
  // New behaviour: use sinceMs exactly when > 0. Only fall back to todayMidnight
  //   when no timestamp is given (sinceMs === 0). We do NOT clamp sinceMs up to
  //   midnight — a post-call scan must be allowed to look at just the last few
  //   minutes. (sinceMs is always "today" in practice, so we never regress to
  //   scanning previous days.)
  const todayMidnight  = getISTMidnightMs();
  const effectiveSince = sinceMs > 0
    ? sinceMs            // respect the caller's window exactly
    : todayMidnight;     // no timestamp given — scan from midnight

  const wantName = String(leadName || '').trim();

  const uploadedSet   = await loadUploadedSet();
  const newlyUploaded = [];
  let uploaded = 0, failed = 0, skipped = 0;

  let callLogs = [];
  try { callLogs = await getDeviceCallLogs(200); } catch {}  // 200 gives better timestamp coverage

  const dirsToScan = await buildScanDirs(RECORDING_DIRS);
  for (const dir of dirsToScan) {
    // PERF FIX (app freeze): yield to the event loop before each directory so a
    // multi-folder sweep never holds the JS thread long enough to jank the UI.
    // RNFS.readDir + per-file work across ~20 folders was running to completion
    // in one synchronous burst; this lets touches/animations interleave.
    await new Promise(r => setTimeout(r, 0));

    const files = await scanDirectory(dir, effectiveSince);

    let processedInDir = 0;
    for (const file of files) {
      // PERF FIX (ANR / "SkyUp CRM isn't responding"): the per-file matching
      // (regex, name normalisation, nested call-log scans) is synchronous. With
      // many recordings this inner loop ran to completion without releasing the
      // single JS thread, freezing the UI — e.g. while the follow-up date/time
      // picker was open. Yield every few files so touches and animations can
      // interleave. setTimeout(0) hands control back to the event loop.
      if (processedInDir > 0 && processedInDir % 5 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
      processedInDir++;

      const filePath = file.path;
      const fileMs   = new Date(file.mtime).getTime();

      // ── Resolve phone number ───────────────────────────────────────────────
      const normalizedArg = phoneNumber ? normalizePhone(phoneNumber) : null;

      // Source 1: filename digits (most reliable — dialer put it there)
      let phone = null;
      const fromFilename = extractPhoneFromFilename(file.name);
      if (fromFilename) phone = normalizePhone(fromFilename);

      // NAME MATCH: does this filename contain the lead's name?
      // This is the signal the manual Upload button relies on. We compute it up
      // front so it can both (a) rescue files the digit logic would skip, and
      // (b) attribute the file to the target when a target number was given.
      const nameMatched = !!wantName && filenameMatchesName(file.name, wantName);

      // Source 1b: filename LAST-4-DIGITS pattern ("Lead Name 3210.m4a").
      // Resolve the 4-digit suffix to a full number via the target number
      // (per-call sync) or the call log (disambiguated by time). This is the
      // common case for recordings saved as "<contact name> <last 4 digits>".
      if (!phone) {
        const last4 = extractLast4FromFilename(file.name);
        if (last4) {
          const resolved = resolveLast4ToPhone(last4, fileMs, callLogs, normalizedArg);
          if (resolved) {
            phone = resolved;
          } else if (normalizedArg && !nameMatched) {
            // A target was given, its last-4 didn't match, no call-log entry with
            // this suffix sits in the window, AND the filename doesn't carry the
            // lead's name — not this lead's file.
            skipped++;
            continue;
          }
          // If the name matched, fall through — the name carries the attribution.
        }
      }

      // Source 1c: NAME → number, when a target was given.
      // If the filename matches the lead's name and we have a target number,
      // attribute the file to that number directly. This is exactly what makes
      // "pooja 1057-26....mp3" upload manually; the auto path now does the same.
      if (!phone && normalizedArg && nameMatched) {
        phone = normalizedArg;
      }

      // Source 2: timestamp match against call log.
      // FIX: pass normalizedArg so that during a per-lead sync we prefer the
      // call-log entry whose NUMBER matches the target — not merely the entry
      // that happens to be closest in time. This stops name-saved recordings
      // from being mis-attributed to a different lead whose call was nearby.
      let fromLog = null;
      if (!phone && callLogs.length > 0) {
        const matched = findCallLogByTimestamp(fileMs, callLogs, normalizedArg);
        if (matched) fromLog = normalizePhone(matched.phoneNumber);
        // When a target number was given but NO call to that number sits in the
        // window AND the name didn't match, this file isn't the target's — skip.
        else if (normalizedArg && !nameMatched) { skipped++; continue; }
      }
      if (!phone && fromLog) phone = fromLog;

      // Source 2b: NAME match in a no-target sweep — recover the number from the
      // call log's cached contact name. Lets the periodic sweep (phoneNumber=null)
      // upload name-saved files instead of discarding them.
      if (!phone && !normalizedArg && nameMatched && callLogs.length > 0) {
        let best = null, minDiff = Infinity;
        for (const log of callLogs) {
          const logName = normaliseForNameMatch(log.name || '');
          if (logName && filenameMatchesName(file.name, log.name)) {
            const diff = Math.abs(fileMs - parseInt(log.timestamp));
            if (diff < minDiff) { minDiff = diff; best = normalizePhone(log.phoneNumber || ''); }
          }
        }
        if (best) phone = best;
      }

      // Source 3: phoneNumber arg as last-resort fallback (safe when the filename
      // had no number AND either no call log was available, or the name matched).
      if (!phone && normalizedArg && (callLogs.length === 0 || nameMatched)) phone = normalizedArg;

      // Cross-check: if a target was given and we resolved to a number that
      // isn't byte-identical, decide whether it's truly a DIFFERENT call or just
      // a different REPRESENTATION of the same lead's number.
      //
      // WHY THIS IS LOOSER NOW (the "fetches for one lead, not others" bug):
      // recordings are commonly saved as "<name> <last4>", so Source 1b resolves
      // the last-4 to a full number that can legitimately differ from the stored
      // number in the higher digits (SIM/routing prefix, a number stored with an
      // extension, call-log number vs CRM number). normalizePhone already trims
      // country code / leading zero and keeps the last 10, so a genuine match
      // shares a long suffix. The OLD check rejected anything not exactly equal,
      // which silently skipped real matches for those leads.
      //
      // Accept the file for the target when ANY hold:
      //   • nameMatched — filename carries the lead's name (strongest signal);
      //   • same last 4 digits — exactly the suffix the file was named with;
      //   • one number is a suffix of the other (>=7 digits) — country-code /
      //     prefix / leading-zero differences.
      // Otherwise it's a different call → skip (prevents cross-lead bleed).
      if (normalizedArg && phone && phone !== normalizedArg) {
        const a = phone;
        const b = normalizedArg;
        const sameLast4   = a.length >= 4 && b.length >= 4 && a.slice(-4) === b.slice(-4);
        const suffixMatch = (a.length >= 7 && b.endsWith(a)) || (b.length >= 7 && a.endsWith(b));

        if (nameMatched || sameLast4 || suffixMatch) {
          // Same lead, different representation — attribute to the target so the
          // upload, dedup key and skipPhones check all use one canonical number.
          phone = normalizedArg;
        } else {
          console.log(
            `[recordingService] Skipping ${file.name}: resolved to ${phone} but expected ${normalizedArg}`,
          );
          skipped++;
          continue;
        }
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