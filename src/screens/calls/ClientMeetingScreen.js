// src/screens/calls/ClientMeetingScreen.js
// ─────────────────────────────────────────────────────────────────────────────
// CLIENT MEETING — Field Visit Log
//
// A purpose-built screen for logging in-person client visits from the field.
// Completely separate from the Call Remark modal in LeadDetailScreen.
//
// Features:
//   • Lead selector with live search
//   • Visit type: In-Person / Site Visit / Demo / Video Call / Phone Call
//   • Location check-in (GPS address + manual override)
//   • Visit status outcome chips
//   • Meeting notes (free text)
//   • Follow-up date & time picker (Android-safe imperative API)
//   • Past meetings history for selected lead
//
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, Alert, ActivityIndicator, StatusBar,
  Platform, KeyboardAvoidingView,
} from 'react-native';
// NOTE: @react-native-community/datetimepicker is intentionally NOT imported.
// The follow-up date scheduler was removed from this screen, and the native
// module isn't in the compiled bundle (it crashed the screen when invoked).
import { useSelector }            from 'react-redux';
import { useNavigation }          from '@react-navigation/native';
import Icon                       from 'react-native-vector-icons/MaterialCommunityIcons';
import AsyncStorage               from '@react-native-async-storage/async-storage';
import { BASE_URL }               from '../../config/config';
import { requestLocationPermission } from '../../services/permissionsService';

// ── Constants ─────────────────────────────────────────────────────────────────
const VISIT_TYPES = [
  { id: 'In-Person',  icon: 'account-group',       label: 'In-Person'  },
  { id: 'Site Visit', icon: 'map-marker-outline',   label: 'Site Visit' },
  { id: 'Demo',       icon: 'presentation',         label: 'Demo'       },
  { id: 'Video Call', icon: 'video-outline',        label: 'Video Call' },
  { id: 'Phone Call', icon: 'phone-outline',        label: 'Phone Call' },
];

