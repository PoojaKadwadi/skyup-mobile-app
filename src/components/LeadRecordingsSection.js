// src/components/LeadRecordingsSection.js


import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, Alert, Platform,
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

const fmtRecDate = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
});

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

async function addToUploadedSet(fileKey) {
  try {
    const set = await loadUploadedSet();
    set.add(fileKey);
    const arr = Array.from(set);
    if (arr.length > 2000) arr.splice(0, arr.length - 2000);
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

// ── Contact name match ────────────────────────────────────────────────────────
function filenameMatchesName(filename, leadName) {
  if (!leadName || leadName.trim().length < 3) return false;
  const nameNoExt = filename.replace(/\.[^.]+$/, '');
  const prefix    = stripTimestampSuffix(nameNoExt).toLowerCase().trim();
  const name      = leadName.toLowerCase().trim();
  if (prefix.length < 3) return false;

  return prefix === name
    || (name.length >= 4 && name.startsWith(prefix))
    || (prefix.length >= 4 && prefix.startsWith(name));
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
async function scanDir(dir) {
  if (!RNFS) return [];
  try {
    const exists = await RNFS.exists(dir);
    if (!exists) return [];
    const entries = await RNFS.readDir(dir);

    const audioFiles = [];

    for (const entry of entries) {
      if (isFileEntry(entry)) {
        const ext = entry.name.split('.').pop().toLowerCase();
        if (AUDIO_EXTS.has(ext)) audioFiles.push(entry);
      } else {
        try {
          const subEntries = await RNFS.readDir(entry.path);
          for (const sub of subEntries) {
            if (!isFileEntry(sub)) continue;
            const ext = sub.name.split('.').pop().toLowerCase();
            if (AUDIO_EXTS.has(ext)) audioFiles.push(sub);
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
async function findRecordingsForLead(phoneNumber, leadName = '', callLogs = []) {
  if (!RNFS) return [];

  const granted = await requestStoragePermission();
  if (!granted) throw new Error('Storage permission denied');

  const variants = getPhoneVariants(phoneNumber);
  const seen     = new Set();
  const results  = [];

  console.log(`[Recordings] Scanning for phone="${phoneNumber}" name="${leadName}" variants=${JSON.stringify(variants)}`);

  const dirsToScan = await buildScanDirs(RECORDING_DIRS);

  for (const dir of dirsToScan) {
    const files = await scanDir(dir);
    if (files.length > 0) {
      console.log(`[Recordings] Dir "${dir}" → ${files.length} audio file(s):`, files.map(f => f.name));
    }

    for (const f of files) {
      if (seen.has(f.path)) continue;

      const byPhone = filenameMatchesPhone(f.name, variants);
      const byName  = !byPhone && filenameMatchesName(f.name, leadName);
      const byTime  = !byPhone && !byName && timestampMatchesCallLog(f.mtime, callLogs);

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
// FIX: Checks AsyncStorage on mount so "Saved" state persists across navigation.
// Without this, every time the user navigated away and back, Upload would
// re-appear even for recordings already uploaded in this session.
function RecordingRow({ item, leadId, phoneNumber }) {
  const [status, setStatus] = useState('idle'); // idle | checking | uploading | done | failed

  // FIX: On mount check AsyncStorage to see if this file was already uploaded
  useEffect(() => {
    let cancelled = false;
    const checkUploaded = async () => {
      setStatus('checking');
      try {
        const fileMs  = item.modifiedAt ? new Date(item.modifiedAt).getTime() : 0;
        const fileKey = makeFileKey(item.name, normalizePhone(phoneNumber || ''), fileMs);
        const set     = await loadUploadedSet();
        if (!cancelled) {
          setStatus(set.has(fileKey) ? 'done' : 'idle');
        }
      } catch {
        if (!cancelled) setStatus('idle');
      }
    };
    checkUploaded();
    return () => { cancelled = true; };
  }, [item.path, item.modifiedAt, phoneNumber]);

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
          {item.modifiedAt ? `  ·  ${fmtRecDate.format(new Date(item.modifiedAt))}` : ''}
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
export default function LeadRecordingsSection({ lead }) {
  const [recordings, setRecordings] = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [scanned,    setScanned]    = useState(false);

  const doScanRef = useRef(null);

  const doScan = useCallback(async (isManual = true) => {
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

      const found = await findRecordingsForLead(
        lead.mobile,
        lead.name || '',
        callLogs,
      );
      setRecordings(found);
      setScanned(true);

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

  useEffect(() => {
    if (!lead?.mobile || Platform.OS !== 'android') return;
    doScanRef.current(false);
  }, [lead?.mobile]);

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