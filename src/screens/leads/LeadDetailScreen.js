import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, Alert, Modal, ActivityIndicator, StatusBar,
  KeyboardAvoidingView, Platform, AppState,
} from 'react-native';
import DateTimePicker                              from '@react-native-community/datetimepicker';
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

const OUTCOMES = ['Answered', 'Not Answered', 'Busy', 'Switch Off', 'Call Back Later', 'Interested', 'Not Interested'];

function maskPhone(phone) {
  if (!phone) return '—';
  const digits = normalizePhone(phone) || String(phone).replace(/\D/g, '');
  if (digits.length < 6) return '••••••';
  return digits.slice(0, 2) + '•••••' + digits.slice(-2);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  } catch { return dateStr; }
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
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
  const [followUpDate,    setFollowUpDate]    = useState(null);   // null = no follow-up
  const [showDatePicker,  setShowDatePicker]  = useState(false);
  const [showTimePicker,  setShowTimePicker]  = useState(false);
  const [pickerTempDate,  setPickerTempDate]  = useState(new Date());

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

  const handleCall = async () => {
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
            const logs = await getCallLogsForNumber(lead.mobile);
            if (logs.length > 0) await syncCallLogs(logs.slice(0, 5));
          } catch {}

          try { triggerPostCallRecordingSync(lead.mobile, callStartedAt); } catch {}

          setTimeout(() => setShowRemarkModal(true), 600);
        }
      });

      const { Linking } = require('react-native');
      const { normalizePhone: norm } = require('../../services/phoneService');
      const dialUri = `tel:${norm(lead.mobile)}`;
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
    return () => {
      callPending.current = false;
      callListenerRef.current?.remove();
    };
  }, []);

  // ── Date picker handlers ────────────────────────────────────────────────────
  const handleDateChange = (event, selectedDate) => {
    if (Platform.OS === 'android') setShowDatePicker(false);
    if (event.type === 'dismissed') return;
    if (selectedDate) {
      setPickerTempDate(selectedDate);
      if (Platform.OS === 'android') {
        // On Android, after picking date, open time picker next
        setShowTimePicker(true);
      }
    }
  };

  const handleTimeChange = (event, selectedTime) => {
    setShowTimePicker(false);
    if (event.type === 'dismissed') return;
    if (selectedTime) {
      const combined = new Date(pickerTempDate);
      combined.setHours(selectedTime.getHours(), selectedTime.getMinutes(), 0, 0);
      setFollowUpDate(combined.toISOString());
    }
  };

  const handleIosDateTimeChange = (event, selectedDate) => {
    if (selectedDate) {
      setPickerTempDate(selectedDate);
      setFollowUpDate(selectedDate.toISOString());
    }
  };

  const clearFollowUpDate = () => {
    setFollowUpDate(null);
    setPickerTempDate(new Date());
  };

  // Reset modal state when it closes
  const closeModal = () => {
    setShowRemarkModal(false);
    setRemark('');
    setOutcome('');
    setFollowUpDate(null);
    setPickerTempDate(new Date());
    setShowDatePicker(false);
    setShowTimePicker(false);
  };

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
        followUpDate: followUpDate || null,   // FIX: now actually sends the date
      })).unwrap();

      closeModal();
      Alert.alert(
        '✓ Saved',
        followUpDate
          ? `Remark saved. Follow-up set for ${formatDateTime(followUpDate)}`
          : 'Call remark saved to CRM'
      );
    } catch (e) {
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

  const maskedPhone = maskPhone(lead.mobile);

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
        <CallButton phoneNumber={lead.mobile} onCallStart={handleCall} size="small" />
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>

        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <View style={styles.infoItem}>
              <View style={styles.infoItemLeft}>
                <Icon name="phone-lock" size={14} color="#64748B" style={{ marginRight: 6 }} />
                <Text style={styles.infoLabel}>Mobile</Text>
              </View>
              <Text style={styles.infoValue}>{maskedPhone}</Text>
            </View>
            <InfoItem icon="email-outline" label="Email" value={lead.email || '—'} />
          </View>
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
            <View style={styles.outcomeRow}>
              {OUTCOMES.map(o => (
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
                  onPress={() => {
                    setPickerTempDate(new Date());
                    setShowDatePicker(true);
                  }}
                >
                  <Icon name="calendar-plus" size={16} color="#93C5FD" style={{ marginRight: 6 }} />
                  <Text style={styles.setDateBtnText}>Set Follow-Up Date & Time</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Android: date picker (modal) */}
            {showDatePicker && Platform.OS === 'android' && (
              <DateTimePicker
                value={pickerTempDate}
                mode="date"
                display="default"
                minimumDate={new Date()}
                onChange={handleDateChange}
              />
            )}

            {/* Android: time picker (modal, shown after date picked) */}
            {showTimePicker && Platform.OS === 'android' && (
              <DateTimePicker
                value={pickerTempDate}
                mode="time"
                display="default"
                onChange={handleTimeChange}
              />
            )}

            {/* iOS: inline datetime picker */}
            {showDatePicker && Platform.OS === 'ios' && (
              <View style={styles.iosPickerWrapper}>
                <DateTimePicker
                  value={pickerTempDate}
                  mode="datetime"
                  display="inline"
                  minimumDate={new Date()}
                  onChange={handleIosDateTimeChange}
                  themeVariant="dark"
                  style={{ backgroundColor: '#0F172A' }}
                />
                <TouchableOpacity
                  style={styles.iosDoneBtn}
                  onPress={() => setShowDatePicker(false)}
                >
                  <Text style={styles.iosDoneBtnText}>Done</Text>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity
              style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
              onPress={handleSubmitRemark}
              disabled={submitting}
            >
              {submitting
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.submitBtnText}>Save Remark</Text>
              }
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
});