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

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, Modal, RefreshControl, SectionList,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useSelector }    from 'react-redux';
import Icon               from 'react-native-vector-icons/MaterialCommunityIcons';
import moment             from 'moment';
import { useTheme }       from '../../theme/ThemeContext';
import apiClient          from '../../api/apiClient';
import { normalizePhone } from '../../services/phoneService';

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

const NotCalledCard = React.memo(function NotCalledCard({ item, onPress, colors }) {
  const s           = useMemo(() => createStyles(colors), [colors]);
  const statusColor = STATUS_COLORS[item.status] || '#64748B';
  const initials    = getInitials(item.name);
  const nextFU      = getNextFollowUp(item);
  const remark      = (item.remark || item.initialRemark || '').trim();
  const days        = item.daysSinceAssigned ?? 0;

  return (
    <TouchableOpacity
      style={[s.card, s.cardNotCalled]}
      onPress={() => onPress(item._id)}
      activeOpacity={0.75}
    >
      <View style={[s.avatar, { backgroundColor: statusColor + '22' }]}>
        <Text style={[s.avatarTxt, { color: statusColor }]}>{initials}</Text>
      </View>

      <View style={s.cardBody}>
        <View style={s.nameRow}>
          <Text style={s.leadName} numberOfLines={1}>{item.name || maskPhone(item.mobile)}</Text>
          <Icon name="chevron-right" size={14} color={colors.textMuted} style={{ marginLeft: 4 }} />
        </View>

        <Text style={s.phoneText}>{maskPhone(item.mobile || item.primaryPhone)}</Text>

        <View style={s.badgeRow}>
          {item.status ? (
            <View style={[s.badge, { backgroundColor: statusColor + '18' }]}>
              <Text style={[s.badgeTxt, { color: statusColor }]}>{item.status}</Text>
            </View>
          ) : null}
          {item.campaign ? (
            <View style={[s.badge, { backgroundColor: colors.border }]}>
              <Text style={[s.badgeTxt, { color: colors.textMuted }]}>{item.campaign}</Text>
            </View>
          ) : null}
        </View>

        {/* Initial/campaign remark */}
        {remark ? (
          <Text style={s.initialRemark} numberOfLines={2}>"{remark}"</Text>
        ) : null}

        {/* Waiting days */}
        <View style={s.waitRow}>
          <Icon name="timer-sand" size={11} color="#EF4444" />
          <Text style={s.waitTxt}>{waitingLabel(days)}</Text>
        </View>

        {/* Follow-up badge */}
        {nextFU ? (
          <View style={s.fuRow}>
            <Icon name="calendar-clock" size={11} color="#8B5CF6" />
            <Text style={s.fuTxt}>Follow-up: {moment(nextFU).format('DD MMM, hh:mm A')}</Text>
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
});

// ─── Call log card (for "Pending" and "Done" sections) ───────────────────────

const CallLogCard = React.memo(function CallLogCard({ item, onPress, colors }) {
  const s    = useMemo(() => createStyles(colors), [colors]);
  const cfg  = CALL_TYPE_CFG[item.callType] || CALL_TYPE_CFG.incoming;
  const lead = item.matchedLead;
  const time = item.timestamp ? fmtTime(new Date(item.timestamp).getTime()) : '—';
  const dur  = formatDuration(item.duration);
  const done = isDone(item);
  const rm   = done ? (item.remark || '').trim() : null;
  const statusColor  = lead?.status ? (STATUS_COLORS[lead.status] || '#64748B') : '#64748B';
  const displayName  = lead?.name || item.name || null;
  const initials     = displayName ? getInitials(displayName) : null;
  const nextFU       = getNextFollowUp(lead);
  const isNavigable  = !!(lead?._id || item.matchedLeadId);

  const handlePress = useCallback(() => {
    if (isNavigable) onPress(lead?._id || item.matchedLeadId);
  }, [lead, item.matchedLeadId, isNavigable, onPress]);

  return (
    <TouchableOpacity
      style={[s.card, done ? s.cardDone : s.cardPending]}
      onPress={isNavigable ? handlePress : undefined}
      activeOpacity={isNavigable ? 0.75 : 1}
    >
      {/* Avatar or icon */}
      {initials ? (
        <View style={[s.avatar, { backgroundColor: statusColor + '22' }]}>
          <Text style={[s.avatarTxt, { color: statusColor }]}>{initials}</Text>
        </View>
      ) : (
        <View style={[s.avatar, { backgroundColor: cfg.color + '20' }]}>
          <Icon name={cfg.icon} size={20} color={cfg.color} />
        </View>
      )}

      <View style={s.cardBody}>
        <View style={s.nameRow}>
          <Text style={s.leadName} numberOfLines={1}>
            {displayName || maskPhone(item.phoneNumber)}
          </Text>
          {isNavigable && (
            <Icon name="chevron-right" size={14} color={colors.textMuted} style={{ marginLeft: 4 }} />
          )}
        </View>

        {displayName && <Text style={s.phoneText}>{maskPhone(item.phoneNumber)}</Text>}

        <View style={s.badgeRow}>
          <View style={[s.badge, { backgroundColor: cfg.color + '18' }]}>
            <Icon name={cfg.icon} size={10} color={cfg.color} />
            <Text style={[s.badgeTxt, { color: cfg.color }]}>{cfg.label}</Text>
          </View>
          {lead?.status && (
            <View style={[s.badge, { backgroundColor: statusColor + '18' }]}>
              <Text style={[s.badgeTxt, { color: statusColor }]}>{lead.status}</Text>
            </View>
          )}
          {dur && (
            <View style={[s.badge, { backgroundColor: colors.border }]}>
              <Icon name="timer-outline" size={10} color={colors.textMuted} />
              <Text style={[s.badgeTxt, { color: colors.textMuted }]}>{dur}</Text>
            </View>
          )}
        </View>

        {done ? (
          <View style={s.remarkRow}>
            <Icon name="check-circle" size={11} color="#10B981" />
            <Text style={s.remarkTxt} numberOfLines={2}>"{rm}"</Text>
          </View>
        ) : (
          <View style={s.remarkRow}>
            <Icon name="clock-alert-outline" size={11} color="#F59E0B" />
            <Text style={s.pendingTxt}>Remark pending — tap to add</Text>
          </View>
        )}

        {nextFU && (
          <View style={s.fuRow}>
            <Icon name="calendar-clock" size={11} color="#8B5CF6" />
            <Text style={s.fuTxt}>Follow-up: {moment(nextFU).format('DD MMM, hh:mm A')}</Text>
          </View>
        )}

        {item.user?.name && (
          <Text style={s.agentTxt}>👤 {item.user.name}</Text>
        )}
      </View>

      <View style={{ alignItems: 'flex-end', paddingTop: 2 }}>
        <Text style={s.timeTxt}>{time}</Text>
      </View>
    </TouchableOpacity>
  );
});

// ─── Section header ───────────────────────────────────────────────────────────

const SectionHeader = React.memo(function SectionHeader({ section, colors }) {
  const cfg = SECTION_CFG[section.key];
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingHorizontal: 20, paddingTop: 18, paddingBottom: 8,
    }}>
      <Icon name={cfg.icon} size={14} color={cfg.color} />
      <Text style={{
        fontSize: 12, fontWeight: '800', color: cfg.color,
        letterSpacing: 0.6, textTransform: 'uppercase',
      }}>
        {cfg.label} · {section.data.length}
      </Text>
    </View>
  );
});

