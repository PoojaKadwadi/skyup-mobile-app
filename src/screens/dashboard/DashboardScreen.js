// src/screens/dashboard/DashboardScreen.js
// ─────────────────────────────────────────────────────────────────────────────
// CHANGES (auto-sync recording feature):
//
//  1. useAutoSyncSetup hook — runs once on first login. Checks if permissions
//     have been granted before; if not, automatically shows the step-by-step
//     setup guide popup and requests permissions.
//     Uses AsyncStorage key 'crm_auto_sync_setup_done' to avoid re-prompting.
//
//  2. "Auto Sync" quick-action button added to the dashboard action row.
//     Tapping it opens the setup guide (or shows status if already set up).
//
//  3. All previous performance fixes retained (single-pass KPI, etc.).
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  RefreshControl, StatusBar, ActivityIndicator, InteractionManager, Alert,
} from 'react-native';
import AsyncStorage                     from '@react-native-async-storage/async-storage';
import { useDispatch, useSelector }     from 'react-redux';
import { useNavigation, useFocusEffect }                from '@react-navigation/native';
import Icon                             from 'react-native-vector-icons/MaterialCommunityIcons';
import { fetchLeads }                   from '../../store/slices/leadsSlice';
import { triggerManualSync }            from '../../services/backgroundSyncService';
import { checkAllPermissions }          from '../../services/permissionsService';
import { checkAndNotifyNewLeads, checkAndNotifyFollowUps, checkAndScheduleClockInReminder } from '../../services/notificationService';
import { autoSetupRecordingSync }       from '../../services/recordingService';
import { COLORS, RADIUS, FONT }         from '../../theme/tokens';
import { useTheme }                     from '../../theme/ThemeContext';
import AttendanceWidget                 from '../../components/AttendanceWidget';
import NotificationPermissionBanner    from '../../components/NotificationPermissionBanner';

const AUTO_SYNC_SETUP_KEY = 'crm_auto_sync_setup_done';

// PERF FIX: Module-level cache so repeated AsyncStorage.getItem calls for this
// key (useAutoSyncSetup hook) become memory reads
// after the first access. Cleared to null on logout via clearAutoSyncCache().
let _autoSyncSetupCache = null;
async function isAutoSyncDone() {
  if (_autoSyncSetupCache !== null) return _autoSyncSetupCache === 'true';
  try { _autoSyncSetupCache = await AsyncStorage.getItem(AUTO_SYNC_SETUP_KEY); } catch {}
  return _autoSyncSetupCache === 'true';
}
async function markAutoSyncDone() {
  _autoSyncSetupCache = 'true';
  try { await AsyncStorage.setItem(AUTO_SYNC_SETUP_KEY, 'true'); } catch {}
}
export function clearAutoSyncCache() { _autoSyncSetupCache = null; }

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function parseDate(s) {
  if (!s) return new Date(NaN);
  const m = s.match(/^(\d{1,2})\s([A-Za-z]{3})\s(\d{4})$/);
  if (m) {
    const mo = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
    return new Date(+m[3], mo[m[2]], +m[1], 12);
  }
  return new Date(s);
}

