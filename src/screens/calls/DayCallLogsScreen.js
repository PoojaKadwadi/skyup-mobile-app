// src/screens/calls/DayCallLogsScreen.js
// ─────────────────────────────────────────────────────────────────────────────
// NEW SCREEN: lets the user pick any specific day and see every call logged
// that day — CallLogsScreen only ever shows "today", with no way to look back
// at a particular past date. Uses the backend's existing GET /call-logs
// endpoint, which already supports ?date=YYYY-MM-DD (added for admin
// reporting) — no backend changes needed, this screen was simply never built
// on the mobile side to use it.
//
// Reached via a "By Date" button on CallLogsScreen — see AppNavigator.js for
// the stack registration and CallLogsScreen.js for the entry point.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  ActivityIndicator, Modal,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSelector }   from 'react-redux';
import Icon              from 'react-native-vector-icons/MaterialCommunityIcons';
import moment             from 'moment';
import { useTheme }       from '../../theme/ThemeContext';
import apiClient          from '../../api/apiClient';
import { normalizePhone } from '../../services/phoneService';

// ── Shared small helpers — duplicated from CallLogsScreen.js deliberately,
// matching the pattern already used elsewhere in this app (e.g. calcBreakMinutes
// duplicated between attendanceController.js and markIdleJob.js) rather than
// creating a new shared-utils import that both screens would need to agree on.
const CALL_TYPE_CONFIG = {
  incoming: { icon: 'phone-incoming', color: '#059669', label: 'Incoming' },
  outgoing: { icon: 'phone-outgoing', color: '#2563EB', label: 'Outgoing' },
  missed:   { icon: 'phone-missed',   color: '#EF4444', label: 'Missed'   },
  rejected: { icon: 'phone-cancel',   color: '#F59E0B', label: 'Rejected' },
  blocked:  { icon: 'phone-off',      color: '#64748B', label: 'Blocked'  },
};

function maskPhone(phone) {
  if (!phone) return '—';
  const digits = normalizePhone(phone) || String(phone).replace(/\D/g, '');
  if (digits.length < 6) return '••••••';
  return digits.slice(0, 2) + '•••••' + digits.slice(-2);
}

function formatDuration(secs) {
  if (!secs || secs === 0) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtTime(ms) { return moment(ms).format('hh:mm A'); }

const ItemSeparator = () => <View style={{ height: 8 }} />;

// ── Minimal month-grid day picker — self-contained, no new dependency.
// Mirrors the plain View/Text calendar pattern already used elsewhere in this
// app (see LeadsScreen.js's SimpleCalendar) rather than a native date-picker
// module, which has previously caused crashes on some Android builds when
// not properly linked (see CalendarDateTimePicker.js's own comment on this).
function daysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }

