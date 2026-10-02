// src/screens/calls/DayCallLogsScreen.js
// ─────────────────────────────────────────────────────────────────────────────
// FEATURES:
//
//  1. THREE SECTIONS in priority order:
//       🔴 "Not Called (N)"     — assigned leads never contacted on/before this day
//       🟠 "Remark Pending (N)" — called but no remark logged yet
//       ✅ "Done (N)"           — called + remark logged
//
//  2. CARRY-FORWARD RULE (not called → auto-shows next day)
//     Backend query: leads where no callHistory.calledAt >= dayStart.
//     This means a lead assigned 3 days ago and never called still appears in
//     the "Not Called" section today, tomorrow, and every day until called.
//     It does NOT disappear. Once called it drops off automatically.
//
//  3. AUTO-REFRESH after remark (useFocusEffect)
//     When agent logs a remark in LeadDetail and presses Back, the list
//     silently refreshes — pending card moves to Done, not-called card
//     disappears if they just made the call.
//
//  4. NEXT-DAY FOLLOW-UP badge on every card.
//
//  5. Tapping any card opens LeadDetail.
//
//  6. Pull-to-refresh, prev/next day nav, calendar picker.
//
//  7. Timezone offset fix (tzOffset param) on both API calls.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, Modal, RefreshControl, SectionList, TextInput, ScrollView,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useSelector }    from 'react-redux';
import Icon               from 'react-native-vector-icons/MaterialCommunityIcons';
import moment             from 'moment';
import { useTheme }       from '../../theme/ThemeContext';
import apiClient          from '../../api/apiClient';
import { normalizePhone } from '../../services/phoneService';
import { statusLabel, statusColor } from '../../services/customizationService';

// ─── Constants ────────────────────────────────────────────────────────────────

const CALL_TYPE_CFG = {
  incoming: { icon: 'phone-incoming', color: '#059669', label: 'Incoming' },
  outgoing: { icon: 'phone-outgoing', color: '#2563EB', label: 'Outgoing' },
  missed:   { icon: 'phone-missed',   color: '#EF4444', label: 'Missed'   },
  rejected: { icon: 'phone-cancel',   color: '#F59E0B', label: 'Rejected' },
  blocked:  { icon: 'phone-off',      color: '#64748B', label: 'Blocked'  },
};

const STATUS_COLORS = {
  'New':            '#3B82F6',
  'In Progress':    '#F59E0B',
  'Interested':     '#8B5CF6',
  'Converted':      '#10B981',
  'Not Interested': '#EF4444',
};

