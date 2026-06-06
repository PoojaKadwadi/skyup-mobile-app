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
import { autoSetupRecordingSync }       from '../../services/recordingService';
import { COLORS, RADIUS, FONT }         from '../../theme/tokens';
import AttendanceWidget                 from '../../components/AttendanceWidget';
import NotificationPermissionBanner    from '../../components/NotificationPermissionBanner';

const AUTO_SYNC_SETUP_KEY = 'crm_auto_sync_setup_done';

// PERF FIX: Module-level cache so repeated AsyncStorage.getItem calls for this
// key (useAutoSyncSetup hook + handleAutoSyncSetup button) become memory reads
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

  for (const l of leads) {
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
            'Some permissions were not granted. Auto sync may not work fully.\n\nTap "Auto Sync" on the dashboard to retry.',
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
      });
      return () => task.cancel();
    }, [lastFetchedAt, dispatch]),
  );

  const onRefresh = useCallback(() => {
    dispatch(fetchLeads());
    triggerManualSync();
  }, [dispatch]);

  const kpi = useMemo(() => computeKpi(leads), [leads]);

  // ── Manual "Set Up Auto Sync" handler (for the dashboard button)
  const handleAutoSyncSetup = useCallback(async () => {
    try {
      // PERF FIX: use cached isAutoSyncDone() instead of raw AsyncStorage.getItem
      const already = await isAutoSyncDone();
      if (already) {
        // Already set up — show current status
        const perms = await checkAllPermissions();
        const allOk = perms.callPhone && perms.readCallLog && perms.readStorage;
        Alert.alert(
          allOk ? '✅ Auto Sync Active' : '⚠️ Some Permissions Missing',
          [
            `Phone access: ${perms.callPhone   ? '✅' : '❌'}`,
            `Call log:     ${perms.readCallLog ? '✅' : '❌'}`,
            `Storage:      ${perms.readStorage ? '✅' : '❌'}`,
            '',
            allOk
              ? 'Recordings are syncing automatically after each call.'
              : 'Tap "Re-run Setup" to grant missing permissions.',
          ].join('\n'),
          [
            { text: 'Close',       style: 'cancel' },
            { text: 'Re-run Setup', onPress: () => runSetup() },
          ],
        );
        return;
      }
      runSetup();
    } catch {
      runSetup();
    }
  }, []);

  const runSetup = useCallback(async () => {
    const result = await autoSetupRecordingSync();
    if (result.success) {
      // PERF FIX: use cached markAutoSyncDone() — updates memory + AsyncStorage
      await markAutoSyncDone();
      Alert.alert(
        '✅ Auto Sync Enabled',
        `Recordings will sync automatically after each call.\n\nSave recordings to:\n${result.folderPath}`,
        [{ text: 'Got it' }],
      );
    } else if (!result.success && result.partial) {
      Alert.alert('⚠️ Partial Setup', 'Some permissions were denied. Try again from Settings.');
    }
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0F172A" />

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
            ? <ActivityIndicator size="small" color="#93C5FD" />
            : <Icon name="refresh" size={20} color="#93C5FD" />
          }
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor="#93C5FD" />}
        showsVerticalScrollIndicator={false}
      >
        {/* Quick Actions Row */}
        <View style={styles.quickRow}>
          <TouchableOpacity
            style={styles.quickBtn}
            onPress={() => navigation.navigate('Recordings')}
          >
            <Icon name="microphone" size={20} color="#93C5FD" />
            <Text style={styles.quickLabel}>Recordings</Text>
          </TouchableOpacity>

          {/* ── NEW: Auto Sync Setup button ── */}
          <TouchableOpacity
            style={[styles.quickBtn, styles.quickBtnHighlight]}
            onPress={handleAutoSyncSetup}
          >
            <Icon name="sync" size={20} color="#4ADE80" />
            <Text style={[styles.quickLabel, { color: '#4ADE80' }]}>Auto Sync</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.quickBtn}
            onPress={() => navigation.navigate('Call Logs')}
          >
            <Icon name="phone-log" size={20} color="#93C5FD" />
            <Text style={styles.quickLabel}>Call Logs</Text>
          </TouchableOpacity>
        </View>

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
function KpiCard({ label, value, icon, color }) {
  return (
    <View style={[styles.kpiCard, { borderLeftColor: color }]}>
      <Icon name={icon} size={22} color={color} style={{ marginBottom: 6 }} />
      <Text style={styles.kpiValue}>{value}</Text>
      <Text style={styles.kpiLabel}>{label}</Text>
    </View>
  );
}

function StatusChip({ label, count, color }) {
  return (
    <View style={[styles.chip, { borderColor: color + '40' }]}>
      <Text style={[styles.chipCount, { color }]}>{count}</Text>
      <Text style={styles.chipLabel}>{label}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#0D0F14' },
  header:           { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 52, paddingBottom: 16, backgroundColor: '#1A1D27', borderBottomWidth: 1, borderBottomColor: '#262A38' },
  greeting:         { fontSize: 22, fontWeight: '800', color: '#F0F2FA' },
  subtitle:         { fontSize: 12, color: '#565C75', marginTop: 2 },
  syncBtn:          { width: 40, height: 40, borderRadius: 20, backgroundColor: '#1E2236', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#262A38' },
  scroll:           { padding: 16, paddingBottom: 40 },

  quickRow:         { flexDirection: 'row', gap: 10, marginBottom: 16 },
  quickBtn:         { flex: 1, backgroundColor: '#1A1D27', borderRadius: 12, alignItems: 'center', paddingVertical: 14, gap: 6, borderWidth: 1, borderColor: '#262A38' },
  quickBtnHighlight:{ borderColor: '#166534', backgroundColor: '#052e16' },
  quickLabel:       { fontSize: 11, fontWeight: '600', color: '#93C5FD' },

  kpiGrid:          { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  kpiCard:          { flex: 1, minWidth: '45%', backgroundColor: '#1A1D27', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#262A38', borderLeftWidth: 3 },
  kpiValue:         { fontSize: 26, fontWeight: '800', color: '#F0F2FA' },
  kpiLabel:         { fontSize: 11, color: '#565C75', marginTop: 2 },

  section:          { backgroundColor: '#1A1D27', borderRadius: 14, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#262A38' },
  sectionTitle:     { fontSize: 14, fontWeight: '700', color: '#94A3B8', marginBottom: 12 },

  barChart:         { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', height: 100 },
  barCol:           { flex: 1, alignItems: 'center', gap: 4 },
  bar:              { width: 20, backgroundColor: '#3B82F6', borderRadius: 4 },
  barLabel:         { fontSize: 10, color: '#565C75' },
  barVal:           { fontSize: 10, color: '#94A3B8', fontWeight: '600' },

  statusRow:        { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip:             { borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center', minWidth: '22%' },
  chipCount:        { fontSize: 18, fontWeight: '800' },
  chipLabel:        { fontSize: 10, color: '#565C75', marginTop: 2, textAlign: 'center' },
});