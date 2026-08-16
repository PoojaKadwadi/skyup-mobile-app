// src/screens/leads/LeadsScreen.js
// FIXES (this revision):
//   1. New Lead / Follow-up filter not clearing — route.params persisted across
//      navigation. Fixed by calling navigation.setParams({ followUpOnly: false,
//      filterStatus: null }) after applying params so re-visiting the tab never
//      re-applies a stale param.
//   2. Replaced icon buttons (filter/sort) with always-visible inline dropdowns —
//      Status, Quality, Industry, Sort all show as a horizontal scrollable row
//      of picker dropdowns directly below the search bar. No hidden panel.
//   3. Loading indicator during background sync — a slim blue bar appears at the
//      top of the list while fetchLeads/fetchLeadsDelta is in flight, even when
//      the list already has data (previously only showed on empty list).

import React, { useEffect, useCallback, useMemo, useState, memo, useRef } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  TextInput, RefreshControl, StatusBar, InteractionManager,
  ActivityIndicator, ScrollView, Modal as RNModal,
} from 'react-native';
import { useDispatch, useSelector }     from 'react-redux';
import { useNavigation, useRoute,
         useFocusEffect }               from '@react-navigation/native';
import Icon                             from 'react-native-vector-icons/MaterialCommunityIcons';
import {
  fetchLeads, fetchLeadsDelta, selectFilteredLeads,
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

const STATUS_FILTERS   = ['all', 'New', 'In Progress', 'Interested', 'Converted', 'Not Interested'];
const QUALITY_FILTERS  = ['All', 'Hot', 'Warm', 'Cold'];
const INDUSTRY_FILTERS = [
  'All', 'Healthcare', 'Education', 'Real Estate', 'Logistics', 'Finance',
  'IT Solutions', 'Digital Marketing', 'Construction', 'Local Business',
  'Interior Designers', 'Professional Services', 'Untagged',
];
const SORT_OPTIONS = [
  { label: 'Recent',      value: 'recent'    },
  { label: 'Newest',      value: 'date_desc' },
  { label: 'Oldest',      value: 'date_asc'  },
  { label: 'Name A–Z',    value: 'name_asc'  },
  { label: 'By Status',   value: 'status'    },
];
const DATE_FILTERS = [
  { label: 'All Time',   value: 'all'   },
  { label: 'Today',      value: 'today' },
  { label: 'This Week',  value: 'week'  },
  { label: 'This Month', value: 'month' },
];

// Returns start-of-day for a date
function startOf(d) { const r = new Date(d); r.setHours(0,0,0,0); return r; }
function endOf(d)   { const r = new Date(d); r.setHours(23,59,59,999); return r; }
function isInDateRange(lead, range) {
  if (range === 'all') return true;
  const ts = lead._raw_date || 0;
  if (!ts) return false;
  const now  = new Date();
  if (range === 'today') return ts >= startOf(now) && ts <= endOf(now);
  if (range === 'week') {
    const start = startOf(new Date(now));
    start.setDate(now.getDate() - now.getDay());
    return ts >= start && ts <= endOf(now);
  }
  if (range === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return ts >= start && ts <= endOf(now);
  }
  return true;
}

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
    'Interested':     { dot: colors.green, bg: colors.greenBg, text: colors.greenLight },
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

// ── Inline dropdown pill ──────────────────────────────────────────────────────
// Uses a Modal overlay for the menu so it's never clipped by the parent
// ScrollView. The pill measures its own position and renders the menu
// absolutely on top of everything.
function FilterDropdown({ label, value, options, onChange, colors }) {
  const [open,    setOpen]    = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const pillRef = useRef(null);

  const isActive = value && value !== 'all' && value !== 'All' && value !== 'date_desc';

  const openMenu = () => {
    pillRef.current?.measureInWindow((x, y, _w, h) => {
      setMenuPos({ top: y + h + 4, left: x });
      setOpen(true);
    });
  };

  return (
    <>
      <TouchableOpacity
        ref={pillRef}
        style={[
          dd.pill,
          { backgroundColor: isActive ? colors.blueBg : colors.surface,
            borderColor:      isActive ? colors.blue   : colors.border },
        ]}
        onPress={openMenu}
        activeOpacity={0.7}
      >
        <Text style={[dd.pillTxt, { color: isActive ? colors.blueLight : colors.textSec }]}>
          {label}: <Text style={{ fontWeight: '700' }}>
            {value === 'all' ? 'All' : value}
          </Text>
        </Text>
        <Icon
          name={open ? 'chevron-up' : 'chevron-down'}
          size={13}
          color={isActive ? colors.blueLight : colors.textMuted}
          style={{ marginLeft: 2 }}
        />
      </TouchableOpacity>

      <RNModal
        visible={open}
        transparent
        animationType="none"
        onRequestClose={() => setOpen(false)}
      >
        {/* Tap outside to close */}
        <TouchableOpacity
          style={dd.backdrop}
          activeOpacity={1}
          onPress={() => setOpen(false)}
        />
        <View style={[dd.menu, {
          top: menuPos.top, left: menuPos.left,
          backgroundColor: colors.surface,
          borderColor: colors.border,
        }]}>
          {options.map(opt => {
            const optVal   = typeof opt === 'object' ? opt.value : opt;
            const optLabel = typeof opt === 'object' ? opt.label : (opt === 'all' ? 'All' : opt);
            const selected = value === optVal;
            return (
              <TouchableOpacity
                key={optVal}
                style={[dd.menuItem, selected && { backgroundColor: colors.blueBg }]}
                onPress={() => { onChange(optVal); setOpen(false); }}
              >
                <Text style={[dd.menuTxt, { color: selected ? colors.blueLight : colors.textPrimary }]}>
                  {optLabel}
                </Text>
                {selected && <Icon name="check" size={13} color={colors.blueLight} />}
              </TouchableOpacity>
            );
          })}
        </View>
      </RNModal>
    </>
  );
}
const dd = StyleSheet.create({
  pill:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 20, borderWidth: 1, gap: 3 },
  pillTxt:  { fontSize: FONT.sm, fontWeight: '500' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  menu:     { position: 'absolute', minWidth: 180, borderRadius: 10, borderWidth: 1, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 10 },
  menuItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 11 },
  menuTxt:  { fontSize: FONT.sm, fontWeight: '500' },
});

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
  const s  = useMemo(() => createStyles(colors), [colors]);
  const sc = getStatusCfg(colors)[item.status] || getStatusCfg(colors)['New'];
  const initials = (item.name || '?')
    .split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();

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