// Section config — each has its own accent color + icon
const SECTION_CFG = {
  notCalled: { color: '#EF4444', icon: 'phone-remove-outline',  label: 'Not Called'     },
  pending:   { color: '#F59E0B', icon: 'clock-alert-outline',   label: 'Remark Pending' },
  done:      { color: '#10B981', icon: 'check-circle-outline',  label: 'Done'           },
  other:     { color: '#64748B', icon: 'phone-outline',         label: 'Other numbers'  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function maskPhone(phone) {
  const d = normalizePhone(phone) || String(phone || '').replace(/\D/g, '');
  if (d.length < 6) return '••••••';
  return d.slice(0, 2) + '•••••' + d.slice(-2);
}

function formatDuration(secs) {
  if (!secs) return null;
  const m = Math.floor(secs / 60), s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtTime(ms)  { return moment(ms).format('hh:mm A'); }
function getInitials(name) {
  return (name || '?').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
}

function getNextFollowUp(lead) {
  const arr = lead?.scheduledCalls || lead?.pendingScheduledCalls || [];
  const pending = arr.filter(sc => sc && !sc.done && sc.scheduledAt);
  if (!pending.length) return null;
  return pending.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0].scheduledAt;
}

// A real agent remark vs an auto-generated one
function isDone(log) {
  const r = (log.remark || '').trim();
  if (!r) return false;
  if (/^(outgoing|incoming|missed|rejected) call from mobile app/i.test(r)) return false;
  return true;
}

// How long has this lead been waiting (for "Not Called" cards)
function waitingLabel(daysSince) {
  if (daysSince === 0) return 'Assigned today';
  if (daysSince === 1) return 'Waiting 1 day';
  return `Waiting ${daysSince} days`;
}

// ─── Calendar picker ──────────────────────────────────────────────────────────

function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

function DayPickerModal({ visible, selectedDate, onSelect, onClose, colors }) {
  const s    = useMemo(() => createStyles(colors), [colors]);
  const base = selectedDate || new Date();
  const [vy, setVy] = useState(base.getFullYear());
  const [vm, setVm] = useState(base.getMonth());

  useEffect(() => {
    if (visible) {
      const b = selectedDate || new Date();
      setVy(b.getFullYear()); setVm(b.getMonth());
    }
  }, [visible]); // eslint-disable-line

  const today    = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d; }, []);
  const firstDow = new Date(vy, vm, 1).getDay();
  const cells    = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth(vy, vm); d++) cells.push(d);

  const prev = () => vm === 0 ? (setVm(11), setVy(y => y-1)) : setVm(m => m-1);
  const next = () => vm === 11 ? (setVm(0),  setVy(y => y+1)) : setVm(m => m+1);
  const label = new Date(vy, vm, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={s.modalBg} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={s.calCard}>
          <View style={s.calHead}>
            <TouchableOpacity onPress={prev} hitSlop={{top:8,bottom:8,left:8,right:8}}>
              <Icon name="chevron-left"  size={24} color={colors.textPrimary} />
            </TouchableOpacity>
            <Text style={s.calMonthLbl}>{label}</Text>
            <TouchableOpacity onPress={next} hitSlop={{top:8,bottom:8,left:8,right:8}}>
              <Icon name="chevron-right" size={24} color={colors.textPrimary} />
            </TouchableOpacity>
          </View>
          <View style={s.calWeekRow}>
            {['S','M','T','W','T','F','S'].map((d,i) => (
              <Text key={i} style={s.calWeekDay}>{d}</Text>
            ))}
          </View>
          <View style={s.calGrid}>
            {cells.map((d, i) => {
              if (!d) return <View key={i} style={s.calCell} />;
              const future  = new Date(vy, vm, d) > today;
              const chosen  = selectedDate &&
                selectedDate.getFullYear() === vy &&
                selectedDate.getMonth()    === vm &&
                selectedDate.getDate()     === d;
              return (
                <TouchableOpacity key={i} style={[s.calCell, chosen && s.calCellSel]}
                  disabled={future} onPress={() => onSelect(new Date(vy, vm, d))}>
                  <Text style={[s.calCellTxt,
                    future && s.calCellDis,
                    chosen && s.calCellSelTxt]}>{d}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// ─── Lead card (for "Not Called" section) ────────────────────────────────────
// PERF: cards receive the shared StyleSheet (`s`) from the screen instead of
// each card building its own with StyleSheet.create — that was N style
// objects per render on long lists.

const NotCalledCard = React.memo(function NotCalledCard({ item, onPress, colors, s }) {
  const stColor = statusColor(item.status) || STATUS_COLORS[item.status] || '#64748B';
  const nextFU      = getNextFollowUp(item);
  const remark      = (item.remark || item.initialRemark || '').trim();
  const days        = item.daysSinceAssigned ?? 0;

  return (
    <TouchableOpacity style={[s.card, s.cardNotCalled]} onPress={() => onPress(item._id)} activeOpacity={0.75}>
      <View style={[s.avatar, { backgroundColor: stColor + '22' }]}>
        <Text style={[s.avatarTxt, { color: stColor }]}>{getInitials(item.name)}</Text>
      </View>

      <View style={s.cardBody}>
        <View style={s.nameRow}>
          <Text style={s.leadName} numberOfLines={1}>{item.name || maskPhone(item.mobile)}</Text>
          <View style={[s.waitPill, days > 0 && s.waitPillLate]}>
            <Icon name="timer-sand" size={10} color="#EF4444" />
            <Text style={s.waitTxt}>{waitingLabel(days)}</Text>
          </View>
        </View>
        <Text style={s.phoneText}>{maskPhone(item.mobile || item.primaryPhone)}</Text>

        <View style={s.badgeRow}>
          {item.status ? (
            <View style={[s.badge, { backgroundColor: stColor + '18' }]}>
              <Text style={[s.badgeTxt, { color: stColor }]}>{statusLabel(item.status)}</Text>
            </View>
          ) : null}
          {item.campaign ? (
            <View style={[s.badge, { backgroundColor: colors.border }]}>
              <Text style={[s.badgeTxt, { color: colors.textMuted }]} numberOfLines={1}>{item.campaign}</Text>
            </View>
          ) : null}
        </View>

        {remark ? <Text style={s.initialRemark} numberOfLines={1}>"{remark}"</Text> : null}

        {nextFU ? (
          <View style={s.fuRow}>
            <Icon name="calendar-clock" size={11} color="#8B5CF6" />
            <Text style={s.fuTxt}>Follow-up {moment(nextFU).format('DD MMM, hh:mm A')}</Text>
          </View>
        ) : null}
      </View>

      <View style={s.callNowBtn}>
        <Icon name="phone" size={16} color="#fff" />
      </View>
    </TouchableOpacity>
  );
});

// ─── Call log card (for "Pending" and "Done" sections) ───────────────────────

const CallLogCard = React.memo(function CallLogCard({ item, onPress, colors, s }) {
  const cfg  = CALL_TYPE_CFG[item.callType] || CALL_TYPE_CFG.incoming;
  const lead = item.matchedLead;
  const time = item.timestamp ? fmtTime(new Date(item.timestamp).getTime()) : '—';
  const dur  = formatDuration(item.duration);
  const done = isDone(item);
  const rm   = done ? (item.remark || '').trim() : null;
  const stColor  = lead?.status ? (statusColor(lead.status) || STATUS_COLORS[lead.status] || '#64748B') : '#64748B';
  const displayName  = lead?.name || item.name || null;
  const nextFU       = getNextFollowUp(lead);
  const isNavigable  = !!(lead?._id || item.matchedLeadId);
  const hasRecording = Array.isArray(item.recordings) && item.recordings.length > 0;

  const handlePress = useCallback(() => {
    if (isNavigable) onPress(lead?._id || item.matchedLeadId);
  }, [lead, item.matchedLeadId, isNavigable, onPress]);

  return (
    <TouchableOpacity
      style={[s.card, done ? s.cardDone : s.cardPending]}
      onPress={isNavigable ? handlePress : undefined}
      activeOpacity={isNavigable ? 0.75 : 1}
    >
      <View style={[s.avatar, { backgroundColor: cfg.color + '1F' }]}>
        <Icon name={cfg.icon} size={20} color={cfg.color} />
      </View>

      <View style={s.cardBody}>
        <View style={s.nameRow}>
          <Text style={s.leadName} numberOfLines={1}>{displayName || maskPhone(item.phoneNumber)}</Text>
          <Text style={s.timeTxt}>{time}</Text>
        </View>
        <Text style={s.phoneText}>
          {displayName ? maskPhone(item.phoneNumber) : (isNavigable ? '' : 'Not a lead')}
        </Text>

        <View style={s.badgeRow}>
          <View style={[s.badge, { backgroundColor: cfg.color + '18' }]}>
            <Text style={[s.badgeTxt, { color: cfg.color }]}>{cfg.label}</Text>
          </View>
          {dur ? (
            <View style={[s.badge, { backgroundColor: colors.border }]}>
              <Icon name="timer-outline" size={10} color={colors.textMuted} />
              <Text style={[s.badgeTxt, { color: colors.textMuted }]}>{dur}</Text>
            </View>
          ) : null}
          {lead?.status ? (
            <View style={[s.badge, { backgroundColor: stColor + '18' }]}>
              <Text style={[s.badgeTxt, { color: stColor }]}>{statusLabel(lead.status)}</Text>
            </View>
          ) : null}
          {hasRecording ? (
            <View style={[s.badge, { backgroundColor: '#7C3AED18' }]}>
              <Icon name="microphone" size={10} color="#7C3AED" />
              <Text style={[s.badgeTxt, { color: '#7C3AED' }]}>Recorded</Text>
            </View>
          ) : null}
        </View>

        {isNavigable ? (done ? (
          <View style={s.remarkRow}>
            <Icon name="check-circle" size={12} color="#10B981" />
            <Text style={s.remarkTxt} numberOfLines={2}>{rm}</Text>
          </View>
        ) : (
          <View style={s.pendingPill}>
            <Icon name="pencil-plus-outline" size={12} color="#F59E0B" />
            <Text style={s.pendingTxt}>Add remark</Text>
          </View>
        )) : null}

        {nextFU ? (
          <View style={s.fuRow}>
            <Icon name="calendar-clock" size={11} color="#8B5CF6" />
            <Text style={s.fuTxt}>Follow-up {moment(nextFU).format('DD MMM, hh:mm A')}</Text>
          </View>
        ) : null}

        {item.user?.name ? <Text style={s.agentTxt}>👤 {item.user.name}</Text> : null}
      </View>
    </TouchableOpacity>
  );
});

// ─── Section header ───────────────────────────────────────────────────────────

const SectionHeader = React.memo(function SectionHeader({ section, s }) {
  const cfg = SECTION_CFG[section.key];
  return (
    <View style={s.sectionHead}>
      <View style={[s.sectionDot, { backgroundColor: cfg.color }]} />
      <Text style={[s.sectionTitle, { color: cfg.color }]}>{cfg.label}</Text>
      <View style={[s.sectionCount, { backgroundColor: cfg.color + '1F' }]}>
        <Text style={[s.sectionCountTxt, { color: cfg.color }]}>{section.total ?? section.data.length}</Text>
      </View>
    </View>
  );
});

const Separator = () => <View style={{ height: 8 }} />;

// ─── Filters ──────────────────────────────────────────────────────────────────

const VIEW_TABS = [
  { key: 'all',       label: 'All' },
  { key: 'notCalled', label: 'Not called' },
  { key: 'pending',   label: 'Remark pending' },
  { key: 'done',      label: 'Done' },
];
const TYPE_FILTERS = [
  { key: 'all',      label: 'All calls', icon: 'phone' },
  { key: 'outgoing', label: 'Outgoing',  icon: 'phone-outgoing' },
  { key: 'incoming', label: 'Incoming',  icon: 'phone-incoming' },
  { key: 'missed',   label: 'Missed',    icon: 'phone-missed' },
];
const PAGE = 40; // render the not-called list in pages for speed

function normLogs(raw) {
  return (raw || [])
    .map(l => ({ ...l, _tsMs: l.timestamp ? new Date(l.timestamp).getTime() : 0 }))
    .filter(l => l._tsMs && !isNaN(l._tsMs))
    .sort((a, b) => b._tsMs - a._tsMs);
}

function matchesSearch(q, ...vals) {
  if (!q) return true;
  const digits = q.replace(/\D/g, '');
  return vals.some(v => {
    const str = String(v || '').toLowerCase();
    if (str.includes(q)) return true;
    return digits.length >= 3 && str.replace(/\D/g, '').includes(digits);
  });
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function DayCallLogsScreen() {
  const navigation = useNavigation();
  const { colors } = useTheme();
  const s          = useMemo(() => createStyles(colors), [colors]);

  const authUser = useSelector(st => st.auth?.user);
  const isAdmin  = authUser?.role === 'admin' || authUser?.role === 'super_admin';

  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d;
  });
  const [pickerOpen,  setPickerOpen]  = useState(false);
  const [logs,        setLogs]        = useState([]);
  const [uncalled,    setUncalled]    = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [refreshing,  setRefreshing]  = useState(false);
  const [error,       setError]       = useState(null);

  // Filters
  const [view,       setView]       = useState('all');
  const [callType,   setCallType]   = useState('all');
  const [leadsOnly,  setLeadsOnly]  = useState(false);
  const [search,     setSearch]     = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [notCalledShown, setNotCalledShown] = useState(PAGE);

  const dateParam = useMemo(() => moment(selectedDate).format('YYYY-MM-DD'), [selectedDate]);
  const tzOffset  = useMemo(() => -new Date().getTimezoneOffset(), []);
  const isToday   = useMemo(() => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return t.getTime() === selectedDate.getTime();
  }, [selectedDate]);

  // ── Fetch both lists in parallel (one function for load / refresh / focus) ─
  const reqIdRef = useRef(0);
  const fetchAll = useCallback(async (mode = 'load') => {
    const reqId = ++reqIdRef.current;
    if (mode === 'refresh') setRefreshing(true);
    else if (mode === 'load') setLoading(true);
    if (mode !== 'silent') setError(null);
    try {
      const params = { date: dateParam, limit: 200, tzOffset };
      const [logsRes, uncalledRes] = await Promise.allSettled([
        apiClient.get('/call-logs',          { params }),
        apiClient.get('/call-logs/uncalled', { params }),
      ]);
      if (reqId !== reqIdRef.current) return; // a newer request superseded this one
      if (logsRes.status === 'fulfilled') setLogs(normLogs(logsRes.value.data.logs));
      else if (mode !== 'silent') {
        setLogs([]);
        setError(logsRes.reason?.response?.data?.message || 'Could not load call logs.');
      }
      if (uncalledRes.status === 'fulfilled') setUncalled(uncalledRes.value.data.leads || []);
      else if (mode !== 'silent') setUncalled([]);
    } finally {
      if (reqId === reqIdRef.current) { setLoading(false); setRefreshing(false); }
    }
  }, [dateParam, tzOffset]);

  // Load when date changes
  useEffect(() => { setNotCalledShown(PAGE); fetchAll('load'); }, [fetchAll]);

  // Silent refresh when coming BACK to this screen (not on the first focus —
  // the effect above already loads, which used to double every request).
  const firstFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocusRef.current) { firstFocusRef.current = false; return undefined; }
      const timer = setTimeout(() => fetchAll('silent'), 350);
      return () => clearTimeout(timer);
    }, [fetchAll])
  );

  // ── Nav ───────────────────────────────────────────────────────────────────
  const goPrev = useCallback(() => {
    const d = new Date(selectedDate); d.setDate(d.getDate() - 1); setSelectedDate(d);
  }, [selectedDate]);
  const goNext = useCallback(() => {
    if (isToday) return;
    const d = new Date(selectedDate); d.setDate(d.getDate() + 1); setSelectedDate(d);
  }, [selectedDate, isToday]);
  const openLead = useCallback((leadId) => {
    if (leadId) navigation.navigate('LeadDetail', { leadId });
  }, [navigation]);

  // ── Build sections (with filters) ─────────────────────────────────────────
  const calledLeadIds = useMemo(() => {
    const ids = new Set();
    for (const log of logs) {
      if (log.matchedLead?._id) ids.add(String(log.matchedLead._id));
      if (log.matchedLeadId)    ids.add(String(log.matchedLeadId));
    }
    return ids;
  }, [logs]);

  const q = search.trim().toLowerCase();

  const filtered = useMemo(() => {
    const notCalled = uncalled
      .filter(l => !calledLeadIds.has(String(l._id)))
      .filter(l => matchesSearch(q, l.name, l.mobile, l.primaryPhone, l.campaign));
    const callLogs = logs
      .filter(l => callType === 'all' || l.callType === callType)
      .filter(l => !leadsOnly || l.matchedLead?._id || l.matchedLeadId)
      .filter(l => matchesSearch(q, l.matchedLead?.name, l.name, l.phoneNumber, l.remark));
    return {
      notCalled,
      pending: callLogs.filter(l => !isDone(l) && (l.matchedLead?._id || l.matchedLeadId)),
      done:    callLogs.filter(l => isDone(l)),
      other:   callLogs.filter(l => !isDone(l) && !(l.matchedLead?._id || l.matchedLeadId)),
    };
  }, [uncalled, logs, calledLeadIds, callType, leadsOnly, q]);

  const sections = useMemo(() => {
    const out = [];
    const want = (k) => view === 'all' || view === k;
    if (want('notCalled') && filtered.notCalled.length && callType === 'all') {
      out.push({ key: 'notCalled', total: filtered.notCalled.length, data: filtered.notCalled.slice(0, notCalledShown) });
    }
    if (want('pending') && filtered.pending.length) out.push({ key: 'pending', data: filtered.pending });
    if (want('done') && filtered.done.length)       out.push({ key: 'done', data: filtered.done });
    if (view === 'all' && filtered.other.length)   out.push({ key: 'other', data: filtered.other });
    return out;
  }, [filtered, view, callType, notCalledShown]);

  const summary = useMemo(() => ({
    total:     logs.length,
    incoming:  logs.filter(l => l.callType === 'incoming').length,
    outgoing:  logs.filter(l => l.callType === 'outgoing').length,
    missed:    logs.filter(l => l.callType === 'missed').length,
    talkSecs:  logs.reduce((a, l) => a + (Number(l.duration) || 0), 0),
    notCalled: uncalled.filter(l => !calledLeadIds.has(String(l._id))).length,
    pending:   logs.filter(l => !isDone(l) && (l.matchedLead?._id || l.matchedLeadId)).length,
  }), [logs, uncalled, calledLeadIds]);

  const activeFilterCount = (callType !== 'all' ? 1 : 0) + (leadsOnly ? 1 : 0);
  const dayLabel = isToday ? 'Today' : moment(selectedDate).format('ddd, DD MMM YYYY');
  const isEmpty  = !loading && sections.length === 0;

  const renderItem = useCallback(({ item, section }) => (
    section.key === 'notCalled'
      ? <NotCalledCard item={item} onPress={openLead} colors={colors} s={s} />
      : <CallLogCard item={item} onPress={openLead} colors={colors} s={s} />
  ), [openLead, colors, s]);

  const renderSectionHeader = useCallback(({ section }) => <SectionHeader section={section} s={s} />, [s]);

  const renderSectionFooter = useCallback(({ section }) => (
    section.key === 'notCalled' && section.total > section.data.length ? (
      <TouchableOpacity style={s.moreBtn} onPress={() => setNotCalledShown(n => n + PAGE)}>
        <Text style={s.moreTxt}>Show {Math.min(PAGE, section.total - section.data.length)} more · {section.total - section.data.length} left</Text>
      </TouchableOpacity>
    ) : null
  ), [s]);

  const keyExtractor = useCallback((item, i) => (
    item._id ? String(item._id) : `${item.phoneNumber || ''}-${item._tsMs || i}`
  ), []);

  const Stat = ({ icon, color, value, label, onPress, active }) => (
    <TouchableOpacity style={[s.stat, active && { borderColor: color, backgroundColor: color + '14' }]} onPress={onPress} activeOpacity={0.7}>
      <Icon name={icon} size={15} color={color} />
      <Text style={s.statVal}>{value}</Text>
      <Text style={s.statLbl} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Icon name="arrow-left" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={s.title}>Calls by Day</Text>
          <Text style={s.subtitle}>{isAdmin ? 'Company-wide' : 'Your calls'} · auto-synced</Text>
        </View>
        <TouchableOpacity onPress={() => setShowFilters(v => !v)} style={[s.filterBtn, (showFilters || activeFilterCount) && s.filterBtnOn]}>
          <Icon name="filter-variant" size={18} color={(showFilters || activeFilterCount) ? '#fff' : colors.textPrimary} />
          {activeFilterCount > 0 && <Text style={s.filterBadge}>{activeFilterCount}</Text>}
        </TouchableOpacity>
      </View>

      {/* Date navigation */}
      <View style={s.dateRow}>
        <TouchableOpacity onPress={goPrev} style={s.dateBtn}>
          <Icon name="chevron-left" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <TouchableOpacity style={s.dateLbl} onPress={() => setPickerOpen(true)}>
          <Icon name="calendar-month" size={16} color={colors.blue || '#2563EB'} />
          <Text style={s.dateTxt}>{dayLabel}</Text>
          <Icon name="menu-down" size={18} color={colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity onPress={goNext} style={s.dateBtn} disabled={isToday}>
          <Icon name="chevron-right" size={22} color={isToday ? colors.textMuted : colors.textPrimary} />
        </TouchableOpacity>
      </View>

      {/* Stat tiles (tap to filter) */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.statsRow}>
        <Stat icon="phone" color="#2563EB" value={summary.total} label="Calls"
          active={callType === 'all' && view === 'all'} onPress={() => { setCallType('all'); setView('all'); }} />
        <Stat icon="phone-outgoing" color="#2563EB" value={summary.outgoing} label="Outgoing"
          active={callType === 'outgoing'} onPress={() => setCallType(t => (t === 'outgoing' ? 'all' : 'outgoing'))} />
        <Stat icon="phone-incoming" color="#059669" value={summary.incoming} label="Incoming"
          active={callType === 'incoming'} onPress={() => setCallType(t => (t === 'incoming' ? 'all' : 'incoming'))} />
        <Stat icon="phone-missed" color="#EF4444" value={summary.missed} label="Missed"
          active={callType === 'missed'} onPress={() => setCallType(t => (t === 'missed' ? 'all' : 'missed'))} />
        <Stat icon="phone-remove-outline" color="#EF4444" value={summary.notCalled} label="Not called"
          active={view === 'notCalled'} onPress={() => { setCallType('all'); setView(v => (v === 'notCalled' ? 'all' : 'notCalled')); }} />
        <Stat icon="clock-alert-outline" color="#F59E0B" value={summary.pending} label="Remark pending"
          active={view === 'pending'} onPress={() => setView(v => (v === 'pending' ? 'all' : 'pending'))} />
        <Stat icon="timer-outline" color="#8B5CF6" value={formatDuration(summary.talkSecs) || '0s'} label="Talk time" />
      </ScrollView>

      {/* Search + tabs */}
      <View style={s.searchWrap}>
        <Icon name="magnify" size={18} color={colors.textMuted} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search name, number, remark…"
          placeholderTextColor={colors.textMuted}
          style={s.searchInput}
          returnKeyType="search"
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Icon name="close-circle" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tabsRow}>
        {VIEW_TABS.map(t => (
          <TouchableOpacity key={t.key} onPress={() => setView(t.key)} style={[s.tab, view === t.key && s.tabOn]}>
            <Text style={[s.tabTxt, view === t.key && s.tabTxtOn]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {showFilters && (
        <View style={s.filterPanel}>
          <Text style={s.filterLabel}>Call type</Text>
          <View style={s.chipRow}>
            {TYPE_FILTERS.map(t => (
              <TouchableOpacity key={t.key} onPress={() => setCallType(t.key)} style={[s.fChip, callType === t.key && s.fChipOn]}>
                <Icon name={t.icon} size={13} color={callType === t.key ? '#fff' : colors.textSec || colors.textMuted} />
                <Text style={[s.fChipTxt, callType === t.key && { color: '#fff' }]}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={s.filterLabel}>Numbers</Text>
          <View style={s.chipRow}>
            <TouchableOpacity onPress={() => setLeadsOnly(false)} style={[s.fChip, !leadsOnly && s.fChipOn]}>
              <Text style={[s.fChipTxt, !leadsOnly && { color: '#fff' }]}>All numbers</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setLeadsOnly(true)} style={[s.fChip, leadsOnly && s.fChipOn]}>
              <Text style={[s.fChipTxt, leadsOnly && { color: '#fff' }]}>CRM leads only</Text>
            </TouchableOpacity>
          </View>
          {activeFilterCount > 0 && (
            <TouchableOpacity onPress={() => { setCallType('all'); setLeadsOnly(false); }} style={{ marginTop: 6 }}>
              <Text style={{ color: colors.blue || '#2563EB', fontWeight: '700', fontSize: 13 }}>Clear filters</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Body */}
      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={colors.blue || '#2563EB'} />
          <Text style={s.emptyTxt}>Loading…</Text>
        </View>
      ) : error && isEmpty ? (
        <View style={s.center}>
          <Icon name="alert-circle-outline" size={40} color={colors.textMuted} />
          <Text style={s.emptyTxt}>{error}</Text>
          <TouchableOpacity onPress={() => fetchAll('load')} style={s.retryBtn}>
            <Text style={s.retryTxt}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : isEmpty ? (
        <View style={s.center}>
          <Icon name={q || activeFilterCount || view !== 'all' ? 'filter-remove-outline' : 'phone-check-outline'} size={52} color={colors.textMuted} />
          <Text style={s.emptyTitle}>{q || activeFilterCount || view !== 'all' ? 'Nothing matches these filters' : `All clear for ${dayLabel}`}</Text>
          <Text style={s.emptyTxt}>
            {q || activeFilterCount || view !== 'all'
              ? 'Try a different search or clear the filters.'
              : isToday ? 'No calls yet today and no pending leads.' : 'No calls and no uncalled leads on this date.'}
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          renderSectionHeader={renderSectionHeader}
          renderSectionFooter={renderSectionFooter}
          ItemSeparatorComponent={Separator}
          contentContainerStyle={s.listContent}
          stickySectionHeadersEnabled={false}
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          windowSize={7}
          removeClippedSubviews
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => fetchAll('refresh')} tintColor={colors.blue || '#2563EB'} />
          }
        />
      )}

      <DayPickerModal
        visible={pickerOpen}
        selectedDate={selectedDate}
        colors={colors}
        onClose={() => setPickerOpen(false)}
        onSelect={d => { setSelectedDate(d); setPickerOpen(false); }}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

// PERF: StyleSheet objects are cached per theme — rows/cards that call
// createStyles(colors) no longer rebuild the whole sheet on every mount.
const __styleCache = new WeakMap();
function createStyles(colors) {
  if (colors && __styleCache.has(colors)) return __styleCache.get(colors);
  const out = __buildStyles(colors);
  if (colors) __styleCache.set(colors, out);
  return out;
}
function __buildStyles(colors) {
  const blue   = colors.blue   || '#2563EB';
  const green  = '#10B981';
  const amber  = '#F59E0B';
  const red    = '#EF4444';
  const purple = '#8B5CF6';

  return StyleSheet.create({
    root:   { flex: 1, backgroundColor: colors.bg },

    // Header
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 52, paddingBottom: 14, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
    title:  { fontSize: 20, fontWeight: '800', color: colors.textPrimary },
    subtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2 },

    // Date nav
    dateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
    dateBtn: { padding: 8 },
    dateLbl: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6 },
    dateTxt: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },

    // Summary
    summaryBar:   { paddingHorizontal: 20, paddingVertical: 10 },
    summaryTxt:   { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
    summaryChips: { flexDirection: 'row', gap: 8, marginTop: 6 },
    chip:         { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
    chipTxt:      { fontSize: 11, fontWeight: '800' },

    // List
    listContent: { paddingHorizontal: 16, paddingBottom: 36 },

    // Card base
    card: {
      flexDirection: 'row', alignItems: 'flex-start', gap: 12,
      backgroundColor: colors.surface, borderRadius: 14, padding: 14,
      borderWidth: 1, borderColor: colors.border,
    },
    cardNotCalled: { borderLeftWidth: 3, borderLeftColor: red   },
    cardPending:   { borderLeftWidth: 3, borderLeftColor: amber },
    cardDone:      { borderLeftWidth: 3, borderLeftColor: green },

    // Avatar
    avatar:    { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    avatarTxt: { fontSize: 15, fontWeight: '800' },

    // Card body
    cardBody:     { flex: 1, minWidth: 0 },
    nameRow:      { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
    leadName:     { fontSize: 15, fontWeight: '700', color: colors.textPrimary, flex: 1 },
    phoneText:    { fontSize: 11, color: colors.textMuted, fontFamily: 'monospace', marginBottom: 6 },

    badgeRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: 6 },
    badge:        { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6 },
    badgeTxt:     { fontSize: 11, fontWeight: '700' },

    remarkRow:    { flexDirection: 'row', alignItems: 'flex-start', gap: 5, marginTop: 2 },
    remarkTxt:    { flex: 1, fontSize: 12, color: green,  fontStyle: 'italic', lineHeight: 16 },
    pendingTxt:   { fontSize: 12, color: amber, fontWeight: '600' },
    initialRemark:{ fontSize: 12, color: colors.textMuted, fontStyle: 'italic', marginTop: 4, lineHeight: 16 },

    waitRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
    waitTxt: { fontSize: 11, color: red, fontWeight: '700' },

    fuRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5, backgroundColor: purple + '12', borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, alignSelf: 'flex-start' },
    fuTxt: { fontSize: 11, color: purple, fontWeight: '700' },

    agentTxt: { fontSize: 10, color: colors.textMuted, marginTop: 4 },
    timeTxt:  { fontSize: 12, fontWeight: '600', color: colors.textSec || colors.textMuted },

    // Filters / stats / tabs
    filterBtn:    { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
    filterBtnOn:  { backgroundColor: blue, borderColor: blue },
    filterBadge:  { position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: red, color: '#fff', fontSize: 10, fontWeight: '800', textAlign: 'center', overflow: 'hidden' },
    statsRow:     { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4, gap: 8 },
    stat:         { width: 92, paddingVertical: 10, paddingHorizontal: 10, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    statVal:      { fontSize: 18, fontWeight: '800', color: colors.textPrimary, marginTop: 4 },
    statLbl:      { fontSize: 11, color: colors.textMuted, fontWeight: '600', marginTop: 1 },
    searchWrap:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 10, paddingHorizontal: 12, height: 42, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    searchInput:  { flex: 1, color: colors.textPrimary, fontSize: 14, paddingVertical: 0 },
    tabsRow:      { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
    tab:          { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: colors.border },
    tabOn:        { backgroundColor: blue, borderColor: blue },
    tabTxt:       { fontSize: 13, fontWeight: '700', color: colors.textSec || colors.textMuted },
    tabTxtOn:     { color: '#fff' },
    filterPanel:  { marginHorizontal: 16, marginBottom: 6, padding: 12, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    filterLabel:  { fontSize: 11, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },
    chipRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
    fChip:        { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 18, borderWidth: 1, borderColor: colors.border },
    fChipOn:      { backgroundColor: blue, borderColor: blue },
    fChipTxt:     { fontSize: 12, fontWeight: '700', color: colors.textSec || colors.textMuted },

    // Section header
    sectionHead:     { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingTop: 16, paddingBottom: 8 },
    sectionDot:      { width: 8, height: 8, borderRadius: 4 },
    sectionTitle:    { fontSize: 12, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
    sectionCount:    { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
    sectionCountTxt: { fontSize: 11, fontWeight: '800' },
    moreBtn:         { alignItems: 'center', paddingVertical: 12, marginTop: 8, borderRadius: 12, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
    moreTxt:         { color: blue, fontWeight: '700', fontSize: 13 },

    // Card extras
    waitPill:     { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, backgroundColor: red + '14', marginLeft: 6 },
    waitPillLate: { backgroundColor: red + '24' },
    pendingPill:  { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8, backgroundColor: amber + '18', marginTop: 2 },
    callNowBtn:   { width: 34, height: 34, borderRadius: 17, backgroundColor: green, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },

    // Empty / center
    center:     { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingTop: 60 },
    emptyTitle: { fontSize: 17, fontWeight: '800', color: colors.textPrimary, marginTop: 14, textAlign: 'center' },
    emptyTxt:   { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: 8, lineHeight: 20 },
    retryBtn:   { marginTop: 16, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10, backgroundColor: blue },
    retryTxt:   { color: '#fff', fontWeight: '700', fontSize: 14 },

    // Calendar
    modalBg:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
    calCard:     { width: '86%', backgroundColor: colors.surface, borderRadius: 16, padding: 16 },
    calHead:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
    calMonthLbl: { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
    calWeekRow:  { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
    calWeekDay:  { width: 32, textAlign: 'center', fontSize: 12, fontWeight: '700', color: colors.textMuted },
    calGrid:     { flexDirection: 'row', flexWrap: 'wrap' },
    calCell:     { width: '14.28%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
    calCellSel:  { backgroundColor: blue, borderRadius: 8 },
    calCellTxt:  { fontSize: 14, color: colors.textPrimary },
    calCellDis:  { color: colors.textMuted, opacity: 0.4 },
    calCellSelTxt: { color: '#fff', fontWeight: '700' },
  });
}