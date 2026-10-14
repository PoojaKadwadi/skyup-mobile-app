// src/components/AdFilterModal.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Ad-level filter for "Calls by Day": a pill (<AdFilterPill/>) that opens a bottom sheet (<AdFilterModal/>)
// where you narrow leads by CAMPAIGN → AD SET → AD. Each list is searchable, scrolls, and shows how many
// leads sit under every choice. "No ad recorded" finds leads that arrived without ad details.
//
// A scrollable sheet rather than the small dropdown the other filters use, because a company can have
// dozens of ad sets and ads with long names. Logic lives in ../screens/calls/dayFilterUtils.js.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, FlatList, TextInput, ActivityIndicator,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import {
  EMPTY_AD, hasAdFilter, campaignList, adSetList, adList, chooseCampaign, chooseAdSet, chooseAd,
  adFilterLabel, adFilterTrail, filterSearch,
} from '../screens/calls/dayFilterUtils';

const TABS = [
  { key: 'campaign', label: 'Campaign', all: 'All campaigns' },
  { key: 'adset',    label: 'Ad set',   all: 'All ad sets'   },
  { key: 'ad',       label: 'Ad',       all: 'All ads'       },
];

// ── The pill (same look as FilterDropdown's) ──────────────────────────────────
export function AdFilterPill({ value, tree, onPress, dark, colors }) {
  const active = hasAdFilter(value);
  const pillBg = active ? colors.blueBg   : (dark ? '#2A2F45' : '#EEF0F7');
  const pillBd = active ? colors.blue      : (dark ? '#4C5270' : '#BFC5D6');
  const lblClr = active ? colors.blueLight : (dark ? '#B7BCD4' : '#4A5270');
  const valClr = active ? colors.blueLight : (dark ? '#FFFFFF' : '#111827');
  return (
    <TouchableOpacity
      style={[st.pill, { backgroundColor: pillBg, borderColor: pillBd }]} onPress={onPress} activeOpacity={0.75}
      accessibilityRole="button" accessibilityLabel="Filter by ad"
    >
      <Icon name="bullhorn-outline" size={13} color={lblClr} />
      <Text style={[st.pillLabel, { color: lblClr }]}>Ad: </Text>
      <Text style={[st.pillValue, { color: valClr }]} numberOfLines={1}>{adFilterLabel(value, tree)}</Text>
      <Icon name="chevron-down" size={12} color={lblClr} />
    </TouchableOpacity>
  );
}