function DayPickerModal({ visible, selectedDate, onSelect, onClose, colors }) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const base = selectedDate || new Date();
  const [viewYear,  setViewYear]  = useState(base.getFullYear());
  const [viewMonth, setViewMonth] = useState(base.getMonth());

  useEffect(() => {
    if (visible) {
      const b = selectedDate || new Date();
      setViewYear(b.getFullYear());
      setViewMonth(b.getMonth());
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const firstDow  = new Date(viewYear, viewMonth, 1).getDay();
  const totalDays = daysInMonth(viewYear, viewMonth);
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) cells.push(d);

  const goPrev = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else setViewMonth(m => m - 1); };
  const goNext = () => { if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); } else setViewMonth(m => m + 1); };
  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  const isFuture = (d) => new Date(viewYear, viewMonth, d) > today;
  const isSelected = (d) => selectedDate &&
    selectedDate.getFullYear() === viewYear && selectedDate.getMonth() === viewMonth && selectedDate.getDate() === d;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.calendarCard} onPress={() => {}}>
          <View style={styles.calendarHeader}>
            <TouchableOpacity onPress={goPrev} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Icon name="chevron-left" size={24} color={colors.textPrimary} />
            </TouchableOpacity>
            <Text style={styles.calendarMonthLabel}>{monthLabel}</Text>
            <TouchableOpacity onPress={goNext} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Icon name="chevron-right" size={24} color={colors.textPrimary} />
            </TouchableOpacity>
          </View>
          <View style={styles.calendarWeekRow}>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <Text key={i} style={styles.calendarWeekDay}>{d}</Text>
            ))}
          </View>
          <View style={styles.calendarGrid}>
            {cells.map((d, i) => {
              if (d === null) return <View key={i} style={styles.calendarCell} />;
              const future  = isFuture(d);
              const chosen  = isSelected(d);
              return (
                <TouchableOpacity
                  key={i}
                  style={[styles.calendarCell, chosen && styles.calendarCellSelected]}
                  disabled={future}
                  onPress={() => onSelect(new Date(viewYear, viewMonth, d))}
                >
                  <Text style={[
                    styles.calendarCellText,
                    future && styles.calendarCellTextDisabled,
                    chosen && styles.calendarCellTextSelected,
                  ]}>{d}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const LogRow = React.memo(function LogRow({ item, colors }) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const cfg = CALL_TYPE_CONFIG[item.callType] || CALL_TYPE_CONFIG.incoming;
  const time = item.timestamp ? fmtTime(new Date(item.timestamp).getTime()) : '—';

  return (
    <View style={styles.logCard}>
      <View style={[styles.logIconWrap, { backgroundColor: cfg.color + '20' }]}>
        <Icon name={cfg.icon} size={20} color={cfg.color} />
      </View>
      <View style={styles.logBody}>
        <Text style={styles.logNumber} numberOfLines={1}>
          {item.name || maskPhone(item.phoneNumber)}
        </Text>
        {item.name ? <Text style={styles.logSubNumber}>{maskPhone(item.phoneNumber)}</Text> : null}
        <Text style={[styles.logType, { color: cfg.color }]}>{cfg.label}</Text>
        {item.user?.name ? <Text style={styles.logAgent}>👤 {item.user.name}</Text> : null}
      </View>
      <View style={styles.logRight}>
        <Text style={styles.logTime}>{time}</Text>
        <Text style={styles.logDuration}>{item.duration > 0 ? formatDuration(item.duration) : '—'}</Text>
      </View>
    </View>
  );
});

export default function DayCallLogsScreen() {
  const navigation = useNavigation();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const authUser = useSelector((s) => s.auth?.user);
  const isAdmin  = authUser?.role === 'admin' || authUser?.role === 'super_admin';

  const [selectedDate, setSelectedDate] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [pickerOpen, setPickerOpen]     = useState(false);
  const [logs,    setLogs]    = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  const dateParam = useMemo(() => moment(selectedDate).format('YYYY-MM-DD'), [selectedDate]);
  const isToday = useMemo(() => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return t.getTime() === selectedDate.getTime();
  }, [selectedDate]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.get('/call-logs', { params: { date: dateParam, limit: 200 } });
      const raw = res.data.logs || [];
      const valid = raw
        .map(l => ({ ...l, _tsMs: l.timestamp ? new Date(l.timestamp).getTime() : 0 }))
        .filter(l => l._tsMs && !isNaN(l._tsMs))
        .sort((a, b) => b._tsMs - a._tsMs);
      setLogs(valid);
    } catch (e) {
      setError(e?.response?.data?.message || 'Could not load calls for this day.');
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [dateParam]);

  useEffect(() => { load(); }, [load]);

  const goPrevDay = () => {
    const d = new Date(selectedDate); d.setDate(d.getDate() - 1);
    setSelectedDate(d);
  };
  const goNextDay = () => {
    if (isToday) return; // don't allow navigating into the future
    const d = new Date(selectedDate); d.setDate(d.getDate() + 1);
    setSelectedDate(d);
  };

  const dayLabel = isToday ? 'Today' : moment(selectedDate).format('dddd, DD MMM YYYY');

  const summary = useMemo(() => {
    const total    = logs.length;
    const incoming = logs.filter(l => l.callType === 'incoming').length;
    const outgoing = logs.filter(l => l.callType === 'outgoing').length;
    const missed   = logs.filter(l => l.callType === 'missed').length;
    return { total, incoming, outgoing, missed };
  }, [logs]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Icon name="arrow-left" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.title}>Calls by Day</Text>
          <Text style={styles.subtitle}>{isAdmin ? 'Company-wide' : 'Your calls'}</Text>
        </View>
      </View>

      <View style={styles.dateNavRow}>
        <TouchableOpacity onPress={goPrevDay} style={styles.dateNavBtn}>
          <Icon name="chevron-left" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.dateLabelWrap} onPress={() => setPickerOpen(true)}>
          <Icon name="calendar" size={16} color={colors.primary} />
          <Text style={styles.dateLabel}>{dayLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={goNextDay} style={styles.dateNavBtn} disabled={isToday}>
          <Icon name="chevron-right" size={22} color={isToday ? colors.textMuted : colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <View style={styles.summaryRow}>
        <Text style={styles.summaryText}>
          {summary.total} call{summary.total === 1 ? '' : 's'} · {summary.incoming} in · {summary.outgoing} out · {summary.missed} missed
        </Text>
      </View>

      {loading ? (
        <View style={styles.emptyState}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.emptyState}>
          <Icon name="alert-circle-outline" size={40} color={colors.textMuted} />
          <Text style={styles.emptyText}>{error}</Text>
          <TouchableOpacity onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : logs.length === 0 ? (
        <View style={styles.emptyState}>
          <Icon name="phone-off-outline" size={40} color={colors.textMuted} />
          <Text style={styles.emptyText}>No calls on {dayLabel}</Text>
        </View>
      ) : (
        <FlatList
          data={logs}
          keyExtractor={(item) => item._id || `${item.phoneNumber}-${item._tsMs}`}
          renderItem={({ item }) => <LogRow item={item} colors={colors} />}
          ItemSeparatorComponent={ItemSeparator}
          contentContainerStyle={styles.listContent}
        />
      )}

      <DayPickerModal
        visible={pickerOpen}
        selectedDate={selectedDate}
        colors={colors}
        onClose={() => setPickerOpen(false)}
        onSelect={(d) => { setSelectedDate(d); setPickerOpen(false); }}
      />
    </View>
  );
}

function createStyles(colors) {
  return StyleSheet.create({
    container:    { flex: 1, backgroundColor: colors.bg },
    header:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 52, paddingBottom: 14, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
    title:        { fontSize: 20, fontWeight: '800', color: colors.textPrimary },
    subtitle:     { fontSize: 12, color: colors.textMuted, marginTop: 2 },

    dateNavRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
    dateNavBtn:   { padding: 8 },
    dateLabelWrap:{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6 },
    dateLabel:    { fontSize: 15, fontWeight: '700', color: colors.textPrimary },

    summaryRow:   { paddingHorizontal: 20, paddingVertical: 10 },
    summaryText:  { fontSize: 12, color: colors.textMuted, fontWeight: '600' },

    listContent:  { paddingHorizontal: 20, paddingBottom: 24 },
    logCard:      { backgroundColor: colors.surface, borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: colors.border },
    logIconWrap:  { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    logBody:      { flex: 1, minWidth: 0 },
    logNumber:    { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
    logSubNumber: { fontSize: 11, color: colors.textMuted, marginBottom: 2, fontFamily: 'monospace' },
    logType:      { fontSize: 11, fontWeight: '600' },
    logAgent:     { fontSize: 10, color: colors.textMuted, marginTop: 2 },
    logRight:     { alignItems: 'flex-end', gap: 2 },
    logTime:      { fontSize: 12, fontWeight: '600', color: colors.textSec },
    logDuration:  { fontSize: 11, color: colors.textMuted },

    emptyState:   { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 40, paddingHorizontal: 30 },
    emptyText:    { fontSize: 14, color: colors.textMuted, textAlign: 'center', marginTop: 10 },
    retryBtn:     { marginTop: 14, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.primary },
    retryBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

    modalBackdrop:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
    calendarCard:        { width: '86%', backgroundColor: colors.surface, borderRadius: 16, padding: 16 },
    calendarHeader:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
    calendarMonthLabel:  { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
    calendarWeekRow:     { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
    calendarWeekDay:     { width: 32, textAlign: 'center', fontSize: 12, fontWeight: '700', color: colors.textMuted },
    calendarGrid:        { flexDirection: 'row', flexWrap: 'wrap' },
    calendarCell:        { width: '14.28%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
    calendarCellSelected:{ backgroundColor: colors.primary, borderRadius: 8 },
    calendarCellText:        { fontSize: 14, color: colors.textPrimary },
    calendarCellTextDisabled:{ color: colors.textMuted, opacity: 0.4 },
    calendarCellTextSelected:{ color: '#fff', fontWeight: '700' },
  });
}