import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, Alert, Modal, ActivityIndicator, StatusBar,
  KeyboardAvoidingView, Platform, AppState, Linking,
} from 'react-native';
// CRASH FIX: @react-native-community/datetimepicker NOT in bundle — removed import
// DateTimePickerAndroid.open() was crashing the Follow-Up button on every Android device.
// Replaced with pure-JS date/time picker using built-in TextInput + View components.
import { useDispatch, useSelector }                from 'react-redux';
import { useNavigation, useRoute }                 from '@react-navigation/native';
import Icon                                        from 'react-native-vector-icons/MaterialCommunityIcons';
import { submitCallRemark, patchLead }             from '../../store/slices/leadsSlice';
import { makePhoneCall, normalizePhone }           from '../../services/phoneService';
import { getCallLogsForNumber }                    from '../../services/phoneService';
import { getLeadCallLogs }                         from '../../api/callLogsApi';
import { triggerPostCallRecordingSync }            from '../../services/backgroundSyncService';
import { syncCallLogs }                            from '../../api/callLogsApi';
import CallButton                                  from '../../components/CallButton';
import LeadRecordingsSection                       from '../../components/LeadRecordingsSection';
import moment                                      from 'moment';

const OUTCOMES = ['Answered', 'Not Answered', 'Busy', 'Switch Off', 'Call Back Later', 'Interested', 'Not Interested'];

function maskPhone(phone) {
  if (!phone) return '—';
  const digits = normalizePhone(phone) || String(phone).replace(/\D/g, '');
  if (digits.length < 6) return '••••••';
  return digits.slice(0, 2) + '•••••' + digits.slice(-2);
}

// toLocaleDateString/toLocaleString rely on Hermes ICU data which may be
// incomplete on real devices and throw "Incomplete locale data" — use
// moment instead, which formats without Intl.
function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return moment(dateStr).format('DD MMM YYYY');
  } catch { return dateStr; }
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  try {
    return moment(dateStr).format('DD MMM, hh:mm A');
  } catch { return dateStr; }
}