const Separator = () => <View style={{ height: 8 }} />;

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

  const dateParam = useMemo(() => moment(selectedDate).format('YYYY-MM-DD'), [selectedDate]);
  const tzOffset  = useMemo(() => -new Date().getTimezoneOffset(), []);
  const isToday   = useMemo(() => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return t.getTime() === selectedDate.getTime();
  }, [selectedDate]);

  // ── Fetch both lists in parallel ──────────────────────────────────────────
  const fetchAll = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else           setLoading(true);
    setError(null);

    try {
      const params = { date: dateParam, limit: 200, tzOffset };

      const [logsRes, uncalledRes] = await Promise.allSettled([
        apiClient.get('/call-logs',          { params }),
        apiClient.get('/call-logs/uncalled',  { params }),
      ]);

      // Call logs
      if (logsRes.status === 'fulfilled') {
        const raw = logsRes.value.data.logs || [];
        setLogs(
          raw
            .map(l => ({ ...l, _tsMs: l.timestamp ? new Date(l.timestamp).getTime() : 0 }))
            .filter(l => l._tsMs && !isNaN(l._tsMs))
            .sort((a, b) => b._tsMs - a._tsMs)
        );
      } else {
        setLogs([]);
        setError(logsRes.reason?.response?.data?.message || 'Could not load call logs.');
      }

      // Uncalled leads
      if (uncalledRes.status === 'fulfilled') {
        setUncalled(uncalledRes.value.data.leads || []);
      } else {
        setUncalled([]);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [dateParam, tzOffset]);

  // Load when date changes
  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Silent refresh when returning from LeadDetail (after logging remark / making a call)
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const timer = setTimeout(async () => {
        if (!alive || loading) return;
        try {
          const params = { date: dateParam, limit: 200, tzOffset };
          const [lr, ur] = await Promise.allSettled([
            apiClient.get('/call-logs',         { params }),
            apiClient.get('/call-logs/uncalled', { params }),
          ]);
          if (!alive) return;
          if (lr.status === 'fulfilled') {
            const raw = lr.value.data.logs || [];
            setLogs(
              raw
                .map(l => ({ ...l, _tsMs: l.timestamp ? new Date(l.timestamp).getTime() : 0 }))
                .filter(l => l._tsMs && !isNaN(l._tsMs))
                .sort((a, b) => b._tsMs - a._tsMs)
            );
          }
          if (ur.status === 'fulfilled') setUncalled(ur.value.data.leads || []);
        } catch { /* silent */ }
      }, 350);
      return () => { alive = false; clearTimeout(timer); };
    }, [dateParam, tzOffset, loading])
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

  // ── Build sections ────────────────────────────────────────────────────────
  // Exclude from "Not Called" any lead that appears in call logs (already called)
  const calledLeadIds = useMemo(() => {
    const ids = new Set();
    for (const log of logs) {
      if (log.matchedLead?._id) ids.add(String(log.matchedLead._id));
      if (log.matchedLeadId)    ids.add(String(log.matchedLeadId));
    }
    return ids;
  }, [logs]);

  const sections = useMemo(() => {
    const notCalledLeads = uncalled.filter(l => !calledLeadIds.has(String(l._id)));
    const pendingLogs    = logs.filter(l => !isDone(l));
    const doneLogs       = logs.filter(l =>  isDone(l));
    const result = [];
    if (notCalledLeads.length) result.push({ key: 'notCalled', data: notCalledLeads });
    if (pendingLogs.length)    result.push({ key: 'pending',   data: pendingLogs    });
    if (doneLogs.length)       result.push({ key: 'done',      data: doneLogs       });
    return result;
  }, [uncalled, logs, calledLeadIds]);

  const summary = useMemo(() => ({
    total:     logs.length,
    incoming:  logs.filter(l => l.callType === 'incoming').length,
    outgoing:  logs.filter(l => l.callType === 'outgoing').length,
    missed:    logs.filter(l => l.callType === 'missed').length,
    notCalled: sections.find(s => s.key === 'notCalled')?.data.length ?? 0,
    pending:   sections.find(s => s.key === 'pending')?.data.length   ?? 0,
  }), [logs, sections]);

  const dayLabel = isToday
    ? 'Today'
    : moment(selectedDate).format('dddd, DD MMM YYYY');

  const isEmpty  = !loading && sections.length === 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={s.root}>

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}
          hitSlop={{top:10,bottom:10,left:10,right:10}}>
          <Icon name="arrow-left" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={s.title}>Calls by Day</Text>
          <Text style={s.subtitle}>{isAdmin ? 'Company-wide' : 'Your calls'}</Text>
        </View>
      </View>

      {/* Date navigation */}
      <View style={s.dateRow}>
        <TouchableOpacity onPress={goPrev} style={s.dateBtn}>
          <Icon name="chevron-left" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <TouchableOpacity style={s.dateLbl} onPress={() => setPickerOpen(true)}>
          <Icon name="calendar" size={16} color={colors.blue || '#2563EB'} />
          <Text style={s.dateTxt}>{dayLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={goNext} style={s.dateBtn} disabled={isToday}>
          <Icon name="chevron-right" size={22}
            color={isToday ? colors.textMuted : colors.textPrimary} />
        </TouchableOpacity>
      </View>

      {/* Summary bar */}
      {(logs.length > 0 || summary.notCalled > 0) && !loading && (
        <View style={s.summaryBar}>
          <Text style={s.summaryTxt}>
            {summary.total} call{summary.total !== 1 ? 's' : ''} · {summary.incoming} in · {summary.outgoing} out · {summary.missed} missed
          </Text>
          <View style={s.summaryChips}>
            {summary.notCalled > 0 && (
              <View style={[s.chip, { backgroundColor: '#EF444418' }]}>
                <Text style={[s.chipTxt, { color: '#EF4444' }]}>
                  {summary.notCalled} not called
                </Text>
              </View>
            )}
            {summary.pending > 0 && (
              <View style={[s.chip, { backgroundColor: '#F59E0B18' }]}>
                <Text style={[s.chipTxt, { color: '#F59E0B' }]}>
                  {summary.pending} pending
                </Text>
              </View>
            )}
          </View>
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
          <TouchableOpacity onPress={() => fetchAll()} style={s.retryBtn}>
            <Text style={s.retryTxt}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : isEmpty ? (
        <View style={s.center}>
          <Icon name="phone-check-outline" size={52} color={colors.textMuted} />
          <Text style={s.emptyTitle}>All clear for {dayLabel}</Text>
          <Text style={s.emptyTxt}>
            {isToday
              ? 'No calls yet today and no pending leads.'
              : 'No calls and no uncalled leads on this date.'}
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item, i) =>
            item._id
              ? String(item._id)
              : `${item.phoneNumber || ''}-${item._tsMs || i}`
          }
          renderItem={({ item, section }) =>
            section.key === 'notCalled' ? (
              <NotCalledCard item={item} onPress={openLead} colors={colors} />
            ) : (
              <CallLogCard item={item} onPress={openLead} colors={colors} />
            )
          }
          renderSectionHeader={({ section }) => (
            <SectionHeader section={section} colors={colors} />
          )}
          ItemSeparatorComponent={Separator}
          contentContainerStyle={s.listContent}
          stickySectionHeadersEnabled={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchAll(true)}
              tintColor={colors.blue || '#2563EB'}
            />
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

function createStyles(colors) {
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