// ── The sheet ─────────────────────────────────────────────────────────────────
export default function AdFilterModal({ visible, onClose, onApply, value, tree, loading, dayLabel, colors, dark }) {
  const [draft, setDraft] = useState(EMPTY_AD);
  const [tab,   setTab]   = useState('campaign');
  const [query, setQuery] = useState('');

  // start from what is currently applied each time the sheet opens
  useEffect(() => {
    if (visible) { setDraft(value || EMPTY_AD); setQuery(''); setTab(value && value.adsetId ? 'ad' : value && value.campaign ? 'adset' : 'campaign'); }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = useMemo(() => makeStyles(colors, dark), [colors, dark]);

  const lists = useMemo(() => ({
    campaign: campaignList(tree),
    adset:    adSetList(tree, draft.campaign),
    ad:       adList(tree, draft.campaign, draft.adsetId),
  }), [tree, draft.campaign, draft.adsetId]);

  const shown = useMemo(() => filterSearch(lists[tab], query), [lists, tab, query]);
  const selectedValue = tab === 'campaign' ? draft.campaign : tab === 'adset' ? draft.adsetId : draft.adId;
  const trail = adFilterTrail(draft, tree);
  const empty = !loading && lists.campaign.length === 0;

  const pick = (v) => {
    if (tab === 'campaign') { setDraft((d) => chooseCampaign(d, v, tree)); setTab(v ? 'adset' : 'campaign'); }
    else if (tab === 'adset') { setDraft((d) => chooseAdSet(d, v, tree)); setTab(v ? 'ad' : 'adset'); }
    else setDraft((d) => chooseAd(d, v, tree));
    setQuery('');
  };

  const rows = [{ value: '', label: TABS.find((t) => t.key === tab).all, count: null, isAll: true }, ...shown];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.wrap}>
        <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onClose} accessibilityLabel="Close ad filter" />
        <View style={s.sheet} accessibilityViewIsModal>
          <View style={s.grab} />
          <View style={s.head}>
            <View style={{ flex: 1 }}>
              <Text style={s.title}>Filter by ad</Text>
              <Text style={s.sub} numberOfLines={1}>{trail.length ? trail.join('  ›  ') : `Leads for ${dayLabel || 'this day'}`}</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Icon name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={s.tabs}>
            {TABS.map((t) => {
              const n = lists[t.key].length;
              const on = tab === t.key;
              return (
                <TouchableOpacity key={t.key} style={[s.tab, on && s.tabOn]} onPress={() => { setTab(t.key); setQuery(''); }} activeOpacity={0.8}
                  accessibilityRole="tab" accessibilityState={{ selected: on }}>
                  <Text style={[s.tabTxt, on && s.tabTxtOn]}>{t.label}</Text>
                  <Text style={[s.tabCount, on && s.tabTxtOn]}>{n}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={s.search}>
            <Icon name="magnify" size={18} color={colors.textMuted} />
            <TextInput value={query} onChangeText={setQuery} placeholder={`Search ${TABS.find((t) => t.key === tab).label.toLowerCase()}s…`}
              placeholderTextColor={colors.textMuted} style={s.searchInput} />
            {query ? <TouchableOpacity onPress={() => setQuery('')}><Icon name="close-circle" size={16} color={colors.textMuted} /></TouchableOpacity> : null}
          </View>

          {loading ? (
            <View style={s.center}><ActivityIndicator color={colors.blue} /><Text style={s.muted}>Loading ads…</Text></View>
          ) : empty ? (
            <View style={s.center}>
              <Icon name="bullhorn-outline" size={36} color={colors.textMuted} />
              <Text style={s.muted}>No campaign or ad information for this day.</Text>
            </View>
          ) : (
            <FlatList
              data={rows} keyExtractor={(r) => `${tab}:${r.value || 'all'}`} style={s.list} keyboardShouldPersistTaps="handled"
              ListEmptyComponent={<Text style={[s.muted, { padding: 20, textAlign: 'center' }]}>Nothing matches “{query}”.</Text>}
              renderItem={({ item }) => {
                const on = item.value === selectedValue;
                return (
                  <TouchableOpacity style={[s.row, on && s.rowOn]} onPress={() => pick(item.value)} activeOpacity={0.7}
                    accessibilityRole="radio" accessibilityState={{ selected: on }}>
                    <Icon name={on ? 'radiobox-marked' : 'radiobox-blank'} size={18} color={on ? colors.blueLight : colors.textMuted} />
                    <Text style={[s.rowTxt, item.isAll && s.rowAll, on && { color: colors.blueLight }]} numberOfLines={2}>{item.label}</Text>
                    {item.count != null ? <Text style={s.rowCount}>{item.count}</Text> : null}
                  </TouchableOpacity>
                );
              }}
            />
          )}

          <View style={s.foot}>
            <TouchableOpacity style={s.clearBtn} onPress={() => { setDraft(EMPTY_AD); setTab('campaign'); setQuery(''); }} activeOpacity={0.8}>
              <Text style={s.clearTxt}>Clear</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.applyBtn} onPress={() => onApply(draft)} activeOpacity={0.85}>
              <Text style={s.applyTxt}>{hasAdFilter(draft) ? 'Show these leads' : 'Show all leads'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  pill:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 9, borderRadius: 20, borderWidth: 2, gap: 2, maxWidth: 260 },
  pillLabel: { fontSize: 12, fontWeight: '500' },
  pillValue: { fontSize: 12, fontWeight: '800', flexShrink: 1 },
});

function makeStyles(colors, dark) {
  return StyleSheet.create({
    wrap:     { flex: 1, justifyContent: 'flex-end' },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(15,23,42,0.5)' },
    sheet:    { maxHeight: '86%', minHeight: '55%', backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 18 },
    grab:     { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginTop: 8 },
    head:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 10 },
    title:    { fontSize: 17, fontWeight: '800', color: colors.textPrimary },
    sub:      { fontSize: 12, color: colors.textMuted, marginTop: 2 },
    tabs:     { flexDirection: 'row', marginHorizontal: 16, padding: 3, borderRadius: 12, backgroundColor: dark ? '#13161E' : '#EEF0F7', gap: 3 },
    tab:      { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8, borderRadius: 9 },
    tabOn:    { backgroundColor: colors.blue },
    tabTxt:   { fontSize: 13, fontWeight: '700', color: colors.textMuted },
    tabCount: { fontSize: 11, fontWeight: '700', color: colors.textMuted },
    tabTxtOn: { color: '#fff' },
    search:   { flexDirection: 'row', alignItems: 'center', gap: 8, margin: 16, marginBottom: 6, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
    searchInput: { flex: 1, paddingVertical: 9, fontSize: 14, color: colors.textPrimary },
    list:     { flexGrow: 1, flexShrink: 1 },
    row:      { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: colors.border },
    rowOn:    { backgroundColor: colors.blueBg },
    rowTxt:   { flex: 1, fontSize: 14, color: colors.textPrimary, fontWeight: '500' },
    rowAll:   { fontWeight: '800' },
    rowCount: { fontSize: 12, fontWeight: '800', color: colors.textMuted, minWidth: 24, textAlign: 'right' },
    center:   { alignItems: 'center', justifyContent: 'center', padding: 36, gap: 8 },
    muted:    { fontSize: 13, color: colors.textMuted },
    foot:     { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 12 },
    clearBtn: { paddingHorizontal: 20, paddingVertical: 13, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
    clearTxt: { fontSize: 14, fontWeight: '700', color: colors.textSec || colors.textMuted },
    applyBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: 12, backgroundColor: colors.blue },
    applyTxt: { fontSize: 14, fontWeight: '800', color: '#fff' },
  });
}
