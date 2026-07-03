// src/screens/leads/LeadsScreen.js
// PERFORMANCE FIXES (this revision):
//   1. useFocusEffect with 2-min stale threshold replaces bare useEffect.
//      The old code had NO fetch guard — every mount of this tab triggered
//      a full network request. Now only re-fetches when data is >2 min old.
//      Manual pull-to-refresh always forces a fresh fetch regardless.
//
//   2. InteractionManager wraps fetchLeads — the network call waits until
//      the native slide-in animation completes. Prevents animation jank on
//      first visit to this tab.
//
//   3. Stable renderItem — the old inline arrow functions
//      `onPress={() => navigate(...)}` and `onCallStart={() => handle(item)}`
//      created a NEW function object on every renderItem call, defeating
//      LeadRow's React.memo entirely. Every leads-array change re-rendered
//      every visible row even when individual items hadn't changed.
//      Fix: LeadRow now receives stable `onPress` and `onCallStart` via
//      useCallback + item.id so memo can actually bail out.
//
//   4. Debounced search (300ms) retained from prior revision.
//
// All previous fixes (React.memo, getItemLayout, windowSize, etc.) retained.

import React, { useEffect, useCallback, useMemo, useState, memo, useRef } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  TextInput, RefreshControl, StatusBar, InteractionManager,
} from 'react-native';
import { useDispatch, useSelector }     from 'react-redux';
import { useNavigation, useRoute,
         useFocusEffect }               from '@react-navigation/native';
import Icon                             from 'react-native-vector-icons/MaterialCommunityIcons';
import {
  fetchLeads, selectFilteredLeads,
  setSearchQuery, setFilterStatus,
} from '../../store/slices/leadsSlice';
import CallButton                    from '../../components/CallButton';
import { RADIUS, FONT }              from '../../theme/tokens';
import { useTheme }                  from '../../theme/ThemeContext';

function maskPhone(phone) {
  if (!phone) return '—';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 6) return '••••••';
  return digits.slice(0, 2) + '•••••' + digits.slice(-2);
}

const STATUS_FILTERS = ['all', 'New', 'In Progress', 'Converted', 'Not Interested'];

// Returns true when a lead has a follow-up scheduled for today or earlier
// (due today or overdue). Mirrors the same predicate in DashboardScreen so the
// "Followups" card count and this filtered list always agree.
function isFollowUpDue(lead) {
  if (!lead?.followUpDate) return false;
  const d = new Date(lead.followUpDate);
  if (isNaN(d.getTime())) return false;
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  return d.getTime() <= endOfToday.getTime();
}

function getStatusCfg(colors) {
  return {
    'New':            { dot: colors.blue,  bg: colors.blueBg,  text: colors.blueLight  },
    'In Progress':    { dot: colors.amber, bg: colors.amberBg, text: colors.amberLight },
    'Converted':      { dot: colors.green, bg: colors.greenBg, text: colors.greenLight },
    'Not Interested': { dot: colors.red,   bg: colors.redBg,   text: colors.redLight   },
  };
}

function getQualityCfg(colors) {
  return {
    Hot:  { color: colors.red,   bg: colors.redBg,   text: colors.redLight,   emoji: '🔥' },
    Warm: { color: colors.amber, bg: colors.amberBg, text: colors.amberLight, emoji: '🌤️' },
    Cold: { color: colors.blue,  bg: colors.blueBg,  text: colors.blueLight,  emoji: '❄️' },
  };
}

const SORT_OPTIONS = [
  { label: 'Newest first', value: 'date_desc' },
  { label: 'Oldest first', value: 'date_asc'  },
  { label: 'Name A–Z',     value: 'name_asc'  },
  { label: 'By Status',    value: 'status'    },
];

function StatusBadge({ status }) {
  const { colors } = useTheme();
  const c = getStatusCfg(colors)[status] || getStatusCfg(colors)['New'];
  return (
    <View style={[badge.wrap, { backgroundColor: c.bg }]}>
      <View style={[badge.dot, { backgroundColor: c.dot }]} />
      <Text style={[badge.txt, { color: c.text }]}>{status}</Text>
    </View>
  );
}
const badge = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, gap: 4 },
  dot:  { width: 6, height: 6, borderRadius: 3 },
  txt:  { fontSize: FONT.xs, fontWeight: '700' },
});

