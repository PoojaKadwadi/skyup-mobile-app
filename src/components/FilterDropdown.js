// src/components/FilterDropdown.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared filter pill ("Label: Value ▾") + dropdown menu — same look as the
// Leads screen filters. Explicit per-theme colours so the text is always
// readable in light and dark mode (theme-token text colours rendered
// invisible on some Android builds).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal as RNModal } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';

export default function FilterDropdown({ label, value, options, onChange, dark, colors }) {
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

