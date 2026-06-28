// src/screens/calls/RecordingsScreen.js
// FIXES in this revision:
//   1. CRASH FIX — removed reference to non-existent `handleUpload` in renderItem.
//      Manual upload was previously removed (recordings are auto-uploaded after
//      each call) but the renderItem still referenced it, causing a crash.
//   2. TODAY-ONLY filter — scanForRecordings filters files to today's date.
//   3. DUPLICATE UPLOAD GUARD — uploadedSet (AsyncStorage v4) checked before
//      every upload. Same fileKey cannot be uploaded twice even across restarts.
//   4. AUTO-SCAN on mount — scans automatically when screen opens.
//   5. CRASH FIX — replaced Intl.DateTimeFormat with moment (Hermes has no en-IN locale data).

import React, { useState, useCallback, useRef, useEffect, memo } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  Alert, ActivityIndicator, StatusBar, InteractionManager,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Icon              from 'react-native-vector-icons/MaterialCommunityIcons';
import AsyncStorage      from '@react-native-async-storage/async-storage';
import moment            from 'moment';

import { normalizePhone } from '../../services/phoneService';
import { store }          from '../../store';

// Mask phone for display only — full number is still used for upload/matching
function maskPhone(phone) {
  if (!phone) return '';
  const digits = normalizePhone(phone) || String(phone).replace(/\D/g, '');
  if (digits.length < 6) return '••••••';
  return digits.slice(0, 2) + '•••••' + digits.slice(-2);
}

// Mask phone digits inside a filename for display — replaces any 7-15 digit
// sequence that isn't a date/time pattern with a masked version.
function maskFilename(filename) {
  if (!filename) return filename;
  return filename.replace(/\d{7,15}/g, (match) => {
    const digits = match.replace(/\D/g, '');
    // Skip date-like (8 digits YYYYMMDD) and time-like (6 digits HHMMSS) patterns
    if (digits.length === 8) {
      const y = parseInt(digits.slice(0, 4));
      if (y >= 1900 && y <= 2100) return match; // looks like a date — keep as-is
    }
    if (digits.length === 6) {
      const h = parseInt(digits.slice(0, 2));
      if (h >= 0 && h <= 23) return match; // looks like a time — keep as-is
    }
    // It's a phone number — mask it
    return digits.slice(0, 2) + '•••••' + digits.slice(-2);
  });
}

// FIX: moment instead of Intl.DateTimeFormat — Hermes has no full ICU data
function fmtRecDate(date) { return moment(date).format('DD MMM, hh:mm A'); }

let RNFS;
try { RNFS = require('react-native-fs'); } catch {}

import { uploadRecording } from '../../api/callLogsApi';
import { requestStoragePermission } from '../../services/permissionsService';
import { buildScanDirs }             from '../../services/recordingPathService';

const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'wav', 'amr', '3gp', 'ogg', 'opus']);
const UPLOAD_TRACKER_KEY = 'uploaded_recordings_v4';

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
  '/storage/emulated/0/Android/data/com.android.dialer/files/Recordings',
  '/storage/emulated/0/Android/data/com.google.android.dialer/files/Recordings',
  '/storage/emulated/0/Android/data/com.oneplus.callrecorder/files',
  '/storage/emulated/0/ColorOS/callrecord',
  '/storage/emulated/0/Music',
  '/storage/emulated/0/Downloads',
];

function isFileEntry(f) {
  if (typeof f.isFile === 'function') return f.isFile();
  if (typeof f.isFile === 'boolean')  return f.isFile;
  return AUDIO_EXTS.has((f.name || '').split('.').pop().toLowerCase());
}

function getTodayMidnightMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function scanForRecordings() {
  if (!RNFS) throw new Error('react-native-fs not installed. Run: npm install react-native-fs');

  const granted = await requestStoragePermission();
  if (!granted) throw new Error('Storage permission denied');

  const todayMidnight = getTodayMidnightMs();
  const seen  = new Set();
  const found = [];

  const dirsToScan = await buildScanDirs(RECORDING_DIRS);

  for (const dir of dirsToScan) {
    try {
      const exists = await RNFS.exists(dir);
      if (!exists) continue;
      const entries = await RNFS.readDir(dir);
      for (const f of entries) {
        const ext   = f.name.split('.').pop().toLowerCase();
        const mtime = new Date(f.mtime).getTime();
        if (isFileEntry(f) && AUDIO_EXTS.has(ext) && !seen.has(f.path) && mtime >= todayMidnight) {
          seen.add(f.path);
          found.push({ path: f.path, name: f.name, size: f.size, extension: `.${ext}`, modifiedAt: f.mtime });
        } else if (!isFileEntry(f)) {
          try {
            const subs = await RNFS.readDir(f.path);
            for (const s of subs) {
              const sExt  = s.name.split('.').pop().toLowerCase();
              const sMtime = new Date(s.mtime).getTime();
              if (isFileEntry(s) && AUDIO_EXTS.has(sExt) && !seen.has(s.path) && sMtime >= todayMidnight) {
                seen.add(s.path);
                found.push({ path: s.path, name: s.name, size: s.size, extension: `.${sExt}`, modifiedAt: s.mtime });
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  return found.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

// ── Phone resolution — mirrors recordingService so the manual screen and the
// auto-sync agree on which lead a file belongs to. Handles BOTH supported
// filename formats:
//   • Full number:  "Call 919876543210 2024-...m4a"   → extract directly
//   • Last-4 only:   "Pooja Kadwadi 3210.m4a"          → resolve via lead list
// Returns a normalized full number, or null if it genuinely can't be resolved
// (only those files get treated as "needs manual handling").

function isDateOrTimePattern(digits) {
  if (digits.length === 8) {
    const y = parseInt(digits.slice(0, 4));
    const m = parseInt(digits.slice(4, 6));
    const d = parseInt(digits.slice(6, 8));
    if (y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) return true;
    const d2 = parseInt(digits.slice(0, 2));
    const m2 = parseInt(digits.slice(2, 4));
    const y2 = parseInt(digits.slice(4, 8));
    if (d2 >= 1 && d2 <= 31 && m2 >= 1 && m2 <= 12 && y2 >= 1900 && y2 <= 2100) return true;
  }
  if (digits.length === 6) {
    const h = parseInt(digits.slice(0, 2));
    const m = parseInt(digits.slice(2, 4));
    const s = parseInt(digits.slice(4, 6));
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59 && s >= 0 && s <= 59) return true;
  }
  return false;
}

// Full 7-15 digit number anywhere in the filename (skips date/time runs).
function extractFullNumber(filename) {
  const matches = filename.replace(/[_\-\.]/g, ' ').match(/\+?\d{7,15}/g);
  if (!matches) return null;
  for (const m of matches) {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) continue;
    if (isDateOrTimePattern(digits)) continue;
    return digits;
  }
  return null;
}

// Trailing last-4 group ("Name 3210"), only when there's no full number.
function extractLast4(filename) {
  if (extractFullNumber(filename)) return null;
  const base   = filename.replace(/\.[^.]+$/, '');
  const groups = base.replace(/[_\-\.]/g, ' ').match(/\d{3,6}/g);
  if (!groups) return null;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.length >= 3 && g.length <= 6) {
      const last4 = g.slice(-4);
      if (last4.length === 4) return last4;
    }
  }
  return null;
}

// Resolve a last-4 against the agent's lead list (unambiguous matches only).
function resolveLast4FromLeads(last4) {
  if (!last4 || last4.length !== 4) return null;
  try {
    const items = store.getState()?.leads?.items || [];
    const hits = [];
    for (const lead of items) {
      const norm = normalizePhone(lead.primaryPhone || lead.mobile || lead.phone || '');
      if (norm && norm.length >= 4 && norm.slice(-4) === last4 && !hits.includes(norm)) {
        hits.push(norm);
      }
    }
    if (hits.length === 1) return hits[0];
  } catch {}
  return null;
}

// Public resolver used throughout this screen.
function extractPhone(filename) {
  const full = extractFullNumber(filename);
  if (full) return normalizePhone(full);
  const last4 = extractLast4(filename);
  if (last4) return resolveLast4FromLeads(last4);
  return null;
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// PERF: memoized row. Receives only its OWN isUploading/isDone booleans (not the
// whole uploading/uploaded maps), so changing one file's status re-renders only
// that row instead of the entire list.
const RecordingRow = memo(function RecordingRow({ item, isUploading, isDone, onUpload }) {
  const phone = extractPhone(item.name);
  const handleUpload = useCallback(() => onUpload(item), [onUpload, item]);

  return (
    <View style={styles.card}>
      <View style={styles.cardLeft}>
        <View style={[styles.extBadge, isDone && styles.extBadgeDone]}>
          <Text style={styles.extText}>{item.extension?.toUpperCase() || 'AUD'}</Text>
        </View>
      </View>
      <View style={styles.cardMid}>
        <Text style={styles.fileName} numberOfLines={1}>{maskFilename(item.name)}</Text>
        <Text style={styles.fileMeta}>
          {formatSize(item.size)} · {fmtRecDate(item.modifiedAt)}
        </Text>
        {phone ? (
          <Text style={styles.phoneHint}>📞 {maskPhone(phone)}</Text>
        ) : (
          <Text style={styles.noPhone}>No phone number in filename</Text>
        )}
      </View>

      {isUploading ? (
        <ActivityIndicator size="small" color="#93C5FD" style={styles.statusBadge} />
      ) : isDone ? (
        <View style={[styles.statusBadge, styles.statusBadgeDone]}>
          <Icon name="check-circle" size={18} color="#4ADE80" />
        </View>
      ) : phone ? (
        <TouchableOpacity
          style={[styles.statusBadge, styles.statusBadgeUpload]}
          onPress={handleUpload}
        >
          <Icon name="cloud-upload-outline" size={18} color="#93C5FD" />
        </TouchableOpacity>
      ) : (
        <View style={styles.statusBadge}>
          <Icon name="cloud-clock-outline" size={18} color="#64748B" />
        </View>
      )}

      <Text style={isDone ? styles.autoLabelDone : styles.autoLabelPending}>
        {isUploading ? 'Uploading' : isDone ? 'Uploaded' : phone ? 'Upload' : 'Pending'}
      </Text>
    </View>
  );
});

async function loadUploadedSet() {
  try {
    const raw = await AsyncStorage.getItem(UPLOAD_TRACKER_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

async function saveUploadedSet(set) {
  try {
    const arr = Array.from(set);
    if (arr.length > 2000) arr.splice(0, arr.length - 2000);
    await AsyncStorage.setItem(UPLOAD_TRACKER_KEY, JSON.stringify(arr));
  } catch {}
}

function makeFileKey(filename, phone, mtimeMs) {
  return `${normalizePhone(phone)}::${filename}::${mtimeMs}`;
}

export default function RecordingsScreen() {
  const navigation = useNavigation();
  const [recordings,    setRecordings]    = useState([]);
  const [loading,       setLoading]       = useState(false);
  const [uploading,     setUploading]     = useState({});
  const [uploaded,      setUploaded]      = useState({});
  const uploadedSetRef  = useRef(new Set());

  useEffect(() => {
    loadUploadedSet().then(set => { uploadedSetRef.current = set; });
  }, []);

  // ── Manual upload handler (for recordings that weren't auto-uploaded) ────
  const handleUpload = useCallback(async (item) => {
    const phone = extractPhone(item.name);
    if (!phone) {
      Alert.alert('Cannot Upload', 'No phone number found in filename. Cannot associate this recording with a call.');
      return;
    }

    const fileMs  = new Date(item.modifiedAt).getTime();
    const fileKey = makeFileKey(item.name, phone, fileMs);

    // FIX: Always re-read AsyncStorage before uploading — not just the
    // in-memory ref. The background auto-sync may have uploaded this file
    // between the last scan and the user tapping Upload, and the ref
    // would be stale in that case.
    const freshSet = await loadUploadedSet();
    uploadedSetRef.current = freshSet;

    if (freshSet.has(fileKey)) {
      // Already uploaded (by auto-sync or a previous tap) — just mark done
      setUploaded(prev => ({ ...prev, [item.path]: true }));
      return;
    }

    setUploading(prev => ({ ...prev, [item.path]: true }));
    try {
      await uploadRecording(item.path, phone, fileMs);
      uploadedSetRef.current.add(fileKey);
      await saveUploadedSet(uploadedSetRef.current);
      setUploaded(prev => ({ ...prev, [item.path]: true }));
    } catch (e) {
      Alert.alert('Upload Failed', e.message || 'Could not upload recording.');
    } finally {
      setUploading(prev => ({ ...prev, [item.path]: false }));
    }
  }, []);

  const scanRecordings = useCallback((silent = false) => {
    setLoading(true);
    InteractionManager.runAfterInteractions(async () => {
      try {
        const found = await scanForRecordings();

        // FIX: Re-load from AsyncStorage on every scan (not just mount).
        // Auto-sync may have uploaded files between mount and this rescan —
        // using the stale in-memory ref would show Upload buttons for files
        // already uploaded by the background service.
        const freshSet = await loadUploadedSet();
        uploadedSetRef.current = freshSet;   // keep ref in sync too

        const initialUploaded = {};
        found.forEach(rec => {
          const phone  = extractPhone(rec.name);
          const fileMs = new Date(rec.modifiedAt).getTime();
          if (phone) {
            const fileKey = makeFileKey(rec.name, phone, fileMs);
            if (freshSet.has(fileKey)) initialUploaded[rec.path] = true;
          }
        });
        setUploaded(initialUploaded);
        setRecordings(found);

        if (!silent && found.length === 0) {
          Alert.alert(
            'No Recordings Found Today',
            'No call recordings from today were found on your device.\n\n' +
            'Recordings from previous days are not shown here — use the Lead Detail screen to find older recordings.',
          );
        }
      } catch (e) {
        Alert.alert('Error', 'Could not scan for recordings: ' + e.message);
      } finally {
        setLoading(false);
      }
    });
  }, []);

  // Auto-scan on mount
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      scanRecordings(true);
    });
    return () => task.cancel();
  }, []);

  const keyExtractor = useCallback((item) => item.path, []);

  const renderItem = useCallback(({ item }) => (
    <RecordingRow
      item={item}
      isUploading={uploading[item.path] || false}
      isDone={uploaded[item.path] || false}
      onUpload={handleUpload}
    />
  ), [uploading, uploaded, handleUpload]);

  // FIX: moment instead of Intl
  const todayLabel = moment().format('ddd, DD MMM');

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0F172A" />

      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Recordings</Text>
          <Text style={styles.subtitle}>
            {recordings.length > 0
              ? `${recordings.length} files today · ${todayLabel}`
              : `Today · ${todayLabel}`}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.scanBtn, loading && styles.scanBtnDisabled]}
          onPress={() => scanRecordings(false)}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator size="small" color="#93C5FD" />
            : <Icon name="folder-search-outline" size={18} color="#93C5FD" />
          }
          <Text style={styles.scanBtnText}>
            {loading ? 'Scanning…' : 'Rescan'}
          </Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={recordings}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={true}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyState}>
              <Icon name="microphone-off" size={52} color="#334155" />
              <Text style={styles.emptyTitle}>No recordings today</Text>
              <Text style={styles.emptySubtitle}>
                No call recordings from today were found on your device.
                {'\n\n'}Tap Rescan if you just completed a call.
              </Text>
              <TouchableOpacity style={styles.scanBtnLarge} onPress={() => scanRecordings(false)}>
                <Icon name="folder-search-outline" size={20} color="#93C5FD" />
                <Text style={styles.scanBtnLargeText}>Rescan for Today's Recordings</Text>
              </TouchableOpacity>
            </View>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container:          { flex: 1, backgroundColor: '#0D0F14' },
  header:             { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 52, paddingBottom: 14, backgroundColor: '#1A1D27', borderBottomWidth: 1, borderBottomColor: '#262A38' },
  title:              { fontSize: 22, fontWeight: '800', color: '#F0F2FA' },
  subtitle:           { fontSize: 12, color: '#565C75', marginTop: 2 },
  scanBtn:            { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#1E2236', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: '#262A38' },
  scanBtnDisabled:    { opacity: 0.5 },
  scanBtnText:        { color: '#93C5FD', fontSize: 13, fontWeight: '600' },
  listContent:        { padding: 16, paddingBottom: 40 },
  card:               { backgroundColor: '#1A1D27', borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: '#262A38' },
  cardLeft:           { alignItems: 'center', justifyContent: 'center' },
  extBadge:           { backgroundColor: '#1e293b', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: '#334155' },
  extBadgeDone:       { backgroundColor: '#052e16', borderColor: '#166534' },
  extText:            { fontSize: 10, fontWeight: '800', color: '#93C5FD', letterSpacing: 1 },
  cardMid:            { flex: 1, minWidth: 0 },
  fileName:           { fontSize: 13, fontWeight: '600', color: '#F0F2FA', marginBottom: 3 },
  fileMeta:           { fontSize: 11, color: '#565C75', marginBottom: 3 },
  phoneHint:          { fontSize: 11, color: '#4ADE80', fontWeight: '600' },
  noPhone:            { fontSize: 11, color: '#F59E0B' },
  statusBadge:        { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1e293b', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#334155' },
  statusBadgeDone:    { backgroundColor: '#052e16', borderColor: '#166534' },
  statusBadgeUpload:  { borderColor: '#3b82f6', backgroundColor: '#1e3a5f' },
  emptyState:         { alignItems: 'center', paddingTop: 80, paddingHorizontal: 32 },
  emptyTitle:         { fontSize: 17, fontWeight: '700', color: '#475569', marginTop: 14 },
  emptySubtitle:      { fontSize: 13, color: '#334155', marginTop: 6, textAlign: 'center', lineHeight: 20 },
  scanBtnLarge:       { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 24, backgroundColor: '#1E2236', borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12, borderWidth: 1, borderColor: '#262A38' },
  scanBtnLargeText:   { color: '#93C5FD', fontSize: 14, fontWeight: '600' },
  autoLabelDone:      { fontSize: 9, color: '#4ADE80', fontWeight: '700', textAlign: 'center', marginTop: 2, letterSpacing: 0.5 },
  autoLabelPending:   { fontSize: 9, color: '#475569', fontWeight: '600', textAlign: 'center', marginTop: 2 },
});