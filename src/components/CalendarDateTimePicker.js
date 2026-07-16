// src/components/CalendarDateTimePicker.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure-JS calendar + 12-hour (AM/PM) time picker for follow-up / meeting dates.
//
// WHY PURE JS:
//   @react-native-community/datetimepicker's native module is not compiled into
//   the app bundle, so DateTimePickerAndroid.open() crashes. This component uses
//   only built-in RN views — no native dependency — so it can't crash that way.
//
// UI:
//   • Month grid (Su–Sa) like the web CRM calendar, with ‹ ›/up-down month nav,
//     "Clear" and "Today" shortcuts, the selected day highlighted.
//   • Time row: hour buttons 1–12, minute stepper, and an AM/PM toggle.
//
// PROPS:
//   value      ISO string | null   — current selection (seeds the picker)
//   onConfirm  (isoString) => void — called with the chosen date/time
//   onCancel   () => void
//   minDate    Date (optional)     — days before this are disabled (default: today)
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useTheme } from '../theme/ThemeContext';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

// Build the 6×7 grid of day-cells for a given month view.
function buildMonthMatrix(viewYear, viewMonth) {
  const firstDay   = new Date(viewYear, viewMonth, 1);
  const startWeekday = firstDay.getDay();                 // 0=Sun
  const daysInMonth  = new Date(viewYear, viewMonth + 1, 0).getDate();

  const cells = [];
  // Leading days from previous month
  const prevDays = new Date(viewYear, viewMonth, 0).getDate();
  for (let i = startWeekday - 1; i >= 0; i--) {
    cells.push({ day: prevDays - i, inMonth: false, date: new Date(viewYear, viewMonth - 1, prevDays - i) });
  }
  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, inMonth: true, date: new Date(viewYear, viewMonth, d) });
  }
  // Trailing days to fill the final week row
  let next = 1;
  while (cells.length % 7 !== 0) {
    cells.push({ day: next, inMonth: false, date: new Date(viewYear, viewMonth + 1, next) });
    next++;
  }
  return cells;
}

