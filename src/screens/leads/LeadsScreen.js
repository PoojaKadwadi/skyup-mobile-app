// src/screens/leads/LeadsScreen.js
// FIXES (this revision):
//   1. New Lead / Follow-up filter not clearing — route.params persisted across
//      navigation. Fixed by calling navigation.setParams({ followUpOnly: false,
//      filterStatus: null }) after applying params so re-visiting the tab never
//      re-applies a stale param.
//   2. Filter pills now wrap onto multiple lines (flexWrap) below the search
//      bar instead of sitting in a horizontal ScrollView — previously extra
//      filters (and the new Source filter) could scroll off-screen and go
//      unnoticed. Now every filter is always visible without scrolling.
//   3. Loading indicator during background sync — a slim blue bar appears at the
//      top of the list while fetchLeads/fetchLeadsDelta is in flight, even when
//      the list already has data (previously only showed on empty list).
//   4. CRASH FIX (earlier revision) — removed a half-built custom date-range
//      block that referenced undeclared state and a missing picker component.
//   5. Custom date range — real implementation this time. A lightweight
//      SimpleCalendar (plain View/Text, no new dependency) lets the user pick
//      a start then end date; 'Custom Range' is now a real DATE_FILTERS option.
//   6. Source filter — new dropdown driven by the actual `source` values
//      present in the loaded leads (csv, meta, excel, manual, etc.), computed
//      dynamically so it never goes stale as new sources get added.

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
  fetchLeads, fetchLeadsDelta, loadLeadsSmart, selectFilteredLeads,
  setSearchQuery, setFilterStatus, isFollowUpDue, getEffectiveFollowUp, getScheduledFollowUp,
} from '../../store/slices/leadsSlice';
import CallButton                    from '../../components/CallButton';
import { RADIUS, FONT }              from '../../theme/tokens';
import { useTheme }                  from '../../theme/ThemeContext';
import useCustomization from '../../hooks/useCustomization';
import { industriesList } from '../../services/customizationService';

function maskPhone(phone) {
  if (!phone) return '—';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 6) return '••••••';
  return digits.slice(0, 2) + '•••••' + digits.slice(-2);
}

const STATUS_FILTERS   = ['all', 'New', 'In Progress', 'Interested', 'Converted', 'Not Interested'];
const QUALITY_FILTERS  = ['All', 'Hot', 'Warm', 'Cold'];
// Industry filter options = company's Industries list (Customize CRM) +
// any "Other" industries actually present on leads + Untagged.
const SORT_OPTIONS = [
  { label: 'Recent',      value: 'recent'    },
  { label: 'Newest',      value: 'date_desc' },
  { label: 'Oldest',      value: 'date_asc'  },
  { label: 'Name A–Z',    value: 'name_asc'  },
  { label: 'By Status',   value: 'status'    },
];
const DATE_FILTERS = [
  { label: 'All Time',     value: 'all'    },
  { label: 'Today',        value: 'today'  },
  { label: 'This Week',    value: 'week'   },
  { label: 'This Month',   value: 'month'  },
  { label: 'Custom Range', value: 'custom' },
];

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// Returns start-of-day for a date
function startOf(d) { const r = new Date(d); r.setHours(0,0,0,0); return r; }
function endOf(d)   { const r = new Date(d); r.setHours(23,59,59,999); return r; }
function isInDateRange(lead, range, customFrom, customTo) {
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
  if (range === 'custom') {
    if (!customFrom) return true; // range not fully chosen yet — don't filter anything out
    const from = startOf(customFrom);
    const to   = customTo ? endOf(customTo) : endOf(customFrom);
    return ts >= from && ts <= to;
  }
  return true;
}

function daysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }

// ── Lightweight calendar for the custom date-range picker ──────────────────
// No external date-picker library required — just Views/Text and state.
function SimpleCalendar({ initialDate, minDate, colors, onSelect }) {
  const base = initialDate || new Date();
  const [viewYear,  setViewYear]  = useState(base.getFullYear());
  const [viewMonth, setViewMonth] = useState(base.getMonth());

  const firstDow   = new Date(viewYear, viewMonth, 1).getDay();
  const totalDays  = daysInMonth(viewYear, viewMonth);
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) cells.push(d);

  const goPrev = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };
  const goNext = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };

  const monthLabel = new Date(viewYear, viewMonth, 1)
    .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  const minStart = minDate ? startOf(minDate) : null;
  const isDisabled = (d) => {
    if (!minStart) return false;
    return new Date(viewYear, viewMonth, d) < minStart;
  };
  const isSelected = (d) => {
    if (!initialDate) return false;
    return d === initialDate.getDate() && viewMonth === initialDate.getMonth() && viewYear === initialDate.getFullYear();
  };

  return (
    <View>
      <View style={cal.header}>
        <TouchableOpacity onPress={goPrev} style={cal.navBtn}>
          <Icon name="chevron-left" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={[cal.monthLabel, { color: colors.textPrimary }]}>{monthLabel}</Text>
        <TouchableOpacity onPress={goNext} style={cal.navBtn}>
          <Icon name="chevron-right" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>
      <View style={cal.dowRow}>
        {DAY_LABELS.map((lbl, i) => (
          <View key={i} style={cal.dowCell}>
            <Text style={[cal.dowTxt, { color: colors.textMuted }]}>{lbl}</Text>
          </View>
        ))}
      </View>
      <View style={cal.grid}>
        {cells.map((d, i) => {
          if (d === null) return <View key={i} style={cal.dayCell} />;
          const disabled = isDisabled(d);
          const selected = isSelected(d);
          return (
            <TouchableOpacity
              key={i}
              disabled={disabled}
              onPress={() => onSelect(new Date(viewYear, viewMonth, d))}
              style={cal.dayCell}
              activeOpacity={0.7}
            >
              <View style={[
                cal.dayCircle,
                selected && { backgroundColor: colors.blue },
              ]}>
                <Text style={[
                  cal.dayTxt,
                  { color: disabled ? colors.border : (selected ? '#FFFFFF' : colors.textPrimary) },
                ]}>
                  {d}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}
const cal = StyleSheet.create({
  header:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  navBtn:     { padding: 8 },
  monthLabel: { fontSize: 15, fontWeight: '700' },
  dowRow:     { flexDirection: 'row', marginBottom: 4 },
  dowCell:    { width: `${100 / 7}%`, alignItems: 'center', paddingVertical: 4 },
  dowTxt:     { fontSize: 11, fontWeight: '700' },
  grid:       { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell:    { width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  dayCircle:  { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  dayTxt:     { fontSize: 13, fontWeight: '600' },
});

// FIX: this used to be a LOCAL, narrower re-implementation that only
// checked lead.followUpDate — it silently ignored the shared, comprehensive
// definition's auto-derived follow-ups (an untouched "New"/"In Progress"
// lead becomes due the day after its last contact, even with no explicit
// followUpDate set). Since the Dashboard's "Follow-ups Due" KPI count is
// computed from the SHARED isFollowUpDue (leadsSlice.js), but this screen's
// filter used this local, narrower version, tapping the Dashboard's
// Followups card opened a list MISSING every auto-derived lead the count
// had included — the exact "count shown ≠ list shown" bug a comment in
// DashboardScreen.js already describes fixing, but this local shadow
// definition meant it was never actually fully fixed. Now imported from
// leadsSlice.js directly — see the FIX comment above isFollowUpDue there
// for the shared history.

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
// FilterDropdown — pill shows "Label: Value" and opens a modal menu.
// IMPORTANT: Two separate <Text> nodes for label and value.
// Nested <Text> color inheritance is broken on Android — the inner node
// rendered transparent. Each node now has its own explicit color.
// Theme-aware: computes pill bg/border/text per dark flag so pills are
// visible in BOTH light and dark mode without relying on theme resolution.
function FilterDropdown({ label, value, options, onChange, dark, colors }) {
  const [open,    setOpen]    = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const pillRef = useRef(null);

  // Human-readable label from options list
  const displayLabel = (() => {
    if (!value || value === 'all') return 'All';
    const found = options.find(o => (typeof o === 'object' ? o.value : o) === value);
    if (!found) return String(value);
    return typeof found === 'object' ? found.label : found;
  })();

  const isActive = !!(value && value !== 'all' && value !== 'All' && value !== 'recent');

  const openMenu = () => {
    if (!pillRef.current) return;
    pillRef.current.measureInWindow((x, y, _w, h) => {
      setMenuPos({ top: y + h + 4, left: Math.max(8, x) });
      setOpen(true);
    });
  };

  // Explicit, hardcoded per-theme colors — never rely on theme resolution for
  // pill text, and never blend into the screen background. Bumped contrast
  // (lighter fill, thicker border, brighter text) so pills read clearly at a
  // glance instead of looking like empty outlines.
  const pillBg  = isActive ? colors.blueBg   : (dark ? '#2A2F45' : '#EEF0F7');
  const pillBd  = isActive ? colors.blue      : (dark ? '#4C5270' : '#BFC5D6');
  const lblClr  = isActive ? colors.blueLight : (dark ? '#B7BCD4' : '#4A5270');
  const valClr  = isActive ? colors.blueLight : (dark ? '#FFFFFF' : '#111827');
  const chvClr  = isActive ? colors.blueLight : (dark ? '#B7BCD4' : '#6B7280');

  return (
    <>
      <TouchableOpacity
        ref={pillRef}
        style={[dd.pill, { backgroundColor: pillBg, borderColor: pillBd }]}
        onPress={openMenu}
        activeOpacity={0.75}
      >
        <Text style={[dd.pillLabel, { color: lblClr }]}>{label}: </Text>
        <Text style={[dd.pillValue, { color: valClr }]}>{displayLabel}</Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} color={chvClr} style={{ marginLeft: 2 }} />
      </TouchableOpacity>

      <RNModal
        visible={open}
        transparent
        animationType="none"
        onRequestClose={() => setOpen(false)}
      >
        <TouchableOpacity style={dd.backdrop} activeOpacity={1} onPress={() => setOpen(false)} />
        <View style={[dd.menu, {
          top: menuPos.top, left: menuPos.left,
          backgroundColor: colors.surface,
          borderColor:     colors.border,
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
  pill:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 9, borderRadius: 20, borderWidth: 2, gap: 2 },
  pillLabel: { fontSize: 12, fontWeight: '500' },
  pillValue: { fontSize: 12, fontWeight: '800' },
  backdrop:  { ...StyleSheet.absoluteFillObject },
  menu:      { position: 'absolute', minWidth: 190, borderRadius: 12, borderWidth: 1, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 14 },
  menuItem:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  menuTxt:   { fontSize: 13, fontWeight: '500' },
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

// "📅 Today 1:00 PM" chip for an agent-set follow-up (red when overdue).
// Plain string formatting (no Intl/toLocale*) — cheap on Hermes for long lists.
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtFollowUp(d) {
  const now = new Date();
  const dayKey = (x) => x.getFullYear() * 10000 + x.getMonth() * 100 + x.getDate();
  const tmr = new Date(now); tmr.setDate(now.getDate() + 1);
  const h = d.getHours(), m = d.getMinutes();
  const time = `${h % 12 || 12}:${m < 10 ? '0' : ''}${m} ${h < 12 ? 'am' : 'pm'}`;
  const k = dayKey(d);
  const day = k === dayKey(now) ? 'Today' : k === dayKey(tmr) ? 'Tomorrow'
            : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return { label: `${day} ${time}`, overdue: d.getTime() < now.getTime() };
}

function FollowUpChip({ item }) {
  const { colors } = useTheme();
  // Recomputed only when this lead's follow-up data changes.
  const info = useMemo(() => {
    const d = getScheduledFollowUp(item);
    return d ? fmtFollowUp(d) : null;
  }, [item.pendingScheduledCalls, item.followUpDate]);
  if (!info) return null;
  const { label, overdue } = info;
  const clr  = overdue ? colors.red : colors.amber;
  return (
    <View style={[badge.wrap, { backgroundColor: clr + '1A', borderWidth: 1, borderColor: clr + '55' }]}>
      <Icon name="calendar-clock" size={10} color={clr} />
      <Text style={[badge.txt, { color: clr }]}>{label}</Text>
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
          <FollowUpChip item={item} />
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
            {/* 2 lines max — Facebook form leads carry very long auto remarks */}
            <Text style={s.remark} numberOfLines={2}>"{item.remark}"</Text>
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
  // Unfiltered — used when followUpOnly to bypass Redux filterStatus
  // (filterStatus='New' uses isNotContacted which hides all called leads)
  const allItems   = useSelector(s => s.leads?.items ?? []);
  const totalLeads = allItems.length;
  // PERF FIX: subscribe to individual fields instead of the whole s.leads object.
  // Previously useSelector((s) => s.leads) re-ran on EVERY leads state change
  // (upsert, delta fetch, search query) even when loading/filterStatus didn't change,
  // causing the whole LeadsScreen to re-render. Granular selectors only re-render
  // when the specific field changes.
  const loading       = useSelector(s => s.leads.loading);
  // FIX: subscribe to the error field from Redux so the list can show a real
  // error state (with retry) instead of just showing an empty list when the
  // fetch failed. Previously this field was never read here.
  const leadsError    = useSelector(s => s.leads.error);
  const searchQuery   = useSelector(s => s.leads.searchQuery);
  const filterStatus  = useSelector(s => s.leads.filterStatus);
  const filtersResetAt = useSelector(s => s.leads.filtersResetAt);
  const lastFetchedAt = useSelector(s => s.leads.lastFetchedAt);

  // Same derivation as CallLogsScreen.js's isAdmin — the backend already
  // returns every company lead (not just this user's own) for an admin
  // session (see leadController.js getMyLeads), so the header should say
  // so plainly rather than showing the employee-oriented "My Leads" label
  // to someone who is, correctly, seeing everyone's leads.
  const authUser = useSelector((s) => s.auth?.user);
  const isAdmin  = authUser?.role === 'admin' || authUser?.role === 'super_admin';

  const [sortBy,         setSortBy]         = useState('recent');
  const [filterTemp,     setFilterTemp]     = useState('All');
  const [filterIndustry, setFilterIndustry] = useState('All');
  const [filterSource,   setFilterSource]   = useState('All');
  const [filterDate,     setFilterDate]     = useState('all');
  const [followUpOnly,   setFollowUpOnly]   = useState(false);
  // Custom date-range picker state
  const [customFrom,         setCustomFrom]         = useState(null);
  const [customTo,           setCustomTo]           = useState(null);
  const [showCustomPicker,   setShowCustomPicker]   = useState(false);
  const [customPickerTarget, setCustomPickerTarget] = useState('from'); // 'from' | 'to'

  const [localSearch, setLocalSearch] = useState(searchQuery);
  const debounceRef = useRef(null);

  // BUG FIX: after searching or filtering and then clearing/closing it, the
  // list stayed scrolled wherever it happened to be (e.g. deep in a filtered
  // result), instead of returning to the top of the now-different list. This
  // ref + effect scrolls back to the top whenever the active search/filter/
  // sort criteria change, so the user always starts reading the new result
  // set from the beginning.
  const listRef = useRef(null);
  const scrollToTop = useCallback((animated = false) => {
    // Twice: once now, once after the new rows have rendered — a single call
    // fired before the re-render was being undone, leaving the list "stuck"
    // mid-way after clearing a filter.
    listRef.current?.scrollToOffset?.({ offset: 0, animated });
    requestAnimationFrame(() => listRef.current?.scrollToOffset?.({ offset: 0, animated: false }));
  }, []);

  // ── BUG FIX: new leads shouldn't pop into view while the user is reading ──
  // further down the list. `displayed` is live — a brand-new lead (pushed via
  // socket, or an existing lead whose sort key changed) lands at index 0 the
  // instant it arrives. Previously that reordered the list under the user's
  // finger mid-scroll. Now: while scrolled away from the top in the DEFAULT
  // view (no search/filter, default sort, not the follow-up view), the list
  // stays frozen at what the user is already looking at, and a small banner
  // reports how many new leads are waiting above — tapping it (or scrolling
  // back to the top yourself) reveals them. Any active search/filter/sort
  // is left exactly as before (unaffected by this).
  const isNearTopRef      = useRef(true);
  const frozenAnchorIdRef = useRef(null);
  const [frozenList,      setFrozenList]      = useState(null); // null = not frozen
  const [pendingNewCount, setPendingNewCount] = useState(0);

  // Any change of search / filter / sort = a NEW result set → always start
  // at the top and never "freeze" onto the old (filtered) list.
  const filterKey = [
    searchQuery, filterStatus, filterTemp, filterIndustry, filterSource,
    filterDate, sortBy, followUpOnly ? 1 : 0,
    customFrom ? +customFrom : '', customTo ? +customTo : '',
  ].join('|');
  const lastFilterKeyRef = useRef(filterKey);

  const isDefaultView =
    !localSearch && filterStatus === 'all' && filterTemp === 'All' &&
    filterIndustry === 'All' && filterSource === 'All' && filterDate === 'all' &&
    sortBy === 'recent' && !followUpOnly;

  const handleScroll = useCallback((e) => {
    isNearTopRef.current = e.nativeEvent.contentOffset.y < ITEM_TOTAL;
  }, []);

  const revealNewLeads = useCallback(() => {
    setFrozenList(null);
    setPendingNewCount(0);
    frozenAnchorIdRef.current = null;
    isNearTopRef.current = true;
    listRef.current?.scrollToOffset?.({ offset: 0, animated: true });
  }, []);

  // Source options built from whatever's actually in the data (csv, meta,
  // excel, manual, etc.) so this never goes stale as new sources appear.
  const cust = useCustomization();
  const industryFilters = useMemo(() => {
    const list = industriesList(cust);
    const extra = new Set();
    allItems.forEach(l => { if (l.industry && !list.includes(l.industry)) extra.add(l.industry); });
    return ['All', ...list, ...Array.from(extra).sort(), 'Untagged'];
  }, [cust, allItems]);

  const sourceOptions = useMemo(() => {
    const seen = new Set();
    let hasUntagged = false;
    allItems.forEach(l => {
      if (l.source) seen.add(l.source);
      else hasUntagged = true;
    });
    const opts = Array.from(seen).sort().map(v => ({
      value: v,
      label: v.charAt(0).toUpperCase() + v.slice(1),
    }));
    if (hasUntagged) opts.push({ value: 'Untagged', label: 'Untagged' });
    return [{ value: 'All', label: 'All' }, ...opts];
  }, [allItems]);

  // ── FIX 1: Stale fetch guard ──────────────────────────────────────────────
  const STALE_MS = 5 * 60 * 1000;
  useFocusEffect(
    useCallback(() => {
      const isStale = !lastFetchedAt || (Date.now() - lastFetchedAt > STALE_MS);
      if (!isStale) return;
      const task = InteractionManager.runAfterInteractions(() => {
        dispatch(loadLeadsSmart());
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
    listRef.current?.scrollToOffset?.({ offset: 0, animated: false });
  }, [dispatch]);

  const onRefresh = useCallback(() => { dispatch(loadLeadsSmart()); }, [dispatch]);

  const handleLeadPress = useCallback((leadId) => {
    navigation.navigate('LeadDetail', { leadId });
  }, [navigation]);

  const handleCallStart = useCallback((leadId) => {
    navigation.navigate('LeadDetail', { leadId, postCall: true });
  }, [navigation]);

  const displayed = useMemo(() => {
    let res = followUpOnly ? [...allItems] : [...filteredLeads];
    // Follow-ups list: everything due today/overdue (incl. auto next-day
    // follow-ups, same rule as the Dashboard count) PLUS agent-set follow-ups
    // on later days, so a follow-up the agent just added is always visible.
    if (followUpOnly)          res = res.filter(l => isFollowUpDue(l) || !!getScheduledFollowUp(l));
    if (filterTemp !== 'All')  res = res.filter(l => (l.Quality || l.temperature) === filterTemp);
    if (filterIndustry !== 'All') {
      res = filterIndustry === 'Untagged'
        ? res.filter(l => !l.industry)
        : res.filter(l => l.industry === filterIndustry);
    }
    if (filterDate !== 'all')  res = res.filter(l => isInDateRange(l, filterDate, customFrom, customTo));
    if (filterSource !== 'All') {
      res = filterSource === 'Untagged'
        ? res.filter(l => !l.source)
        : res.filter(l => l.source === filterSource);
    }
    // Sort
    if (followUpOnly && sortBy === 'recent') {
      // Agent-set follow-ups first, by time (overdue → today 1 PM → tomorrow…),
      // then auto-derived ones.
      // Compute each lead's sort key ONCE (not inside the comparator, which
      // would recompute it ~n·log n times).
      const keyed = res.map(l => {
        const f = getEffectiveFollowUp(l);
        return { l, g: f ? (f.auto ? 1 : 0) : 2, t: f ? f.date.getTime() : 0 };
      });
      keyed.sort((a, b) => a.g - b.g || a.t - b.t);
      res = keyed.map(x => x.l);
    } else if (sortBy === 'recent') {
      // Most recently called or created — uses _raw_date which is max(createdAt, lastCalledAt)
      res.sort((a, b) => (b._raw_date || 0) - (a._raw_date || 0));
    } else if (sortBy === 'date_desc') {
      const withTs = res.map(l => ({ l, ts: +(new Date(l.date || 0)) }));
      withTs.sort((a, b) => b.ts - a.ts);
      res = withTs.map(x => x.l);
    } else if (sortBy === 'date_asc') {
      const withTs = res.map(l => ({ l, ts: +(new Date(l.date || 0)) }));
      withTs.sort((a, b) => a.ts - b.ts);
      res = withTs.map(x => x.l);
    } else if (sortBy === 'name_asc') {
      res.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (sortBy === 'status') {
      res.sort((a, b) => (a.status || '').localeCompare(b.status || ''));
    }
    return res;
  }, [filteredLeads, allItems, sortBy, filterTemp, filterIndustry, filterSource, filterDate, customFrom, customTo, followUpOnly]);

  const prevDisplayedRef = useRef(displayed);
  useEffect(() => {
    const prevList = prevDisplayedRef.current;

    if (lastFilterKeyRef.current !== filterKey) {
      // Filters changed (incl. "Clear") → live list, back to the beginning.
      lastFilterKeyRef.current = filterKey;
      if (frozenList) setFrozenList(null);
      if (pendingNewCount) setPendingNewCount(0);
      frozenAnchorIdRef.current = null;
      isNearTopRef.current = true;
      prevDisplayedRef.current = displayed;
      scrollToTop(false);
      return;
    }

    if (!isDefaultView || isNearTopRef.current) {
      // Live mode: either not in the scenario this applies to, or the user
      // is already at (or near) the top, so a reorder there is expected.
      if (frozenList) setFrozenList(null);
      if (pendingNewCount) setPendingNewCount(0);
      frozenAnchorIdRef.current = null;
      prevDisplayedRef.current = displayed;
      return;
    }

    if (!frozenList) {
      // First divergence detected while scrolled down — freeze at what the
      // user was ALREADY looking at (the list as of the previous render),
      // not the incoming one that already contains the new item.
      setFrozenList(prevList);
      const anchorId = prevList[0]?.id ?? null;
      frozenAnchorIdRef.current = anchorId;
      const idx = anchorId ? displayed.findIndex(l => l.id === anchorId) : -1;
      setPendingNewCount(idx === -1 ? 1 : idx);
      prevDisplayedRef.current = displayed;
      return;
    }

    // Already frozen — count how many items now sit ahead of the frozen
    // anchor in the live data. That's the "N new leads" badge.
    const idx = frozenAnchorIdRef.current
      ? displayed.findIndex(l => l.id === frozenAnchorIdRef.current)
      : -1;
    setPendingNewCount(idx === -1 ? pendingNewCount : idx);
    prevDisplayedRef.current = displayed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayed, isDefaultView, filterKey]);

  const visibleList = frozenList || displayed;

  const renderItem = useCallback(({ item }) => (
    <LeadRow item={item} leadId={item.id} onPress={handleLeadPress} onCallStart={handleCallStart} />
  ), [handleLeadPress, handleCallStart]);

  const keyExtractor = useCallback((item) => item.id, []);

  // Search/filters are cleared when the app is closed and reopened (see
  // App.js → resetLeadFilters). Redux search/status are reset there; this
  // clears the screen's own local filters too. Skips the initial mount.
  const lastResetSeenRef = useRef(filtersResetAt);

  const clearAllFilters = useCallback(() => {
    handleSearchClear();
    dispatch(setFilterStatus('all'));
    setFilterTemp('All');
    setFilterIndustry('All');
    setFilterSource('All');
    setFilterDate('all');
    setCustomFrom(null);
    setCustomTo(null);
    setSortBy('recent');
    setFollowUpOnly(false);
    setFrozenList(null);
    setPendingNewCount(0);
    frozenAnchorIdRef.current = null;
    isNearTopRef.current = true;
    scrollToTop(false);
  }, [dispatch, handleSearchClear, scrollToTop]);

  useEffect(() => {
    if (filtersResetAt === lastResetSeenRef.current) return;
    lastResetSeenRef.current = filtersResetAt;
    clearAllFilters();
  }, [filtersResetAt, clearAllFilters]);

  const hasActiveFilters = !!(
    localSearch || filterStatus !== 'all' || filterTemp !== 'All' ||
    filterIndustry !== 'All' || filterSource !== 'All' || filterDate !== 'all' ||
    followUpOnly || sortBy !== 'recent'
  );

  // Label shown on the Date pill when a custom range is active
  const customDateLabel = customFrom
    ? customFrom.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
      + (customTo ? ' – ' + customTo.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : ' – …')
    : 'Custom Range';

  return (
    <View style={s.root}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={colors.surface} />

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>{isAdmin ? 'All Leads' : 'My Leads'}</Text>
          <View style={s.headerCountWrap}>
            <Text style={s.headerCount}>{displayed.length} leads</Text>
          </View>
        </View>
        <View style={s.securityNote}>
          <Icon name="phone-lock" size={12} color={colors.textMuted} />
          <Text style={s.securityTxt}>Numbers masked</Text>
        </View>
      </View>

      {/* ── Custom date-range picker ──────────────────────────────────── */}
      {showCustomPicker && (
        <RNModal visible transparent animationType="slide" onRequestClose={() => setShowCustomPicker(false)}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
            <View style={{
              backgroundColor: colors.surface,
              borderTopLeftRadius: 20, borderTopRightRadius: 20,
              padding: 16, paddingBottom: 32,
            }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 }}>
                {customPickerTarget === 'from' ? 'Select Start Date' : 'Select End Date'}
              </Text>
              {customPickerTarget === 'to' && customFrom && (
                <Text style={{ fontSize: 13, color: colors.textSec, marginBottom: 8 }}>
                  From: {customFrom.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                </Text>
              )}
              <SimpleCalendar
                initialDate={customPickerTarget === 'to' ? customTo : customFrom}
                minDate={customPickerTarget === 'to' ? customFrom : undefined}
                colors={colors}
                onSelect={(picked) => {
                  if (customPickerTarget === 'from') {
                    setCustomFrom(picked);
                    setCustomTo(null);
                    setCustomPickerTarget('to');
                  } else {
                    const finalTo = customFrom && picked < customFrom ? customFrom : picked;
                    setCustomTo(finalTo);
                    setShowCustomPicker(false);
                    setFilterDate('custom');
                  }
                }}
              />
              <TouchableOpacity
                style={{ marginTop: 8, alignSelf: 'center', padding: 10 }}
                onPress={() => {
                  if (customPickerTarget === 'to') {
                    setCustomPickerTarget('from');
                  } else {
                    setShowCustomPicker(false);
                    if (filterDate !== 'custom') setFilterDate('all');
                  }
                }}
              >
                <Text style={{ color: colors.red, fontWeight: '600', fontSize: 14 }}>
                  {customPickerTarget === 'to' ? 'Back' : 'Cancel'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </RNModal>
      )}

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
          <Text style={s.followUpBannerTxt}>Follow-ups: overdue & today first, then upcoming</Text>
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

      {/* ── FIX 2: Inline filter dropdowns — wrapping row so every filter is
          always visible on screen, nothing hidden behind a horizontal scroll */}
      <View style={s.filterWrap}>
        <FilterDropdown
          label="Status"
          value={filterStatus}
          options={STATUS_FILTERS}
          onChange={(v) => { dispatch(setFilterStatus(v)); setFollowUpOnly(false); }}
          dark={dark} colors={colors}
        />
        <FilterDropdown
          label="Date"
          value={filterDate === 'custom' ? customDateLabel : filterDate}
          options={DATE_FILTERS}
          onChange={(v) => {
            if (v === 'custom') {
              setCustomPickerTarget('from');
              setShowCustomPicker(true);
            } else {
              setFilterDate(v);
              setCustomFrom(null);
              setCustomTo(null);
            }
          }}
          dark={dark} colors={colors}
        />
        <FilterDropdown
          label="Quality"
          value={filterTemp}
          options={QUALITY_FILTERS}
          onChange={setFilterTemp}
          dark={dark} colors={colors}
        />
        <FilterDropdown
          label="Industry"
          value={filterIndustry}
          options={industryFilters}
          onChange={setFilterIndustry}
          dark={dark} colors={colors}
        />
        <FilterDropdown
          label="Source"
          value={filterSource}
          options={sourceOptions}
          onChange={setFilterSource}
          dark={dark} colors={colors}
        />
        <FilterDropdown
          label="Sort"
          value={sortBy}
          options={SORT_OPTIONS}
          onChange={setSortBy}
          dark={dark} colors={colors}
        />
      </View>

      {/* ── New-leads banner (only while frozen — see the effect above) ──── */}
      {pendingNewCount > 0 && (
        <TouchableOpacity style={s.newLeadsBanner} onPress={revealNewLeads} activeOpacity={0.85}>
          <Icon name="arrow-up-circle" size={14} color={colors.blue} />
          <Text style={s.newLeadsBannerTxt}>
            {pendingNewCount} new lead{pendingNewCount > 1 ? 's' : ''} — tap to view
          </Text>
        </TouchableOpacity>
      )}

      {/* ── Lead list ───────────────────────────────────────────────────── */}
      <FlatList
        ref={listRef}
        data={visibleList}
        onScroll={handleScroll}
        scrollEventThrottle={100}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        // getItemLayout removed: it assumed every card is 88px, but cards are
        // taller and vary (campaign / remark / follow-up lines), which made
        // FlatList skip and mis-position rows while scrolling.
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        updateCellsBatchingPeriod={50}
        windowSize={7}
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
          loading ? (
            <View style={s.empty}>
              <ActivityIndicator size="large" color={colors.blue} />
              <Text style={s.emptyTitle}>Loading leads…</Text>
              <Text style={s.emptySub}>This can take a moment on first load</Text>
            </View>
          ) : leadsError && totalLeads === 0 ? (
            // FIX: show a real error state with retry when the fetch failed
            // and there are no cached leads to display. Previously this fell
            // through to the generic "No leads yet" empty state which gave
            // the user no indication that something went wrong or how to fix it.
            <View style={s.empty}>
              <Icon name="wifi-off" size={52} color={colors.border} />
              <Text style={s.emptyTitle}>Could not load leads</Text>
              <Text style={s.emptySub}>{leadsError}</Text>
              <TouchableOpacity onPress={onRefresh} style={s.clearBtnCenter}>
                <Text style={s.clearBtnTxt}>Tap to retry</Text>
              </TouchableOpacity>
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
    newLeadsBanner:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginHorizontal: 16, marginTop: 10, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.blueBg, borderWidth: 1, borderColor: colors.blue + '55' },
    newLeadsBannerTxt: { fontSize: FONT.sm, fontWeight: '700', color: colors.blueLight },

    // Search row
    searchRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
    searchBox:   { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: RADIUS.md, paddingHorizontal: 14, height: 44, borderWidth: 1, borderColor: colors.border },
    searchIcon:  { marginRight: 8 },
    searchInput: { flex: 1, color: colors.textPrimary, fontSize: FONT.base },

    // Clear button (next to search)
    clearBtn:    { paddingHorizontal: 10, paddingVertical: 8 },
    clearBtnTxt: { fontSize: FONT.sm, color: colors.red, fontWeight: '700' },
    clearBtnCenter: { marginTop: 16, alignSelf: 'center' },

    // FIX 2: Filter dropdown row — wraps onto multiple lines so nothing is
    // ever hidden off-screen; no fixed height, grows with content.
    filterWrap: {
      flexDirection: 'row', flexWrap: 'wrap',
      paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12, gap: 8,
      backgroundColor: colors.bg,
      borderBottomWidth: 1, borderBottomColor: colors.border,
    },

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