function TempBadge({ temp }) {
  const { colors } = useTheme();
  const c = getQualityCfg(colors)[temp];
  if (!c) return null;
  return (
    <View style={[badge.wrap, { backgroundColor: c.bg, borderWidth: 1, borderColor: c.color + '40' }]}>
      <Text style={[badge.txt, { color: c.text }]}>{c.emoji} {temp}</Text>
    </View>
  );
}

const LeadRow = memo(function LeadRow({ item, leadId, onPress, onCallStart }) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const sc = getStatusCfg(colors)[item.status] || getStatusCfg(colors)['New'];
  const initials = (item.name || '?')
    .split(' ')
    .map(n => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  // Stable per-item callbacks — useCallback keyed on leadId (primitive string)
  // so they're only recreated when the leadId changes, not on every parent render.
  const handlePress     = useCallback(() => onPress(leadId),     [onPress, leadId]);
  const handleCallStart = useCallback(() => onCallStart(leadId), [onCallStart, leadId]);

  return (
    <TouchableOpacity style={s.leadCard} onPress={handlePress} activeOpacity={0.75}>
      <View style={[s.avatar, { backgroundColor: sc.dot + '20' }]}>
        <Text style={[s.avatarTxt, { color: sc.dot }]}>{initials}</Text>
      </View>
      <View style={s.leadInfo}>
        <View style={s.leadNameRow}>
          <Text style={s.leadName} numberOfLines={1}>{item.name}</Text>
          {item.reassignCount > 0 && (
            <Text style={s.reassignBadge}>🔄{item.reassignCount}</Text>
          )}
        </View>
        <View style={s.phoneRow}>
          <Icon name="phone-lock" size={11} color={colors.textMuted} style={s.phoneIcon} />
          <Text style={s.leadPhone}>{maskPhone(item.mobile)}</Text>
        </View>
        <View style={s.tagRow}>
          <StatusBadge status={item.status} />
          <TempBadge temp={item.Quality || item.temperature} />
        </View>
        {item.campaign && item.campaign !== '—' && (
          <Text style={s.leadCampaign} numberOfLines={1}>{item.campaign}</Text>
        )}
        {item.remark ? (
          <View style={s.remarkRow}>
            <Icon
              name={item.remarkIsManual ? 'pencil' : 'bullhorn-variant-outline'}
              size={11}
              color={item.remarkIsManual ? colors.purpleLight : colors.textMuted}
              style={s.remarkIcon}
            />
            <Text style={s.remark}>"{item.remark}"</Text>
          </View>
        ) : null}
      </View>
      <CallButton phoneNumber={item.mobile} onCallStart={handleCallStart} />
    </TouchableOpacity>
  );
});

const ITEM_HEIGHT   = 88;
const SEPARATOR_H   = 8;
const ITEM_TOTAL    = ITEM_HEIGHT + SEPARATOR_H;
const getItemLayout = (_, index) => ({
  length: ITEM_TOTAL,
  offset: ITEM_TOTAL * index,
  index,
});

