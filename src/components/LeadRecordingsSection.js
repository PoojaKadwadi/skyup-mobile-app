// src/components/LeadRecordingsSection.js


import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, Alert, Platform, InteractionManager,
} from 'react-native';
import Icon         from 'react-native-vector-icons/MaterialCommunityIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { uploadRecording, getLeadCallLogs } from '../api/callLogsApi';
import { requestStoragePermission }         from '../services/permissionsService';
import { buildScanDirs }                    from '../services/recordingPathService';
import { normalizePhone }                   from '../services/phoneService';

// Mask phone digits inside a filename for display only.
// The actual filename is still used for upload/matching — this is display-only.
function maskFilename(filename) {
  if (!filename) return filename;
  return filename.replace(/\d{7,15}/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length === 8) {
      const y = parseInt(digits.slice(0, 4));
      if (y >= 1900 && y <= 2100) return match; // date — keep
    }
    if (digits.length === 6) {
      const h = parseInt(digits.slice(0, 2));
      if (h >= 0 && h <= 23) return match; // time — keep
    }
    return digits.slice(0, 2) + '•••••' + digits.slice(-2);
  });
}

// EMAIL MASKING: hide the local part of an email address for privacy.
// e.g. "john.doe@example.com" → "jo••••e@example.com"
function maskEmail(email) {
  if (!email || !email.includes('@')) return email || '—';
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${'•'.repeat(local.length)}@${domain}`;
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(2, local.length - 3))}${local.slice(-1)}@${domain}`;
}

// FIX: moment replaces Intl.DateTimeFormat — Hermes (Android) has no en-IN ICU data
// Intl.DateTimeFormat('en-IN', ...) throws 'Incomplete locale data' at module load time,
// crashing every screen that imports this component.
function fmtRecDate(date) {
  const m = typeof date === 'string' ? require('moment')(date) : require('moment')(date);
  return m.format('DD MMM, hh:mm A');
}

let RNFS;
try { RNFS = require('react-native-fs'); } catch {}

// Shared dedup key with RecordingsScreen and recordingService
const UPLOAD_TRACKER_KEY = 'uploaded_recordings_v4';

// ── Recording directories ─────────────────────────────────────────────────────
const RECORDING_DIRS = [
  '/storage/emulated/0/SkyUpCRM/Recordings',
  '/storage/emulated/0/Recordings/Call recordings',
  '/storage/emulated/0/Recordings/Call Recordings',
  '/storage/emulated/0/Recordings/Call',
  '/storage/emulated/0/Recordings',
  '/storage/emulated/0/Samsung/Call',
  '/storage/emulated/0/DCIM/Call Recordings',
  '/storage/emulated/0/MIUI/sound_recorder/call_rec',
  '/storage/emulated/0/sound_recorder',
  '/storage/emulated/0/Call',
  '/storage/emulated/0/PhoneRecord',
  '/storage/emulated/0/Record/Call',
  '/storage/emulated/0/Record',
  '/storage/emulated/0/callrecordings',
  '/storage/emulated/0/CallRecordings',
  '/storage/emulated/0/call_recordings',
  '/storage/emulated/0/Android/data/com.android.dialer/files/Recordings',
  '/storage/emulated/0/Android/data/com.google.android.dialer/files/Recordings',
  '/storage/emulated/0/Android/data/com.oneplus.callrecorder/files',
  '/storage/emulated/0/ColorOS/callrecord',
  '/storage/emulated/0/recording',
  '/storage/emulated/0/Music',
  '/storage/emulated/0/Downloads',
];

const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'wav', 'amr', '3gp', 'ogg', 'opus', 'wma']);

// ── Dedup helpers ─────────────────────────────────────────────────────────────
function makeFileKey(filename, phone, mtimeMs) {
  return `${normalizePhone(phone)}::${filename}::${mtimeMs}`;
}

