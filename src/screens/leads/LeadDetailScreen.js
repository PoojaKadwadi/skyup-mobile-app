import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  TextInput, Alert, Modal, ActivityIndicator, StatusBar,
  KeyboardAvoidingView, Platform, AppState, Linking, InteractionManager,
} from 'react-native';
// CRASH FIX: @react-native-community/datetimepicker NOT in bundle — removed import
// DateTimePickerAndroid.open() was crashing the Follow-Up button on every Android device.
// Replaced with pure-JS date/time picker using built-in TextInput + View components.
import { useDispatch, useSelector }                from 'react-redux';
import { useNavigation, useRoute, useFocusEffect }                 from '@react-navigation/native';
import Icon                                        from 'react-native-vector-icons/MaterialCommunityIcons';
import { submitCallRemark, patchLead, fetchLeads, upsertLead }             from '../../store/slices/leadsSlice';
import { makePhoneCall, normalizePhone }           from '../../services/phoneService';
import { getCallLogsForNumber }                    from '../../services/phoneService';
import { getLeadCallLogs }                         from '../../api/callLogsApi';
import { markLeadInvalid, markNotInterested, getLeadActionSummary, getLeadById } from '../../api/leadsApi';
import { triggerPostCallRecordingSync }            from '../../services/backgroundSyncService';
import { syncCallLogs }                            from '../../api/callLogsApi';
import CallButton                                  from '../../components/CallButton';
import LeadRecordingsSection                       from '../../components/LeadRecordingsSection';
import CalendarDateTimePicker                       from '../../components/CalendarDateTimePicker';
import { postMeetingRemark }                        from '../../api/meetingsApi';
import { scheduleMeetingFollowUp }                  from '../../services/notificationService';
import moment                                      from 'moment';
import { useTheme }                                from '../../theme/ThemeContext';

// Visit types offered when the agent logs a Client Meeting from the remark modal.
const MEETING_TYPES = ['In-Person', 'Site Visit', 'Demo', 'Video Call', 'Phone Call'];

// Lead status options — kept in sync with the website's UpdateStatusModal
// (["New","In Progress","Converted","Not Interested"]). "Not Interested" runs the
// backend reassignment/verification flow instead of a plain status patch.
const STATUS_OPTIONS = ['New', 'In Progress', 'Converted', 'Not Interested'];

const OUTCOMES = ['Answered', 'Not Answered', 'Busy', 'Switch Off', 'Call Back Later', 'Interested', 'Not Interested', 'Invalid', 'Client Meeting'];

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

function callTypeColor(type, colors) {
  return ({ incoming: colors.green, outgoing: colors.blue, missed: colors.red, rejected: colors.amber, blocked: colors.textSec })[type] || colors.textSec;
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
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={[styles.infoItem, full && { flex: 1, width: '100%' }]}>
      <View style={styles.infoItemLeft}>
        <Icon name={icon} size={14} color={colors.textSec} style={{ marginRight: 6 }} />
        <Text style={styles.infoLabel}>{label}</Text>
      </View>
      <Text style={styles.infoValue} numberOfLines={full ? 0 : 1}>{value}</Text>
    </View>
  );
}

// Tracks lead ids whose contact has already been auto-saved this session, so
// re-opening a lead doesn't write the contact again. Module-level so it
// survives screen unmount/remount within the same app run.
const _autoSavedContactIds = new Set();

// Session-scoped flags so account-setup alerts show at most once per app run.
// Temperature quick-set options. Static hex colours (theme-independent) so this
// safely stays at module scope; the translucent chip backgrounds read fine on
// both dark and light. Keys map to the backend's Hot/Warm/Cold temperature field.
const TEMP_OPTIONS = [
  { key: 'Hot',  icon: 'fire',          color: '#EF4444', bg: 'rgba(239,68,68,0.14)' },
  { key: 'Warm', icon: 'weather-sunny', color: '#F59E0B', bg: 'rgba(245,158,11,0.14)' },
  { key: 'Cold', icon: 'snowflake',     color: '#3B82F6', bg: 'rgba(59,130,246,0.14)' },
];

const _contactsAlertShown = { noAccount: false, notOnDevice: false };

