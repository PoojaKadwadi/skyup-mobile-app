import React, { useState, useCallback, useEffect, useMemo, memo, useRef } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  RefreshControl, StatusBar, Alert, ActivityIndicator, Linking,
  InteractionManager,
} from 'react-native';
import { useDispatch, useSelector }   from 'react-redux';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import Icon                            from 'react-native-vector-icons/MaterialCommunityIcons';
import { ScrollView as HScrollView }   from 'react-native';
import moment                          from 'moment';
import { useTheme }                    from '../../theme/ThemeContext';

// CRASH FIX: Replaced Intl.DateTimeFormat('en-IN', ...) with moment.
// Hermes (the Android JS engine) ships without full ICU locale data, so
// new Intl.DateTimeFormat('en-IN', ...) throws "Incomplete locale data" and
// crashes the ENTIRE screen at module load time — before any component mounts.
// Because this file is imported by the navigator, the crash propagates up and
// makes unrelated screens (like the Follow-Up button on LeadDetail) appear broken.
// moment formats dates without relying on Intl, so it works on all Android versions.
function fmtTime(ms) { return moment(ms).format('hh:mm A'); }
function fmtDate(ms) { return moment(ms).format('DD MMM'); }
// fmtFull kept for reference but currently unused — removing Intl dependency anyway
// function fmtFull(ms) { return moment(ms).format('DD MMM, hh:mm A'); }

const todayLabel = moment().format('DD MMM YYYY');

import { fetchTodayServerLogs, matchPhoneToLead } from '../../api/callLogsApi';
import apiClient from '../../api/apiClient';
import { triggerManualSync }   from '../../services/backgroundSyncService';
import { normalizePhone }      from '../../services/phoneService';

let markSynced;
try { ({ markSynced } = require('../../store/slices/callsSlice')); } catch {}

const CALL_TYPE_CONFIG = {
  incoming: { icon: 'phone-incoming', color: '#059669', label: 'Incoming' },
  outgoing: { icon: 'phone-outgoing', color: '#2563EB', label: 'Outgoing' },
  missed:   { icon: 'phone-missed',   color: '#EF4444', label: 'Missed'   },
  rejected: { icon: 'phone-cancel',   color: '#F59E0B', label: 'Rejected' },
  blocked:  { icon: 'phone-off',      color: '#64748B', label: 'Blocked'  },
};

// FIX 2: Normalize before masking — strips 91 prefix first
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

// FIX 1: Relative time for today, absolute for older — and guard bad timestamps
// Uses moment instead of Intl.DateTimeFormat to avoid Hermes ICU crash.
function formatTimestamp(tsRaw) {
  // Backend returns ISO date strings ("2026-05-21T06:30:00.000Z")
  // parseInt() on those yields just the year (2026) which is < 1_000_000_000_000
  // and gets wrongly filtered as bogus. Use new Date() to handle both formats.
  const ts = tsRaw ? new Date(tsRaw).getTime() : 0;
  if (!ts || isNaN(ts) || ts < 1000000000000) {
    return { time: '—', date: '—' };
  }
  const now      = Date.now();
  const diff     = now - ts;
  const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0);

  if (ts >= todayMid.getTime()) {
    // Today: show time + relative
    const mins = Math.floor(diff / 60000);
    let rel = 'just now';
    if (mins >= 60) rel = `${Math.floor(mins / 60)}h ago`;
    else if (mins >= 1) rel = `${mins}m ago`;
    return { time: fmtTime(ts), date: rel };
  }
  // Older: show time + date
  return { time: fmtTime(ts), date: fmtDate(ts) };
}