const ITEM_HEIGHT = 88;
const SEPARATOR_H = 8;
const ITEM_TOTAL  = ITEM_HEIGHT + SEPARATOR_H;
const getItemLayout = (_, index) => ({ length: ITEM_TOTAL, offset: ITEM_TOTAL * index, index });

export default function LeadsScreen() {
  const dispatch   = useDispatch();
  const navigation = useNavigation();
  const route      = useRoute();
  const { dark, colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);

  const filteredLeads = useSelector(selectFilteredLeads);
  const { loading, searchQuery, filterStatus, lastFetchedAt } = useSelector((s) => s.leads);

  const [sortBy,         setSortBy]         = useState('recent');
  const [filterTemp,     setFilterTemp]     = useState('All');
  const [filterIndustry, setFilterIndustry] = useState('All');
  const [filterDate,     setFilterDate]     = useState('all');
  const [followUpOnly,   setFollowUpOnly]   = useState(false);

  const [localSearch, setLocalSearch] = useState(searchQuery);
  const debounceRef = useRef(null);

  // ── FIX 1: Stale fetch guard ──────────────────────────────────────────────
  const STALE_MS = 5 * 60 * 1000;
  useFocusEffect(
    useCallback(() => {
      const isStale = !lastFetchedAt || (Date.now() - lastFetchedAt > STALE_MS);
      if (!isStale) return;
      const task = InteractionManager.runAfterInteractions(() => {
        if (lastFetchedAt) {
          dispatch(fetchLeadsDelta(lastFetchedAt));
        } else {
          dispatch(fetchLeads());
        }
      });
      return () => task.cancel();
    }, [lastFetchedAt])
  );

  // ── FIX 2: Route params — apply then CLEAR so re-visiting the tab doesn't
  // re-apply a stale "New Lead" or "Follow-up" filter. Previously the params
  // persisted on the route object forever, so coming back to Leads always
  // re-applied the last dashboard tap even after the user had cleared it.
  useFocusEffect(
    useCallback(() => {
      if (route.params?.followUpOnly) {
        setFollowUpOnly(true);
        dispatch(setFilterStatus('all'));
        // Clear so next focus doesn't re-apply
        navigation.setParams({ followUpOnly: false, filterStatus: null });
      } else if (route.params?.filterStatus) {
        setFollowUpOnly(false);
        dispatch(setFilterStatus(route.params.filterStatus));
        navigation.setParams({ followUpOnly: false, filterStatus: null });
      }
    }, [route.params?.followUpOnly, route.params?.filterStatus])
  );

  const handleSearchChange = useCallback((text) => {
    setLocalSearch(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => dispatch(setSearchQuery(text)), 300);
  }, [dispatch]);

  const handleSearchClear = useCallback(() => {
    setLocalSearch('');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    dispatch(setSearchQuery(''));
  }, [dispatch]);

  const onRefresh = useCallback(() => { dispatch(fetchLeads()); }, [dispatch]);

  const handleLeadPress = useCallback((leadId) => {
    navigation.navigate('LeadDetail', { leadId });
  }, [navigation]);

  const handleCallStart = useCallback((leadId) => {
    navigation.navigate('LeadDetail', { leadId, postCall: true });
  }, [navigation]);

  const displayed = useMemo(() => {
    let res = [...filteredLeads];
    if (followUpOnly)          res = res.filter(isFollowUpDue);
    if (filterTemp !== 'All')  res = res.filter(l => (l.Quality || l.temperature) === filterTemp);
    if (filterIndustry !== 'All') {
      res = filterIndustry === 'Untagged'
        ? res.filter(l => !l.industry)
        : res.filter(l => l.industry === filterIndustry);
    }
    if (filterDate !== 'all')  res = res.filter(l => isInDateRange(l, filterDate));
    // Sort
    if (sortBy === 'recent') {
      // Most recently called or created — uses _raw_date which is max(createdAt, lastCalledAt)
      res = [...res].sort((a, b) => (b._raw_date || 0) - (a._raw_date || 0));
    } else if (sortBy === 'date_desc') {
      const withTs = res.map(l => ({ l, ts: +(new Date(l.date || 0)) }));
      withTs.sort((a, b) => b.ts - a.ts);
      res = withTs.map(x => x.l);
    } else if (sortBy === 'date_asc') {
      const withTs = res.map(l => ({ l, ts: +(new Date(l.date || 0)) }));
      withTs.sort((a, b) => a.ts - b.ts);
      res = withTs.map(x => x.l);
    } else if (sortBy === 'name_asc') {
      res = [...res].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (sortBy === 'status') {
      res = [...res].sort((a, b) => (a.status || '').localeCompare(b.status || ''));
    }
    return res;
  }, [filteredLeads, sortBy, filterTemp, filterIndustry, filterDate, followUpOnly]);

  const renderItem = useCallback(({ item }) => (
    <LeadRow item={item} leadId={item.id} onPress={handleLeadPress} onCallStart={handleCallStart} />
  ), [handleLeadPress, handleCallStart]);

  const keyExtractor = useCallback((item) => item.id, []);

  const clearAllFilters = useCallback(() => {
    handleSearchClear();
    dispatch(setFilterStatus('all'));
    setFilterTemp('All');
    setFilterIndustry('All');
    setFilterDate('all');
    setSortBy('recent');
    setFollowUpOnly(false);
  }, [dispatch, handleSearchClear]);

  const hasActiveFilters = !!(
    localSearch || filterStatus !== 'all' || filterTemp !== 'All' ||
    filterIndustry !== 'All' || filterDate !== 'all' || followUpOnly || sortBy !== 'recent'
  );

  return (
    <View style={s.root}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={colors.surface} />

      {/* ── Header ─────────────────────────────────────────────────────── */}
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

      {/* ── FIX 3: Sync loading bar — visible even when list has data ───── */}
      {loading && (
        <View style={s.syncBar}>
          <ActivityIndicator size="small" color={colors.blue} />
          <Text style={s.syncTxt}>Syncing leads…</Text>
        </View>
      )}

      {/* ── Follow-up banner ────────────────────────────────────────────── */}
      {followUpOnly && (
        <TouchableOpacity style={s.followUpBanner} onPress={clearAllFilters} activeOpacity={0.8}>
          <Icon name="calendar-clock" size={14} color={colors.amber} />
          <Text style={s.followUpBannerTxt}>Showing follow-ups due today or overdue</Text>
          <Icon name="close-circle" size={15} color={colors.amber} />
        </TouchableOpacity>
      )}

      {/* ── Search bar ──────────────────────────────────────────────────── */}
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
        {hasActiveFilters && (
          <TouchableOpacity style={s.clearBtn} onPress={clearAllFilters}>
            <Text style={s.clearBtnTxt}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── FIX 2: Inline filter dropdowns (always visible, no icon needed) */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.filterScroll}
        contentContainerStyle={s.filterScrollContent}
      >
        <FilterDropdown
          label="Status"
          value={filterStatus}
          options={STATUS_FILTERS}
          onChange={(v) => { dispatch(setFilterStatus(v)); setFollowUpOnly(false); }}
          colors={colors}
        />
        <FilterDropdown
          label="Date"
          value={filterDate}
          options={DATE_FILTERS}
          onChange={setFilterDate}
          colors={colors}
        />
        <FilterDropdown
          label="Quality"
          value={filterTemp}
          options={QUALITY_FILTERS}
          onChange={setFilterTemp}
          colors={colors}
        />
        <FilterDropdown
          label="Industry"
          value={filterIndustry}
          options={INDUSTRY_FILTERS}
          onChange={setFilterIndustry}
          colors={colors}
        />
        <FilterDropdown
          label="Sort"
          value={sortBy}
          options={SORT_OPTIONS}
          onChange={setSortBy}
          colors={colors}
        />
      </ScrollView>

      {/* ── Lead list ───────────────────────────────────────────────────── */}
      <FlatList
        data={displayed}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        updateCellsBatchingPeriod={50}
        windowSize={7}
        removeClippedSubviews={true}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
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
          loading ? (
            <View style={s.empty}>
              <ActivityIndicator size="large" color={colors.blue} />
              <Text style={s.emptyTitle}>Loading leads…</Text>
              <Text style={s.emptySub}>This can take a moment on first load</Text>
            </View>
          ) : (
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
                <TouchableOpacity onPress={clearAllFilters} style={s.clearBtnCenter}>
                  <Text style={s.clearBtnTxt}>Clear all filters</Text>
                </TouchableOpacity>
              )}
            </View>
          )
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

    // Header
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 20, paddingTop: 52, paddingBottom: 14,
      backgroundColor: colors.surface,
      borderBottomWidth: 1, borderBottomColor: colors.border,
    },
    headerTitle:     { fontSize: FONT.xl, fontWeight: '800', color: colors.textPrimary },
    headerCountWrap: { backgroundColor: colors.surfaceAlt, borderRadius: RADIUS.full, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start', marginTop: 2 },
    headerCount:     { fontSize: FONT.xs, color: colors.textMuted, fontWeight: '600' },
    securityNote:    { flexDirection: 'row', alignItems: 'center', gap: 4 },
    securityTxt:     { fontSize: 10, color: colors.textMuted, fontWeight: '600' },

    // FIX 3: Sync loading bar
    syncBar: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingHorizontal: 16, paddingVertical: 6,
      backgroundColor: colors.blueBg,
      borderBottomWidth: 1, borderBottomColor: colors.blue + '30',
    },
    syncTxt: { fontSize: FONT.xs, color: colors.blueLight, fontWeight: '600' },

    // Follow-up banner
    followUpBanner:    { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 10, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.amberBg, borderWidth: 1, borderColor: colors.amber + '55' },
    followUpBannerTxt: { flex: 1, fontSize: FONT.sm, fontWeight: '600', color: colors.amberLight },

    // Search row
    searchRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
    searchBox:   { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: RADIUS.md, paddingHorizontal: 14, height: 44, borderWidth: 1, borderColor: colors.border },
    searchIcon:  { marginRight: 8 },
    searchInput: { flex: 1, color: colors.textPrimary, fontSize: FONT.base },

    // Clear button (next to search)
    clearBtn:    { paddingHorizontal: 10, paddingVertical: 8 },
    clearBtnTxt: { fontSize: FONT.sm, color: colors.red, fontWeight: '700' },
    clearBtnCenter: { marginTop: 16, alignSelf: 'center' },

    // FIX 2: Filter dropdown row — no maxHeight so pills are fully visible
    filterScroll:        { borderBottomWidth: 1, borderBottomColor: colors.border },
    filterScrollContent: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 8 },

    // Lead list
    listContent: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 24 },
    leadCard:    { backgroundColor: colors.surface, borderRadius: RADIUS.lg, padding: 14, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.border, gap: 12 },
    avatar:      { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    avatarTxt:   { fontSize: 13, fontWeight: '800' },
    leadInfo:    { flex: 1, minWidth: 0 },
    leadNameRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 },
    leadName:    { fontSize: FONT.md, fontWeight: '700', color: colors.textPrimary, flexShrink: 1 },
    reassignBadge: { fontSize: FONT.xs, color: colors.purple, fontWeight: '700' },
    phoneRow:    { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
    phoneIcon:   { marginRight: 4 },
    leadPhone:   { fontSize: FONT.sm, color: colors.textMuted, fontFamily: 'monospace', letterSpacing: 1 },
    tagRow:      { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 4 },
    leadCampaign:{ fontSize: FONT.xs, color: colors.textSec, marginTop: 2 },
    remarkRow:   { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
    remarkIcon:  { marginRight: 4 },
    remark:      { fontSize: FONT.xs, color: colors.textSec, fontStyle: 'italic', flex: 1 },
    sep:         { height: 8 },
    empty:       { alignItems: 'center', paddingTop: 80 },
    emptyTitle:  { fontSize: 17, fontWeight: '700', color: colors.textSec, marginTop: 14 },
    emptySub:    { fontSize: FONT.base, color: colors.textMuted, marginTop: 5, textAlign: 'center', paddingHorizontal: 32 },
  });
}