export default function LeadDetailScreen() {
  const dispatch   = useDispatch();
  const navigation = useNavigation();
  const route      = useRoute();
  const { leadId, postCall = false } = route.params;
  const { dark, colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const storeLead = useSelector((s) => s.leads.items.find(l => l.id === leadId));
  // Admin-configured Google account email that leads should auto-save into on
  // this employee's device. Set per-employee in the CRM; null when unset.
  const contactAccountEmail = useSelector((s) => s.auth?.user?.contactAccountEmail || '');

  // FIX: the screen used to read the lead ONLY from the Redux store. If the
  // lead wasn't cached (opened from a notification, after a post-call navigate,
  // or after the list refreshed and dropped it) it showed "Lead not found"
  // immediately with no way to recover. We now fall back to fetching the lead
  // by id from the server, showing a loading state while it resolves.
  const [fetchedLead,   setFetchedLead]   = useState(null);
  const [savingTemp,    setSavingTemp]    = useState(false);
  // ── Status quick-set state ────────────────────────────────────────────────
  const [savingStatus,  setSavingStatus]  = useState(false);
  const [niModalVisible, setNiModalVisible] = useState(false); // Not-Interested reason prompt
  const [niReason,       setNiReason]       = useState('');
  const [niSubmitting,   setNiSubmitting]   = useState(false);
  // Modal that lists ALL remarks (call history + the initial campaign remark).
  // Opened by tapping the "Last Remark" row.
  const [showAllRemarks, setShowAllRemarks] = useState(false);
  const [leadLoading,   setLeadLoading]   = useState(false);
  const [leadFetchFail, setLeadFetchFail] = useState(false);

  const lead = storeLead || fetchedLead;

  // Quick-set Hot/Warm/Cold. OPTIMISTIC: update the UI (store item + local copy)
  // instantly, then persist via PATCH /lead/:id in the background. If the persist
  // fails we revert to the previous value so the chip never lies.
  const handleSetTemperature = async (temp) => {
    if (savingTemp || (lead?.temperature || '').toLowerCase() === temp.toLowerCase()) return;
    const prevTemp = lead?.temperature || null;
    setSavingTemp(true);

    // Instant UI
    dispatch(upsertLead({ id: leadId, temperature: temp, Quality: temp }));
    setFetchedLead((prev) => (prev ? { ...prev, temperature: temp, Quality: temp } : prev));

    try {
      await dispatch(patchLead({ id: leadId, data: { temperature: temp } })).unwrap();
    } catch (e) {
      // Revert on failure
      dispatch(upsertLead({ id: leadId, temperature: prevTemp, Quality: prevTemp }));
      setFetchedLead((prev) => (prev ? { ...prev, temperature: prevTemp, Quality: prevTemp } : prev));
      Alert.alert('Update failed', typeof e === 'string' ? e : 'Could not update temperature. Please try again.');
    } finally {
      setSavingTemp(false);
    }
  };

  // Quick-set lead status. New / In Progress / Converted patch instantly via
  // PATCH /lead/:id { status }. "Not Interested" instead opens a reason prompt
  // and runs the backend reassignment/verification flow (same as the website).
  const handleSetStatus = async (status) => {
    if (savingStatus) return;
    if ((lead?.status || '') === status) return;

    if (status === 'Not Interested') {
      setNiReason('');
      setNiModalVisible(true);
      return;
    }

    const prevStatus = lead?.status || null;
    setSavingStatus(true);

    // Instant UI
    dispatch(upsertLead({ id: leadId, status }));
    setFetchedLead((prev) => (prev ? { ...prev, status } : prev));

    try {
      await dispatch(patchLead({ id: leadId, data: { status } })).unwrap();
    } catch (e) {
      dispatch(upsertLead({ id: leadId, status: prevStatus }));
      setFetchedLead((prev) => (prev ? { ...prev, status: prevStatus } : prev));
      Alert.alert('Update failed', typeof e === 'string' ? e : 'Could not update status. Please try again.');
    } finally {
      setSavingStatus(false);
    }
  };

  // Submit the Not-Interested reason → backend reassigns the lead for verification
  // and drops it from this agent's panel, so we refresh the list and go back.
  const submitNotInterested = async () => {
    const reason = niReason.trim();
    if (!reason) {
      Alert.alert('Reason required', 'Please enter a reason before marking this lead Not Interested.');
      return;
    }
    setNiSubmitting(true);
    try {
      const res = await markNotInterested(leadId, { remark: reason });
      setNiModalVisible(false);
      setNiReason('');
      try { await dispatch(fetchLeads()).unwrap?.(); } catch {}
      const who = res?.reassignedTo?.name;
      const msg = res?.message
        || (who
          ? `Lead marked Not Interested and sent to ${who} for verification.`
          : 'Lead marked Not Interested.');
      Alert.alert('✓ Done', msg);
      navigation.goBack();
    } catch (e) {
      Alert.alert('Failed', e?.response?.data?.message || e?.message || String(e));
    } finally {
      setNiSubmitting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (storeLead || !leadId) return;            // store has it — nothing to do
    setLeadLoading(true);
    setLeadFetchFail(false);
    getLeadById(leadId)
      .then((data) => { if (!cancelled) setFetchedLead(data); })
      .catch(() => { if (!cancelled) setLeadFetchFail(true); })
      .finally(() => { if (!cancelled) setLeadLoading(false); });
    return () => { cancelled = true; };
  }, [leadId, storeLead]);

  // ── Refresh on focus ──────────────────────────────────────────────────────
  // The detail page can go stale after the agent logs a Client Meeting (or any
  // remark) on another screen — the backend updates the lead's `remark` and
  // `meetingRemarks` but this screen still shows the cached copy. Re-fetch the
  // lead every time the screen regains focus and push the fresh copy into the
  // Redux store + local state so the "Last Remark" and history are always current.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (!leadId) return;
      getLeadById(leadId)
        .then((data) => {
          if (cancelled || !data) return;
          dispatch(upsertLead(data));   // reconcile the store copy
          setFetchedLead(data);         // and the local fallback copy
        })
        .catch(() => {});               // silent — keep showing cached data on failure
      return () => { cancelled = true; };
    }, [leadId, dispatch]),
  );

  // ── Has this lead already been marked "Interested"? ─────────────────────────
  // If yes, we hide the "Interested" outcome chip so the agent can't pick it
  // again — preventing duplicate "Interested" entries on the same lead.
  // Detected from either the lead's current status OR any past call-history entry.
  // FIX: wrap in useMemo so this only recomputes when the lead changes,
  // not on every render (every keystroke in the remark input triggered a full
  // callHistory.some() scan under the old IIFE pattern).
  const alreadyInterested = useMemo(() => {
    if (!lead) return false;
    const status = (lead.status || '').toLowerCase();
    if (status === 'interested' || status === 'in progress' || status === 'converted') return true;
    const history = Array.isArray(lead.callHistory) ? lead.callHistory : [];
    return history.some(h => (h.outcome || '').toLowerCase() === 'interested');
  }, [lead?.status, lead?.callHistory]);

  // PERF FIX (typing lag): build the CRM call-history list once per data change,
  // not on every keystroke in the remark box. Rendering this inline rebuilt the
  // whole list on each setRemark, which lagged typing on leads with long history.
  // ALL REMARKS list for the "Last Remark" popup — the full call-history
  // (newest first) plus, at the very bottom, the ORIGINAL remark added when the
  // lead was created on the campaign page (lead.initialRemark). Built once per
  // data change, not on every keystroke in the remark box.
  const allRemarksList = useMemo(() => {
    const ch = Array.isArray(lead?.callHistory) ? lead.callHistory : [];
    const initial = (lead?.initialRemark || '').trim();

    const cards = ch.slice().reverse().map((h, i) => (
      <View key={`ch-${i}`} style={styles.historyCard}>
        <View style={styles.historyHeader}>
          <Text style={styles.historyAgent}>{h.userName || 'Agent'}</Text>
          <Text style={styles.historyDate}>{formatDateTime(h.calledAt)}</Text>
        </View>
        {h.outcome ? (
          <Text style={styles.historyOutcome}>Outcome: {h.outcome}</Text>
        ) : null}
        <Text style={styles.historyRemark}>{h.remark}</Text>
      </View>
    ));

    // Append the initial campaign remark (avoid duplicating it if the earliest
    // call-history entry is literally the same text).
    const earliest = ch.length ? (ch[0]?.remark || '').trim() : '';
    if (initial && initial !== earliest) {
      cards.push(
        <View key="initial" style={[styles.historyCard, styles.initialRemarkCard]}>
          <View style={styles.historyHeader}>
            <View style={styles.initialBadge}>
              <Icon name="bullhorn-outline" size={11} color={colors.purpleLight} style={{ marginRight: 4 }} />
              <Text style={styles.initialBadgeText}>Initial remark · from campaign</Text>
            </View>
          </View>
          <Text style={styles.historyRemark}>{initial}</Text>
        </View>,
      );
    }

    if (cards.length === 0) {
      return (
        <View style={styles.historyEmptyWrap}>
          <Icon name="note-off-outline" size={28} color={colors.textMuted} />
          <Text style={styles.historyEmptyText}>No remarks yet for this lead</Text>
        </View>
      );
    }
    return cards;
  }, [lead?.callHistory, lead?.initialRemark, styles, colors]);

  // FIX (primary bug): the remark modal used to be initialised to `postCall`,
  // so tapping "Call" in the leads list — which navigates here with
  // postCall:true — popped the remark modal INSTANTLY, on top of / instead of
  // the dialer. The agent tapped call and within a second saw the remark popup
  // rather than the option to call. The modal must NEVER open on navigation; it
  // opens only after a genuine call actually ends (see the post-call detector
  // effect below), so start it closed.
  const [showRemarkModal, setShowRemarkModal] = useState(false);
  const [remark,          setRemark]          = useState('');
  const [outcome,         setOutcome]         = useState('');
  const [submitting,      setSubmitting]      = useState(false);
  const [crmCallLogs,     setCrmCallLogs]     = useState([]);
  const [loadingLogs,     setLoadingLogs]     = useState(false);
  const [logsLoaded,      setLogsLoaded]      = useState(false);

  // ── AI Action Summary ───────────────────────────────────────────────────────
  const [aiSummary,        setAiSummary]        = useState(null);
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
  const [aiSummaryError,   setAiSummaryError]   = useState('');

  const fetchActionSummary = async (refresh = false) => {
    setAiSummaryLoading(true);
    setAiSummaryError('');
    try {
      const data = await getLeadActionSummary(leadId, { refresh });
      setAiSummary(data);
    } catch (e) {
      const code = e?.response?.data?.code;
      const msg =
        code === 'GROK_NOT_CONFIGURED'
          ? 'AI summary is not configured on the server.'
          : code === 'GROK_UNAVAILABLE'
          ? 'AI summary service is busy. Please try again.'
          : (e?.response?.data?.message || e?.message || 'Could not generate summary.');
      setAiSummaryError(msg);
    } finally {
      setAiSummaryLoading(false);
    }
  };

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

  // ── Client Meeting state ────────────────────────────────────────────────────
  // When the agent picks the "Client Meeting" outcome, the follow-up date is
  // treated as the MEETING date/time (required) and they choose a visit type.
  // On save we also create a meeting on the backend and schedule a reminder
  // + at-time notification, exactly like the dedicated Client Meeting screen.
  const [meetingType, setMeetingType] = useState('In-Person');
  const isClientMeeting = outcome === 'Client Meeting';

  const [uploadProgress,  setUploadProgress]  = useState(null); // retained for API compat
  // FIX: attachDoc and attachRec were used in pickDocument/pickRecording but
  // never declared — calling setAttachDoc/setAttachRec threw
  // 'setAttachDoc is not a function' and crashed the attachment picker.
  const [attachDoc, setAttachDoc] = useState(null);
  const [attachRec, setAttachRec] = useState(null);

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
  const remarkShownRef   = React.useRef(false); // modal shown once per call cycle
  const backgroundAtRef  = React.useRef(0);
  const callNumberRef    = React.useRef('');    // number of the in-flight call
  const callStartedAtRef = React.useRef(0);
  // PERF FIX: track mount state so AppState listener never updates unmounted
  // component state or leaves a stale listener if user navigates away mid-call.
  const isMountedRef     = React.useRef(true);

  // Minimum time the app must sit in TRUE background before we treat the return
  // to foreground as "the call finished". This is what stops the remark popup
  // from firing on transient interruptions that are NOT a real call:
  //   • the dual-SIM "Call with SIM 1 / SIM 2" chooser (very common in India),
  //   • the runtime CALL_PHONE permission dialog,
  //   • pulling down the notification shade,
  //   • the agent opening the dialer, glancing, and coming straight back.
  // A real answered/attempted call always exceeds this.
  const MIN_CALL_MS = 3500;

  // Fire the post-call work: show the remark modal FIRST (so it feels instant),
  // then sync call logs + recordings in the background off the interaction path.
  const finishCall = React.useCallback((numberToCall, startedAt) => {
    if (remarkShownRef.current || !isMountedRef.current) return;
    remarkShownRef.current = true;

    // Show the modal immediately — do NOT wait on any network/disk work.
    setShowRemarkModal(true);

    // Defer the heavy call-log read + uploads so they never block the modal
    // animation or the JS thread while the agent starts typing the remark.
    InteractionManager.runAfterInteractions(async () => {
      try {
        const logs = await getCallLogsForNumber(numberToCall);
        if (logs.length > 0) await syncCallLogs(logs.slice(0, 5));
      } catch {}
      try { triggerPostCallRecordingSync(numberToCall, startedAt, lead?.name || ''); } catch {}
    });
  }, [lead?.name]);

  // Arm a single AppState listener that watches for a genuine background→active
  // round-trip (a real call) and then shows the remark modal. Registering this
  // BEFORE the dialer opens guarantees the background transition is captured
  // even when the dialer is launched by <CallButton> a tick earlier.
  const armCallListener = React.useCallback((numberToCall, startedAt) => {
    callNumberRef.current    = numberToCall;
    callStartedAtRef.current = startedAt;
    remarkShownRef.current   = false;
    callPending.current      = true;

    // If the dialer is already opening (postCall navigation, or CallButton
    // fired openURL just before us), treat the current non-active state as the
    // start of the background period so the timer is accurate.
    if (AppState.currentState === 'background') {
      wentToBackground.current = true;
      backgroundAtRef.current  = startedAt;
    } else {
      wentToBackground.current = false;
      backgroundAtRef.current  = 0;
    }

    callListenerRef.current?.remove();
    callListenerRef.current = AppState.addEventListener('change', (nextState) => {
      if (!callPending.current || !isMountedRef.current) {
        callListenerRef.current?.remove();
        callListenerRef.current = null;
        return;
      }

      // Only a TRUE background counts as "left for a call". 'inactive' is the
      // transient state used by SIM choosers / permission dialogs / the
      // notification shade — ignoring it is what kills the false-trigger popup.
      if (nextState === 'background') {
        if (!wentToBackground.current) {
          wentToBackground.current = true;
          backgroundAtRef.current  = Date.now();
        }
        return;
      }

      if (nextState === 'active' && wentToBackground.current) {
        const timeInBackground = Date.now() - backgroundAtRef.current;

        // Too short → not a real call (chooser/dialog flicker or a quick bail
        // out of the dialer). Reset and keep listening in case they call again.
        if (timeInBackground < MIN_CALL_MS) {
          wentToBackground.current = false;
          backgroundAtRef.current  = 0;
          return;
        }

        callPending.current      = false;
        wentToBackground.current = false;
        callListenerRef.current?.remove();
        callListenerRef.current  = null;

        finishCall(callNumberRef.current, callStartedAtRef.current);
      }
    });
  }, [finishCall]);

  const handleCall = async (dialNumber) => {
    // The big "Call" button is wired as onPress={handleCall}, so React Native
    // passes a press EVENT object as the first arg — not a number. <CallButton>
    // passes a real string number. Only treat the arg as a dialed number when
    // it's actually a string/number.
    const passedNumber =
      (typeof dialNumber === 'string' || typeof dialNumber === 'number')
        ? String(dialNumber)
        : null;

    // CallButton passes the number it dialed; fall back to the lead's primary
    // (lead.mobile already prefers primaryPhone via the normalizer).
    const numberToCall = passedNumber || lead.mobile || lead.primaryPhone || lead.phone;
    try {
      const { requestCallPermission } = require('../../services/permissionsService');
      const granted = await requestCallPermission();
      if (!granted) {
        Alert.alert('Permission Required', 'Call permission is needed to make calls.');
        return;
      }

      const callStartedAt = Date.now();

      // Arm the detector FIRST so no background transition is missed, then dial.
      armCallListener(numberToCall, callStartedAt);

      const { Linking } = require('react-native');
      const { sanitizeForDial } = require('../../services/phoneService');

      // Open the dialer here whenever the number did NOT come from <CallButton>
      // (the standalone "Call" button passes a press event). When CallButton
      // supplied a real number it already launched the dialer, so we must not
      // open it a second time.
      if (!passedNumber) {
        const toDial = sanitizeForDial(numberToCall);
        if (!toDial) throw new Error('Invalid phone number');
        await Linking.openURL(`tel:${toDial}`);
      }

    } catch (e) {
      callPending.current = false;
      callListenerRef.current?.remove();
      callListenerRef.current = null;
      Alert.alert('Call Failed', e.message);
    }
  };

  // Post-call detector for arrivals via the leads list. Tapping "Call" on a
  // list row opens the dialer AND navigates here with postCall:true. We must
  // NOT show the remark modal now (that was the reported bug) — instead arm the
  // same robust detector so the modal appears only after the real call ends.
  React.useEffect(() => {
    if (!postCall) return;
    const number = lead?.mobile || lead?.primaryPhone || lead?.phone || '';
    if (!number) return;
    armCallListener(number, Date.now());
    // Only run once, when the screen opens from a call tap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postCall, lead?.id]);

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
    setMeetingType('In-Person');
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

    // For a Client Meeting the follow-up date is the MEETING date and is required.
    if (isClientMeeting && !followUpDate) {
      Alert.alert('Meeting Date Required', 'Please set the date & time for the client meeting so we can remind you.');
      return;
    }

    // ── Invalid outcome → dedicated two-step verification flow ────────────────
    // First Invalid reassigns the lead to another agent for verification.
    // If THIS lead is already in verification (a colleague marked it Invalid and
    // it was sent to you), picking Invalid CONFIRMS it → the lead is closed and
    // removed from all employee panels. The admin sees it under "Closed Leads".
    if (outcome === 'Invalid') {
      const isVerifying = lead?.invalidStage === 'verification';
      const doSubmit = async (reject = false) => {
        setSubmitting(true);
        try {
          const res = await markLeadInvalid(leadId, { remark: remark.trim(), reject });
          closeModal();
          // Refresh the list so the closed/returned lead drops out of view.
          try { await dispatch(fetchLeads()).unwrap?.(); } catch {}
          const msg = res?.message
            || (res?.isClosed
              ? 'Lead verified Invalid and closed.'
              : 'Lead marked Invalid and sent for verification.');
          Alert.alert('✓ Done', msg);
          if (res?.isClosed) navigation.goBack();
        } catch (e) {
          Alert.alert('Failed', e?.message || String(e));
        } finally { setSubmitting(false); }
      };

      if (isVerifying) {
        Alert.alert(
          'Verify Invalid',
          'A colleague marked this lead Invalid. Do you confirm it is Invalid (this will CLOSE the lead) or reject it (send it back to the original employee)?',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Reject', onPress: () => doSubmit(true) },
            { text: 'Confirm Invalid', style: 'destructive', onPress: () => doSubmit(false) },
          ],
        );
      } else {
        await doSubmit(false);
      }
      return;
    }

    const trimmed = remark.trim();

    // ── Client Meeting: needs the awaited flow (creates a backend meeting and
    // schedules local reminders, and the agent benefits from the confirmation).
    if (isClientMeeting && followUpDate) {
      setSubmitting(true);
      try {
        await dispatch(submitCallRemark({
          leadId, remark: trimmed, outcome,
          followUpDate: followUpDate || null, document: null, recording: null,
        })).unwrap();

        try {
          await postMeetingRemark(leadId, {
            meetingType,
            outcome:  'Follow-Up Required',
            remark:   trimmed,
            location: null,
            followUpDate,
          }, null);

          await scheduleMeetingFollowUp({
            id:       `${leadId}_${Date.parse(followUpDate)}`,
            leadName: lead?.name || 'Client',
            followUpDate,
            meetingType,
            location: null,
          });
        } catch (meetErr) {
          console.warn('[LeadDetail] Meeting create/notify failed:', meetErr.message);
          closeModal();
          Alert.alert(
            'Remark saved — meeting not scheduled',
            'Your remark was saved, but the meeting reminder could not be set up. Please add the meeting from the Client Meeting screen.',
          );
          return;
        }

        closeModal();
        Alert.alert(
          '✓ Saved',
          `Meeting scheduled.\nMeeting: ${formatDateTime(followUpDate)} (${meetingType})\n\nYou'll be reminded before it starts.`,
        );
      } catch (e) {
        setUploadProgress(null);
        Alert.alert('Failed', e.toString());
      } finally { setSubmitting(false); }
      return;
    }

    // ── Common path (a normal call remark) — OPTIMISTIC ───────────────────────
    // PERF FIX (slow save): previously we awaited the network round-trip before
    // closing the modal, so the agent stared at a spinner for the full latency
    // of the request (worse on Render cold-starts / weak signal). Now we close
    // the modal and reset instantly, then fire the save in the background. The
    // store's submitCallRemark.fulfilled reducer appends the entry to the lead's
    // callHistory when it lands, so the UI stays correct. On failure we surface
    // a non-destructive alert so the agent can re-add it.
    const followUp = followUpDate || null;
    closeModal();

    dispatch(submitCallRemark({
      leadId, remark: trimmed, outcome,
      followUpDate: followUp, document: null, recording: null,
    }))
      .unwrap()
      .catch((e) => {
        Alert.alert(
          'Remark not saved',
          `Your remark could not be saved:\n${e?.toString?.() || e}\n\nPlease open the lead and add it again.`,
        );
      });
  };

  if (!lead) {
    // Still resolving from the server — show a spinner instead of "not found".
    if (leadLoading || (!leadFetchFail && !storeLead)) {
      return (
        <View style={styles.notFound}>
          <ActivityIndicator size="large" color={colors.blue} />
          <Text style={[styles.notFoundText, { marginTop: 12 }]}>Loading lead…</Text>
        </View>
      );
    }
    return (
      <View style={styles.notFound}>
        <Icon name="account-alert" size={48} color={colors.textMuted} />
        <Text style={styles.notFoundText}>Lead not found</Text>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backLink}>← Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Save to Contacts (auto) ─────────────────────────────────────────────────
  // Saves the lead as a phone contact with name = "LeadName XXXX"
  // where XXXX = last 4 digits of their phone number.
  //
  // CHANGE: the manual "Save to Contacts" button is removed. The contact is now
  // written AUTOMATICALLY when the lead detail opens (see the effect below).
  //
  // The function takes a `silent` flag:
  //   • silent = true  (automatic path): never shows alerts and never POPS a
  //     permission dialog or fallback intent — those would be intrusive on a
  //     screen that just opened. It only writes when Contacts permission is
  //     ALREADY granted; otherwise it quietly no-ops and returns a status.
  //   • silent = false (kept for any future manual trigger): full behaviour with
  //     permission prompt, alerts, and the ACTION_INSERT fallback.
  const saveLeadToContacts = async (silent = false) => {
    try {
      const rawPhone = lead?.primaryPhone || lead?.mobile || lead?.phone || '';
      if (!rawPhone) return { ok: false, reason: 'no-phone' };

      if (Platform.OS === 'android') {
        const { PermissionsAndroid } = require('react-native');
        const READ  = PermissionsAndroid.PERMISSIONS.READ_CONTACTS;
        const WRITE = PermissionsAndroid.PERMISSIONS.WRITE_CONTACTS;
        const ACCT  = PermissionsAndroid.PERMISSIONS.GET_ACCOUNTS;

        if (silent) {
          // AUTO path: contacts perms must already be granted — don't prompt for
          // them (would be intrusive on screen open). GET_ACCOUNTS is the one
          // exception: it's required for the account lookup and low-friction, so
          // request it once if missing rather than wrongly reporting the account
          // as "not on device".
          const [readOk, writeOk] = await Promise.all([
            PermissionsAndroid.check(READ),
            PermissionsAndroid.check(WRITE),
          ]);
          if (!readOk || !writeOk) return { ok: false, reason: 'no-permission' };

          const acctOk = await PermissionsAndroid.check(ACCT);
          if (!acctOk) {
            const r = await PermissionsAndroid.request(ACCT);
            if (r !== PermissionsAndroid.RESULTS.GRANTED) {
              return { ok: false, reason: 'no-accounts-permission' };
            }
          }
        } else {
          // MANUAL path: prompt as before (now also asks for GET_ACCOUNTS).
          const results = await PermissionsAndroid.requestMultiple([READ, WRITE, ACCT]);
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
            return { ok: false, reason: 'blocked' };
          }
          if (!readGranted || !writeGranted) {
            Alert.alert('Permission Denied', 'Cannot save contact without Contacts permission.');
            return { ok: false, reason: 'denied' };
          }
        }
      }

      // Build contact name: "LeadName 4567" (last 4 digits of the primary number)
      const digits      = rawPhone.replace(/\D/g, '');
      const last4       = digits.slice(-4) || '0000';
      const contactName = `${lead?.name || 'Lead'} ${last4}`;

      // Write directly to the device address book via the native ContactsModule
      // (ContentResolver insert) — NO screen is opened, the contact is written
      // silently.
      const { NativeModules } = require('react-native');
      const ContactsModule = NativeModules.ContactsModule;

      if (ContactsModule && typeof ContactsModule.saveContact === 'function') {
        try {
          // 5th arg: the admin-set Google account to save into. When non-empty,
          // the native module REQUIRES that account to be signed in on the
          // device; if it isn't, it rejects with code ACCOUNT_NOT_ON_DEVICE so
          // we can alert the agent. When empty, the native module also rejects
          // (NO_ACCOUNT_CONFIGURED) — per product decision we alert rather than
          // silently saving to the device default.
          await ContactsModule.saveContact(
            contactName,
            rawPhone,
            lead?.email || '',
            lead?.company || '',
            contactAccountEmail || '',
          );
          if (!silent) Alert.alert('Saved', `"${contactName}" was saved to your contacts.`);
          return { ok: true };
        } catch (nativeErr) {
          console.warn('[SaveToContacts] native insert failed:', nativeErr?.message);
          // react-native bridges the Kotlin promise.reject CODE into err.code.
          const code = nativeErr?.code || '';
          if (code === 'NO_ACCOUNT_CONFIGURED') {
            return { ok: false, reason: 'no-account-configured' };
          }
          if (code === 'ACCOUNT_NOT_ON_DEVICE') {
            return { ok: false, reason: 'account-not-on-device', account: contactAccountEmail };
          }
          // In AUTO mode do NOT fall back to an intent (it would open a screen);
          // just report failure quietly.
          if (silent) return { ok: false, reason: 'native-failed' };
        }
      } else if (silent) {
        // No native module available and we're automatic — don't open a screen.
        return { ok: false, reason: 'no-native-module' };
      }

      // Fallback (MANUAL only): ACTION_INSERT intent (opens pre-filled screen).
      const name    = encodeURIComponent(contactName);
      const phone   = encodeURIComponent(rawPhone);
      const email   = lead?.email ? encodeURIComponent(lead.email) : '';
      const company = lead?.company ? encodeURIComponent(lead.company) : '';

      let uri = `intent:#Intent;action=android.intent.action.INSERT;type=vnd.android.cursor.dir%2Fcontact;S.name=${name};S.phone=${phone}`;
      if (email)   uri += `;S.email=${email}`;
      if (company) uri += `;S.company=${company}`;
      uri += ';end';

      try {
        await Linking.openURL(uri);
      } catch (intentErr) {
        try {
          await Linking.openURL('content://contacts/people/');
        } catch {
          Alert.alert(
            'Cannot Open Contacts',
            `Please add this contact manually:\nName: ${contactName}\nPhone: ${rawPhone}`,
          );
        }
      }
      return { ok: true, viaIntent: true };
    } catch (e) {
      if (!silent) Alert.alert('Error', e.message || 'Failed to save contact.');
      return { ok: false, reason: 'error' };
    }
  };

  // ── Auto-save the lead to contacts when the screen opens ────────────────────
  // Replaces the manual "Save to Contacts" button. Runs once per lead.id:
  //   • _autoSavedContactIds (module-level) dedups across navigations in the
  //     same app session, so re-opening a lead doesn't write it again.
  //   • The OS contacts provider also dedups identical rows, so this is safe
  //     even across app restarts.
  // It only writes when Contacts permission is already granted (silent=true);
  // it never prompts or opens a screen on its own.
  //
  // Account handling (product decision):
  //   • If no contacts account is configured for this employee → alert them to
  //     ask their admin to set one (shown once per session).
  //   • If the configured account isn't signed in on the device → alert them to
  //     add it in Android settings (shown once per session).
  useEffect(() => {
    if (!lead?.id) return;
    if (Platform.OS !== 'android') return;
    if (_autoSavedContactIds.has(lead.id)) return;

    const phone = lead.primaryPhone || lead.mobile || lead.phone || '';
    if (!phone) return;

    // Mark optimistically so a fast re-render doesn't double-fire; clear on
    // failure so a later open (after permission/account is fixed) can retry.
    _autoSavedContactIds.add(lead.id);

    // PERF FIX: defer the contacts write until after the screen has finished
    // rendering + settling its first interactions. The native contacts lookup +
    // write is comparatively heavy and used to run during mount, competing with
    // the first taps and making the screen feel sluggish right after opening.
    const task = InteractionManager.runAfterInteractions(() => {
      saveLeadToContacts(true).then((res) => {
        if (res?.ok) return;
        _autoSavedContactIds.delete(lead.id);

        // Surface account-setup problems to the agent — but only once per app
        // session per problem, so opening many leads doesn't spam alerts.
        if (res?.reason === 'no-account-configured' && !_contactsAlertShown.noAccount) {
          _contactsAlertShown.noAccount = true;
          Alert.alert(
            'Contacts Account Not Set',
            'No contacts email is configured for your account, so leads can’t be auto-saved to your phone. Please ask your admin to set your “Contacts Email (Google account)” in the CRM.',
          );
        } else if (res?.reason === 'account-not-on-device' && !_contactsAlertShown.notOnDevice) {
          _contactsAlertShown.notOnDevice = true;
          Alert.alert(
            'Add Your Contacts Account',
            `Leads are set to auto-save into "${res.account}", but that Google account isn’t signed in on this phone. Add it in Settings → Accounts → Add account → Google, then reopen this lead.`,
            [
              { text: 'Later', style: 'cancel' },
              { text: 'Open Settings', onPress: () => Linking.openSettings() },
            ],
          );
        }
      });
    });
    return () => task?.cancel?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.id]);

  // Resolve primary & secondary numbers. `mobile` is the canonical/primary
  // (already prefers primaryPhone in the normalizer); secondaryPhone is optional.
  const primaryNumber   = lead.primaryPhone || lead.mobile || lead.phone || '';
  const secondaryNumber = lead.secondaryPhone || '';
  const maskedPhone     = maskPhone(primaryNumber);
  const maskedSecondary = secondaryNumber ? maskPhone(secondaryNumber) : '';

  return (
    <View style={styles.container}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={colors.surface} />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Icon name="arrow-left" size={22} color={colors.textPrimary} />
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
                <Icon name="phone-lock" size={14} color={colors.textSec} style={{ marginRight: 6 }} />
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
                    <Icon name="phone-plus" size={14} color={colors.textSec} style={{ marginRight: 6 }} />
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

          <View style={styles.divider} />
          <View style={styles.tempSelectHeader}>
            <Icon name="thermometer" size={15} color={colors.textMuted} />
            <Text style={styles.tempSelectLabel}>Set Temperature</Text>
            {savingTemp ? <ActivityIndicator size="small" color={colors.textMuted} style={{ marginLeft: 6 }} /> : null}
          </View>
          <View style={styles.tempChipRow}>
            {TEMP_OPTIONS.map((opt) => {
              const active = (lead.temperature || '').toLowerCase() === opt.key.toLowerCase();
              return (
                <TouchableOpacity
                  key={opt.key}
                  activeOpacity={0.8}
                  disabled={savingTemp}
                  onPress={() => handleSetTemperature(opt.key)}
                  style={[styles.tempChip, active && { backgroundColor: opt.bg, borderColor: opt.color }]}
                >
                  <Icon name={opt.icon} size={15} color={active ? opt.color : colors.textMuted} />
                  <Text style={[styles.tempChipTxt, active && { color: opt.color, fontWeight: '700' }]}>
                    {opt.key}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.divider} />
          <View style={styles.tempSelectHeader}>
            <Icon name="flag" size={15} color={colors.textMuted} />
            <Text style={styles.tempSelectLabel}>Set Status</Text>
            {savingStatus ? <ActivityIndicator size="small" color={colors.textMuted} style={{ marginLeft: 6 }} /> : null}
          </View>
          <View style={styles.statusChipRow}>
            {STATUS_OPTIONS.map((s) => {
              const active = (lead.status || '') === s;
              const danger = s === 'Not Interested';
              return (
                <TouchableOpacity
                  key={s}
                  activeOpacity={0.8}
                  disabled={savingStatus}
                  onPress={() => handleSetStatus(s)}
                  style={[
                    styles.statusChip,
                    active && (danger
                      ? { backgroundColor: colors.dangerBg || 'rgba(220,38,38,0.12)', borderColor: colors.danger || '#DC2626' }
                      : { backgroundColor: colors.blueBg || 'rgba(37,99,235,0.12)', borderColor: colors.blue || '#2563EB' }),
                  ]}
                >
                  <Text
                    style={[
                      styles.statusChipTxt,
                      active && { color: danger ? (colors.danger || '#DC2626') : (colors.blue || '#2563EB'), fontWeight: '700' },
                    ]}
                    numberOfLines={1}
                  >
                    {s}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {lead.remark ? (
            <>
              <View style={styles.divider} />
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => setShowAllRemarks(true)}
                style={styles.lastRemarkRow}
              >
                <View style={styles.infoItemLeft}>
                  <Icon name="note-text-outline" size={14} color={colors.textSec} style={{ marginRight: 6 }} />
                  <Text style={styles.infoLabel}>Last Remark</Text>
                  <View style={styles.remarksCountPill}>
                    <Icon name="history" size={10} color={colors.blueLight} style={{ marginRight: 3 }} />
                    <Text style={styles.remarksCountText}>
                      View all{lead.callHistory?.length ? ` (${lead.callHistory.length})` : ''}
                    </Text>
                  </View>
                </View>
                <Text style={styles.infoValue}>{lead.remark}</Text>
              </TouchableOpacity>
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
            <Icon name="lock" size={10} color={colors.blueLight} />
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.remarkBtn}
          onPress={() => setShowRemarkModal(true)}
          activeOpacity={0.8}
        >
          <Icon name="pencil-plus-outline" size={18} color={colors.purple} style={{ marginRight: 8 }} />
          <Text style={styles.remarkBtnText}>Add Call Remark</Text>
        </TouchableOpacity>

        <LeadRecordingsSection lead={lead} />

        {/* ── CRM Call Logs ─────────────────────────────────────────────────── */}
        <View style={styles.section}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <Text style={styles.sectionTitle}>Call Logs</Text>
            <TouchableOpacity onPress={loadCrmCallLogs} style={{ padding: 4 }}>
              <Icon name="refresh" size={16} color={colors.textSec} />
            </TouchableOpacity>
          </View>
          {loadingLogs ? (
            <ActivityIndicator color={colors.blue} style={{ marginTop: 8 }} />
          ) : !logsLoaded ? (
            <TouchableOpacity style={styles.loadLogsBtn} onPress={loadCrmCallLogs}>
              <Icon name="download-outline" size={15} color={colors.blueLight} style={{ marginRight: 6 }} />
              <Text style={styles.loadLogsBtnText}>Load Call Logs</Text>
            </TouchableOpacity>
          ) : crmCallLogs.length === 0 ? (
            <Text style={styles.noLogsText}>No call logs found for this lead</Text>
          ) : (
            crmCallLogs.map((log, i) => (
              <View key={i} style={styles.logRow}>
                <View style={[styles.logIcon, { backgroundColor: callTypeColor(log.callType, colors) + '20' }]}>
                  <Icon name={callTypeIcon(log.callType)} size={16} color={callTypeColor(log.callType, colors)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.logType}>{capitalize(log.callType || 'unknown')}</Text>
                  <Text style={styles.logTime}>{formatDateTime(log.timestamp)}</Text>
                  {log.remark ? <Text style={[styles.logTime, { color: colors.textSec }]}>{log.remark}</Text> : null}
                </View>
                <Text style={styles.logDuration}>
                  {log.duration > 0 ? formatDuration(log.duration) : '—'}
                </Text>
              </View>
            ))
          )}
        </View>

        {/* ── AI Action Summary ─────────────────────────────────────────────── */}
        <View style={styles.section}>
          <View style={styles.aiHeaderRow}>
            <Text style={styles.sectionTitle}>AI Action Summary</Text>
            {aiSummary && !aiSummaryLoading && (
              <TouchableOpacity onPress={() => fetchActionSummary(true)}>
                <Icon name="refresh" size={18} color={colors.purpleLight} />
              </TouchableOpacity>
            )}
          </View>

          {!aiSummary && !aiSummaryLoading && !aiSummaryError && (
            <TouchableOpacity style={styles.aiGenerateBtn} onPress={() => fetchActionSummary(false)}>
              <Icon name="robot-happy-outline" size={18} color="#fff" />
              <Text style={styles.aiGenerateBtnText}>Generate Summary & Next Action</Text>
            </TouchableOpacity>
          )}

          {aiSummaryLoading && (
            <View style={styles.aiLoadingBox}>
              <ActivityIndicator color={colors.purpleLight} />
              <Text style={styles.aiLoadingText}>Analyzing remarks…</Text>
            </View>
          )}

          {!!aiSummaryError && !aiSummaryLoading && (
            <View style={styles.aiErrorBox}>
              <Text style={styles.aiErrorText}>{aiSummaryError}</Text>
              <TouchableOpacity onPress={() => fetchActionSummary(false)}>
                <Text style={styles.aiRetryText}>Retry</Text>
              </TouchableOpacity>
            </View>
          )}

          {aiSummary && !aiSummaryLoading && (
            <View style={styles.aiCard}>
              <Text style={styles.aiSummaryText}>{aiSummary.summary}</Text>

              {!!aiSummary.nextAction && (
                <View style={styles.aiNextBox}>
                  <Text style={styles.aiNextLabel}>NEXT ACTION</Text>
                  <Text style={styles.aiNextText}>{aiSummary.nextAction}</Text>
                </View>
              )}

              {Array.isArray(aiSummary.keyPoints) && aiSummary.keyPoints.length > 0 && (
                <View style={{ marginTop: 10 }}>
                  {aiSummary.keyPoints.map((p, i) => (
                    <Text key={i} style={styles.aiKeyPoint}>• {p}</Text>
                  ))}
                </View>
              )}

              <View style={styles.aiMetaRow}>
                {!!aiSummary.sentiment && (
                  <Text style={styles.aiMetaChip}>{aiSummary.sentiment}</Text>
                )}
                {!!aiSummary.suggestedTemp && (
                  <Text style={styles.aiMetaChip}>Suggested: {aiSummary.suggestedTemp}</Text>
                )}
                <Text style={styles.aiBasedOn}>
                  {aiSummary.basedOn === 'remarks+calls' ? 'From remarks + calls' : 'From remarks'}
                </Text>
              </View>
            </View>
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ── All Remarks modal (opened from "Last Remark") ───────────────────── */}
      <Modal
        visible={showAllRemarks}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAllRemarks(false)}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={styles.modalDismissArea}
            activeOpacity={1}
            onPress={() => setShowAllRemarks(false)}
          />
          <View style={styles.allRemarksCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>All Remarks</Text>
              <TouchableOpacity onPress={() => setShowAllRemarks(false)}>
                <Icon name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <Text style={styles.allRemarksSub}>
              Full remark history for {lead.name}, oldest campaign remark last.
            </Text>
            <ScrollView
              style={styles.allRemarksScroll}
              contentContainerStyle={{ paddingBottom: 8 }}
              showsVerticalScrollIndicator
            >
              {allRemarksList}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── Remark modal ────────────────────────────────────────────────────── */}
      {/* ── Not-Interested reason prompt ─────────────────────────────────── */}
      <Modal visible={niModalVisible} transparent animationType="fade" onRequestClose={() => !niSubmitting && setNiModalVisible(false)}>
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <TouchableOpacity
            style={styles.modalDismissArea}
            activeOpacity={1}
            onPress={() => !niSubmitting && setNiModalVisible(false)}
          />
          <View style={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>Mark Not Interested</Text>
              <TouchableOpacity onPress={() => !niSubmitting && setNiModalVisible(false)}>
                <Icon name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <Text style={styles.niHint}>
              This reassigns the lead to another agent for verification. A reason is required.
            </Text>
            <TextInput
              style={styles.niInput}
              value={niReason}
              onChangeText={setNiReason}
              placeholder="Reason / remark…"
              placeholderTextColor={colors.textMuted}
              multiline
              editable={!niSubmitting}
            />
            <TouchableOpacity
              style={[styles.niSubmitBtn, (!niReason.trim() || niSubmitting) && { opacity: 0.5 }]}
              disabled={!niReason.trim() || niSubmitting}
              onPress={submitNotInterested}
              activeOpacity={0.85}
            >
              {niSubmitting
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.niSubmitTxt}>Confirm Not Interested</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

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
              <Text style={styles.modalTitle}>{isClientMeeting ? 'Client Meeting' : 'Call Remark'}</Text>
              <TouchableOpacity onPress={closeModal}>
                <Icon name="close" size={22} color={colors.textSec} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalLabel}>Outcome *</Text>
            {alreadyInterested && (
              <View style={styles.alreadyInterestedNote}>
                <Icon name="check-circle" size={13} color={colors.greenLight} />
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
              placeholderTextColor={colors.textMuted}
              multiline
              value={remark}
              onChangeText={setRemark}
            />

            {/* ── Client Meeting: visit type selector ───────────────────────── */}
            {isClientMeeting && (
              <View style={styles.meetingTypeBlock}>
                <Text style={styles.modalLabel}>Meeting Type</Text>
                <View style={styles.outcomeRow}>
                  {MEETING_TYPES.map(mt => (
                    <TouchableOpacity
                      key={mt}
                      style={[styles.outcomeChip, meetingType === mt && styles.outcomeChipActive]}
                      onPress={() => setMeetingType(mt)}
                    >
                      <Text style={[styles.outcomeChipText, meetingType === mt && styles.outcomeChipTextActive]}>{mt}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {/* ── Follow-up / meeting date picker ───────────────────────────── */}
            {/* FIX: This entire section was missing. followUpDate was always    */}
            {/* sent as null — agent had no way to schedule a follow-up from     */}
            {/* the mobile app, so follow-up notifications never fired.          */}
            {/* For a Client Meeting this same date IS the meeting time and is   */}
            {/* required; otherwise it's an optional follow-up.                  */}
            <View style={styles.followUpRow}>
              <Text style={styles.modalLabel}>
                {isClientMeeting ? 'Meeting Date & Time ' : 'Follow-Up Date '}
                <Text style={styles.optionalTag}>{isClientMeeting ? '(required)' : '(optional)'}</Text>
              </Text>
              {followUpDate ? (
                <View style={styles.followUpSet}>
                  <Icon name="calendar-check" size={16} color={colors.greenLight} style={{ marginRight: 6 }} />
                  <Text style={styles.followUpDateText}>{formatDateTime(followUpDate)}</Text>
                  <TouchableOpacity onPress={clearFollowUpDate} style={styles.clearDateBtn}>
                    <Icon name="close-circle" size={18} color={colors.red} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.setDateBtn}
                  onPress={openDatePicker}
                >
                  <Icon name="calendar-plus" size={16} color={colors.blueLight} style={{ marginRight: 6 }} />
                  <Text style={styles.setDateBtnText}>
                    {isClientMeeting ? 'Set Meeting Date & Time' : 'Set Follow-Up Date & Time'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Calendar + 12-hour AM/PM picker (pure JS — no native module, so it
                can't hit the DateTimePickerAndroid crash). Confirms with an ISO
                string, the same value handleDateConfirm used to produce. */}
            {showDatePicker && (
              <CalendarDateTimePicker
                value={followUpDate}
                minDate={new Date()}
                onConfirm={(iso) => {
                  setPickerTempDate(new Date(iso));
                  setFollowUpDate(iso);
                  setShowDatePicker(false);
                }}
                onCancel={() => setShowDatePicker(false)}
              />
            )}

            <TouchableOpacity
              style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
              onPress={handleSubmitRemark}
              disabled={submitting}
            >
              {submitting ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <ActivityIndicator color="#fff" size="small" />
                  <Text style={styles.submitBtnText}>{isClientMeeting ? 'Scheduling…' : 'Save Remark'}</Text>
                </View>
              ) : (
                <Text style={styles.submitBtnText}>{isClientMeeting ? 'Schedule Meeting' : 'Save Remark'}</Text>
              )}
            </TouchableOpacity>
          </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

    </View>
  );
}

function createStyles(colors) {
return StyleSheet.create({
  container:          { flex: 1, backgroundColor: colors.bg },
  header:             { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 52, paddingBottom: 14, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  backBtn:            { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt },
  headerTitle:        { fontSize: 17, fontWeight: '800', color: colors.textPrimary },
  headerPhone:        { fontSize: 12, color: colors.textMuted, fontFamily: 'monospace', letterSpacing: 1, marginTop: 2 },

  infoCard:           { backgroundColor: colors.surface, margin: 16, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border },
  infoRow:            { flexDirection: 'row', gap: 12 },
  infoItem:           { flex: 1, minWidth: 0 },
  infoItemLeft:       { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  infoLabel:          { fontSize: 11, color: colors.textSec, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  infoValue:          { fontSize: 13, color: colors.textPrimary, fontWeight: '600' },
  divider:            { height: 1, backgroundColor: colors.border, marginVertical: 10 },

  tempSelectHeader:   { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  tempSelectLabel:    { fontSize: 11, color: colors.textSec, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '600' },
  tempChipRow:        { flexDirection: 'row', gap: 8 },
  tempChip:           { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt },
  tempChipTxt:        { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  statusChipRow:      { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  statusChip:         { flexGrow: 1, flexBasis: '22%', alignItems: 'center', justifyContent: 'center', paddingVertical: 9, paddingHorizontal: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt },
  statusChipTxt:      { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  modalHeaderRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  niHint:             { fontSize: 12, color: colors.textSec, marginBottom: 12, lineHeight: 17 },
  niInput:            { minHeight: 80, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, fontSize: 14, color: colors.textPrimary, backgroundColor: colors.surfaceAlt, textAlignVertical: 'top', marginBottom: 14 },
  niSubmitBtn:        { backgroundColor: colors.red || '#DC2626', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  niSubmitTxt:        { color: '#fff', fontSize: 15, fontWeight: '700' },

  callBigBtn:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.green, marginHorizontal: 16, marginBottom: 8, borderRadius: 14, paddingVertical: 14 },
  callBigBtnText:     { color: '#fff', fontSize: 15, fontWeight: '700' },
  lockBadge:          { marginLeft: 8, backgroundColor: '#06402b', borderRadius: 8, paddingHorizontal: 4, paddingVertical: 2 },

  remarkBtn:          { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, marginHorizontal: 16, marginBottom: 16, borderRadius: 14, paddingVertical: 12, borderWidth: 1, borderColor: colors.purple + '40' },
  remarkBtnText:      { color: colors.purpleLight, fontSize: 14, fontWeight: '700' },
  saveContactBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, marginHorizontal: 16, marginBottom: 8, borderRadius: 14, paddingVertical: 12, borderWidth: 1, borderColor: colors.green + '40' },
  saveContactBtnText: { color: colors.greenLight, fontSize: 14, fontWeight: '700' },

  section:            { paddingHorizontal: 16, marginTop: 8 },
  sectionTitle:       { fontSize: 11, fontWeight: '700', color: colors.textSec, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 },
  historyToggle:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  historyHint:        { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', marginTop: 2, marginBottom: 4 },
  noLogsText:         { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', marginTop: 6 },

  loadLogsBtn:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt, borderRadius: 12, paddingVertical: 11, borderWidth: 1, borderColor: colors.border },
  loadLogsBtnText:    { color: colors.blueLight, fontSize: 13, fontWeight: '600' },

  logRow:             { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  logIcon:            { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  logType:            { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  logTime:            { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  logDuration:        { fontSize: 11, color: colors.textSec },

  historyCard:        { backgroundColor: colors.surface, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border },
  historyHeader:      { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  historyAgent:       { fontSize: 12, fontWeight: '700', color: colors.blueLight },
  historyDate:        { fontSize: 11, color: colors.textMuted },
  historyOutcome:     { fontSize: 12, color: colors.purpleLight, fontWeight: '600', marginBottom: 4 },
  aiHeaderRow:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  aiGenerateBtn:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.purple, paddingVertical: 12, borderRadius: 12, marginTop: 4 },
  aiGenerateBtnText:  { color: '#fff', fontSize: 13, fontWeight: '700' },
  aiLoadingBox:       { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 16, justifyContent: 'center' },
  aiLoadingText:      { color: colors.purpleLight, fontSize: 13, fontWeight: '600' },
  aiErrorBox:         { backgroundColor: '#2A1015', borderColor: '#7F1D1D', borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 4 },
  aiErrorText:        { color: colors.redLight, fontSize: 12, marginBottom: 6 },
  aiRetryText:        { color: colors.redLight, fontSize: 13, fontWeight: '700' },
  aiCard:             { backgroundColor: '#1A1530', borderColor: '#3B2F66', borderWidth: 1, borderRadius: 14, padding: 14, marginTop: 4 },
  aiSummaryText:      { color: '#E5E7EB', fontSize: 14, lineHeight: 20 },
  aiNextBox:          { backgroundColor: '#231A45', borderRadius: 10, padding: 10, marginTop: 12 },
  aiNextLabel:        { color: colors.purpleLight, fontSize: 10, fontWeight: '800', letterSpacing: 1, marginBottom: 4 },
  aiNextText:         { color: '#F0EDFF', fontSize: 13, fontWeight: '600', lineHeight: 19 },
  aiKeyPoint:         { color: colors.purpleLight, fontSize: 12.5, lineHeight: 19 },
  aiMetaRow:          { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  aiMetaChip:         { backgroundColor: '#2D2A55', color: colors.purpleLight, fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: 'hidden' },
  aiBasedOn:          { color: '#6B7280', fontSize: 10, marginLeft: 'auto' },
  historyRemark:      { fontSize: 13, color: colors.textPrimary, lineHeight: 18 },

  // ── Last Remark row (tappable → opens All Remarks modal) ──
  lastRemarkRow:      { paddingVertical: 2 },
  remarksCountPill:   { flexDirection: 'row', alignItems: 'center', marginLeft: 'auto', backgroundColor: colors.blueBg, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  remarksCountText:   { fontSize: 10, fontWeight: '700', color: colors.blueLight },

  // ── All Remarks modal ──
  allRemarksCard:     { backgroundColor: colors.surface, paddingHorizontal: 20, paddingTop: 20, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: colors.border, paddingBottom: 28, maxHeight: '82%' },
  allRemarksSub:      { fontSize: 12, color: colors.textMuted, marginBottom: 14 },
  allRemarksScroll:   { flexGrow: 0 },

  // ── Initial (campaign) remark card ──
  initialRemarkCard:  { backgroundColor: colors.purpleBg + '30', borderColor: colors.purpleLight + '50' },
  initialBadge:       { flexDirection: 'row', alignItems: 'center' },
  initialBadgeText:   { fontSize: 11, fontWeight: '700', color: colors.purpleLight },

  // ── Empty state inside the All Remarks modal ──
  historyEmptyWrap:   { alignItems: 'center', paddingVertical: 30, gap: 8 },
  historyEmptyText:   { fontSize: 13, color: colors.textMuted },

  notFound:           { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  notFoundText:       { color: colors.textMuted, fontSize: 16, marginTop: 14, marginBottom: 14 },
  backLink:           { color: colors.blueLight, fontSize: 14, fontWeight: '600' },

  modalOverlay:       { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalDismissArea:   { flex: 1 },
  modalScroll:        { maxHeight: '90%', flexGrow: 0 },
  modalCard:          { backgroundColor: colors.surface, padding: 20, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: colors.border, paddingBottom: 36 },
  modalHeader:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  modalTitle:         { fontSize: 17, fontWeight: '800', color: colors.textPrimary },
  modalLabel:         { fontSize: 12, color: colors.textSec, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase' },
  optionalTag:        { fontSize: 11, color: colors.textSec, fontWeight: '400', textTransform: 'none' },
  outcomeRow:         { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 16 },
  alreadyInterestedNote: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8, backgroundColor: '#0E2A1E', borderWidth: 1, borderColor: colors.greenLight + '40', marginBottom: 10 },
  alreadyInterestedText: { fontSize: 11, color: colors.greenLight, fontWeight: '600', flex: 1 },
  outcomeChip:        { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  outcomeChipActive:  { backgroundColor: colors.blue + '20', borderColor: colors.blue },
  outcomeChipText:    { fontSize: 12, color: colors.textSec, fontWeight: '600' },
  outcomeChipTextActive: { color: colors.blueLight },
  remarkInput:        { backgroundColor: colors.surface, borderRadius: 10, padding: 12, color: colors.textPrimary, minHeight: 100, textAlignVertical: 'top', borderWidth: 1, borderColor: colors.border, marginBottom: 16 },
  submitBtn:          { backgroundColor: colors.blue, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  submitBtnDisabled:  { opacity: 0.6 },
  submitBtnText:      { color: '#fff', fontSize: 14, fontWeight: '700' },

  // Follow-up date picker styles
  followUpRow:        { marginBottom: 16 },
  meetingTypeBlock:   { marginBottom: 4 },
  followUpSet:        { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: colors.greenLight + '40' },
  followUpDateText:   { flex: 1, fontSize: 13, color: colors.greenLight, fontWeight: '600' },
  clearDateBtn:       { padding: 2 },
  setDateBtn:         { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: colors.border },
  setDateBtnText:     { fontSize: 13, color: colors.blueLight, fontWeight: '600' },
  iosPickerWrapper:   { backgroundColor: colors.surface, borderRadius: 12, marginBottom: 12, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  iosDoneBtn:         { alignItems: 'center', paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border },
  iosDoneBtnText:     { color: colors.blue, fontSize: 15, fontWeight: '700' },

  // Attachment styles
  attachRow:          { marginBottom: 10 },
  attachLabelRow:     { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  attachTypeLabel:    { fontSize: 12, color: colors.textSec, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  attachPickBtn:      { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: colors.border },
  attachPickBtnText:  { fontSize: 13, color: colors.blueLight, fontWeight: '600' },
  attachHint:         { fontSize: 11, color: colors.textMuted },
  attachChip:         { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: '#1E3A5F' },
  attachChipName:     { flex: 1, fontSize: 12, color: colors.textPrimary, fontWeight: '500' },
  attachChipSize:     { fontSize: 11, color: colors.textMuted },
  attachRemoveBtn:    { marginLeft: 6, padding: 2 },

  // Pure-JS date/time picker styles (replaces native DateTimePickerAndroid)
  jsPickerWrapper:     { backgroundColor: colors.surface, borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: colors.textMuted },
  jsPickerTitle:       { fontSize: 12, fontWeight: '700', color: colors.textSec, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 14, textAlign: 'center' },
  jsPickerRow:         { flexDirection: 'row', gap: 8, marginBottom: 10 },
  jsPickerField:       { flex: 1 },
  jsPickerLabel:       { fontSize: 10, color: colors.textSec, fontWeight: '600', textTransform: 'uppercase', marginBottom: 4, textAlign: 'center' },
  jsPickerInput:       { backgroundColor: colors.surface, borderRadius: 8, borderWidth: 1, borderColor: colors.textMuted, color: colors.textPrimary, fontSize: 16, fontWeight: '700', textAlign: 'center', paddingVertical: 10 },
  jsPickerActions:     { flexDirection: 'row', gap: 10, marginTop: 6 },
  jsPickerCancel:      { flex: 1, alignItems: 'center', paddingVertical: 11, borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.textMuted },
  jsPickerCancelText:  { color: colors.textSec, fontSize: 14, fontWeight: '600' },
  jsPickerConfirm:     { flex: 1, alignItems: 'center', paddingVertical: 11, borderRadius: 10, backgroundColor: colors.blue },
  jsPickerConfirmText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
}