function timeAgo(ms) {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`;
}

const ItemSeparator = () => <View style={{ height: 8 }} />;

const LogRow = memo(function LogRow({ item, onPress, isLoading }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const cfg = CALL_TYPE_CONFIG[item.callType] || CALL_TYPE_CONFIG.incoming;
  const handlePress = useCallback(() => onPress(item), [onPress, item]);
  const { time, date } = formatTimestamp(item.timestamp);

  return (
    <TouchableOpacity
      style={styles.logCard}
      onPress={handlePress}
      activeOpacity={0.75}
    >
      <View style={[styles.logIconWrap, { backgroundColor: cfg.color + '20' }]}>
        {isLoading
          ? <ActivityIndicator size="small" color={cfg.color} />
          : <Icon name={cfg.icon} size={20} color={cfg.color} />
        }
      </View>
      <View style={styles.logBody}>
        <Text style={styles.logNumber} numberOfLines={1}>
          {item.name || maskPhone(item.phoneNumber)}
        </Text>
        {item.name
          ? <Text style={styles.logSubNumber}>{maskPhone(item.phoneNumber)}</Text>
          : null
        }
        <Text style={[styles.logType, { color: cfg.color }]}>{cfg.label}</Text>
        {item.user?.name
          ? <Text style={styles.logAgent}>👤 {item.user.name}</Text>
          : null
        }
      </View>
      <View style={styles.logRight}>
        <Text style={styles.logTime}>{time}</Text>
        <Text style={styles.logDate}>{date}</Text>
        <Text style={styles.logDuration}>
          {item.duration > 0 ? formatDuration(item.duration) : '—'}
        </Text>
      </View>
    </TouchableOpacity>
  );
});

export default function CallLogsScreen() {
  const dispatch   = useDispatch();
  const navigation = useNavigation();
  const { dark, colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const lastSyncedAt = useSelector((s) => s.calls?.lastSyncedAt ?? null);
  const authUser     = useSelector((s) => s.auth?.user);
  const isAdmin      = authUser?.role === 'admin' || authUser?.role === 'super_admin';

  const [todayLogs,    setTodayLogs]   = useState([]);
  const [loading,      setLoading]     = useState(false);
  const [syncing,      setSyncing]     = useState(false);
  const [activeFilter, setFilter]      = useState('all');
  const [lastSynced,   setLastSynced]  = useState(lastSyncedAt);
  const [lookingUp,    setLookingUp]   = useState(null);
  const [agents,       setAgents]      = useState([]);   // [{_id, name}] for admin agent filter
  const [activeAgent,  setActiveAgent] = useState('all'); // 'all' or userId string
  const hasSyncedOnFocusRef            = useRef(false);

  // FIX: Single load on mount — no double-fetch.
  // useFocusEffect below handles the first sync+load when screen becomes active.
  // This effect only handles the agent filter change (admin re-filter).
  const isFirstMount = useRef(true);
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return; // skip — useFocusEffect handles initial load
    }
    // Re-load when admin changes agent filter
    loadTodayLogs(activeAgent);
  }, [activeAgent]);

  // Auto-sync + load when screen comes into focus (once per session).
  // This replaces the old on-mount useEffect to avoid the double-load.
  useFocusEffect(
    useCallback(() => {
      if (!hasSyncedOnFocusRef.current) {
        // FIX: store the timer id and clear it in the cleanup function so we
        // don't fire the sync after the screen unmounts (memory leak + possible
        // state-update-on-unmounted-component warning on fast navigation).
        const timer = setTimeout(async () => {
          try {
            await triggerManualSync();
            setLastSynced(Date.now());
            if (markSynced) dispatch(markSynced());
            await loadTodayLogs();
            hasSyncedOnFocusRef.current = true;
          } catch {
            // Silent — will retry on next focus visit.
            // Still load logs from server so UI is not empty.
            loadTodayLogs().catch(() => {});
          }
        }, 600);
        // Return cleanup so useFocusEffect cancels the timer when the user
        // navigates away before the 600ms fires.
        return () => clearTimeout(timer);
      }
    }, [])
  );

  const loadTodayLogs = useCallback(async (userId = activeAgent) => {
    setLoading(true);
    try {
      // Build query params — admin can filter by agent
      const params = {};
      if (userId && userId !== 'all') params.userId = userId;

      const res  = await apiClient.get('/call-logs/today', { params });
      const logs = res.data.logs || [];

      // Extract unique agents from the returned logs for the agent filter tabs
      // (only meaningful when admin gets company-wide data)
      if (res.data.scoped === 'company') {
        const agentMap = new Map();
        logs.forEach(l => {
          if (l.user?._id) agentMap.set(String(l.user._id), l.user.name || 'Agent');
        });
        setAgents(Array.from(agentMap, ([id, name]) => ({ _id: id, name })));
      }

      // PERF FIX: pre-compute _tsMs once during data load so keyExtractor and
      // any sort operations never allocate new Date() objects during rendering.
      const valid = logs
        .map(l => ({ ...l, _tsMs: l.timestamp ? new Date(l.timestamp).getTime() : 0 }))
        .filter(l => l._tsMs && !isNaN(l._tsMs) && l._tsMs > 1000000000000);
      setTodayLogs(valid);
    } catch (e) {
      Alert.alert('Error', 'Could not load today\'s call logs: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, [activeAgent]);

  // FIX 5: Pull-to-refresh also re-syncs for immediacy
  const handleRefresh = useCallback(async () => {
    setLoading(true);
    try {
      await triggerManualSync();
      const now = Date.now();
      setLastSynced(now);
      if (markSynced) dispatch(markSynced());
      await loadTodayLogs();
    } catch {
      await loadTodayLogs(); // Fallback to just re-fetch
    } finally {
      setLoading(false);
    }
  }, [loadTodayLogs]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await triggerManualSync();
      const now = Date.now();
      setLastSynced(now);
      if (markSynced) dispatch(markSynced());
      await loadTodayLogs();
      Alert.alert('✓ Synced', 'Today\'s call logs synced to CRM.');
    } catch (e) {
      Alert.alert('Sync Failed', e.message || 'Could not sync. Will retry automatically.');
    } finally {
      setSyncing(false);
    }
  };

  const lookingUpRef = useRef(lookingUp);
  useEffect(() => { lookingUpRef.current = lookingUp; }, [lookingUp]);

  const handleLogPress = useCallback(async (log) => {
    if (lookingUpRef.current) return;
    setLookingUp(new Date(log.timestamp).getTime());
    try {
      const match = await matchPhoneToLead(log.phoneNumber);
      if (match?.leadId) {
        navigation.navigate('LeadDetail', { leadId: match.leadId });
      } else {
        const { time, date } = formatTimestamp(log.timestamp);
        Alert.alert(
          log.name || maskPhone(log.phoneNumber),
          `No CRM lead matched for this number.\n\n` +
          `Type: ${log.callType}\nDuration: ${formatDuration(log.duration)}\n` +
          `Time: ${time} · ${date}`,
          [{ text: 'OK' }],
        );
      }
    } catch {
      // silent
    } finally {
      setLookingUp(null);
    }
  }, [navigation]);

  const filteredLogs = React.useMemo(
    () => activeFilter === 'all'
      ? todayLogs
      : todayLogs.filter(l => l.callType === activeFilter),
    [todayLogs, activeFilter],
  );

  const keyExtractor = useCallback(
    // PERF FIX: use pre-computed _tsMs field — no Date allocation per render
    (item) => `${item._tsMs}_${item.phoneNumber}`,
    [],
  );

  const renderItem = useCallback(({ item }) => (
    <LogRow
      item={item}
      onPress={handleLogPress}
      isLoading={lookingUp === new Date(item.timestamp).getTime()}
    />
  ), [lookingUp, handleLogPress]);

  const syncedText = lastSynced
    ? `Last synced ${timeAgo(lastSynced)}`
    : 'Not yet synced today';

  return (
    <View style={styles.container}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={colors.surface} />

      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Call Logs</Text>
          <Text style={styles.subtitle}>Today · {todayLabel} · {filteredLogs.length} calls{isAdmin ? ' · ' + (activeAgent === 'all' ? 'All Agents' : (agents.find(a=>a._id===activeAgent)?.name || 'Agent')) : ''}</Text>
        </View>
        <View style={styles.autoSyncBadge}>
          {syncing
            ? <ActivityIndicator size="small" color={colors.blueLight} />
            : <Icon name="cloud-check-outline" size={16} color={colors.greenLight} />
          }
          <Text style={styles.autoSyncText}>{syncing ? 'Syncing…' : 'Auto'}</Text>
        </View>
      </View>

      <View style={styles.syncInfo}>
        <Icon name="information-outline" size={12} color={colors.textMuted} />
        <Text style={styles.syncInfoText}>{syncedText}</Text>
      </View>

      {/* Agent filter — only shown to admins when multiple agents have logs */}
      {isAdmin && agents.length > 0 && (
        <HScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ paddingHorizontal: 16, marginBottom: 8 }}
          contentContainerStyle={{ gap: 8, flexDirection: 'row' }}
        >
          {[{ _id: 'all', name: 'All Agents' }, ...agents].map(a => (
            <TouchableOpacity
              key={a._id}
              style={[styles.agentTab, activeAgent === a._id && styles.agentTabActive]}
              onPress={() => setActiveAgent(a._id)}
            >
              <Icon
                name={a._id === 'all' ? 'account-group-outline' : 'account-outline'}
                size={12}
                color={activeAgent === a._id ? colors.textPrimary : colors.textSec}
              />
              <Text style={[styles.agentTabText, activeAgent === a._id && styles.agentTabTextActive]}>
                {a.name}
              </Text>
            </TouchableOpacity>
          ))}
        </HScrollView>
      )}

      <View style={styles.filterRow}>
        {['all', 'incoming', 'outgoing', 'missed'].map(f => (
          <TouchableOpacity
            key={f}
            style={[styles.filterTab, activeFilter === f && styles.filterTabActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.filterTabText, activeFilter === f && styles.filterTabTextActive]}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filteredLogs}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        initialNumToRender={15}
        maxToRenderPerBatch={15}
        windowSize={7}
        removeClippedSubviews={true}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={handleRefresh}
            tintColor={colors.blue}
            colors={[colors.blue]}
          />
        }
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={ItemSeparator}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyState}>
              <Icon name="phone-outline" size={48} color={colors.textMuted} />
              <Text style={styles.emptyTitle}>No calls synced yet today</Text>
              <Text style={styles.emptySubtitle}>
                Tap Sync to upload today's call logs, or pull down to refresh.
              </Text>
            </View>
          ) : null
        }
      />
    </View>
  );
}

function createStyles(colors) {
  return StyleSheet.create({
    container:           { flex: 1, backgroundColor: colors.bg },
    header:              { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 52, paddingBottom: 14, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
    title:               { fontSize: 22, fontWeight: '800', color: colors.textPrimary },
    subtitle:            { fontSize: 12, color: colors.textMuted, marginTop: 2 },
    autoSyncBadge:       { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.greenBg, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.green },
    autoSyncText:        { color: colors.greenLight, fontSize: 12, fontWeight: '600' },
    syncInfo:            { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 20, paddingVertical: 8 },
    syncInfoText:        { fontSize: 11, color: colors.textMuted },
    filterRow:           { flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginBottom: 12 },
    filterTab:           { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    filterTabActive:     { backgroundColor: colors.surfaceAlt, borderColor: colors.textMuted },
    filterTabText:       { color: colors.textSec, fontSize: 12, fontWeight: '600' },
    filterTabTextActive: { color: colors.textPrimary },
    listContent:         { paddingHorizontal: 16, paddingBottom: 24 },
    logCard:             { backgroundColor: colors.surface, borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: colors.border },
    logIconWrap:         { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    logBody:             { flex: 1, minWidth: 0 },
    logNumber:           { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
    logSubNumber:        { fontSize: 11, color: colors.textMuted, marginBottom: 2, fontFamily: 'monospace' },
    logType:             { fontSize: 11, fontWeight: '600' },
    logRight:            { alignItems: 'flex-end', gap: 2 },
    logTime:             { fontSize: 12, fontWeight: '600', color: colors.textSec },
    logDate:             { fontSize: 11, color: colors.textMuted },
    logDuration:         { fontSize: 11, color: colors.textMuted },
    emptyState:          { alignItems: 'center', paddingTop: 80 },
    emptyTitle:          { fontSize: 17, fontWeight: '700', color: colors.textSec, marginTop: 14 },
    emptySubtitle:       { fontSize: 13, color: colors.textMuted, marginTop: 6, textAlign: 'center', paddingHorizontal: 32 },
    agentTab:            { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    agentTabActive:      { backgroundColor: colors.blueBg, borderColor: colors.blue },
    agentTabText:        { color: colors.textSec, fontSize: 12, fontWeight: '600' },
    agentTabTextActive:  { color: colors.textPrimary },
    logAgent:            { fontSize: 10, color: colors.textMuted, marginTop: 2 },
  });
}