async function loadUploadedSet() {
  try {
    const raw = await AsyncStorage.getItem(UPLOAD_TRACKER_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

const TRACKER_TTL_MS = 24 * 60 * 60 * 1000; // 24h — mirrors recordingService
async function addToUploadedSet(fileKey) {
  try {
    const set = await loadUploadedSet();
    set.add(fileKey);
    // FIX: prune entries older than 24h instead of capping at 2000.
    // Each key ends with ::mtimeMs — extract and drop stale ones so the set
    // stays small (today's uploads only) and has() checks remain fast.
    const cutoff = Date.now() - TRACKER_TTL_MS;
    const arr = Array.from(set).filter(k => {
      const parts = k.split('::');
      const ts = parseInt(parts[parts.length - 1]);
      return !isNaN(ts) && ts > cutoff;
    });
    await AsyncStorage.setItem(UPLOAD_TRACKER_KEY, JSON.stringify(arr));
  } catch {}
}

// ── Phone variant builder ─────────────────────────────────────────────────────
function getPhoneVariants(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits || digits.length < 7) return [];

  const ten = digits.slice(-10);
  const set = new Set([
    ten,
    '91' + ten,
    '0'  + ten,
    ten.slice(-7),
  ]);
  if (digits.length > 10) set.add(digits);

  return Array.from(set);
}

// ── Timestamp suffix stripper ─────────────────────────────────────────────────
function stripTimestampSuffix(nameNoExt) {
  return nameNoExt.replace(/-\d{10}$/, '').trim();
}

// ── Phone match ───────────────────────────────────────────────────────────────
function filenameMatchesPhone(filename, variants) {
  if (!variants.length) return false;
  const nameNoExt  = filename.replace(/\.[^.]+$/, '');
  const prefix     = stripTimestampSuffix(nameNoExt);
  const prefixDigs = prefix.replace(/\D/g, '');
  if (prefixDigs.length < 7) return false;

  return variants.some(v => v.length >= 7 && prefixDigs.includes(v));
}

// ── Does the filename positively identify a DIFFERENT contact? ────────────────
// A timestamp-only ("matched by call time") match must NOT accept a recording
// whose filename clearly belongs to someone else. Some dialers save files like
// "Chinni The Spiderman-26xxxxxxxx.mp3" — a different name AND a different
// number — yet they were attributed to the current lead purely because the file
// time was near the lead's call. This returns true when the filename carries an
// identifying phone or name that does NOT match the current lead, so byTime can
// reject it. It returns false for ambiguous filenames (no name/number), which
// time-proximity is still allowed to rescue.
function filenameNamesDifferentContact(filename, variants, leadName) {
  const nameNoExt = filename.replace(/\.[^.]+$/, '');
  const prefix    = stripTimestampSuffix(nameNoExt);
  const digs      = prefix.replace(/\D/g, '');

  // 1. Filename contains a phone-like number that is NOT this lead's number.
  if (digs.length >= 7) {
    const matchesLead = variants.some(v => v.length >= 7 && digs.includes(v));
    if (!matchesLead) return true; // a different number → different contact
  }

  // 2. Filename contains a name, and it isn't this lead's name.
  const fileName = normaliseForNameMatch(prefix);
  const wantName = normaliseForNameMatch(leadName || '');
  if (fileName.length >= 2) {
    if (!wantName) return true; // file is named for someone, lead has no name to match
    const wantTokens = wantName.split(' ').filter(t => t.length >= 2);
    const fileTokens = new Set(fileName.split(' ').filter(t => t.length >= 2));
    const shares = wantTokens.some(t => fileTokens.has(t));
    if (!shares) return true; // named for a different person
  }

  return false; // no conflicting identity → ambiguous, time match may rescue
}

// ── Contact name match ────────────────────────────────────────────────────────
// The OLD matcher only compared the lead name against the START of the filename
// prefix. Real dialers, however, wrap the contact name in boilerplate AND a
// date/time, e.g.:
//   "Call recording pooja 1057.m4a"        ← prefix "call recording", name in middle
//   "Call_pooja_1057_20250525.m4a"         ← "Call" prefix + trailing date
//   "Recording_Pooja_143000.m4a"           ← prefix + trailing time
// Because the name sits in the MIDDLE, startsWith() never matched and the
// recording was reported as "not found". This version normalises the filename
// (strip dialer boilerplate + date/time + the user's "last 4 digits" suffix)
// and checks whether the lead-name tokens appear ANYWHERE inside it.

// Dialer/app boilerplate words that are never part of a contact name.
const FILENAME_NOISE = /\b(call|calls|recording|recordings|rec|record|voice|audio|incoming|outgoing|outgoingcall|incomingcall|with|to|from)\b/gi;

function normaliseForNameMatch(text) {
  return String(text || '')
    .toLowerCase()
    // turn separators into spaces
    .replace(/[_\-.+()]+/g, ' ')
    // drop date/time digit clusters (YYYYMMDD, HHMMSS, epoch, "1057"-style etc.)
    .replace(/\d+/g, ' ')
    // remove dialer boilerplate words
    .replace(FILENAME_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function filenameMatchesName(filename, leadName) {
  if (!leadName || leadName.trim().length < 2) return false;

  const nameNoExt = filename.replace(/\.[^.]+$/, '');
  const haystack  = normaliseForNameMatch(nameNoExt);   // e.g. "pooja"
  const needle    = normaliseForNameMatch(leadName);    // e.g. "pooja"
  if (haystack.length < 2 || needle.length < 2) return false;

  // Exact normalised equality (most common: "Call recording pooja 1057" → "pooja")
  if (haystack === needle) return true;

  // Whole-name substring either direction (handles extra tokens on either side)
  if (haystack.includes(needle) || needle.includes(haystack)) return true;

  // Token overlap: every word of the (shorter) lead name appears in the filename.
  // Covers "Ramesh Kumar" lead vs a "ramesh" recording and vice-versa.
  const hTokens = new Set(haystack.split(' ').filter(t => t.length >= 2));
  const nTokens = needle.split(' ').filter(t => t.length >= 2);
  if (nTokens.length === 0) return false;
  const matched = nTokens.filter(t => hTokens.has(t));
  // Require either all name tokens present, or at least one distinctive (≥4 char) token.
  if (matched.length === nTokens.length) return true;
  if (matched.some(t => t.length >= 4)) return true;

  return false;
}

// ── Timestamp fallback match ──────────────────────────────────────────────────
function timestampMatchesCallLog(fileMtime, callLogs) {
  if (!callLogs?.length || !fileMtime) return false;
  const fileMs   = new Date(fileMtime).getTime();
  const FIVE_MIN = 5 * 60 * 1000;
  return callLogs.some(log => {
    const logMs = new Date(log.timestamp).getTime();
    return Math.abs(fileMs - logMs) <= FIVE_MIN;
  });
}

// ── isFile helper ─────────────────────────────────────────────────────────────
function isFileEntry(entry) {
  if (typeof entry.isFile === 'function') return entry.isFile();
  if (typeof entry.isFile === 'boolean')  return entry.isFile;
  const ext = (entry.name || '').split('.').pop().toLowerCase();
  return AUDIO_EXTS.has(ext);
}

// ── Directory scanner (one level deep) ───────────────────────────────────────
async function scanDir(dir, sinceMs = 0) {
  if (!RNFS) return [];
  try {
    const exists = await RNFS.exists(dir);
    if (!exists) return [];
    const entries = await RNFS.readDir(dir);

    const audioFiles = [];

    // FIX: apply the time filter here so we don't accumulate (and later
    // name-match) every recording on the device. Without this the screen
    // listed all 60+ old files and froze while walking every folder.
    const passesTime = (entry) =>
      sinceMs <= 0 || new Date(entry.mtime).getTime() >= sinceMs;

    for (const entry of entries) {
      if (isFileEntry(entry)) {
        const ext = entry.name.split('.').pop().toLowerCase();
        if (AUDIO_EXTS.has(ext) && passesTime(entry)) audioFiles.push(entry);
      } else {
        try {
          const subEntries = await RNFS.readDir(entry.path);
          for (const sub of subEntries) {
            if (!isFileEntry(sub)) continue;
            const ext = sub.name.split('.').pop().toLowerCase();
            if (AUDIO_EXTS.has(ext) && passesTime(sub)) audioFiles.push(sub);
          }
        } catch {}
      }
    }

    return audioFiles;
  } catch (e) {
    console.warn('[LeadRecordingsSection] scanDir failed for', dir, ':', e.message);
    return [];
  }
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function findRecordingsForLead(phoneNumber, leadName = '', callLogs = [], sinceMs = 0) {
  if (!RNFS) return [];

  const granted = await requestStoragePermission();
  if (!granted) throw new Error('Storage permission denied');

  const variants = getPhoneVariants(phoneNumber);
  const seen     = new Set();
  const results  = [];

  console.log(`[Recordings] Scanning for phone="${phoneNumber}" name="${leadName}" since=${sinceMs ? new Date(sinceMs).toISOString() : 'all'} variants=${JSON.stringify(variants)}`);

  const dirsToScan = await buildScanDirs(RECORDING_DIRS);

  for (const dir of dirsToScan) {
    const files = await scanDir(dir, sinceMs);
    if (files.length > 0) {
      console.log(`[Recordings] Dir "${dir}" → ${files.length} audio file(s):`, files.map(f => f.name));
    }

    for (const f of files) {
      if (seen.has(f.path)) continue;

      const byPhone = filenameMatchesPhone(f.name, variants);
      const byName  = !byPhone && filenameMatchesName(f.name, leadName);
      // Time-proximity is only allowed to rescue AMBIGUOUS filenames. If the
      // filename clearly names a different person/number, do NOT accept it even
      // when the timestamp is close (fixes other contacts' recordings showing
      // up under this lead via "matched by call time").
      const byTime  = !byPhone && !byName
        && !filenameNamesDifferentContact(f.name, variants, leadName)
        && timestampMatchesCallLog(f.mtime, callLogs);

      if (!byPhone && !byName && !byTime) {
        const prefix = stripTimestampSuffix(f.name.replace(/\.[^.]+$/, ''));
        console.log(`[Recordings] SKIP "${f.name}" prefix="${prefix}" prefixDigs="${prefix.replace(/\D/g,'')}" variants=${JSON.stringify(variants)}`);
        continue;
      }

      seen.add(f.path);
      results.push({
        path:        f.path,
        name:        f.name,
        size:        f.size,
        ext:         f.name.split('.').pop().toUpperCase(),
        modifiedAt:  f.mtime,
        matchMethod: byPhone ? 'number' : byName ? 'name' : 'timestamp',
      });
      console.log(`[Recordings] MATCH "${f.name}" via ${byPhone ? 'phone' : byName ? 'name' : 'timestamp'}`);
    }
  }

  console.log(`[Recordings] Total matched: ${results.length}`);
  return results.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Recording row ─────────────────────────────────────────────────────────────
// PERF FIX: uploadedSet is now passed from the parent (loaded once) instead of
// each row independently calling AsyncStorage. This reduces N async reads to 1.
function RecordingRow({ item, leadId, phoneNumber, uploadedSet }) {
  const fileMs  = item.modifiedAt ? new Date(item.modifiedAt).getTime() : 0;
  const fileKey = makeFileKey(item.name, normalizePhone(phoneNumber || ''), fileMs);

  // Synchronous initialiser — no useEffect, no bridge call
  const [status, setStatus] = useState(() => uploadedSet.has(fileKey) ? 'done' : 'idle');

  const handleUpload = async () => {
    setStatus('uploading');
    try {
      const fileMs  = item.modifiedAt ? new Date(item.modifiedAt).getTime() : Date.now();
      const phone   = normalizePhone(phoneNumber || '');
      const fileKey = makeFileKey(item.name, phone, fileMs);

      await uploadRecording(item.path, phone, fileMs, leadId);

      // FIX: Persist to AsyncStorage so "Saved" survives navigation/restart
      await addToUploadedSet(fileKey);
      setStatus('done');
    } catch (e) {
      setStatus('failed');
      Alert.alert('Upload Failed', e.message || 'Could not upload recording.');
    }
  };

  return (
    <View style={styles.recRow}>
      <View style={styles.recIconWrap}>
        <Icon name="microphone" size={18} color="#7C3AED" />
      </View>
      <View style={styles.recInfo}>
        <Text style={styles.recName} numberOfLines={2}>{maskFilename(item.name)}</Text>
        <Text style={styles.recMeta}>
          {formatSize(item.size)} · {item.ext}
          {item.modifiedAt ? `  ·  ${fmtRecDate(new Date(item.modifiedAt))}` : ''}
        </Text>
        {item.matchMethod !== 'number' && (
          <Text style={styles.recMatchBadge}>
            {item.matchMethod === 'name' ? 'matched by contact name' : 'matched by call time'}
          </Text>
        )}
      </View>

      {status === 'done' ? (
        <View style={styles.doneBadge}>
          <Icon name="check-circle" size={16} color="#059669" />
          <Text style={styles.doneText}>Saved</Text>
        </View>
      ) : status === 'uploading' ? (
        <ActivityIndicator size="small" color="#7C3AED" style={{ paddingHorizontal: 12 }} />
      ) : status === 'checking' ? (
        <ActivityIndicator size="small" color="#64748B" style={{ paddingHorizontal: 12 }} />
      ) : (
        <TouchableOpacity
          style={[styles.uploadBtn, status === 'failed' && styles.uploadBtnFailed]}
          onPress={handleUpload}
        >
          <Icon
            name={status === 'failed' ? 'reload' : 'cloud-upload-outline'}
            size={14}
            color={status === 'failed' ? '#EF4444' : '#A78BFA'}
          />
          <Text style={[styles.uploadBtnText, status === 'failed' && { color: '#EF4444' }]}>
            {status === 'failed' ? 'Retry' : 'Upload'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
function LeadRecordingsSection({ lead }) {
  const [recordings, setRecordings] = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [scanned,    setScanned]    = useState(false);
  // PERF FIX: load the uploaded-set ONCE for all rows, not once per RecordingRow.
  const [uploadedSet, setUploadedSet] = useState(() => new Set());

  const doScanRef   = useRef(null);
  // PERF FIX: 5-min scan result cache keyed by lead.id — avoids rescanning the
  // same lead on every navigation. Also passes a 7-day sinceMs floor to scanDir
  // so the filesystem walk is bounded to recent files.
  const scanCacheRef = useRef({ leadId: null, ts: 0, results: [] });
  const SCAN_CACHE_MS  = 5 * 60 * 1000;
  const SEVEN_DAYS_MS  = 7 * 24 * 60 * 60 * 1000;

  // Load uploadedSet once on mount
  useEffect(() => {
    loadUploadedSet().then(setUploadedSet).catch(() => {});
  }, []);

  const doScan = useCallback(async (isManual = true, sinceMs = 0) => {
    if (!lead?.mobile) return;
    if (!RNFS) {
      if (isManual) Alert.alert('Module Missing', 'react-native-fs not installed.\n\nRun: npm install react-native-fs');
      return;
    }

    setLoading(true);
    try {
      let callLogs = [];
      try {
        if (lead?.id) callLogs = await getLeadCallLogs(lead.id) || [];
      } catch {}

      // FIX: sinceMs is now actually passed through. A manual "Rescan" passes 0
      // (scan everything for this lead); the automatic open passes a 7-day floor
      // so the filesystem walk is bounded and the screen no longer freezes while
      // listing every old recording on the device.
      const found = await findRecordingsForLead(
        lead.mobile,
        lead.name || '',
        callLogs,
        sinceMs,
      );
      setRecordings(found);
      setScanned(true);

      // FIX: cache the REAL results (the old code stored an empty array, so the
      // 5-min cache never worked and every navigation triggered a full rescan).
      scanCacheRef.current = {
        leadId:  lead.id,
        ts:      Date.now(),
        results: found,
      };

      if (isManual && found.length === 0) {
        const displayNumber = String(lead.mobile).replace(/\D/g, '').slice(-10);
        Alert.alert(
          'No Recordings Found',
          `No recordings matching "${displayNumber}" were found on this device.\n\n` +
          'Possible reasons:\n' +
          '• Your dialer app has call recording disabled\n' +
          '• Recording permission not granted to the dialer\n' +
          '• Recordings are saved to internal app storage (not accessible)\n\n' +
          'Check Settings → Dialer → Call Recording.',
        );
      }
    } catch (e) {
      if (isManual) Alert.alert('Scan Error', e.message);
      console.warn('[LeadRecordingsSection] scan error:', e.message);
      setScanned(true);
    } finally {
      setLoading(false);
    }
  }, [lead?.mobile, lead?.id, lead?.name]);

  doScanRef.current = doScan;

  // PERF FIX: Before scanning, check the 5-min in-memory cache for this lead.
  // If cache is fresh, render immediately without touching the filesystem.
  // When a real scan is needed, pass sinceMs = now - 7 days so scanDir only
  // walks files modified in the last week instead of all-time.
  useEffect(() => {
    if (!lead?.mobile || Platform.OS !== 'android') return;

    const cache = scanCacheRef.current;
    const isFresh = cache.leadId === lead.id && (Date.now() - cache.ts) < SCAN_CACHE_MS;
    if (isFresh) {
      setRecordings(cache.results);
      setScanned(true);
      return;
    }

    const sinceMs = Date.now() - SEVEN_DAYS_MS;
    // PERF FIX (freeze on open): defer the heavy scan (RNFS.readDir across many
    // folders + device call-log read) until AFTER the screen finishes animating
    // in. Running it synchronously on mount blocked the JS thread and made
    // opening a lead stick.
    const task = InteractionManager.runAfterInteractions(() => {
      doScanRef.current(false, sinceMs).catch(() => {});
    });
    return () => task.cancel();
  }, [lead?.mobile, lead?.id]); // lead.id added so re-opening different lead re-scans

  const totalCount = recordings.length;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View>
          <Text style={styles.sectionTitle}>Call Recordings</Text>
          <Text style={styles.sectionSub}>
            {loading
              ? 'Scanning device…'
              : scanned
                ? `${totalCount} recording${totalCount !== 1 ? 's' : ''} found`
                : 'Scanning…'}
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.rescanBtn, loading && { opacity: 0.6 }]}
          onPress={() => doScan(true)}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator size="small" color="#fff" />
            : <Icon name="refresh" size={14} color="#fff" />}
          <Text style={styles.rescanBtnText}>{loading ? 'Scanning…' : 'Rescan'}</Text>
        </TouchableOpacity>
      </View>

      {!scanned && loading && (
        <View style={styles.infoNote}>
          <ActivityIndicator size="small" color="#60A5FA" />
          <Text style={styles.infoText}>Scanning device for recordings…</Text>
        </View>
      )}

      {recordings.length > 0 && (
        <View style={styles.recList}>
          {recordings.map(item => (
            <RecordingRow
              key={item.path}
              item={item}
              leadId={lead.id}
              phoneNumber={lead.mobile}
              uploadedSet={uploadedSet}
            />
          ))}
        </View>
      )}

      {scanned && !loading && recordings.length === 0 && (
        <View style={styles.emptyState}>
          <Icon name="microphone-off" size={32} color="#334155" />
          <Text style={styles.emptyText}>No recordings found</Text>
          <Text style={styles.emptyHint}>
            Tap Rescan after a call, or check that your dialer saves recordings to storage.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section:         { paddingHorizontal: 16, marginBottom: 20 },
  sectionHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 8 },
  sectionTitle:    { fontSize: 12, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1 },
  sectionSub:      { fontSize: 11, color: '#475569', marginTop: 2 },
  rescanBtn:       { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 9, backgroundColor: '#7C3AED', flexShrink: 0 },
  rescanBtnText:   { color: '#fff', fontSize: 11, fontWeight: '700' },
  infoNote:        { flexDirection: 'row', gap: 8, backgroundColor: '#1E3A8A15', padding: 10, borderRadius: 10, borderWidth: 1, borderColor: '#2563EB30', marginBottom: 8, alignItems: 'center' },
  infoText:        { flex: 1, color: '#93C5FD', fontSize: 12, lineHeight: 18 },
  recList:         { gap: 8 },
  recRow:          { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E293B', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#334155', gap: 10 },
  recIconWrap:     { width: 36, height: 36, borderRadius: 10, backgroundColor: '#4C1D9520', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  recInfo:         { flex: 1 },
  recName:         { fontSize: 13, fontWeight: '600', color: '#CBD5E1', lineHeight: 18 },
  recMeta:         { fontSize: 11, color: '#475569', marginTop: 3 },
  recMatchBadge:   { fontSize: 10, color: '#64748B', marginTop: 2, fontStyle: 'italic' },
  uploadBtn:       { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#4C1D9520', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderColor: '#7C3AED40', flexShrink: 0 },
  uploadBtnFailed: { borderColor: '#EF444440', backgroundColor: '#EF444410' },
  uploadBtnText:   { color: '#A78BFA', fontSize: 12, fontWeight: '700' },
  doneBadge:       { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
  doneText:        { color: '#059669', fontSize: 12, fontWeight: '700' },
  emptyState:      { alignItems: 'center', paddingVertical: 20, gap: 6 },
  emptyText:       { color: '#475569', fontSize: 13, fontWeight: '600' },
  emptyHint:       { color: '#334155', fontSize: 12, textAlign: 'center', paddingHorizontal: 16, lineHeight: 18 },
});

// PERF FIX (typing lag): memoize so this section does NOT re-render — and does
// not re-run its file scan — every time the parent LeadDetailScreen re-renders
// (e.g. on every keystroke in the remark box). It only depends on the lead's
// id / mobile / name, so re-render only when those actually change.
export default React.memo(LeadRecordingsSection, (prev, next) =>
  prev.lead?.id === next.lead?.id &&
  prev.lead?.mobile === next.lead?.mobile &&
  prev.lead?.name === next.lead?.name
);