export default function CalendarDateTimePicker({ value, onConfirm, onCancel, minDate }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const seed = value ? new Date(value) : new Date();
  const today = startOfDay(new Date());
  const floor = minDate ? startOfDay(minDate) : today;

  const [viewYear,  setViewYear]  = useState(seed.getFullYear());
  const [viewMonth, setViewMonth] = useState(seed.getMonth());     // 0-11
  const [selected,  setSelected]  = useState(value ? startOfDay(seed) : null);

  // 12-hour time state
  const seedHour24 = seed.getHours();
  const [hour12,  setHour12]  = useState(((seedHour24 + 11) % 12) + 1); // 1..12
  const [minute,  setMinute]  = useState(seed.getMinutes());
  const [meridiem, setMeridiem] = useState(seedHour24 >= 12 ? 'PM' : 'AM');

  const matrix = useMemo(() => buildMonthMatrix(viewYear, viewMonth), [viewYear, viewMonth]);

  const goMonth = (delta) => {
    let m = viewMonth + delta;
    let y = viewYear;
    if (m < 0)  { m = 11; y -= 1; }
    if (m > 11) { m = 0;  y += 1; }
    setViewMonth(m);
    setViewYear(y);
  };

  const pickDay = (cell) => {
    if (startOfDay(cell.date) < floor) return; // disabled past day
    if (!cell.inMonth) {
      setViewYear(cell.date.getFullYear());
      setViewMonth(cell.date.getMonth());
    }
    setSelected(startOfDay(cell.date));
  };

  const handleToday = () => {
    const n = new Date();
    setViewYear(n.getFullYear());
    setViewMonth(n.getMonth());
    setSelected(startOfDay(n));
  };

  const handleClear = () => setSelected(null);

  const confirm = () => {
    if (!selected) { onCancel?.(); return; }
    let h = hour12 % 12;                 // 12 -> 0
    if (meridiem === 'PM') h += 12;      // PM adds 12 (except 12 PM handled by %12)
    const out = new Date(selected);
    out.setHours(h, minute, 0, 0);
    onConfirm?.(out.toISOString());
  };

  const isSameDay = (a, b) =>
    a && b && a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  return (
    <View style={styles.card}>
      {/* Header: month + nav */}
      <View style={styles.header}>
        <Text style={styles.monthLabel}>{MONTHS[viewMonth]}, {viewYear}</Text>
        <View style={styles.navRow}>
          <TouchableOpacity style={styles.navBtn} onPress={() => goMonth(-1)}>
            <Icon name="chevron-up" size={22} color={colors.blueLight} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.navBtn} onPress={() => goMonth(1)}>
            <Icon name="chevron-down" size={22} color={colors.blueLight} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Weekday header */}
      <View style={styles.weekRow}>
        {WEEKDAYS.map(w => (
          <Text key={w} style={styles.weekday}>{w}</Text>
        ))}
      </View>

      {/* Day grid */}
      <View style={styles.grid}>
        {matrix.map((cell, i) => {
          const disabled = startOfDay(cell.date) < floor;
          const sel      = isSameDay(selected, cell.date);
          const isToday  = isSameDay(today, cell.date);
          return (
            <TouchableOpacity
              key={i}
              style={[styles.cell, sel && styles.cellSelected]}
              onPress={() => pickDay(cell)}
              disabled={disabled}
              activeOpacity={0.7}
            >
              <Text style={[
                styles.cellText,
                !cell.inMonth && styles.cellOut,
                disabled && styles.cellDisabled,
                isToday && !sel && styles.cellToday,
                sel && styles.cellTextSelected,
              ]}>
                {cell.day}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Shortcuts */}
      <View style={styles.shortcutRow}>
        <TouchableOpacity onPress={handleClear}><Text style={styles.shortcut}>Clear</Text></TouchableOpacity>
        <TouchableOpacity onPress={handleToday}><Text style={styles.shortcut}>Today</Text></TouchableOpacity>
      </View>

      {/* ── Time: hour 1–12, minute, AM/PM ─────────────────────────────────── */}
      <Text style={styles.timeTitle}>Time</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.hourScroll}>
        {Array.from({ length: 12 }, (_, k) => k + 1).map(h => (
          <TouchableOpacity
            key={h}
            style={[styles.hourBtn, hour12 === h && styles.hourBtnActive]}
            onPress={() => setHour12(h)}
          >
            <Text style={[styles.hourText, hour12 === h && styles.hourTextActive]}>{h}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Minute: full 0–59 list so any exact minute can be picked (was a
          +5/−5 stepper that only allowed 0,5,10…55). */}
      <Text style={styles.timeTitle}>Minute</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.hourScroll}>
        {Array.from({ length: 60 }, (_, k) => k).map(m => (
          <TouchableOpacity
            key={m}
            style={[styles.hourBtn, minute === m && styles.hourBtnActive]}
            onPress={() => setMinute(m)}
          >
            <Text style={[styles.hourText, minute === m && styles.hourTextActive]}>
              {String(m).padStart(2, '0')}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={styles.minMeridiemRow}>
        {/* AM / PM toggle */}
        <View style={styles.meridiemBox}>
          {['AM', 'PM'].map(mer => (
            <TouchableOpacity
              key={mer}
              style={[styles.meridiemBtn, meridiem === mer && styles.meridiemBtnActive]}
              onPress={() => setMeridiem(mer)}
            >
              <Text style={[styles.meridiemText, meridiem === mer && styles.meridiemTextActive]}>{mer}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Selected preview */}
      {selected && (
        <Text style={styles.preview}>
          {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][selected.getDay()]} {selected.getDate()} {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][selected.getMonth()]} {selected.getFullYear()}
          {'  ·  '}{hour12}:{String(minute).padStart(2, '0')} {meridiem}
        </Text>
      )}

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.confirmBtn, !selected && styles.confirmBtnDisabled]}
          onPress={confirm}
          disabled={!selected}
        >
          <Text style={styles.confirmText}>Confirm</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const CELL = 40;

function createStyles(colors) {
  return StyleSheet.create({
  card:        { backgroundColor: colors.surface, borderRadius: 16, padding: 14,
                 borderWidth: 1, borderColor: colors.border, marginTop: 8 },
  header:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  monthLabel:  { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  navRow:      { flexDirection: 'row', gap: 8 },
  navBtn:      { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                 backgroundColor: colors.surfaceAlt },

  weekRow:     { flexDirection: 'row', marginBottom: 4 },
  weekday:     { width: CELL, textAlign: 'center', fontSize: 12, fontWeight: '700', color: colors.textMuted },

  grid:        { flexDirection: 'row', flexWrap: 'wrap' },
  cell:        { width: CELL, height: CELL, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  cellSelected:{ backgroundColor: colors.blue, borderWidth: 2, borderColor: colors.blueLight },
  cellText:    { fontSize: 14, color: colors.textPrimary, fontWeight: '600' },
  cellTextSelected: { color: '#FFFFFF', fontWeight: '800' },
  cellOut:     { color: colors.textMuted, fontWeight: '400' },
  cellDisabled:{ color: colors.border },
  cellToday:   { color: colors.blueLight },

  shortcutRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, marginBottom: 4,
                 paddingHorizontal: 4 },
  shortcut:    { color: colors.blueLight, fontSize: 14, fontWeight: '700' },

  timeTitle:   { color: colors.textSec, fontSize: 11, fontWeight: '700', textTransform: 'uppercase',
                 letterSpacing: 1.2, marginTop: 12, marginBottom: 8 },
  hourScroll:  { flexDirection: 'row' },
  hourBtn:     { width: 40, height: 40, borderRadius: 10, backgroundColor: colors.surfaceAlt,
                 alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  hourBtnActive:{ backgroundColor: colors.blue },
  hourText:    { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },
  hourTextActive:{ color: '#FFFFFF' },

  minMeridiemRow:{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  minuteBox:   { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surfaceAlt, borderRadius: 10,
                 paddingHorizontal: 6 },
  stepBtn:     { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  minuteText:  { color: colors.textPrimary, fontSize: 16, fontWeight: '800', minWidth: 34, textAlign: 'center' },

  meridiemBox: { flexDirection: 'row', backgroundColor: colors.surfaceAlt, borderRadius: 10, overflow: 'hidden' },
  meridiemBtn: { paddingHorizontal: 18, paddingVertical: 9 },
  meridiemBtnActive: { backgroundColor: colors.blue },
  meridiemText:{ color: colors.textSec, fontSize: 14, fontWeight: '700' },
  meridiemTextActive: { color: '#FFFFFF' },

  preview:     { color: colors.blueLight, fontSize: 13, fontWeight: '700', textAlign: 'center', marginTop: 12 },

  actions:     { flexDirection: 'row', gap: 10, marginTop: 14 },
  cancelBtn:   { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
                 alignItems: 'center' },
  cancelText:  { color: colors.textSec, fontSize: 14, fontWeight: '700' },
  confirmBtn:  { flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: colors.blue, alignItems: 'center' },
  confirmBtnDisabled: { backgroundColor: colors.border },
  confirmText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  });
}