function formatDuration(secs) {
  if (!secs || secs === 0) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function callTypeColor(type) {
  return ({ incoming: '#059669', outgoing: '#2563EB', missed: '#EF4444', rejected: '#F59E0B', blocked: '#64748B' })[type] || '#64748B';
}
function callTypeIcon(type) {
  return ({ incoming: 'phone-incoming', outgoing: 'phone-outgoing', missed: 'phone-missed', rejected: 'phone-cancel', blocked: 'phone-off' })[type] || 'phone';
}
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

// EMAIL MASKING: show only the first 2 chars + last char of the local part.
// e.g. "john.doe@example.com" → "jo••••e@example.com"
// Protects PII visible on-screen while keeping the domain for verification.
function maskEmail(email) {
  if (!email || !email.includes('@')) return email || '—';
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${'•'.repeat(local.length)}@${domain}`;
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(2, local.length - 3))}${local.slice(-1)}@${domain}`;
}

function InfoItem({ icon, label, value, full }) {
  return (
    <View style={[styles.infoItem, full && { flex: 1, width: '100%' }]}>
      <View style={styles.infoItemLeft}>
        <Icon name={icon} size={14} color="#64748B" style={{ marginRight: 6 }} />
        <Text style={styles.infoLabel}>{label}</Text>
      </View>
      <Text style={styles.infoValue} numberOfLines={full ? 0 : 1}>{value}</Text>
    </View>
  );
}

export default function LeadDetailScreen() {
  const dispatch   = useDispatch();
  const navigation = useNavigation();
  const route      = useRoute();
  const { leadId, postCall = false } = route.params;

  const lead = useSelector((s) => s.leads.items.find(l => l.id === leadId));

  // ── Has this lead already been marked "Interested"? ─────────────────────────
  // If yes, we hide the "Interested" outcome chip so the agent can't pick it
  // again — preventing duplicate "Interested" entries on the same lead.
  // Detected from either the lead's current status OR any past call-history entry.
  const alreadyInterested = (() => {
    if (!lead) return false;
    const status = (lead.status || '').toLowerCase();
    if (status === 'interested' || status === 'in progress' || status === 'converted') return true;
    const history = Array.isArray(lead.callHistory) ? lead.callHistory : [];
    return history.some(h => (h.outcome || '').toLowerCase() === 'interested');
  })();

  const [showRemarkModal, setShowRemarkModal] = useState(postCall);
  const [remark,          setRemark]          = useState('');
  const [outcome,         setOutcome]         = useState('');
  const [submitting,      setSubmitting]      = useState(false);
  const [crmCallLogs,     setCrmCallLogs]     = useState([]);
  const [loadingLogs,     setLoadingLogs]     = useState(false);
  const [logsLoaded,      setLogsLoaded]      = useState(false);

  // ── Follow-up date state ────────────────────────────────────────────────────
  // FIX: followUpDate was hardcoded to null — the agent had no way to set it.
  // Now there's a date/time picker in the remark modal.
  const [followUpDate,    setFollowUpDate]    = useState(null);
  const [showDatePicker,  setShowDatePicker]  = useState(false); // iOS only
  const [pickerTempDate,  setPickerTempDate]  = useState(new Date());
  // Raw text fields for the date/time picker. Kept as strings so the user can
  // type freely (clear a field, type multiple digits) without the value being
  // reformatted on every keystroke — which was the bug that made day/month/year
  // impossible to edit. Validated + assembled into a Date only on Confirm.
  const [pickerFields, setPickerFields] = useState({ day: '', month: '', year: '', hour: '', minute: '' });

  const [uploadProgress,  setUploadProgress]  = useState(null); // retained for API compat

  const loadCrmCallLogs = useCallback(async () => {
    setLoadingLogs(true);
    try {
      const logs = await getLeadCallLogs(leadId, 10);
      setCrmCallLogs(logs);
      setLogsLoaded(true);
    } catch (e) {
      console.warn('[LeadDetail] Could not fetch CRM call logs:', e.message);
    } finally {
      setLoadingLogs(false);
    }
  }, [leadId]);

  // ── Call handling ───────────────────────────────────────────────────────────
  const callListenerRef  = React.useRef(null);
  const wentToBackground = React.useRef(false);
  const callPending      = React.useRef(false);
  // PERF FIX: track mount state so AppState listener never updates unmounted
  // component state or leaves a stale listener if user navigates away mid-call.
  const isMountedRef     = React.useRef(true);

  const handleCall = async (dialNumber) => {
    // CallButton passes the number it dialed; fall back to the lead's primary
    // (lead.mobile already prefers primaryPhone via the normalizer).
    const numberToCall = dialNumber || lead.mobile || lead.primaryPhone || lead.phone;
    try {
      const { requestCallPermission } = require('../../services/permissionsService');
      const granted = await requestCallPermission();
      if (!granted) {
        Alert.alert('Permission Required', 'Call permission is needed to make calls.');
        return;
      }

      const callStartedAt = Date.now();
      wentToBackground.current = false;
      callPending.current      = true;
      let backgroundAt         = 0;
      callListenerRef.current?.remove();

      callListenerRef.current = AppState.addEventListener('change', async (nextState) => {
        if (!callPending.current) return;
        // PERF FIX: abort immediately if component unmounted to prevent
        // state updates on an unmounted component and stale listener actions.
        if (!isMountedRef.current) {
          callListenerRef.current?.remove();
          callListenerRef.current = null;
          return;
        }

        if (nextState === 'background' || nextState === 'inactive') {
          if (!wentToBackground.current) {
            backgroundAt = Date.now();
            wentToBackground.current = true;
          }
          return;
        }

        if (nextState === 'active' && wentToBackground.current) {
          const timeInBackground = Date.now() - backgroundAt;
          if (timeInBackground < 2000) {
            wentToBackground.current = false;
            backgroundAt = 0;
            return;
          }

          callPending.current      = false;
          wentToBackground.current = false;
          callListenerRef.current?.remove();
          callListenerRef.current = null;

          try {
            const logs = await getCallLogsForNumber(numberToCall);
            if (logs.length > 0) await syncCallLogs(logs.slice(0, 5));
          } catch {}

          try { triggerPostCallRecordingSync(numberToCall, callStartedAt); } catch {}

          setTimeout(() => setShowRemarkModal(true), 600);
        }
      });

      const { Linking } = require('react-native');
      const { normalizePhone: norm } = require('../../services/phoneService');
      const dialUri = `tel:${norm(numberToCall)}`;
      const canOpen = await Linking.canOpenURL(dialUri);
      if (!canOpen) throw new Error('This device cannot make phone calls');
      await Linking.openURL(dialUri);

    } catch (e) {
      callPending.current = false;
      callListenerRef.current?.remove();
      callListenerRef.current = null;
      Alert.alert('Call Failed', e.message);
    }
  };

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      // PERF FIX: set isMountedRef false first so any in-flight AppState
      // callback aborts before touching state. Then ensure the listener is
      // always removed — even if the component unmounts before the call completes.
      isMountedRef.current = false;
      callPending.current  = false;
      if (callListenerRef.current) {
        callListenerRef.current.remove();
        callListenerRef.current = null;
      }
    };
  }, []);

  // ── Date/Time picker ───────────────────────────────────────────────────────
  // CRASH FIX: Replaced DateTimePickerAndroid.open() with simple JS picker.
  // The @react-native-community/datetimepicker native module is NOT compiled
  // into index.android.bundle, so calling DateTimePickerAndroid.open() throws
  // "undefined is not an object" and crashes the Follow-Up button instantly.
  const openDatePicker = () => {
    // Seed the editable fields from "now" (or the already-chosen follow-up).
    const base = followUpDate ? new Date(followUpDate) : new Date();
    setPickerFields({
      day:    String(base.getDate()),
      month:  String(base.getMonth() + 1),
      year:   String(base.getFullYear()),
      hour:   String(base.getHours()),
      minute: String(base.getMinutes()),
    });
    setShowDatePicker(true);
  };

  // JS picker confirm handler — assembles a Date from the raw string fields,
  // clamping each part to a valid range (and the day to the real number of days
  // in the chosen month/year, so e.g. Feb 31 → Feb 28/29 instead of rolling
  // over into March).
  const handleDateConfirm = () => {
    const now   = new Date();
    let year    = parseInt(pickerFields.year, 10);
    let month   = parseInt(pickerFields.month, 10);
    let day     = parseInt(pickerFields.day, 10);
    let hour    = parseInt(pickerFields.hour, 10);
    let minute  = parseInt(pickerFields.minute, 10);

    if (!Number.isFinite(year))   year   = now.getFullYear();
    if (!Number.isFinite(month))  month  = now.getMonth() + 1;
    if (!Number.isFinite(day))    day    = now.getDate();
    if (!Number.isFinite(hour))   hour   = 0;
    if (!Number.isFinite(minute)) minute = 0;

    month = Math.min(Math.max(month, 1), 12);
    hour  = Math.min(Math.max(hour, 0), 23);
    minute = Math.min(Math.max(minute, 0), 59);
    year  = Math.min(Math.max(year, now.getFullYear()), now.getFullYear() + 10);

    // Clamp day to the actual number of days in the selected month/year.
    const daysInMonth = new Date(year, month, 0).getDate();
    day = Math.min(Math.max(day, 1), daysInMonth);

    const assembled = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (isNaN(assembled.getTime())) {
      setShowDatePicker(false);
      return;
    }
    setPickerTempDate(assembled);
    setFollowUpDate(assembled.toISOString());
    setShowDatePicker(false);
  };

  // JS picker confirm handler (legacy callers)
  const handleDateChange = (selectedDate) => {
    if (selectedDate && !isNaN(selectedDate)) {
      setPickerTempDate(selectedDate);
      setFollowUpDate(selectedDate.toISOString());
    }
    setShowDatePicker(false);
  };

  const clearFollowUpDate = () => {
    setFollowUpDate(null);
    setPickerTempDate(new Date());
    setShowDatePicker(false);
  };

  // Reset modal state when it closes
  const closeModal = () => {
    setShowRemarkModal(false);
    setRemark('');
    setOutcome('');
    setFollowUpDate(null);
    setPickerTempDate(new Date());
    setShowDatePicker(false);
    setUploadProgress(null);
  };

  // ── Attachment pickers ──────────────────────────────────────────────────────
  // Uses react-native-document-picker (already a common dep in RN CRM apps).
  // Gracefully falls back with a clear message if not installed.

  const pickDocument = async () => {
    try {
      const DocumentPicker = require('react-native-document-picker').default
        || require('react-native-document-picker');

      const [result] = await DocumentPicker.pick({
        type: [
          DocumentPicker.types.pdf,
          DocumentPicker.types.doc,
          DocumentPicker.types.docx,
          DocumentPicker.types.xls,
          DocumentPicker.types.xlsx,
          DocumentPicker.types.plainText,
          DocumentPicker.types.images,
        ],
        copyTo: 'cachesDirectory',
      });

      // Use fileCopyUri when available (reliable across all Android versions)
      const uri = result.fileCopyUri || result.uri;
      setAttachDoc({
        uri,
        name: result.name || uri.split('/').pop(),
        type: result.type || 'application/octet-stream',
        size: result.size || 0,
      });
    } catch (e) {
      if (e?.code === 'DOCUMENT_PICKER_CANCELED') return; // user tapped back
      if (e?.message?.includes('Unable to resolve module')) {
        Alert.alert(
          'Package Missing',
          'react-native-document-picker is required for this feature.\nRun: npm install react-native-document-picker',
        );
        return;
      }
      Alert.alert('Pick Failed', e.message || 'Could not open document picker.');
    }
  };

  const pickRecording = async () => {
    try {
      const DocumentPicker = require('react-native-document-picker').default
        || require('react-native-document-picker');

      const [result] = await DocumentPicker.pick({
        type: [DocumentPicker.types.audio],
        copyTo: 'cachesDirectory',
      });

      const uri = result.fileCopyUri || result.uri;
      setAttachRec({
        uri,
        name: result.name || uri.split('/').pop(),
        type: result.type || 'audio/mpeg',
        size: result.size || 0,
      });
    } catch (e) {
      if (e?.code === 'DOCUMENT_PICKER_CANCELED') return;
      if (e?.message?.includes('Unable to resolve module')) {
        Alert.alert(
          'Package Missing',
          'react-native-document-picker is required for this feature.\nRun: npm install react-native-document-picker',
        );
        return;
      }
      Alert.alert('Pick Failed', e.message || 'Could not open audio picker.');
    }
  };

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '';
    if (bytes < 1024)       return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ── Submit remark ───────────────────────────────────────────────────────────
  const handleSubmitRemark = async () => {
    if (!remark.trim()) { Alert.alert('Required', 'Please enter a call remark'); return; }
    if (!outcome)       { Alert.alert('Required', 'Please select a call outcome'); return; }

    setSubmitting(true);

    try {
      await dispatch(submitCallRemark({
        leadId,
        remark:      remark.trim(),
        outcome,
        followUpDate: followUpDate || null,
        document:    null,
        recording:   null,
      })).unwrap();

      closeModal();
      const extras = [
        followUpDate && `Follow-up: ${formatDateTime(followUpDate)}`,
      ].filter(Boolean);

      Alert.alert(
        '✓ Saved',
        extras.length
          ? `Remark saved.\n${extras.join('\n')}`
          : 'Call remark saved to CRM',
      );
    } catch (e) {
      setUploadProgress(null);
      Alert.alert('Failed', e.toString());
    } finally { setSubmitting(false); }
  };

  if (!lead) {
    return (
      <View style={styles.notFound}>
        <Icon name="account-alert" size={48} color="#334155" />
        <Text style={styles.notFoundText}>Lead not found</Text>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backLink}>← Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Save to Contacts ──────────────────────────────────────────────────────
  // Saves the lead as a phone contact with name = "LeadName XXXX"
  // where XXXX = last 4 digits of their phone number.
  const handleSaveToContacts = async () => {
    try {
      // Use react-native-permissions (consistent with the rest of the app).
      // PermissionsAndroid.request() was used before — it silently fails on Android 11+
      // when the permission is in the BLOCKED state (previously denied) because it
      // just returns DENIED without showing a dialog, leaving the user no way to fix it.
      // react-native-permissions correctly distinguishes BLOCKED so we can send
      // the user to Settings when needed.
      //
      // ALSO: WRITE_CONTACTS alone is insufficient on some Android versions —
      // READ_CONTACTS must also be granted first, otherwise the OS rejects the write.
      // Both permissions must be declared in AndroidManifest.xml (now fixed there too).
      if (Platform.OS === 'android') {
        // FIX: Use PermissionsAndroid (built into RN bundle) instead of
        // react-native-permissions which is NOT in the compiled bundle.
        // require('react-native-permissions') was silently failing, so the
        // Contacts permission dialog NEVER appeared — it jumped straight to
        // showing "Permission Required → Open Settings" on every tap.
        const { PermissionsAndroid } = require('react-native');
        const READ  = PermissionsAndroid.PERMISSIONS.READ_CONTACTS;
        const WRITE = PermissionsAndroid.PERMISSIONS.WRITE_CONTACTS;

        const results = await PermissionsAndroid.requestMultiple([READ, WRITE]);

        const readGranted  = results[READ]  === PermissionsAndroid.RESULTS.GRANTED;
        const writeGranted = results[WRITE] === PermissionsAndroid.RESULTS.GRANTED;
        const readBlocked  = results[READ]  === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN;
        const writeBlocked = results[WRITE] === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN;

        if (readBlocked || writeBlocked) {
          Alert.alert(
            'Contacts Permission Required',
            'SkyUp CRM needs Contacts permission to save this lead. Please enable it in Settings → Apps → SkyUp CRM → Permissions → Contacts.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open Settings', onPress: () => Linking.openSettings() },
            ],
          );
          return;
        }

        if (!readGranted || !writeGranted) {
          Alert.alert('Permission Denied', 'Cannot save contact without Contacts permission.');
          return;
        }
      }

      // Build contact name: "LeadName 4567" (last 4 digits of the primary number)
      const rawPhone = lead.primaryPhone || lead.mobile || lead.phone || '';
      const digits   = rawPhone.replace(/\D/g, '');
      const last4    = digits.slice(-4) || '0000';
      const contactName = `${lead.name || 'Lead'} ${last4}`;

      // Auto-save directly to the device address book via the native
      // ContactsModule (ContentResolver insert) — NO screen is opened, the
      // contact is written silently. This replaces the old ACTION_INSERT intent
      // that only PRE-FILLED the New Contact screen and required a manual tap.
      const { NativeModules } = require('react-native');
      const ContactsModule = NativeModules.ContactsModule;

      if (ContactsModule && typeof ContactsModule.saveContact === 'function') {
        try {
          await ContactsModule.saveContact(
            contactName,
            rawPhone,
            lead.email || '',
            lead.company || '',
          );
          Alert.alert('Saved', `"${contactName}" was saved to your contacts.`);
          return;
        } catch (nativeErr) {
          // Fall through to the intent method below if the native insert fails
          // for any reason (e.g. OEM ContentResolver quirk).
          console.warn('[SaveToContacts] native insert failed, falling back:', nativeErr?.message);
        }
      }

      // Fallback: ACTION_INSERT intent (opens pre-filled New Contact screen).
      const name    = encodeURIComponent(contactName);
      const phone   = encodeURIComponent(rawPhone);
      const email   = lead.email ? encodeURIComponent(lead.email) : '';
      const company = lead.company ? encodeURIComponent(lead.company) : '';

      // Standard INSERT intent — universally supported on Android 5+
      let uri = `intent:#Intent;action=android.intent.action.INSERT;type=vnd.android.cursor.dir%2Fcontact;S.name=${name};S.phone=${phone}`;
      if (email)   uri += `;S.email=${email}`;
      if (company) uri += `;S.company=${company}`;
      uri += ';end';

      try {
        await Linking.openURL(uri);
      } catch (intentErr) {
        // Last resort: open Contacts app home so user can add manually
        try {
          await Linking.openURL('content://contacts/people/');
        } catch {
          Alert.alert(
            'Cannot Open Contacts',
            `Please add this contact manually:\nName: ${contactName}\nPhone: ${rawPhone}`,
          );
        }
      }
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to save contact.');
    }
  };

  // Resolve primary & secondary numbers. `mobile` is the canonical/primary
  // (already prefers primaryPhone in the normalizer); secondaryPhone is optional.
  const primaryNumber   = lead.primaryPhone || lead.mobile || lead.phone || '';
  const secondaryNumber = lead.secondaryPhone || '';
  const maskedPhone     = maskPhone(primaryNumber);
  const maskedSecondary = secondaryNumber ? maskPhone(secondaryNumber) : '';

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0F172A" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Icon name="arrow-left" size={22} color="#F1F5F9" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle} numberOfLines={1}>{lead.name}</Text>
          <Text style={styles.headerPhone}>{maskedPhone}</Text>
        </View>
        <CallButton phoneNumber={primaryNumber} onCallStart={handleCall} size="small" />
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>

        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <View style={styles.infoItem}>
              <View style={styles.infoItemLeft}>
                <Icon name="phone-lock" size={14} color="#64748B" style={{ marginRight: 6 }} />
                <Text style={styles.infoLabel}>Primary</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={styles.infoValue}>{maskedPhone}</Text>
                {primaryNumber ? (
                  <CallButton phoneNumber={primaryNumber} onCallStart={handleCall} size="small" />
                ) : null}
              </View>
            </View>
            <InfoItem icon="email-outline" label="Email" value={maskEmail(lead.email)} />
          </View>

          {/* Secondary number — only shown when the lead has one */}
          {secondaryNumber ? (
            <>
              <View style={styles.divider} />
              <View style={styles.infoRow}>
                <View style={styles.infoItem}>
                  <View style={styles.infoItemLeft}>
                    <Icon name="phone-plus" size={14} color="#64748B" style={{ marginRight: 6 }} />
                    <Text style={styles.infoLabel}>Secondary</Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={styles.infoValue}>{maskedSecondary}</Text>
                    <CallButton phoneNumber={secondaryNumber} onCallStart={handleCall} size="small" />
                  </View>
                </View>
                <View style={styles.infoItem} />
              </View>
            </>
          ) : null}

          <View style={styles.divider} />
          <View style={styles.infoRow}>
            <InfoItem icon="source-branch" label="Source" value={lead.source} />
            <InfoItem icon="calendar"      label="Date"   value={formatDate(lead.date)} />
          </View>
          <View style={styles.divider} />
          <View style={styles.infoRow}>
            <InfoItem icon="flag"        label="Status"      value={lead.status} />
            <InfoItem icon="thermometer" label="Temperature" value={lead.temperature || '—'} />
          </View>
          {lead.remark ? (
            <>
              <View style={styles.divider} />
              <InfoItem icon="note-text-outline" label="Last Remark" value={lead.remark} full />
            </>
          ) : null}
          {lead.followUpDate ? (
            <>
              <View style={styles.divider} />
              <InfoItem icon="calendar-clock" label="Follow-Up" value={formatDateTime(lead.followUpDate)} full />
            </>
          ) : null}
        </View>

        <TouchableOpacity style={styles.callBigBtn} onPress={handleCall} activeOpacity={0.85}>
          <Icon name="phone" size={20} color="#fff" style={{ marginRight: 8 }} />
          <Text style={styles.callBigBtnText}>Call {maskedPhone}</Text>
          <View style={styles.lockBadge}>
            <Icon name="lock" size={10} color="#93C5FD" />
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.saveContactBtn}
          onPress={handleSaveToContacts}
          activeOpacity={0.8}
        >
          <Icon name="account-plus-outline" size={18} color="#059669" style={{ marginRight: 8 }} />
          <Text style={styles.saveContactBtnText}>Save to Contacts</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.remarkBtn}
          onPress={() => setShowRemarkModal(true)}
          activeOpacity={0.8}
        >
          <Icon name="pencil-plus-outline" size={18} color="#7C3AED" style={{ marginRight: 8 }} />
          <Text style={styles.remarkBtnText}>Add Call Remark</Text>
        </TouchableOpacity>

        <LeadRecordingsSection lead={lead} />

        {/* ── CRM Call Logs ─────────────────────────────────────────────────── */}
        <View style={styles.section}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <Text style={styles.sectionTitle}>Call Logs</Text>
            <TouchableOpacity onPress={loadCrmCallLogs} style={{ padding: 4 }}>
              <Icon name="refresh" size={16} color="#64748B" />
            </TouchableOpacity>
          </View>
          {loadingLogs ? (
            <ActivityIndicator color="#2563EB" style={{ marginTop: 8 }} />
          ) : !logsLoaded ? (
            <TouchableOpacity style={styles.loadLogsBtn} onPress={loadCrmCallLogs}>
              <Icon name="download-outline" size={15} color="#93C5FD" style={{ marginRight: 6 }} />
              <Text style={styles.loadLogsBtnText}>Load Call Logs</Text>
            </TouchableOpacity>
          ) : crmCallLogs.length === 0 ? (
            <Text style={styles.noLogsText}>No call logs found for this lead</Text>
          ) : (
            crmCallLogs.map((log, i) => (
              <View key={i} style={styles.logRow}>
                <View style={[styles.logIcon, { backgroundColor: callTypeColor(log.callType) + '20' }]}>
                  <Icon name={callTypeIcon(log.callType)} size={16} color={callTypeColor(log.callType)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.logType}>{capitalize(log.callType || 'unknown')}</Text>
                  <Text style={styles.logTime}>{formatDateTime(log.timestamp)}</Text>
                  {log.remark ? <Text style={[styles.logTime, { color: '#94A3B8' }]}>{log.remark}</Text> : null}
                </View>
                <Text style={styles.logDuration}>
                  {log.duration > 0 ? formatDuration(log.duration) : '—'}
                </Text>
              </View>
            ))
          )}
        </View>

        {lead.callHistory?.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>CRM Call History</Text>
            {lead.callHistory.slice().reverse().map((h, i) => (
              <View key={i} style={styles.historyCard}>
                <View style={styles.historyHeader}>
                  <Text style={styles.historyAgent}>{h.userName || 'Agent'}</Text>
                  <Text style={styles.historyDate}>{formatDateTime(h.calledAt)}</Text>
                </View>
                {h.outcome && (
                  <Text style={styles.historyOutcome}>Outcome: {h.outcome}</Text>
                )}
                <Text style={styles.historyRemark}>{h.remark}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ── Remark modal ────────────────────────────────────────────────────── */}
      <Modal visible={showRemarkModal} transparent animationType="slide" onRequestClose={closeModal}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
        >
          <TouchableOpacity style={styles.modalDismissArea} activeOpacity={1} onPress={closeModal} />
          <ScrollView
            style={styles.modalScroll}
            contentContainerStyle={{ flexGrow: 1 }}
            bounces={false}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Call Remark</Text>
              <TouchableOpacity onPress={closeModal}>
                <Icon name="close" size={22} color="#94A3B8" />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalLabel}>Outcome *</Text>
            {alreadyInterested && (
              <View style={styles.alreadyInterestedNote}>
                <Icon name="check-circle" size={13} color="#34D399" />
                <Text style={styles.alreadyInterestedText}>
                  This lead is already marked Interested — pick a different outcome.
                </Text>
              </View>
            )}
            <View style={styles.outcomeRow}>
              {OUTCOMES
                .filter(o => !(alreadyInterested && o === 'Interested'))
                .map(o => (
                  <TouchableOpacity
                    key={o}
                    style={[styles.outcomeChip, outcome === o && styles.outcomeChipActive]}
                    onPress={() => setOutcome(o)}
                  >
                    <Text style={[styles.outcomeChipText, outcome === o && styles.outcomeChipTextActive]}>{o}</Text>
                  </TouchableOpacity>
                ))}
            </View>

            <Text style={styles.modalLabel}>Remark *</Text>
            <TextInput
              style={styles.remarkInput}
              placeholder="What did you discuss?"
              placeholderTextColor="#475569"
              multiline
              value={remark}
              onChangeText={setRemark}
            />

            {/* ── Follow-up date picker ─────────────────────────────────────── */}
            {/* FIX: This entire section was missing. followUpDate was always    */}
            {/* sent as null — agent had no way to schedule a follow-up from     */}
            {/* the mobile app, so follow-up notifications never fired.          */}
            <View style={styles.followUpRow}>
              <Text style={styles.modalLabel}>Follow-Up Date <Text style={styles.optionalTag}>(optional)</Text></Text>
              {followUpDate ? (
                <View style={styles.followUpSet}>
                  <Icon name="calendar-check" size={16} color="#34D399" style={{ marginRight: 6 }} />
                  <Text style={styles.followUpDateText}>{formatDateTime(followUpDate)}</Text>
                  <TouchableOpacity onPress={clearFollowUpDate} style={styles.clearDateBtn}>
                    <Icon name="close-circle" size={18} color="#EF4444" />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.setDateBtn}
                  onPress={openDatePicker}
                >
                  <Icon name="calendar-plus" size={16} color="#93C5FD" style={{ marginRight: 6 }} />
                  <Text style={styles.setDateBtnText}>Set Follow-Up Date & Time</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Pure-JS date/time picker — replaces DateTimePickerAndroid.open()
                which crashed because the native module is not in the bundle.
                Uses only built-in RN components: View, Text, TextInput. */}
            {showDatePicker && (
              <View style={styles.jsPickerWrapper}>
                <Text style={styles.jsPickerTitle}>Set Follow-Up Date &amp; Time</Text>
                <View style={styles.jsPickerRow}>
                  <View style={styles.jsPickerField}>
                    <Text style={styles.jsPickerLabel}>Day</Text>
                    <TextInput
                      style={styles.jsPickerInput}
                      keyboardType="number-pad"
                      maxLength={2}
                      placeholder="DD"
                      placeholderTextColor="#475569"
                      value={pickerFields.day}
                      onChangeText={(v) => setPickerFields(p => ({ ...p, day: v.replace(/\D/g, '') }))}
                    />
                  </View>
                  <View style={styles.jsPickerField}>
                    <Text style={styles.jsPickerLabel}>Month</Text>
                    <TextInput
                      style={styles.jsPickerInput}
                      keyboardType="number-pad"
                      maxLength={2}
                      placeholder="MM"
                      placeholderTextColor="#475569"
                      value={pickerFields.month}
                      onChangeText={(v) => setPickerFields(p => ({ ...p, month: v.replace(/\D/g, '') }))}
                    />
                  </View>
                  <View style={styles.jsPickerField}>
                    <Text style={styles.jsPickerLabel}>Year</Text>
                    <TextInput
                      style={styles.jsPickerInput}
                      keyboardType="number-pad"
                      maxLength={4}
                      placeholder="YYYY"
                      placeholderTextColor="#475569"
                      value={pickerFields.year}
                      onChangeText={(v) => setPickerFields(p => ({ ...p, year: v.replace(/\D/g, '') }))}
                    />
                  </View>
                </View>
                <View style={styles.jsPickerRow}>
                  <View style={styles.jsPickerField}>
                    <Text style={styles.jsPickerLabel}>Hour (0-23)</Text>
                    <TextInput
                      style={styles.jsPickerInput}
                      keyboardType="number-pad"
                      maxLength={2}
                      placeholder="HH"
                      placeholderTextColor="#475569"
                      value={pickerFields.hour}
                      onChangeText={(v) => setPickerFields(p => ({ ...p, hour: v.replace(/\D/g, '') }))}
                    />
                  </View>
                  <View style={styles.jsPickerField}>
                    <Text style={styles.jsPickerLabel}>Minute</Text>
                    <TextInput
                      style={styles.jsPickerInput}
                      keyboardType="number-pad"
                      maxLength={2}
                      placeholder="MM"
                      placeholderTextColor="#475569"
                      value={pickerFields.minute}
                      onChangeText={(v) => setPickerFields(p => ({ ...p, minute: v.replace(/\D/g, '') }))}
                    />
                  </View>
                </View>
                <View style={styles.jsPickerActions}>
                  <TouchableOpacity
                    style={styles.jsPickerCancel}
                    onPress={() => setShowDatePicker(false)}
                  >
                    <Text style={styles.jsPickerCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.jsPickerConfirm}
                    onPress={handleDateConfirm}
                  >
                    <Text style={styles.jsPickerConfirmText}>Confirm</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            <TouchableOpacity
              style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
              onPress={handleSubmitRemark}
              disabled={submitting}
            >
              {submitting ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <ActivityIndicator color="#fff" size="small" />
                  <Text style={styles.submitBtnText}>Save Remark</Text>
                </View>
              ) : (
                <Text style={styles.submitBtnText}>Save Remark</Text>
              )}
            </TouchableOpacity>
          </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container:          { flex: 1, backgroundColor: '#0D0F14' },
  header:             { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 52, paddingBottom: 14, backgroundColor: '#1A1D27', borderBottomWidth: 1, borderBottomColor: '#262A38' },
  backBtn:            { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1E2236' },
  headerTitle:        { fontSize: 17, fontWeight: '800', color: '#F0F2FA' },
  headerPhone:        { fontSize: 12, color: '#565C75', fontFamily: 'monospace', letterSpacing: 1, marginTop: 2 },

  infoCard:           { backgroundColor: '#1A1D27', margin: 16, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#262A38' },
  infoRow:            { flexDirection: 'row', gap: 12 },
  infoItem:           { flex: 1, minWidth: 0 },
  infoItemLeft:       { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  infoLabel:          { fontSize: 11, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  infoValue:          { fontSize: 13, color: '#F0F2FA', fontWeight: '600' },
  divider:            { height: 1, backgroundColor: '#262A38', marginVertical: 10 },

  callBigBtn:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#059669', marginHorizontal: 16, marginBottom: 8, borderRadius: 14, paddingVertical: 14 },
  callBigBtnText:     { color: '#fff', fontSize: 15, fontWeight: '700' },
  lockBadge:          { marginLeft: 8, backgroundColor: '#06402b', borderRadius: 8, paddingHorizontal: 4, paddingVertical: 2 },

  remarkBtn:          { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#1A1D27', marginHorizontal: 16, marginBottom: 16, borderRadius: 14, paddingVertical: 12, borderWidth: 1, borderColor: '#7C3AED40' },
  remarkBtnText:      { color: '#A78BFA', fontSize: 14, fontWeight: '700' },
  saveContactBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#1A1D27', marginHorizontal: 16, marginBottom: 8, borderRadius: 14, paddingVertical: 12, borderWidth: 1, borderColor: '#05966940' },
  saveContactBtnText: { color: '#34D399', fontSize: 14, fontWeight: '700' },

  section:            { paddingHorizontal: 16, marginTop: 8 },
  sectionTitle:       { fontSize: 11, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 },
  noLogsText:         { fontSize: 12, color: '#475569', fontStyle: 'italic', marginTop: 6 },

  loadLogsBtn:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#1E2236', borderRadius: 12, paddingVertical: 11, borderWidth: 1, borderColor: '#262A38' },
  loadLogsBtnText:    { color: '#93C5FD', fontSize: 13, fontWeight: '600' },

  logRow:             { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#262A38' },
  logIcon:            { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  logType:            { fontSize: 13, fontWeight: '600', color: '#F0F2FA' },
  logTime:            { fontSize: 11, color: '#565C75', marginTop: 2 },
  logDuration:        { fontSize: 11, color: '#94A3B8' },

  historyCard:        { backgroundColor: '#1A1D27', borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#262A38' },
  historyHeader:      { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  historyAgent:       { fontSize: 12, fontWeight: '700', color: '#93C5FD' },
  historyDate:        { fontSize: 11, color: '#475569' },
  historyOutcome:     { fontSize: 12, color: '#A78BFA', fontWeight: '600', marginBottom: 4 },
  historyRemark:      { fontSize: 13, color: '#CBD5E1', lineHeight: 18 },

  notFound:           { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0D0F14' },
  notFoundText:       { color: '#475569', fontSize: 16, marginTop: 14, marginBottom: 14 },
  backLink:           { color: '#60A5FA', fontSize: 14, fontWeight: '600' },

  modalOverlay:       { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalDismissArea:   { flex: 1 },
  modalScroll:        { maxHeight: '90%', flexGrow: 0 },
  modalCard:          { backgroundColor: '#1A1D27', padding: 20, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: '#262A38', paddingBottom: 36 },
  modalHeader:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  modalTitle:         { fontSize: 17, fontWeight: '800', color: '#F0F2FA' },
  modalLabel:         { fontSize: 12, color: '#94A3B8', fontWeight: '600', marginBottom: 8, textTransform: 'uppercase' },
  optionalTag:        { fontSize: 11, color: '#64748B', fontWeight: '400', textTransform: 'none' },
  outcomeRow:         { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 16 },
  alreadyInterestedNote: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8, backgroundColor: '#0E2A1E', borderWidth: 1, borderColor: '#34D39940', marginBottom: 10 },
  alreadyInterestedText: { fontSize: 11, color: '#34D399', fontWeight: '600', flex: 1 },
  outcomeChip:        { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: '#0F172A', borderWidth: 1, borderColor: '#262A38' },
  outcomeChipActive:  { backgroundColor: '#1E40AF20', borderColor: '#3B82F6' },
  outcomeChipText:    { fontSize: 12, color: '#94A3B8', fontWeight: '600' },
  outcomeChipTextActive: { color: '#93C5FD' },
  remarkInput:        { backgroundColor: '#0F172A', borderRadius: 10, padding: 12, color: '#F0F2FA', minHeight: 100, textAlignVertical: 'top', borderWidth: 1, borderColor: '#262A38', marginBottom: 16 },
  submitBtn:          { backgroundColor: '#2563EB', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  submitBtnDisabled:  { opacity: 0.6 },
  submitBtnText:      { color: '#fff', fontSize: 14, fontWeight: '700' },

  // Follow-up date picker styles
  followUpRow:        { marginBottom: 16 },
  followUpSet:        { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0F172A', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#34D39940' },
  followUpDateText:   { flex: 1, fontSize: 13, color: '#34D399', fontWeight: '600' },
  clearDateBtn:       { padding: 2 },
  setDateBtn:         { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0F172A', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#262A38' },
  setDateBtnText:     { fontSize: 13, color: '#93C5FD', fontWeight: '600' },
  iosPickerWrapper:   { backgroundColor: '#0F172A', borderRadius: 12, marginBottom: 12, overflow: 'hidden', borderWidth: 1, borderColor: '#262A38' },
  iosDoneBtn:         { alignItems: 'center', paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#262A38' },
  iosDoneBtnText:     { color: '#3B82F6', fontSize: 15, fontWeight: '700' },

  // Attachment styles
  attachRow:          { marginBottom: 10 },
  attachLabelRow:     { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  attachTypeLabel:    { fontSize: 12, color: '#94A3B8', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  attachPickBtn:      { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0F172A', borderRadius: 10, padding: 10, borderWidth: 1, borderColor: '#262A38' },
  attachPickBtnText:  { fontSize: 13, color: '#93C5FD', fontWeight: '600' },
  attachHint:         { fontSize: 11, color: '#475569' },
  attachChip:         { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0F172A', borderRadius: 10, padding: 10, borderWidth: 1, borderColor: '#1E3A5F' },
  attachChipName:     { flex: 1, fontSize: 12, color: '#CBD5E1', fontWeight: '500' },
  attachChipSize:     { fontSize: 11, color: '#475569' },
  attachRemoveBtn:    { marginLeft: 6, padding: 2 },

  // Pure-JS date/time picker styles (replaces native DateTimePickerAndroid)
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
});