function timeAgo(ms) {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`;
}

// Returns true when a lead has a follow-up scheduled for today or earlier
// (i.e. due today or overdue). Kept at module scope with no theme/color
// dependency so it stays Hermes-safe and is reused by the "Followups" card
// count here and the follow-up filter in LeadsScreen.
function isFollowUpDue(lead) {
  if (!lead?.followUpDate) return false;
  const d = new Date(lead.followUpDate);
  if (isNaN(d.getTime())) return false;
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  return d.getTime() <= endOfToday.getTime();
}

function computeKpi(leads) {
  const todayStr  = new Date().toDateString();
  const now       = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);

  const DAY_LABELS = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  const dayKeys    = [];
  const weekLabels = [];
  const dayMap     = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toDateString();
    dayKeys.push(key);
    weekLabels.push(DAY_LABELS[d.getDay()]);
    dayMap[key] = 0;
  }

  let total = 0, converted = 0, inProgress = 0, notInt = 0, newLeads = 0;
  let hot = 0, warm = 0, cold = 0, unclassified = 0;
  let todayLeads = 0, weekLeads = 0;
  let todayConverted = 0, todayFollowUp = 0;
  let followUpDue = 0;

  for (const l of leads) {
    if (isFollowUpDue(l)) followUpDue++;
    total++;
    const st = l.status;
    if      (st === 'Converted')       converted++;
    else if (st === 'In Progress')     inProgress++;
    else if (st === 'Not Interested')  notInt++;
    else if (st === 'New')             newLeads++;

    const q = l.Quality || l.temperature;
    if      (q === 'Hot')  hot++;
    else if (q === 'Warm') warm++;
    else if (q === 'Cold') cold++;
    else                   unclassified++;

    const d  = parseDate(l.date);
    const ds = d.toDateString();

    if (ds === todayStr) {
      todayLeads++;
      if (st === 'Converted')   todayConverted++;
      if (st === 'In Progress') todayFollowUp++;
    }
    if (d >= weekStart && d <= now) weekLeads++;
    if (Object.prototype.hasOwnProperty.call(dayMap, ds)) dayMap[ds]++;
  }

  const weekData = dayKeys.map(k => dayMap[k]);
  const maxBar   = Math.max(...weekData, 1);

  return {
    total, converted, inProgress, notInt, newLeads,
    hot, warm, cold, unclassified,
    todayLeads, weekLeads,
    todayConverted, todayFollowUp,
    followUpDue,
    weekData, weekLabels, maxBar,
    convRate: total > 0 ? Math.round((converted / total) * 100) : 0,
  };
}

// ── Hook: auto-prompt setup on first login ────────────────────────────────────
function useAutoSyncSetup() {
  const setupRan = useRef(false);

  useEffect(() => {
    if (setupRan.current) return;
    setupRan.current = true;

    // Defer past the first paint — let the dashboard load first
    const task = InteractionManager.runAfterInteractions(async () => {
      try {
        const already = await isAutoSyncDone();
        if (already) return;  // already set up — don't ask again

        // First time — show the guide and request permissions automatically
        const result = await autoSetupRecordingSync();

        if (result.success) {
          await markAutoSyncDone();
          Alert.alert(
            '✅ Auto Sync Enabled',
            `All permissions granted!\n\nCall recordings will now sync automatically to your CRM after each call.\n\nSave recordings to:\n${result.folderPath}`,
            [{ text: 'Got it' }],
          );
        } else if (result.partial) {
          // Some permissions granted — remind them but don't block
          Alert.alert(
            '⚠️ Partial Setup',
            'Some permissions were not granted. Auto sync may not work fully.\n\nYou can grant the missing permissions any time from your phone\'s Settings › Apps.',
            [{ text: 'OK' }],
          );
        }
        // If cancelled — do nothing, they can tap the button manually
      } catch (e) {
        console.warn('[DashboardScreen] Auto sync setup error:', e.message);
      }
    });

    return () => task.cancel();
  }, []);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────
export default function DashboardScreen() {
  const navigation = useNavigation();
  const dispatch   = useDispatch();
  const { dark, colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const leads         = useSelector(s => s.leads?.items ?? []);
  const loading       = useSelector(s => s.leads?.loading ?? false);
  const lastFetchedAt = useSelector(s => s.leads?.lastFetchedAt);
  const user          = useSelector(s => s.auth?.user);

  // ── Auto sync setup on first login
  useAutoSyncSetup();

  // ── Permissions check (once on mount, deferred)
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      checkAllPermissions();
    });
    return () => task.cancel();
  }, []);

  // ── Leads fetch — PERF FIX ─────────────────────────────────────────────────
  // Replaced bare useEffect (fired on every mount) with useFocusEffect + 2-min
  // stale threshold. This matches the pattern already used in LeadsScreen and
  // prevents a full network round-trip every time the user switches tabs.
  const STALE_MS = 2 * 60 * 1000;
  useFocusEffect(
    useCallback(() => {
      const task = InteractionManager.runAfterInteractions(() => {
        const isStale = !lastFetchedAt || (Date.now() - lastFetchedAt > STALE_MS);
        if (isStale) dispatch(fetchLeads());

        // Schedule (or cancel) clock-in reminder based on today's attendance.
        // Wrapped in an async IIFE because runAfterInteractions callback cannot be async.
        (async () => {
          try {
            const apiModule = require('../../services/api').default;
            const res = await apiModule.get('/attendance/my-today');
            checkAndScheduleClockInReminder(res.data).catch(() => {});
          } catch {
            // If attendance fetch fails, still schedule reminder (no record = not clocked in)
            checkAndScheduleClockInReminder(null).catch(() => {});
          }
        })();
      });
      return () => task.cancel();
    }, [lastFetchedAt, dispatch]),
  );

  const onRefresh = useCallback(async () => {
    // FIX: await both operations so the RefreshControl spinner stays visible
    // until both finish. The old fire-and-forget let the spinner dismiss
    // immediately while network requests were still in flight, making it look
    // like nothing happened. triggerManualSync is awaited first (call-log +
    // recording sweep), then fetchLeads pulls the updated lead list.
    triggerManualSync().catch(() => {});
    await dispatch(fetchLeads());
  }, [dispatch]);

  const kpi = useMemo(() => computeKpi(leads), [leads]);

  // Toggles the inline "Daily Report" summary panel under the action cards.
  const [showReport, setShowReport] = React.useState(false);

  // Deep-link handlers for the action cards.
  const goNewLeads  = useCallback(() => navigation.navigate('Leads', { filterStatus: 'New' }), [navigation]);
  const goFollowups = useCallback(() => navigation.navigate('Leads', { followUpOnly: true }), [navigation]);
  const toggleReport = useCallback(() => setShowReport(v => !v), []);

  return (
    <View style={styles.container}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={colors.surface} />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Hello, {user?.name?.split(' ')[0] || 'there'} 👋</Text>
          <Text style={styles.subtitle}>
            {lastFetchedAt ? `Updated ${timeAgo(lastFetchedAt)}` : 'Loading…'}
          </Text>
        </View>
        <TouchableOpacity style={styles.syncBtn} onPress={onRefresh} disabled={loading}>
          {loading
            ? <ActivityIndicator size="small" color={colors.blueLight} />
            : <Icon name="refresh" size={20} color={colors.blueLight} />
          }
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor={colors.blueLight} />}
        showsVerticalScrollIndicator={false}
      >
        {/* Quick Actions Row — Daily Report · New Leads · Followups */}
        <View style={styles.quickRow}>
          <ActionCard
            icon="chart-box-outline"
            color="#22C55E"
            value={showReport ? '▲' : '▼'}
            label="Daily Report"
            active={showReport}
            onPress={toggleReport}
          />
          <ActionCard
            icon="account-plus-outline"
            color="#3B82F6"
            value={kpi.newLeads}
            label="New Leads"
            onPress={goNewLeads}
          />
          <ActionCard
            icon="calendar-clock"
            color="#F59E0B"
            value={kpi.followUpDue}
            label="Followups"
            onPress={goFollowups}
          />
        </View>

        {/* Inline Daily Report — today's snapshot, toggled by the card above */}
        {showReport && (
          <View style={styles.reportPanel}>
            <Text style={styles.reportTitle}>Today's Summary</Text>
            <View style={styles.reportRow}>
              <ReportStat label="New Leads Today"  value={kpi.todayLeads}     color="#3B82F6" />
              <ReportStat label="Follow-ups Due"   value={kpi.followUpDue}    color="#F59E0B" />
              <ReportStat label="Converted Today"  value={kpi.todayConverted} color="#22C55E" />
            </View>
          </View>
        )}

        {/* Attendance Widget */}
        <NotificationPermissionBanner />
        <AttendanceWidget />

        {/* KPI Cards */}
        <View style={styles.kpiGrid}>
          <KpiCard label="Total Leads"  value={kpi.total}     icon="account-group"    color="#3B82F6" />
          <KpiCard label="Converted"    value={kpi.converted} icon="check-circle"     color="#22C55E" />
          <KpiCard label="In Progress"  value={kpi.inProgress}icon="progress-clock"   color="#F59E0B" />
          <KpiCard label="Today"        value={kpi.todayLeads}icon="calendar-today"   color="#A78BFA" />
        </View>

        {/* Weekly Bar Chart */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>This Week</Text>
          <View style={styles.barChart}>
            {kpi.weekData.map((val, i) => (
              <View key={i} style={styles.barCol}>
                <View style={[styles.bar, { height: Math.max(4, (val / kpi.maxBar) * 80) }]} />
                <Text style={styles.barLabel}>{kpi.weekLabels[i]}</Text>
                <Text style={styles.barVal}>{val}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Status Summary */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Lead Status</Text>
          <View style={styles.statusRow}>
            <StatusChip label="New"           count={kpi.newLeads}   color="#3B82F6" />
            <StatusChip label="In Progress"   count={kpi.inProgress} color="#F59E0B" />
            <StatusChip label="Converted"     count={kpi.converted}  color="#22C55E" />
            <StatusChip label="Not Interested"count={kpi.notInt}     color="#EF4444" />
          </View>
        </View>

        {/* Temperature */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Lead Temperature</Text>
          <View style={styles.statusRow}>
            <StatusChip label="🔥 Hot"  count={kpi.hot}  color="#EF4444" />
            <StatusChip label="🌡 Warm" count={kpi.warm} color="#F59E0B" />
            <StatusChip label="❄️ Cold" count={kpi.cold} color="#3B82F6" />
          </View>
        </View>

        <View style={{ height: 32 }} />
      </ScrollView>
    </View>
  );
}

// ── Small components ──────────────────────────────────────────────────────────
// Top-row action card: icon + value + label. Used for Daily Report (toggle),
// New Leads (deep-link) and Followups (deep-link).
function ActionCard({ icon, color, value, label, onPress, active }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <TouchableOpacity
      style={[styles.actionCard, active && { borderColor: color, backgroundColor: color + '14' }]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <Icon name={icon} size={20} color={color} />
      <Text style={[styles.actionValue, { color }]}>{value}</Text>
      <Text style={styles.actionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

// Single stat inside the inline Daily Report panel.
function ReportStat({ label, value, color }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.reportStat}>
      <Text style={[styles.reportStatValue, { color }]}>{value}</Text>
      <Text style={styles.reportStatLabel}>{label}</Text>
    </View>
  );
}

function KpiCard({ label, value, icon, color }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={[styles.kpiCard, { borderLeftColor: color }]}>
      <Icon name={icon} size={22} color={color} style={{ marginBottom: 6 }} />
      <Text style={styles.kpiValue}>{value}</Text>
      <Text style={styles.kpiLabel}>{label}</Text>
    </View>
  );
}

function StatusChip({ label, count, color }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={[styles.chip, { borderColor: color + '40' }]}>
      <Text style={[styles.chipCount, { color }]}>{count}</Text>
      <Text style={styles.chipLabel}>{label}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
function createStyles(colors) {
  return StyleSheet.create({
  container:        { flex: 1, backgroundColor: colors.bg },
  header:           { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 52, paddingBottom: 16, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  greeting:         { fontSize: 22, fontWeight: '800', color: colors.textPrimary },
  subtitle:         { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  syncBtn:          { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.blueBg, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  scroll:           { padding: 16, paddingBottom: 40 },

  quickRow:         { flexDirection: 'row', gap: 10, marginBottom: 16 },
  quickBtn:         { flex: 1, backgroundColor: colors.surface, borderRadius: 12, alignItems: 'center', paddingVertical: 14, gap: 6, borderWidth: 1, borderColor: colors.border },
  quickBtnHighlight:{ borderColor: '#166534', backgroundColor: colors.greenBg },
  quickLabel:       { fontSize: 11, fontWeight: '600', color: colors.blueLight },

  // Top-row action cards (Daily Report · New Leads · Followups)
  actionCard:       { flex: 1, backgroundColor: colors.surface, borderRadius: 12, alignItems: 'center', paddingVertical: 14, gap: 4, borderWidth: 1, borderColor: colors.border, shadowColor: '#0F172A', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 6, elevation: 2 },
  actionValue:      { fontSize: 22, fontWeight: '800', lineHeight: 26 },
  actionLabel:      { fontSize: 11, fontWeight: '600', color: colors.textSec, textAlign: 'center' },

  // Inline Daily Report panel
  reportPanel:      { backgroundColor: colors.surface, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: colors.border },
  reportTitle:      { fontSize: 14, fontWeight: '700', color: colors.textSec, marginBottom: 12 },
  reportRow:        { flexDirection: 'row', gap: 10 },
  reportStat:       { flex: 1, backgroundColor: colors.surfaceAlt, borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: colors.border },
  reportStatValue:  { fontSize: 24, fontWeight: '800' },
  reportStatLabel:  { fontSize: 10, color: colors.textMuted, marginTop: 4, textAlign: 'center' },

  kpiGrid:          { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 16 },
  kpiCard:          {
    flex: 1,
    minWidth: '45%',
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    // Visible separation between adjacent cards — the surface/bg/border
    // tokens are nearly the same shade in light mode, so without a shadow
    // the 4 KPI cards visually blend into one block instead of reading as
    // 4 distinct cards.
    shadowColor:   '#0F172A',
    shadowOffset:  { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius:  6,
    elevation:     2,
  },
  kpiValue:         { fontSize: 26, fontWeight: '800', color: colors.textPrimary },
  kpiLabel:         { fontSize: 11, color: colors.textMuted, marginTop: 2 },

  section:          { backgroundColor: colors.surface, borderRadius: 14, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: colors.border },
  sectionTitle:     { fontSize: 14, fontWeight: '700', color: colors.textSec, marginBottom: 12 },

  barChart:         { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', height: 100 },
  barCol:           { flex: 1, alignItems: 'center', gap: 4 },
  bar:              { width: 20, backgroundColor: colors.blue, borderRadius: 4 },
  barLabel:         { fontSize: 10, color: colors.textMuted },
  barVal:           { fontSize: 10, color: colors.textSec, fontWeight: '600' },

  statusRow:        { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip:             { borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center', minWidth: '22%' },
  chipCount:        { fontSize: 18, fontWeight: '800' },
  chipLabel:        { fontSize: 10, color: colors.textMuted, marginTop: 2, textAlign: 'center' },
  });
}