const OUTCOMES = [
  { id: 'Interested',         color: '#34D399', icon: 'thumb-up-outline'    },
  { id: 'Follow-Up Required', color: '#F59E0B', icon: 'calendar-clock'      },
  { id: 'Converted',          color: '#10B981', icon: 'check-decagram'      },
  { id: 'Pending Decision',   color: '#93C5FD', icon: 'clock-outline'       },
  { id: 'Not Interested',     color: '#EF4444', icon: 'thumb-down-outline'  },
  { id: 'No Show',            color: '#64748B', icon: 'account-off-outline' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
// NOTE: Date.prototype.toLocaleString(locale, options) relies on the JS
// engine's ICU/Intl data. Hermes (enabled in android/app/build.gradle) ships
// WITHOUT full ICU data by default, so calling toLocaleString('en-IN', {...})
// throws "Incomplete locale data" and crashes the screen whenever a follow-up
// date is set. Use `moment` (already a project dependency) instead, which
// formats dates without relying on Intl.
import moment from 'moment';

function formatDateTime(iso) {
  if (!iso) return '—';
  try {
    return moment(iso).format('DD MMM YYYY, hh:mm A');
  } catch { return iso; }
}

function formatDateShort(iso) {
  if (!iso) return '—';
  try {
    return moment(iso).format('DD MMM, hh:mm A');
  } catch { return iso; }
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60)   return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs  < 24)   return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function getAuthToken() {
  try { return await AsyncStorage.getItem('auth_token'); } catch { return null; }
}

async function postMeetingRemark(leadId, payload, mediaFile) {
  const token = await getAuthToken();

  // If a media file is attached, send multipart/form-data so the backend's
  // multer middleware stores it (document/recording fields). Otherwise send
  // plain JSON as before.
  if (mediaFile?.uri) {
    const form = new FormData();
    Object.entries(payload).forEach(([k, v]) => {
      if (v !== null && v !== undefined) form.append(k, String(v));
    });
    // Route images/docs to "document", audio to "recording" (matches backend).
    const field = (mediaFile.type || '').startsWith('audio') ? 'recording' : 'document';
    form.append(field, {
      uri:  mediaFile.uri,
      name: mediaFile.name || 'upload',
      type: mediaFile.type || 'application/octet-stream',
    });
    const res = await fetch(`${BASE_URL}/lead/${leadId}/meeting-remark`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        // NOTE: do NOT set Content-Type — RN sets the multipart boundary itself.
      },
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.message || `HTTP ${res.status}`);
    return body;
  }

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res  = await fetch(`${BASE_URL}/lead/${leadId}/meeting-remark`, {
    method: 'POST', headers, body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message || `HTTP ${res.status}`);
  return body;
}

async function fetchMeetingRemarks(leadId) {
  const token = await getAuthToken();
  const headers = {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res  = await fetch(`${BASE_URL}/lead/${leadId}/meeting-remarks`, { headers });
  if (!res.ok) return [];
  const body = await res.json().catch(() => ({}));
  return Array.isArray(body.meetingRemarks) ? body.meetingRemarks : [];
}

// ── Past Meeting Card ─────────────────────────────────────────────────────────
function PastMeetingCard({ item }) {
  const outcome = OUTCOMES.find(o => o.id === item.outcome);
  const color   = outcome?.color || '#94A3B8';
  const visitType = VISIT_TYPES.find(v => v.id === item.meetingType);

  return (
    <View style={styles.histCard}>
      <View style={styles.histCardTop}>
        <View style={styles.histTypeRow}>
          <Icon
            name={visitType?.icon || 'calendar-check'}
            size={13}
            color="#64748B"
            style={{ marginRight: 5 }}
          />
          <Text style={styles.histType}>{item.meetingType || 'Meeting'}</Text>
        </View>
        <Text style={styles.histTime}>{timeAgo(item.metAt || item.createdAt)}</Text>
      </View>

      {item.outcome ? (
        <View style={[styles.histOutcomePill, { backgroundColor: color + '18', borderColor: color + '50' }]}>
          <Icon name={outcome?.icon || 'flag-outline'} size={11} color={color} style={{ marginRight: 4 }} />
          <Text style={[styles.histOutcomeText, { color }]}>{item.outcome}</Text>
        </View>
      ) : null}

      {item.remark ? (
        <Text style={styles.histRemark} numberOfLines={2}>{item.remark}</Text>
      ) : null}

      <View style={styles.histFooter}>
        {item.location ? (
          <View style={styles.histLocationRow}>
            <Icon name="map-marker-outline" size={11} color="#475569" style={{ marginRight: 3 }} />
            <Text style={styles.histLocationText} numberOfLines={1}>{item.location}</Text>
          </View>
        ) : null}
        {item.followUpDate ? (
          <View style={styles.histFollowRow}>
            <Icon name="calendar-arrow-right" size={11} color="#F59E0B" style={{ marginRight: 3 }} />
            <Text style={styles.histFollowText}>{formatDateShort(item.followUpDate)}</Text>
          </View>
        ) : null}
        {item.userName ? (
          <Text style={styles.histAgent}>{item.userName}</Text>
        ) : null}
      </View>
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function ClientMeetingScreen() {
  const navigation = useNavigation();
  const leads      = useSelector(s => s.leads.items);

  // ── Lead search ─────────────────────────────────────────────────────────────
  const [leadSearch,     setLeadSearch]     = useState('');
  const [selectedLeadId, setSelectedLeadId] = useState('');
  const [showPicker,     setShowPicker]     = useState(false);

  const filteredLeads = leads
    .filter(l =>
      l.name?.toLowerCase().includes(leadSearch.toLowerCase()) ||
      (l.mobile || '').includes(leadSearch)
    )
    .slice(0, 20);

  const selectedLead = leads.find(l => l.id === selectedLeadId);

  // ── Form state ──────────────────────────────────────────────────────────────
  const [visitType,      setVisitType]      = useState('In-Person');
  const [outcome,        setOutcome]        = useState('');
  const [notes,          setNotes]          = useState('');
  const [location,       setLocation]       = useState('');
  const [fetchingGPS,    setFetchingGPS]    = useState(false);
  // Optional media attachment (photo / document / recording) for this visit.
  const [mediaFile,      setMediaFile]      = useState(null);
  // Optional follow-up date (re-added). Uses a crash-safe pure-JS picker — the
  // native DateTimePicker module isn't in the bundle and crashed the screen.
  const [followUpDate,   setFollowUpDate]   = useState(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [pickerFields,   setPickerFields]   = useState({ day: '', month: '', year: '', hour: '', minute: '' });
  const [submitting,     setSubmitting]     = useState(false);

  // ── Past meetings ───────────────────────────────────────────────────────────
  const [pastMeetings, setPastMeetings] = useState([]);
  const [loadingPast,  setLoadingPast]  = useState(false);

  useEffect(() => {
    if (!selectedLeadId) { setPastMeetings([]); return; }
    setLoadingPast(true);
    fetchMeetingRemarks(selectedLeadId)
      .then(setPastMeetings)
      .catch(() => setPastMeetings([]))
      .finally(() => setLoadingPast(false));
  }, [selectedLeadId]);

  // ── GPS check-in ─────────────────────────────────────────────────────────
  const handleCheckIn = useCallback(async () => {
    setFetchingGPS(true);
    try {
      // Ensure location permission is granted before calling getCurrentPosition.
      const hasPermission = await requestLocationPermission();
      if (!hasPermission) {
        setFetchingGPS(false);
        return;
      }

      const Geolocation = require('@react-native-community/geolocation').default
        || require('@react-native-community/geolocation');

      // Prefer Google Play Services' fused provider over the legacy Android
      // LocationManager. The legacy path is what throws "No location provider
      // available" when GPS has no lock (e.g. indoors). Fused falls back to
      // wifi/cell automatically. Wrapped in try/catch because setRNConfiguration
      // isn't available on all versions/platforms.
      try {
        Geolocation.setRNConfiguration({
          skipPermissionRequests: true,
          authorizationLevel: 'whenInUse',
          locationProvider: 'auto',   // 'auto' uses Play Services when available
        });
      } catch (_) { /* older lib version — ignore */ }

      const reverseGeocode = async (latitude, longitude) => {
        try {
          const res  = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`,
            { headers: { 'User-Agent': 'SkyUpCRM/1.0' } }
          );
          const data = await res.json();
          setLocation(data.display_name || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
        } catch {
          setLocation(`${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
        } finally {
          setFetchingGPS(false);
        }
      };

      const onSuccess = (pos) => {
        const { latitude, longitude } = pos.coords;
        reverseGeocode(latitude, longitude);
      };

      // Low-accuracy attempt — used as a fallback. Does NOT require a GPS lock,
      // so it succeeds indoors / where the high-accuracy attempt reports
      // "no provider available".
      const tryLowAccuracy = () => {
        Geolocation.getCurrentPosition(
          onSuccess,
          (err2) => {
            setFetchingGPS(false);
            Alert.alert(
              'Location Unavailable',
              (err2?.message && !/provider/i.test(err2.message))
                ? err2.message
                : 'Could not get your location (GPS may be off or unavailable indoors). Please turn on Location / GPS, or type the location manually.',
            );
          },
          { enableHighAccuracy: false, timeout: 20000, maximumAge: 60000 },
        );
      };

      // First try high accuracy (GPS). If it fails for any reason — including
      // "No location provider available" — fall back to low accuracy.
      Geolocation.getCurrentPosition(
        onSuccess,
        () => tryLowAccuracy(),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 10000 },
      );
    } catch {
      setFetchingGPS(false);
      Alert.alert('Location Unavailable', 'Location module not installed. Please type your location manually.');
    }
  }, []);

  // ── Media picker ──────────────────────────────────────────────────────────
  // Lets the rep attach a photo, document, or recording to the visit log.
  // Uses react-native-document-picker (already a dependency).
  const pickMedia = useCallback(async () => {
    try {
      const DocumentPicker = require('react-native-document-picker').default
        || require('react-native-document-picker');

      const [result] = await DocumentPicker.pick({
        type: [
          DocumentPicker.types.images,
          DocumentPicker.types.pdf,
          DocumentPicker.types.doc,
          DocumentPicker.types.docx,
          DocumentPicker.types.audio,
        ],
        copyTo: 'cachesDirectory',
      });

      const uri = result.fileCopyUri || result.uri;
      setMediaFile({
        uri,
        name: result.name || uri.split('/').pop(),
        type: result.type || 'application/octet-stream',
        size: result.size || 0,
      });
    } catch (e) {
      if (e?.code === 'DOCUMENT_PICKER_CANCELED') return;
      if (e?.message?.includes('Unable to resolve module')) {
        Alert.alert('Package Missing', 'react-native-document-picker is required for this feature.');
        return;
      }
      Alert.alert('Pick Failed', e.message || 'Could not open the media picker.');
    }
  }, []);

  // ── Follow-up date picker (crash-safe pure-JS) ────────────────────────────
  const openDatePicker = useCallback(() => {
    const base = followUpDate ? new Date(followUpDate) : new Date();
    setPickerFields({
      day:    String(base.getDate()),
      month:  String(base.getMonth() + 1),
      year:   String(base.getFullYear()),
      hour:   String(base.getHours()),
      minute: String(base.getMinutes()),
    });
    setShowDatePicker(true);
  }, [followUpDate]);

  const handleDateConfirm = useCallback(() => {
    const now    = new Date();
    let year     = parseInt(pickerFields.year, 10);
    let month    = parseInt(pickerFields.month, 10);
    let day      = parseInt(pickerFields.day, 10);
    let hour     = parseInt(pickerFields.hour, 10);
    let minute   = parseInt(pickerFields.minute, 10);

    if (!Number.isFinite(year))   year   = now.getFullYear();
    if (!Number.isFinite(month))  month  = now.getMonth() + 1;
    if (!Number.isFinite(day))    day    = now.getDate();
    if (!Number.isFinite(hour))   hour   = 0;
    if (!Number.isFinite(minute)) minute = 0;

    month  = Math.min(Math.max(month, 1), 12);
    hour   = Math.min(Math.max(hour, 0), 23);
    minute = Math.min(Math.max(minute, 0), 59);
    year   = Math.min(Math.max(year, now.getFullYear()), now.getFullYear() + 10);

    // Clamp day to the real number of days in the chosen month/year (no rollover).
    const daysInMonth = new Date(year, month, 0).getDate();
    day = Math.min(Math.max(day, 1), daysInMonth);

    const assembled = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (isNaN(assembled.getTime())) { setShowDatePicker(false); return; }
    setFollowUpDate(assembled.toISOString());
    setShowDatePicker(false);
  }, [pickerFields]);

  const clearFollowUp = useCallback(() => {
    setFollowUpDate(null);
    setShowDatePicker(false);
  }, []);

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!selectedLeadId) { Alert.alert('Required', 'Please select a lead.'); return; }
    if (!outcome)        { Alert.alert('Required', 'Please select a visit outcome.'); return; }
    if (!notes.trim())   { Alert.alert('Required', 'Please enter meeting notes.'); return; }

    setSubmitting(true);
    try {
      await postMeetingRemark(selectedLeadId, {
        meetingType: visitType,
        outcome,
        remark:      notes.trim(),
        location:    location.trim() || null,
        followUpDate: followUpDate || null,
      }, mediaFile);

      // Refresh history
      const updated = await fetchMeetingRemarks(selectedLeadId);
      setPastMeetings(updated);

      // Reset form (keep lead & visit type for quick follow-on entries)
      setOutcome('');
      setNotes('');
      setLocation('');
      setMediaFile(null);
      setFollowUpDate(null);

      Alert.alert('✓ Visit Logged', 'Client meeting recorded successfully.');
    } catch (e) {
      Alert.alert('Save Failed', e.message || 'Could not save the meeting.');
    } finally {
      setSubmitting(false);
    }
  }, [selectedLeadId, visitType, outcome, notes, location, mediaFile, followUpDate]);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0B1120" />

      {/* ── Header ── */}
      <View style={styles.header}>
        <View style={styles.headerIconWrap}>
          <Icon name="map-marker-check" size={20} color="#34D399" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Client Visit Log</Text>
          <Text style={styles.headerSub}>Record field meetings & check-ins</Text>
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >

          {/* ── Lead Selector ──────────────────────────────────────────────── */}
          <Text style={styles.sectionTitle}>
            <Icon name="account-outline" size={13} color="#64748B" />  CLIENT  *
          </Text>

          <TouchableOpacity
            style={[styles.leadBtn, selectedLead && styles.leadBtnSelected]}
            onPress={() => setShowPicker(v => !v)}
            activeOpacity={0.75}
          >
            {selectedLead ? (
              <View style={styles.leadBtnInner}>
                <View style={styles.leadAvatar}>
                  <Text style={styles.leadAvatarText}>
                    {(selectedLead.name || 'L')[0].toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.leadBtnName}>{selectedLead.name}</Text>
                  <Text style={styles.leadBtnPhone}>{selectedLead.mobile}</Text>
                </View>
                <Icon name={showPicker ? 'chevron-up' : 'chevron-down'} size={16} color="#34D399" />
              </View>
            ) : (
              <View style={styles.leadBtnInner}>
                <Icon name="account-search-outline" size={18} color="#475569" style={{ marginRight: 10 }} />
                <Text style={styles.leadBtnPlaceholder}>Search and select a client…</Text>
                <Icon name="chevron-down" size={16} color="#475569" />
              </View>
            )}
          </TouchableOpacity>

          {showPicker && (
            <View style={styles.leadDropdown}>
              <View style={styles.leadSearchBar}>
                <Icon name="magnify" size={16} color="#475569" style={{ marginRight: 8 }} />
                <TextInput
                  style={styles.leadSearchInput}
                  placeholder="Name or phone…"
                  placeholderTextColor="#334155"
                  value={leadSearch}
                  onChangeText={setLeadSearch}
                  autoFocus
                />
                {leadSearch.length > 0 && (
                  <TouchableOpacity onPress={() => setLeadSearch('')}>
                    <Icon name="close-circle" size={16} color="#475569" />
                  </TouchableOpacity>
                )}
              </View>
              {filteredLeads.length === 0 ? (
                <Text style={styles.leadEmptyText}>No clients found</Text>
              ) : (
                filteredLeads.map(l => (
                  <TouchableOpacity
                    key={l.id}
                    style={[styles.leadOption, selectedLeadId === l.id && styles.leadOptionActive]}
                    onPress={() => { setSelectedLeadId(l.id); setShowPicker(false); setLeadSearch(''); }}
                  >
                    <View style={[styles.leadOptionDot, selectedLeadId === l.id && styles.leadOptionDotActive]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.leadOptionName, selectedLeadId === l.id && { color: '#34D399' }]}>
                        {l.name}
                      </Text>
                      <Text style={styles.leadOptionPhone}>{l.mobile}</Text>
                    </View>
                  </TouchableOpacity>
                ))
              )}
            </View>
          )}

          {/* ── Visit Type ─────────────────────────────────────────────────── */}
          <Text style={styles.sectionTitle}>
            <Icon name="briefcase-outline" size={13} color="#64748B" />  VISIT TYPE
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.visitTypeRow}
          >
            {VISIT_TYPES.map(vt => (
              <TouchableOpacity
                key={vt.id}
                style={[styles.visitTypeChip, visitType === vt.id && styles.visitTypeChipActive]}
                onPress={() => setVisitType(vt.id)}
              >
                <Icon
                  name={vt.icon}
                  size={14}
                  color={visitType === vt.id ? '#34D399' : '#64748B'}
                  style={{ marginRight: 5 }}
                />
                <Text style={[styles.visitTypeText, visitType === vt.id && styles.visitTypeTextActive]}>
                  {vt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* ── Location Check-In ──────────────────────────────────────────── */}
          <Text style={styles.sectionTitle}>
            <Icon name="map-marker-outline" size={13} color="#64748B" />  LOCATION  <Text style={styles.optTag}>(optional)</Text>
          </Text>

          <View style={styles.locationRow}>
            <TextInput
              style={styles.locationInput}
              placeholder="Type location or tap Check-In…"
              placeholderTextColor="#334155"
              value={location}
              onChangeText={setLocation}
              multiline={false}
            />
            <TouchableOpacity
              style={[styles.checkInBtn, fetchingGPS && styles.checkInBtnLoading]}
              onPress={handleCheckIn}
              disabled={fetchingGPS}
            >
              {fetchingGPS
                ? <ActivityIndicator color="#34D399" size="small" />
                : <><Icon name="crosshairs-gps" size={14} color="#34D399" style={{ marginRight: 5 }} />
                    <Text style={styles.checkInBtnText}>Check-In</Text></>
              }
            </TouchableOpacity>
          </View>

          {/* ── Outcome ────────────────────────────────────────────────────── */}
          <Text style={styles.sectionTitle}>
            <Icon name="flag-checkered" size={13} color="#64748B" />  VISIT OUTCOME  *
          </Text>

          <View style={styles.outcomeGrid}>
            {OUTCOMES.map(o => (
              <TouchableOpacity
                key={o.id}
                style={[
                  styles.outcomeCard,
                  outcome === o.id && { borderColor: o.color, backgroundColor: o.color + '12' },
                ]}
                onPress={() => setOutcome(o.id)}
              >
                <Icon
                  name={o.icon}
                  size={16}
                  color={outcome === o.id ? o.color : '#334155'}
                  style={{ marginBottom: 4 }}
                />
                <Text style={[
                  styles.outcomeCardText,
                  outcome === o.id && { color: o.color },
                ]}>
                  {o.id}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* ── Meeting Notes ──────────────────────────────────────────────── */}
          <Text style={styles.sectionTitle}>
            <Icon name="note-edit-outline" size={13} color="#64748B" />  MEETING NOTES  *
          </Text>

          <TextInput
            style={styles.notesInput}
            placeholder="What was discussed? Key points, decisions, next steps…"
            placeholderTextColor="#334155"
            multiline
            value={notes}
            onChangeText={setNotes}
            textAlignVertical="top"
          />

          {/* ── Upload Media ───────────────────────────────────────────────── */}
          <Text style={styles.sectionTitle}>
            <Icon name="paperclip" size={13} color="#64748B" />  UPLOAD MEDIA  <Text style={styles.optTag}>(optional)</Text>
          </Text>

          {mediaFile ? (
            <View style={styles.followUpSet}>
              <Icon
                name={mediaFile.type?.startsWith('image') ? 'image' : mediaFile.type?.startsWith('audio') ? 'music-note' : 'file-document-outline'}
                size={16}
                color="#34D399"
                style={{ marginRight: 8 }}
              />
              <Text style={styles.followUpSetText} numberOfLines={1}>{mediaFile.name}</Text>
              <TouchableOpacity onPress={() => setMediaFile(null)} style={styles.clearFollowUp}>
                <Icon name="close-circle" size={18} color="#EF4444" />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.followUpBtn} onPress={pickMedia}>
              <Icon name="upload" size={16} color="#93C5FD" style={{ marginRight: 8 }} />
              <Text style={styles.followUpBtnText}>Attach Photo, Document or Recording</Text>
            </TouchableOpacity>
          )}

          {/* ── Follow-Up Date ─────────────────────────────────────────────── */}
          <Text style={styles.sectionTitle}>
            <Icon name="calendar-arrow-right" size={13} color="#64748B" />  FOLLOW-UP DATE  <Text style={styles.optTag}>(optional)</Text>
          </Text>

          {followUpDate ? (
            <View style={styles.followUpSet}>
              <Icon name="calendar-check" size={16} color="#34D399" style={{ marginRight: 8 }} />
              <Text style={styles.followUpSetText}>{formatDateTime(followUpDate)}</Text>
              <TouchableOpacity onPress={clearFollowUp} style={styles.clearFollowUp}>
                <Icon name="close-circle" size={18} color="#EF4444" />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.followUpBtn} onPress={openDatePicker}>
              <Icon name="calendar-plus" size={16} color="#93C5FD" style={{ marginRight: 8 }} />
              <Text style={styles.followUpBtnText}>Schedule Follow-Up</Text>
            </TouchableOpacity>
          )}

          {/* Crash-safe pure-JS date/time picker (no native DateTimePicker). */}
          {showDatePicker && (
            <View style={styles.jsPickerWrapper}>
              <Text style={styles.jsPickerTitle}>Set Follow-Up Date &amp; Time</Text>
              <View style={styles.jsPickerRow}>
                <View style={styles.jsPickerField}>
                  <Text style={styles.jsPickerLabel}>Day</Text>
                  <TextInput style={styles.jsPickerInput} keyboardType="number-pad" maxLength={2}
                    placeholder="DD" placeholderTextColor="#475569" value={pickerFields.day}
                    onChangeText={(v) => setPickerFields(p => ({ ...p, day: v.replace(/\D/g, '') }))} />
                </View>
                <View style={styles.jsPickerField}>
                  <Text style={styles.jsPickerLabel}>Month</Text>
                  <TextInput style={styles.jsPickerInput} keyboardType="number-pad" maxLength={2}
                    placeholder="MM" placeholderTextColor="#475569" value={pickerFields.month}
                    onChangeText={(v) => setPickerFields(p => ({ ...p, month: v.replace(/\D/g, '') }))} />
                </View>
                <View style={styles.jsPickerField}>
                  <Text style={styles.jsPickerLabel}>Year</Text>
                  <TextInput style={styles.jsPickerInput} keyboardType="number-pad" maxLength={4}
                    placeholder="YYYY" placeholderTextColor="#475569" value={pickerFields.year}
                    onChangeText={(v) => setPickerFields(p => ({ ...p, year: v.replace(/\D/g, '') }))} />
                </View>
              </View>
              <View style={styles.jsPickerRow}>
                <View style={styles.jsPickerField}>
                  <Text style={styles.jsPickerLabel}>Hour (0-23)</Text>
                  <TextInput style={styles.jsPickerInput} keyboardType="number-pad" maxLength={2}
                    placeholder="HH" placeholderTextColor="#475569" value={pickerFields.hour}
                    onChangeText={(v) => setPickerFields(p => ({ ...p, hour: v.replace(/\D/g, '') }))} />
                </View>
                <View style={styles.jsPickerField}>
                  <Text style={styles.jsPickerLabel}>Minute</Text>
                  <TextInput style={styles.jsPickerInput} keyboardType="number-pad" maxLength={2}
                    placeholder="MM" placeholderTextColor="#475569" value={pickerFields.minute}
                    onChangeText={(v) => setPickerFields(p => ({ ...p, minute: v.replace(/\D/g, '') }))} />
                </View>
              </View>
              <View style={styles.jsPickerActions}>
                <TouchableOpacity style={styles.jsPickerCancel} onPress={() => setShowDatePicker(false)}>
                  <Text style={styles.jsPickerCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.jsPickerConfirm} onPress={handleDateConfirm}>
                  <Text style={styles.jsPickerConfirmText}>Confirm</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ── Save Button ────────────────────────────────────────────────── */}
          <TouchableOpacity
            style={[styles.saveBtn, submitting && styles.saveBtnDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
            activeOpacity={0.8}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Icon name="map-marker-check" size={18} color="#fff" style={{ marginRight: 8 }} />
                <Text style={styles.saveBtnText}>Log Client Visit</Text>
              </>
            )}
          </TouchableOpacity>

          {/* ── Past Visits ───────────────────────────────────────────────── */}
          {selectedLeadId ? (
            <View style={styles.histSection}>
              <View style={styles.histHeader}>
                <Icon name="history" size={14} color="#334155" style={{ marginRight: 6 }} />
                <Text style={styles.histHeaderText}>
                  Visit History
                  {pastMeetings.length > 0 ? `  ·  ${pastMeetings.length}` : ''}
                </Text>
              </View>

              {loadingPast ? (
                <ActivityIndicator color="#2563EB" style={{ marginVertical: 20 }} />
              ) : pastMeetings.length === 0 ? (
                <View style={styles.histEmpty}>
                  <Icon name="calendar-blank-outline" size={36} color="#1E293B" />
                  <Text style={styles.histEmptyText}>No visits logged for this client yet</Text>
                </View>
              ) : (
                [...pastMeetings].reverse().map((item, i) => (
                  <PastMeetingCard key={i} item={item} />
                ))
              )}
            </View>
          ) : null}

        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  // ── Pure-JS follow-up date picker ──
  jsPickerWrapper:     { backgroundColor: '#0F172A', borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#334155' },
  jsPickerTitle:       { fontSize: 12, fontWeight: '700', color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 14, textAlign: 'center' },
  jsPickerRow:         { flexDirection: 'row', gap: 8, marginBottom: 10 },
  jsPickerField:       { flex: 1 },
  jsPickerLabel:       { fontSize: 10, color: '#64748B', fontWeight: '600', textTransform: 'uppercase', marginBottom: 4, textAlign: 'center' },
  jsPickerInput:       { backgroundColor: '#1A1D27', borderRadius: 8, borderWidth: 1, borderColor: '#334155', color: '#F0F2FA', fontSize: 16, fontWeight: '700', textAlign: 'center', paddingVertical: 10 },
  jsPickerActions:     { flexDirection: 'row', gap: 10, marginTop: 6 },
  jsPickerCancel:      { flex: 1, alignItems: 'center', paddingVertical: 11, borderRadius: 10, backgroundColor: '#1A1D27', borderWidth: 1, borderColor: '#334155' },
  jsPickerCancelText:  { color: '#94A3B8', fontSize: 14, fontWeight: '600' },
  jsPickerConfirm:     { flex: 1, alignItems: 'center', paddingVertical: 11, borderRadius: 10, backgroundColor: '#2563EB' },
  jsPickerConfirmText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  root:               { flex: 1, backgroundColor: '#080E1A' },

  // Header
  header:             { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 52, paddingBottom: 16, backgroundColor: '#0B1120', borderBottomWidth: 1, borderBottomColor: '#1E2A3A', gap: 12 },
  headerIconWrap:     { width: 40, height: 40, borderRadius: 20, backgroundColor: '#34D39918', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#34D39930' },
  headerTitle:        { fontSize: 18, fontWeight: '800', color: '#F0F2FA', letterSpacing: 0.2 },
  headerSub:          { fontSize: 11, color: '#334155', marginTop: 2 },

  // Scroll
  scrollContent:      { padding: 16, paddingBottom: 60 },

  // Section titles
  sectionTitle:       { fontSize: 10, fontWeight: '800', color: '#334155', letterSpacing: 1.2, marginBottom: 8, marginTop: 20 },
  optTag:             { fontSize: 10, fontWeight: '400', color: '#1E293B', letterSpacing: 0 },

  // Lead selector
  leadBtn:            { backgroundColor: '#0D1828', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#1E2A3A' },
  leadBtnSelected:    { borderColor: '#34D39940', backgroundColor: '#0D1F2E' },
  leadBtnInner:       { flexDirection: 'row', alignItems: 'center' },
  leadAvatar:         { width: 36, height: 36, borderRadius: 18, backgroundColor: '#34D39918', alignItems: 'center', justifyContent: 'center', marginRight: 10, borderWidth: 1, borderColor: '#34D39930' },
  leadAvatarText:     { fontSize: 15, fontWeight: '800', color: '#34D399' },
  leadBtnName:        { fontSize: 14, fontWeight: '700', color: '#F0F2FA' },
  leadBtnPhone:       { fontSize: 11, color: '#475569', marginTop: 2 },
  leadBtnPlaceholder: { flex: 1, fontSize: 13, color: '#334155' },

  leadDropdown:       { marginTop: 6, backgroundColor: '#0D1828', borderRadius: 12, borderWidth: 1, borderColor: '#1E2A3A', overflow: 'hidden', maxHeight: 280 },
  leadSearchBar:      { flexDirection: 'row', alignItems: 'center', padding: 10, borderBottomWidth: 1, borderBottomColor: '#1E2A3A' },
  leadSearchInput:    { flex: 1, color: '#F0F2FA', fontSize: 13, padding: 0 },
  leadEmptyText:      { padding: 16, color: '#334155', textAlign: 'center', fontSize: 13 },
  leadOption:         { flexDirection: 'row', alignItems: 'center', padding: 12, borderBottomWidth: 1, borderBottomColor: '#0F1A2A', gap: 10 },
  leadOptionActive:   { backgroundColor: '#0D2040' },
  leadOptionDot:      { width: 8, height: 8, borderRadius: 4, backgroundColor: '#1E2A3A' },
  leadOptionDotActive:{ backgroundColor: '#34D399' },
  leadOptionName:     { fontSize: 13, fontWeight: '600', color: '#CBD5E1' },
  leadOptionPhone:    { fontSize: 11, color: '#334155', marginTop: 2 },

  // Visit type
  visitTypeRow:       { gap: 8, paddingBottom: 4 },
  visitTypeChip:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, backgroundColor: '#0D1828', borderWidth: 1, borderColor: '#1E2A3A' },
  visitTypeChipActive:{ backgroundColor: '#34D39910', borderColor: '#34D39950' },
  visitTypeText:      { fontSize: 12, color: '#475569', fontWeight: '600' },
  visitTypeTextActive:{ color: '#34D399' },

  // Location
  locationRow:        { flexDirection: 'row', alignItems: 'center', gap: 8 },
  locationInput:      { flex: 1, backgroundColor: '#0D1828', borderRadius: 10, padding: 12, color: '#F0F2FA', fontSize: 13, borderWidth: 1, borderColor: '#1E2A3A' },
  checkInBtn:         { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, borderRadius: 10, backgroundColor: '#34D39910', borderWidth: 1, borderColor: '#34D39940' },
  checkInBtnLoading:  { opacity: 0.6 },
  checkInBtnText:     { fontSize: 12, fontWeight: '700', color: '#34D399' },

  // Outcome grid
  outcomeGrid:        { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  outcomeCard:        { width: '30.5%', paddingVertical: 12, borderRadius: 12, backgroundColor: '#0D1828', borderWidth: 1, borderColor: '#1E2A3A', alignItems: 'center' },
  outcomeCardText:    { fontSize: 11, fontWeight: '600', color: '#334155', textAlign: 'center', lineHeight: 14, marginTop: 2 },

  // Notes
  notesInput:         { backgroundColor: '#0D1828', borderRadius: 12, padding: 14, color: '#F0F2FA', minHeight: 120, borderWidth: 1, borderColor: '#1E2A3A', fontSize: 13, lineHeight: 21 },

  // Follow-up
  followUpSet:        { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0D1828', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#34D39940' },
  followUpSetText:    { flex: 1, color: '#34D399', fontSize: 13, fontWeight: '700' },
  clearFollowUp:      { padding: 2 },
  followUpBtn:        { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0D1828', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#1E2A3A' },
  followUpBtnText:    { color: '#93C5FD', fontSize: 13, fontWeight: '700' },
  iosPickerBox:       { backgroundColor: '#0B1120', borderRadius: 12, marginTop: 8, overflow: 'hidden', borderWidth: 1, borderColor: '#1E2A3A' },
  iosDoneBtn:         { alignItems: 'center', paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#1E2A3A' },
  iosDoneBtnText:     { color: '#34D399', fontSize: 15, fontWeight: '700' },

  // Save button
  saveBtn:            { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#059669', borderRadius: 14, paddingVertical: 16, marginTop: 24 },
  saveBtnDisabled:    { opacity: 0.55 },
  saveBtnText:        { color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 0.3 },

  // History
  histSection:        { marginTop: 32 },
  histHeader:         { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  histHeaderText:     { fontSize: 11, fontWeight: '800', color: '#334155', letterSpacing: 1.1 },
  histEmpty:          { alignItems: 'center', paddingVertical: 36 },
  histEmptyText:      { fontSize: 13, color: '#1E293B', marginTop: 10 },

  histCard:           { backgroundColor: '#0D1828', borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#1E2A3A' },
  histCardTop:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  histTypeRow:        { flexDirection: 'row', alignItems: 'center' },
  histType:           { fontSize: 12, fontWeight: '700', color: '#475569' },
  histTime:           { fontSize: 11, color: '#1E293B' },
  histOutcomePill:    { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, borderWidth: 1, marginBottom: 8 },
  histOutcomeText:    { fontSize: 11, fontWeight: '700' },
  histRemark:         { fontSize: 12, color: '#64748B', lineHeight: 18, marginBottom: 8 },
  histFooter:         { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  histLocationRow:    { flexDirection: 'row', alignItems: 'center', flex: 1 },
  histLocationText:   { fontSize: 11, color: '#334155', flex: 1 },
  histFollowRow:      { flexDirection: 'row', alignItems: 'center' },
  histFollowText:     { fontSize: 11, color: '#F59E0B', fontWeight: '600' },
  histAgent:          { fontSize: 11, color: '#1E293B', marginLeft: 'auto' },
});