export default function LeadsScreen() {
  const dispatch      = useDispatch();
  const navigation    = useNavigation();
  const route         = useRoute();
  const { dark, colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const filteredLeads = useSelector(selectFilteredLeads);
  const { loading, searchQuery, filterStatus, lastFetchedAt } = useSelector((s) => s.leads);

  const [showFilters, setShowFilters] = useState(false);
  const [showSort,    setShowSort]    = useState(false);
  const [sortBy,      setSortBy]      = useState('date_desc');
  const [filterTemp,  setFilterTemp]  = useState('All');
  // Set from the dashboard "Followups" card. When true, the list is narrowed to
  // leads whose follow-up is due today or overdue (see isFollowUpDue).
  const [followUpOnly, setFollowUpOnly] = useState(false);

  // FIX: Local search value keeps TextInput snappy.
  // Dispatch to Redux is debounced 300ms to avoid filter churn on every keystroke.
  const [localSearch, setLocalSearch] = useState(searchQuery);
  const debounceRef = useRef(null);

  // ✅ FIX 1: useFocusEffect + 2-min stale threshold.
  // The old bare useEffect had no deps array so it ran on every re-render,
  // firing a full network fetch on every tab switch. Now: only re-fetches
  // when data is genuinely stale. InteractionManager defers the network
  // call until the slide-in animation is done — prevents frame drops.
  const STALE_MS = 2 * 60 * 1000;
  useFocusEffect(
    useCallback(() => {
      const isStale = !lastFetchedAt || (Date.now() - lastFetchedAt > STALE_MS);
      if (!isStale) return;
      const task = InteractionManager.runAfterInteractions(() => {
        dispatch(fetchLeads());
      });
      return () => task.cancel();
    }, [lastFetchedAt])
  );

  const handleSearchChange = useCallback((text) => {
    setLocalSearch(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      dispatch(setSearchQuery(text));
    }, 300);
  }, [dispatch]);

  const handleSearchClear = useCallback(() => {
    setLocalSearch('');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    dispatch(setSearchQuery(''));
  }, [dispatch]);

  useEffect(() => {
    // Deep-links from the dashboard cards:
    //   New Leads  → { filterStatus: 'New' }
    //   Followups  → { followUpOnly: true }
    // The two are mutually exclusive; setting one clears the other so the list
    // never shows a stale combination.
    if (route.params?.followUpOnly) {
      setFollowUpOnly(true);
      dispatch(setFilterStatus('all'));
    } else if (route.params?.filterStatus) {
      setFollowUpOnly(false);
      dispatch(setFilterStatus(route.params.filterStatus));
    }
  }, [route.params]);

  const onRefresh = useCallback(() => { dispatch(fetchLeads()); }, [dispatch]);

  // ✅ FIX 2: Stable callbacks — LeadRow now receives primitive `leadId` and
  // two stable handler refs. The old inline arrows in renderItem created new
  // functions on every call, so LeadRow's React.memo always saw new props and
  // always re-rendered every visible row even when items hadn't changed.
  const handleLeadPress = useCallback((leadId) => {
    navigation.navigate('LeadDetail', { leadId });
  }, [navigation]);

  const handleCallStart = useCallback((leadId) => {
    // FIX: the old code waited a hard-coded 2 seconds before navigating, which
    // left a spinner stuck on the card and could land on a lead the store had
    // already dropped ("Lead not found"). Navigate immediately; LeadDetail now
    // fetches the lead by id if it isn't cached, and the post-call recording
    // sync runs in the background regardless.
    navigation.navigate('LeadDetail', { leadId, postCall: true });
  }, [navigation]);

  const displayed = React.useMemo(() => {
    let res = [...filteredLeads];
    if (followUpOnly) {
      res = res.filter(isFollowUpDue);
    }
    if (filterTemp !== 'All') {
      res = res.filter(l => (l.Quality || l.temperature) === filterTemp);
    }
    // FIX: pre-compute sort keys before sorting so `new Date()` is called
    // once per item instead of O(n log n) times inside the comparator.
    // With 500 leads, the old approach called new Date() ~4,500 times per sort.
    if (sortBy === 'date_desc' || sortBy === 'date_asc') {
      const withTs = res.map(l => ({ l, ts: +(l._raw_date || 0) }));
      withTs.sort((a, b) => sortBy === 'date_desc' ? b.ts - a.ts : a.ts - b.ts);
      res = withTs.map(x => x.l);
    } else if (sortBy === 'name_asc') {
      res.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (sortBy === 'status') {
      res.sort((a, b) => (a.status || '').localeCompare(b.status || ''));
    }
    return res;
  }, [filteredLeads, sortBy, filterTemp, followUpOnly]);

  // Stable renderItem — receives only stable refs; no new closures per call.
  const renderItem = useCallback(({ item }) => (
    <LeadRow
      item={item}
      leadId={item.id}
      onPress={handleLeadPress}
      onCallStart={handleCallStart}
    />
  ), [handleLeadPress, handleCallStart]);

  const keyExtractor = useCallback((item) => item.id, []);

  const clearAllFilters = useCallback(() => {
    handleSearchClear();
    dispatch(setFilterStatus('all'));
    setFilterTemp('All');
    setSortBy('date_desc');
    setFollowUpOnly(false);
  }, [dispatch, handleSearchClear]);

  const hasActiveFilters = localSearch || filterStatus !== 'all' || filterTemp !== 'All' || followUpOnly;

  return (
    <View style={s.root}>
      <StatusBar barStyle={dark ? "light-content" : "dark-content"} backgroundColor={colors.surface} />

      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>My Leads</Text>
          <View style={s.headerCountWrap}>
            <Text style={s.headerCount}>{displayed.length} leads</Text>
          </View>
        </View>
        <View style={s.securityNote}>
          <Icon name="phone-lock" size={12} color={colors.textMuted} />
          <Text style={s.securityTxt}>Numbers masked</Text>
        </View>
      </View>

      {followUpOnly && (
        <TouchableOpacity style={s.followUpBanner} onPress={clearAllFilters} activeOpacity={0.8}>
          <Icon name="calendar-clock" size={14} color={colors.amber} />
          <Text style={s.followUpBannerTxt}>Showing follow-ups due today or overdue</Text>
          <Icon name="close-circle" size={15} color={colors.amber} />
        </TouchableOpacity>
      )}

      <View style={s.searchRow}>
        <View style={s.searchBox}>
          <Icon name="magnify" size={16} color={colors.textMuted} style={s.searchIcon} />
          <TextInput
            style={s.searchInput}
            placeholder="Search name, campaign…"
            placeholderTextColor={colors.textMuted}
            value={localSearch}
            onChangeText={handleSearchChange}
          />
          {localSearch ? (
            <TouchableOpacity onPress={handleSearchClear}>
              <Icon name="close-circle" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity
          style={[s.iconBtn, showFilters && s.iconBtnActive]}
          onPress={() => setShowFilters(!showFilters)}
        >
          <Icon name="filter-variant" size={20} color={showFilters ? colors.blue : colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.iconBtn, showSort && s.iconBtnActive]}
          onPress={() => setShowSort(!showSort)}
        >
          <Icon name="sort" size={20} color={showSort ? colors.blue : colors.textMuted} />
        </TouchableOpacity>
      </View>

      {showFilters && (
        <View style={s.filterArea}>
          <Text style={s.filterGroupLabel}>STATUS</Text>
          <View style={s.filterRow}>
            {STATUS_FILTERS.map(f => (
              <TouchableOpacity
                key={f}
                style={[s.chip, filterStatus === f && s.chipActive]}
                onPress={() => dispatch(setFilterStatus(f))}
              >
                <Text style={[s.chipTxt, filterStatus === f && s.chipTxtActive]}>
                  {f === 'all' ? 'All' : f}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={[s.filterGroupLabel, s.filterGroupLabelTop]}>LEAD QUALITY</Text>
          <View style={s.filterRow}>
            {['All', 'Hot', 'Warm', 'Cold'].map(q => (
              <TouchableOpacity
                key={q}
                style={[s.chip, filterTemp === q && s.chipActive]}
                onPress={() => setFilterTemp(q)}
              >
                <Text style={[s.chipTxt, filterTemp === q && s.chipTxtActive]}>{q}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {hasActiveFilters && (
            <TouchableOpacity onPress={clearAllFilters} style={s.clearBtn}>
              <Text style={s.clearBtnTxt}>✕ Clear all filters</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {showSort && (
        <View style={s.filterArea}>
          <Text style={s.filterGroupLabel}>SORT BY</Text>
          <View style={s.filterRow}>
            {SORT_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.value}
                style={[s.chip, sortBy === opt.value && s.chipActive]}
                onPress={() => { setSortBy(opt.value); setShowSort(false); }}
              >
                <Text style={[s.chipTxt, sortBy === opt.value && s.chipTxtActive]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      <FlatList
        data={displayed}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={true}
        refreshControl={
          <RefreshControl
            refreshing={loading} onRefresh={onRefresh}
            tintColor={colors.blue} colors={[colors.blue]}
          />
        }
        contentContainerStyle={s.listContent}
        ItemSeparatorComponent={Separator}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={s.empty}>
            <Icon name="account-search-outline" size={52} color={colors.border} />
            <Text style={s.emptyTitle}>
              {localSearch ? 'No results' : 'No leads yet'}
            </Text>
            <Text style={s.emptySub}>
              {localSearch
                ? `No match for "${localSearch}"`
                : 'Your assigned leads appear here'}
            </Text>
            {hasActiveFilters && (
              <TouchableOpacity onPress={clearAllFilters} style={[s.clearBtn, s.clearBtnMt]}>
                <Text style={s.clearBtnTxt}>Clear filters</Text>
              </TouchableOpacity>
            )}
          </View>
        }
      />
    </View>
  );
}

function Separator() {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  return <View style={s.sep} />;
}

function createStyles(colors) {
return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: 52, paddingBottom: 14,
    backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  headerTitle:    { fontSize: FONT.xl, fontWeight: '800', color: colors.textPrimary },
  headerCountWrap: {
    backgroundColor: colors.surfaceAlt, borderRadius: RADIUS.full,
    paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start', marginTop: 2,
  },
  headerCount:  { fontSize: FONT.xs, color: colors.textMuted, fontWeight: '600' },
  securityNote: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  securityTxt:  { fontSize: 10, color: colors.textMuted, fontWeight: '600' },
  searchRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  followUpBanner:    { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 10, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.amberBg, borderWidth: 1, borderColor: colors.amber + '55' },
  followUpBannerTxt: { flex: 1, fontSize: FONT.sm, fontWeight: '600', color: colors.amberLight },
  searchBox:   {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: RADIUS.md,
    paddingHorizontal: 14, height: 44, borderWidth: 1, borderColor: colors.border,
  },
  searchIcon:  { marginRight: 8 },
  searchInput: { flex: 1, color: colors.textPrimary, fontSize: FONT.base },
  iconBtn:     {
    width: 44, height: 44, backgroundColor: colors.surface, borderRadius: RADIUS.md,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border,
  },
  iconBtnActive: { borderColor: colors.blue, backgroundColor: colors.blueBg },
  filterArea:       { paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  filterGroupLabel: { fontSize: FONT.xs, fontWeight: '700', color: colors.textMuted, letterSpacing: 1, marginBottom: 6 },
  filterGroupLabelTop: { marginTop: 10 },
  filterRow:        { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip:             { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.surface, borderRadius: RADIUS.full, borderWidth: 1, borderColor: colors.border },
  chipActive:    { backgroundColor: colors.blueBg, borderColor: colors.blue },
  chipTxt:       { color: colors.textSec, fontSize: FONT.sm, fontWeight: '600' },
  chipTxtActive: { color: colors.blueLight },
  clearBtn:      { marginTop: 8, alignSelf: 'flex-start' },
  clearBtnMt:    { marginTop: 16 },
  clearBtnTxt:   { fontSize: FONT.sm, color: colors.red, fontWeight: '600' },
  listContent: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 24 },
  leadCard: {
    backgroundColor: colors.surface, borderRadius: RADIUS.lg, padding: 14,
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: colors.border, gap: 12,
  },
  avatar:       { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  avatarTxt:    { fontSize: 13, fontWeight: '800' },
  leadInfo:     { flex: 1, minWidth: 0 },
  leadNameRow:  { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 },
  leadName:     { fontSize: FONT.md, fontWeight: '700', color: colors.textPrimary, flexShrink: 1 },
  reassignBadge:{ fontSize: FONT.xs, color: colors.purple, fontWeight: '700' },
  phoneRow:     { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  phoneIcon:    { marginRight: 4 },
  leadPhone:    { fontSize: FONT.sm, color: colors.textMuted, fontFamily: 'monospace', letterSpacing: 1 },
  tagRow:       { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 4 },
  leadCampaign: { fontSize: FONT.xs, color: colors.textSec, marginTop: 2 },
  remarkRow:    { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  remarkIcon:   { marginRight: 4 },
  remark:       { fontSize: FONT.xs, color: colors.textSec, fontStyle: 'italic', flex: 1 },
  sep:          { height: 8 },
  empty:      { alignItems: 'center', paddingTop: 80 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: colors.textSec, marginTop: 14 },
  emptySub:   { fontSize: FONT.base, color: colors.textMuted, marginTop: 5, textAlign: 'center', paddingHorizontal: 32 },
});
}