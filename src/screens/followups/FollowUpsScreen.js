// src/screens/followups/FollowUpsScreen.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// FOLLOW-UPS — the Daily Report's "Follow-ups" tab, on the phone.
//
//   • Every pending follow-up with what the EMPLOYEE WROTE about it (their remark on the lead, with who + when),
//     the due date, how late / soon it is, and whether an employee set it or it was created automatically.
//     Default view: follow-ups set by employees (automatic ones are one tap away — "Source" filter).
//   • Leads 24h+ old that never got a follow-up date ("No follow-up date").
//   • Admins see every employee: group the list BY EMPLOYEE or by urgency, filter to one employee.
//     An employee sees only their own follow-ups.
//   • Tap a summary tile to filter (Overdue / Due today / Upcoming / No date); search by name, number, note.
//   • Tap a card → the lead. Pull to refresh; refreshes itself when you come back to the screen.
//
// Data: GET /reports/follow-ups (same lists and counts as the web Daily Report). Logic: ./followUpUtils.js
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, SectionList, ActivityIndicator,
  RefreshControl, TextInput,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useSelector } from 'react-redux';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import moment from 'moment';
import { useTheme } from '../../theme/ThemeContext';
import { fetchFollowUps } from '../../api/followUpsApi';
import FilterDropdown from '../../components/FilterDropdown';
import { statusLabel, statusColor } from '../../services/customizationService';
import {
  URGENCY_ORDER, URGENCY_CFG, normalizeReport, filterItems, countByUrgency,
  employeeOptions, groupItems, maskPhone, initials, countBySource,
} from './followUpUtils';

const STALE_MS = 60 * 1000;     // refresh when returning to the screen if the data is older than this

const SHOW_OPTIONS = [
  { value: 'all',      label: 'All follow-ups' },
  { value: 'overdue',  label: 'Overdue' },
  { value: 'today',    label: 'Due today' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'missing',  label: 'No follow-up date' },
];
// Who created the follow-up. Default = what employees themselves set; the automatic ones (workflow / verification calls) are opt-in.
const SOURCE_OPTIONS = [
  { value: 'employee', label: 'Set by employee' },
  { value: 'auto',     label: 'Automatic' },
  { value: 'all',      label: 'All' },
];
const GROUP_OPTIONS = [
  { value: 'employee', label: 'By employee' },
  { value: 'urgency',  label: 'By urgency' },
];

// ─── Cards ────────────────────────────────────────────────────────────────────

const FollowUpCard = React.memo(function FollowUpCard({ item, onPress, showEmployee, colors, s }) {
  const cfg   = URGENCY_CFG[item.urgency];
  const stCol = (item.status && statusColor(item.status)) || '#64748B';
  const due   = item.scheduledAt ? moment(item.scheduledAt) : null;
  const isMeeting = item.type && item.type !== 'follow-up';

  return (
    <TouchableOpacity style={[s.card, { borderLeftColor: cfg.color }]} onPress={() => onPress(item.leadId)} activeOpacity={0.75}>
      <View style={s.cardTop}>
        <View style={[s.avatar, { backgroundColor: cfg.color + '1F' }]}>
          <Text style={[s.avatarTxt, { color: cfg.color }]}>{initials(item.name)}</Text>
        </View>
        <View style={s.cardHead}>
          <Text style={s.leadName} numberOfLines={1}>{item.name || maskPhone(item.mobile)}</Text>
          <Text style={s.phone}>{maskPhone(item.mobile)}</Text>
        </View>
        <View style={[s.urgPill, { backgroundColor: cfg.color + '1A' }]}>
          <Icon name={cfg.icon} size={12} color={cfg.color} />
          <Text style={[s.urgTxt, { color: cfg.color }]} numberOfLines={1}>{item.daysLabel || cfg.label}</Text>
        </View>
      </View>

      {due ? (
        <View style={s.dueRow}>
          <Icon name="calendar-clock" size={13} color="#8B5CF6" />
          <Text style={s.dueTxt}>{due.format('ddd, DD MMM · hh:mm A')}</Text>
          {isMeeting ? <View style={s.typeBadge}><Text style={s.typeTxt}>{item.type}</Text></View> : null}
          <View style={[s.srcBadge, item.origin === 'auto' ? s.srcAuto : s.srcEmp]}>
            <Icon name={item.origin === 'auto' ? 'robot-outline' : 'account-edit-outline'} size={11} color={item.origin === 'auto' ? '#64748B' : colors.blueLight} />
            <Text style={[s.srcTxt, { color: item.origin === 'auto' ? '#64748B' : colors.blueLight }]}>{item.origin === 'auto' ? 'Automatic' : 'Set by employee'}</Text>
          </View>
        </View>
      ) : null}

      {item.kind === 'followup' ? (
        <>
          {item.remark ? (
            <View style={s.remarkBox}>
              <Text style={s.remarkLabel}>EMPLOYEE'S REMARK</Text>
              <View style={s.remarkRow}>
                <Icon name="format-quote-open" size={14} color={colors.textMuted} />
                <Text style={s.remarkTxt}>{item.remark.text}</Text>
              </View>
              {(item.remark.by || item.remark.at) ? (
                <Text style={s.remarkBy}>— {[item.remark.by, item.remark.at ? moment(item.remark.at).format('DD MMM, hh:mm A') : ''].filter(Boolean).join(' · ')}</Text>
              ) : null}
            </View>
          ) : <Text style={s.noNote}>No remark written by the employee</Text>}
          {item.note ? (
            <View style={s.noteRow}>
              <Icon name="note-text-outline" size={13} color={colors.textMuted} />
              <Text style={s.noteLine}>{item.note}</Text>
            </View>
          ) : null}
        </>
      ) : (
        <Text style={s.noNote}>This lead has never had a follow-up date set.</Text>
      )}

      <View style={s.metaRow}>
        {item.status ? (
          <View style={[s.badge, { backgroundColor: stCol + '18' }]}>
            <Text style={[s.badgeTxt, { color: stCol }]}>{statusLabel(item.status)}</Text>
          </View>
        ) : <View />}
        {showEmployee ? (
          <View style={s.empRow}>
            <Icon name="account-outline" size={13} color={colors.textMuted} />
            <Text style={s.empTxt} numberOfLines={1}>{item.employee}</Text>
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
});

const SectionHeader = React.memo(function SectionHeader({ section, groupBy, s, colors }) {
  if (groupBy === 'employee') {
    const c = section.counts;
    return (
      <View style={s.empHead}>
        <View style={[s.empAvatar, { backgroundColor: colors.blueBg }]}>
          <Text style={[s.empAvatarTxt, { color: colors.blueLight }]}>{initials(section.title)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.empName} numberOfLines={1}>{section.title}</Text>
          <View style={s.chipRow}>
            {URGENCY_ORDER.filter((k) => c[k] > 0).map((k) => (
              <View key={k} style={[s.miniChip, { backgroundColor: URGENCY_CFG[k].color + '1A' }]}>
                <Text style={[s.miniChipTxt, { color: URGENCY_CFG[k].color }]}>{c[k]} {k === 'missing' ? 'no date' : k === 'today' ? 'today' : k}</Text>
              </View>
            ))}
          </View>
        </View>
        <Text style={s.empTotal}>{c.total}</Text>
      </View>
    );
  }
  return (
    <View style={s.sectionHead}>
      <View style={[s.sectionDot, { backgroundColor: section.color }]} />
      <Text style={[s.sectionTitle, { color: section.color }]}>{section.title}</Text>
      <View style={[s.sectionCount, { backgroundColor: section.color + '1F' }]}>
        <Text style={[s.sectionCountTxt, { color: section.color }]}>{section.data.length}</Text>
      </View>
    </View>
  );
});

const Separator = () => <View style={{ height: 8 }} />;

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function FollowUpsScreen() {
  const navigation = useNavigation();
  const { colors, dark } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);

  const authUser = useSelector((st) => st.auth?.user);
  const isAdmin  = authUser?.role === 'admin' || authUser?.role === 'super_admin';

  const [report,     setReport]     = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);

  const [urgency,    setUrgency]    = useState('all');
  const [employeeId, setEmployeeId] = useState('all');
  const [search,     setSearch]     = useState('');
  const [source,     setSource]     = useState('employee');   // who set the follow-up (default: employees)
  const [groupBy,    setGroupBy]    = useState(isAdmin ? 'employee' : 'urgency');

  const lastLoadRef = useRef(0);
  const reqRef      = useRef(0);

  const load = useCallback(async (mode = 'load') => {
    const id = ++reqRef.current;
    if (mode === 'refresh') setRefreshing(true); else if (mode === 'load') setLoading(true);
    if (mode !== 'silent') setError(null);
    try {
      const data = await fetchFollowUps();
      if (id !== reqRef.current) return;
      setReport(data);
      lastLoadRef.current = Date.now();
    } catch (e) {
      if (id !== reqRef.current) return;
      if (mode !== 'silent') setError(e?.response?.data?.message || 'Could not load follow-ups.');
    } finally {
      if (id === reqRef.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  // First open loads; coming back to the screen refreshes quietly when the data is stale.
  useFocusEffect(useCallback(() => {
    if (!lastLoadRef.current) load('load');
    else if (Date.now() - lastLoadRef.current > STALE_MS) load('silent');
    return undefined;
  }, [load]));

  const items = useMemo(() => normalizeReport(report), [report]);
  // The tiles count what the employee + search choices leave, regardless of the urgency choice, so they stay useful.
  const counts = useMemo(() => countByUrgency(filterItems(items, { employeeId, search, source })), [items, employeeId, search, source]);
  const list   = useMemo(() => filterItems(items, { employeeId, urgency, search, source }), [items, employeeId, urgency, search, source]);
  // how many follow-ups each source has (for the "N automatic hidden" note) — ignores the source choice itself
  const bySource = useMemo(() => countBySource(filterItems(items, { employeeId, search })), [items, employeeId, search]);
  const sections = useMemo(() => groupItems(list, isAdmin ? groupBy : 'urgency'), [list, groupBy, isAdmin]);
  const empOpts  = useMemo(() => employeeOptions(report?.employees), [report]);

  const openLead = useCallback((leadId) => {
    if (leadId) navigation.navigate('LeadDetail', { leadId, highlightFollowUp: true });
  }, [navigation]);

  const filtersOn = urgency !== 'all' || employeeId !== 'all' || !!search.trim() || source !== 'employee';
  const clearAll  = () => { setUrgency('all'); setEmployeeId('all'); setSearch(''); setSource('employee'); };
  const hiddenAuto = source === 'employee' ? bySource.auto : 0;
  const showEmployee = isAdmin && groupBy !== 'employee';

  const renderItem = useCallback(({ item }) => (
    <FollowUpCard item={item} onPress={openLead} showEmployee={showEmployee} colors={colors} s={s} />
  ), [openLead, showEmployee, colors, s]);
  const renderSectionHeader = useCallback(({ section }) => (
    <SectionHeader section={section} groupBy={isAdmin ? groupBy : 'urgency'} s={s} colors={colors} />
  ), [isAdmin, groupBy, s, colors]);
  const keyExtractor = useCallback((it) => it.key, []);

  const Tile = ({ k }) => {
    const cfg = URGENCY_CFG[k];
    const active = urgency === k;
    return (
      <TouchableOpacity
        style={[s.tile, active && { borderColor: cfg.color, backgroundColor: cfg.color + '14' }]}
        onPress={() => setUrgency((u) => (u === k ? 'all' : k))} activeOpacity={0.7}
        accessibilityRole="button" accessibilityLabel={`${cfg.label}: ${counts[k]}`}
      >
        <Icon name={cfg.icon} size={15} color={cfg.color} />
        <Text style={[s.tileVal, { color: dark ? '#FFFFFF' : '#111827' }]}>{counts[k]}</Text>
        <Text style={[s.tileLbl, { color: dark ? '#B7BCD4' : '#4A5270' }]} numberOfLines={1}>{k === 'missing' ? 'No date' : cfg.label}</Text>
      </TouchableOpacity>
    );
  };

  const isEmpty = !loading && !error && sections.length === 0;

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Icon name="arrow-left" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={s.title}>Follow-ups</Text>
          <Text style={s.subtitle}>{isAdmin ? 'All employees' : 'Your follow-ups'}{report ? ` · ${report.counts?.total ?? 0} pending` : ''}</Text>
        </View>
        <TouchableOpacity
          onPress={() => navigation.navigate('Main', { screen: 'Leads', params: { followUpOnly: true } })}
          style={s.headBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel="Open follow-ups in the Leads list"
        >
          <Icon name="account-group-outline" size={20} color={colors.blueLight} />
        </TouchableOpacity>
      </View>

      {/* Summary tiles (tap to filter) */}
      <View style={s.tilesRow}>
        {URGENCY_ORDER.map((k) => <Tile key={k} k={k} />)}
      </View>

      {/* Search */}
      <View style={s.searchWrap}>
        <Icon name="magnify" size={18} color={colors.textMuted} />
        <TextInput
          value={search} onChangeText={setSearch} placeholder="Search name, number, note, employee…"
          placeholderTextColor={colors.textMuted} style={s.searchInput} returnKeyType="search"
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Icon name="close-circle" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Filter pills */}
      <View style={s.filterWrap}>
        {isAdmin ? (
          <FilterDropdown label="Employee" value={employeeId} options={empOpts} onChange={setEmployeeId} dark={dark} colors={colors} />
        ) : null}
        <FilterDropdown label="Show" value={urgency} options={SHOW_OPTIONS} onChange={setUrgency} dark={dark} colors={colors} />
        <FilterDropdown label="Source" value={source} options={SOURCE_OPTIONS} onChange={setSource} dark={dark} colors={colors} neutralValue="employee" />
        {isAdmin ? (
          <FilterDropdown label="Group" value={groupBy} options={GROUP_OPTIONS} onChange={setGroupBy} dark={dark} colors={colors} neutralValue="employee" />
        ) : null}
        {filtersOn ? (
          <TouchableOpacity onPress={clearAll} activeOpacity={0.75}
            style={[s.clearPill, { borderColor: dark ? '#7F1D1D' : '#FECACA', backgroundColor: dark ? '#3B1212' : '#FEF2F2' }]}>
            <Icon name="close" size={13} color={dark ? '#FCA5A5' : '#DC2626'} />
            <Text style={[s.clearTxt, { color: dark ? '#FCA5A5' : '#DC2626' }]}>Clear</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* What the Source filter is hiding — never silent */}
      {!loading && !error && report && hiddenAuto > 0 ? (
        <TouchableOpacity style={s.hint} onPress={() => setSource('all')} activeOpacity={0.7}>
          <Icon name="robot-outline" size={14} color={colors.textMuted} />
          <Text style={s.hintTxt} numberOfLines={1}>Employee-set only · {hiddenAuto} automatic hidden</Text>
          <Text style={s.hintLink}>Show all</Text>
        </TouchableOpacity>
      ) : null}
      {!loading && !error && report && source === 'auto' ? (
        <TouchableOpacity style={s.hint} onPress={() => setSource('employee')} activeOpacity={0.7}>
          <Icon name="robot-outline" size={14} color={colors.textMuted} />
          <Text style={s.hintTxt} numberOfLines={1}>Showing automatic follow-ups only</Text>
          <Text style={s.hintLink}>Show employee-set</Text>
        </TouchableOpacity>
      ) : null}

      {/* Body */}
      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={colors.blue} /><Text style={s.emptyTxt}>Loading…</Text></View>
      ) : error ? (
        <View style={s.center}>
          <Icon name="alert-circle-outline" size={40} color={colors.textMuted} />
          <Text style={s.emptyTxt}>{error}</Text>
          <TouchableOpacity onPress={() => load('load')} style={s.retryBtn}><Text style={s.retryTxt}>Retry</Text></TouchableOpacity>
        </View>
      ) : isEmpty ? (
        <View style={s.center}>
          <Icon name={filtersOn ? 'filter-remove-outline' : 'calendar-check-outline'} size={52} color={colors.textMuted} />
          <Text style={s.emptyTitle}>{hiddenAuto > 0 && !filtersOn ? 'No follow-ups set by employees' : filtersOn ? 'Nothing matches these filters' : 'No pending follow-ups'}</Text>
          <Text style={s.emptyTxt}>{hiddenAuto > 0 && !filtersOn ? `${hiddenAuto} automatic follow-up${hiddenAuto > 1 ? 's are' : ' is'} hidden. Tap "Show all" above to see ${hiddenAuto > 1 ? 'them' : 'it'}.` : filtersOn ? 'Try a different search or clear the filters.' : isAdmin ? 'Your team has no follow-ups pending. 🎉' : 'You are all caught up. 🎉'}</Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          renderSectionHeader={renderSectionHeader}
          ItemSeparatorComponent={Separator}
          contentContainerStyle={s.listContent}
          stickySectionHeadersEnabled={false}
          initialNumToRender={10}
          windowSize={7}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={report?.truncated ? <Text style={s.truncated}>Showing the first {report.followUps?.length} — narrow by employee to see the rest.</Text> : null}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load('refresh')} tintColor={colors.blue} />}
        />
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const __styleCache = new WeakMap();
function createStyles(colors) {
  if (colors && __styleCache.has(colors)) return __styleCache.get(colors);
  const out = buildStyles(colors);
  if (colors) __styleCache.set(colors, out);
  return out;
}
function buildStyles(colors) {
  const blue = colors.blue || '#2563EB';
  return StyleSheet.create({
    root:   { flex: 1, backgroundColor: colors.bg },

    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 52, paddingBottom: 14, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
    title:  { fontSize: 20, fontWeight: '800', color: colors.textPrimary },
    subtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
    headBtn: { padding: 8, borderRadius: 10, backgroundColor: colors.blueBg },

    tilesRow: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
    tile:     { flex: 1, minWidth: 0, paddingHorizontal: 10, paddingVertical: 10, borderRadius: 12, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'flex-start', gap: 2 },
    tileVal:  { fontSize: 20, fontWeight: '800' },
    tileLbl:  { fontSize: 11, fontWeight: '600' },

    searchWrap:  { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
    searchInput: { flex: 1, paddingVertical: 10, fontSize: 14, color: colors.textPrimary },
    filterWrap:  { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
    clearPill:   { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 20, borderWidth: 2 },
    clearTxt:    { fontSize: 12, fontWeight: '800' },

    listContent: { paddingHorizontal: 16, paddingBottom: 36 },

    sectionHead:     { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 14, paddingBottom: 8 },
    sectionDot:      { width: 8, height: 8, borderRadius: 4 },
    sectionTitle:    { fontSize: 13, fontWeight: '800', letterSpacing: 0.3 },
    sectionCount:    { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
    sectionCountTxt: { fontSize: 11, fontWeight: '800' },

    empHead:      { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 16, paddingBottom: 8 },
    empAvatar:    { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
    empAvatarTxt: { fontSize: 13, fontWeight: '800' },
    empName:      { fontSize: 15, fontWeight: '800', color: colors.textPrimary },
    empTotal:     { fontSize: 18, fontWeight: '800', color: colors.textMuted },
    chipRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 4 },
    miniChip:     { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 },
    miniChipTxt:  { fontSize: 11, fontWeight: '700' },

    card:     { backgroundColor: colors.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border, borderLeftWidth: 4, gap: 9 },
    cardTop:  { flexDirection: 'row', alignItems: 'center', gap: 10 },
    avatar:   { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
    avatarTxt:{ fontSize: 14, fontWeight: '800' },
    cardHead: { flex: 1, minWidth: 0 },
    leadName: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
    phone:    { fontSize: 11, color: colors.textMuted, marginTop: 1 },
    urgPill:  { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, maxWidth: 150 },
    urgTxt:   { fontSize: 11, fontWeight: '800' },

    dueRow:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
    dueTxt:   { fontSize: 12.5, fontWeight: '700', color: '#8B5CF6' },
    typeBadge:{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.blueBg },
    typeTxt:  { fontSize: 10.5, fontWeight: '800', color: colors.blueLight, textTransform: 'capitalize' },

    srcBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 'auto', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 },
    srcEmp:   { backgroundColor: colors.blueBg },
    srcAuto:  { backgroundColor: '#64748B18' },
    srcTxt:   { fontSize: 10.5, fontWeight: '800' },

    remarkBox:   { padding: 10, borderRadius: 10, backgroundColor: colors.surfaceAlt || colors.bg, gap: 4, borderLeftWidth: 3, borderLeftColor: colors.blue },
    remarkLabel: { fontSize: 9.5, fontWeight: '800', letterSpacing: 0.6, color: colors.textMuted },
    remarkRow:   { flexDirection: 'row', alignItems: 'flex-start', gap: 4 },
    remarkTxt:   { flex: 1, fontSize: 13.5, lineHeight: 19, fontStyle: 'italic', color: colors.textPrimary },
    remarkBy:    { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
    noteRow:     { flexDirection: 'row', alignItems: 'flex-start', gap: 5 },
    noteLine:    { flex: 1, fontSize: 12, color: colors.textSec || colors.textMuted },
    noNote:      { fontSize: 12, color: colors.textMuted, fontStyle: 'italic' },

    hint:     { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 16, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: colors.surfaceAlt || colors.bg, borderWidth: 1, borderColor: colors.border },
    hintTxt:  { flex: 1, fontSize: 12, color: colors.textMuted },
    hintLink: { fontSize: 12, fontWeight: '800', color: colors.blueLight },

    metaRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    badge:    { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
    badgeTxt: { fontSize: 11, fontWeight: '700' },
    empRow:   { flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 1 },
    empTxt:   { fontSize: 12, color: colors.textMuted, fontWeight: '600' },

    center:     { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
    emptyTitle: { fontSize: 16, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' },
    emptyTxt:   { fontSize: 13, color: colors.textMuted, textAlign: 'center' },
    retryBtn:   { marginTop: 8, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: blue },
    retryTxt:   { color: '#fff', fontWeight: '700' },
    truncated:  { textAlign: 'center', fontSize: 12, color: colors.textMuted, paddingVertical: 14 },
  });
}
