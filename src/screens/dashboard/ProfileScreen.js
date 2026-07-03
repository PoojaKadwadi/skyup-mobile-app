// src/screens/dashboard/ProfileScreen.js
import React from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, StatusBar,
  ScrollView, Modal, ActivityIndicator, Switch,
} from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import Icon                         from 'react-native-vector-icons/MaterialCommunityIcons';
import { logout }                   from '../../store/slices/authSlice';
import { checkAllPermissions, requestCallPermission,
         requestCallLogPermission, requestStoragePermission,
         requestLocationPermission }
  from '../../services/permissionsService';
import { triggerManualSync }        from '../../services/backgroundSyncService';
import { getCustomRecordingPath, setCustomRecordingPath } from '../../services/recordingPathService';
import { isAutoUploadEnabled, setAutoUpload } from '../../services/autoUploadService';
import { useTheme }                 from '../../theme/ThemeContext';
import moment from 'moment';

let RNFS;
try { RNFS = require('react-native-fs'); } catch {}

export default function ProfileScreen() {
  const dispatch = useDispatch();
  const { user } = useSelector((s) => s.auth);
  const { lastSyncedAt } = useSelector((s) => s.calls);
  const { pendingQueue }  = useSelector((s) => s.sync);
  const { dark, toggle, colors } = useTheme();
  const styles = React.useMemo(() => createStyles(colors), [colors]);

  const [perms, setPerms] = React.useState({ callPhone: false, readCallLog: false, readStorage: false, readContacts: false, location: false });
  const [customPath,     setCustomPath]     = React.useState(null);   // saved folder
  const [browsedPath,    setBrowsedPath]    = React.useState(null);   // currently browsing
  const [browseEntries,  setBrowseEntries]  = React.useState([]);     // folder contents
  const [browseLoading,  setBrowseLoading]  = React.useState(false);
  const [showBrowser,    setShowBrowser]    = React.useState(false);
  const [browserStack,   setBrowserStack]   = React.useState([]);     // navigation history
  const [autoUpload,     setAutoUploadState] = React.useState(true);  // in-app toggle
  const [autoUploadBusy, setAutoUploadBusy]  = React.useState(false);

  React.useEffect(() => {
    checkAllPermissions().then(setPerms);
    getCustomRecordingPath().then(setCustomPath);
    isAutoUploadEnabled().then(setAutoUploadState).catch(() => {});
  }, []);

  // Toggle the auto-upload foreground service on/off and persist the choice.
  const handleAutoUploadToggle = async (next) => {
    setAutoUploadBusy(true);
    setAutoUploadState(next); // optimistic
    try {
      await setAutoUpload(next);
      if (next) {
        Alert.alert(
          'Auto-upload ON',
          'A small ongoing notification keeps the app active so recordings upload automatically after each call. You can turn this off anytime.',
        );
      }
    } catch (e) {
      setAutoUploadState(!next); // revert on failure
      Alert.alert('Could not change setting', e?.message || 'Please try again.');
    } finally {
      setAutoUploadBusy(false);
    }
  };

  // ── Folder browser logic ───────────────────────────────────────────────────
  const openBrowser = async () => {
    const root = '/storage/emulated/0';
    await browseDir(root);
    setBrowserStack([]);
    setShowBrowser(true);
  };

  const browseDir = async (path) => {
    if (!RNFS) {
      Alert.alert('Module Missing', 'react-native-fs is required.\nRun: npm install react-native-fs');
      return;
    }
    setBrowseLoading(true);
    setBrowsedPath(path);
    try {
      const granted = await requestStoragePermission();
      if (!granted) { Alert.alert('Permission Required', 'Storage permission is needed to browse folders.'); return; }
      const entries = await RNFS.readDir(path);
      // Show only directories, sorted alphabetically
      const dirs = entries
        .filter(e => {
          const isDir = typeof e.isDirectory === 'function' ? e.isDirectory() :
                        typeof e.isDirectory === 'boolean'  ? e.isDirectory  : !e.name.includes('.');
          return isDir;
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      setBrowseEntries(dirs);
    } catch (e) {
      Alert.alert('Cannot Open Folder', e.message);
    } finally {
      setBrowseLoading(false);
    }
  };

  const navigateInto = (entry) => {
    setBrowserStack(prev => [...prev, browsedPath]);
    browseDir(entry.path);
  };

  const navigateBack = () => {
    if (browserStack.length === 0) return;
    const prev = browserStack[browserStack.length - 1];
    setBrowserStack(s => s.slice(0, -1));
    browseDir(prev);
  };

  const selectCurrentFolder = async () => {
    if (!browsedPath) return;
    const saved = await setCustomRecordingPath(browsedPath);
    if (saved) {
      setCustomPath(browsedPath);
      setShowBrowser(false);
      Alert.alert(
        '✅ Recording Folder Set',
        `Recordings will now be scanned from:\n\n${browsedPath}\n\nEvery scan and auto-sync after a call will check this folder first.`,
      );
    }
  };

  const clearCustomPath = () => {
    Alert.alert('Remove Custom Folder', 'Remove the saved recording folder? The app will fall back to scanning all common locations.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
          await setCustomRecordingPath(null);
          setCustomPath(null);
        }
      },
    ]);
  };

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => dispatch(logout()) },
    ]);
  };

  const requestPerm = async (type) => {
    if (type === 'call')     await requestCallPermission();
    if (type === 'callLog')  await requestCallLogPermission();
    if (type === 'storage')  await requestStoragePermission();
    if (type === 'contacts') {
      // FIX: Use PermissionsAndroid (built-in) — react-native-permissions
      // is not in the compiled bundle so require() throws silently.
      const { PermissionsAndroid } = require('react-native');
      await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.READ_CONTACTS,
        PermissionsAndroid.PERMISSIONS.WRITE_CONTACTS,
      ]);
    }
    if (type === 'location')  await requestLocationPermission();
    const updated = await checkAllPermissions();
    setPerms(updated);
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={colors.surface} />
      <ScrollView showsVerticalScrollIndicator={false}>

        {/* Profile Card */}
        <View style={styles.profileCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(user?.name || 'U').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
            </Text>
          </View>
          <Text style={styles.userName}>{user?.name || 'Agent'}</Text>
          <Text style={styles.userEmail}>{user?.email || ''}</Text>
          <View style={styles.roleBadge}>
            <Text style={styles.roleText}>{(user?.role || 'user').toUpperCase()}</Text>
          </View>
        </View>

        {/* Auto-Upload Recordings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Auto-Upload Recordings</Text>
          <View style={styles.infoCard}>
            <View style={styles.toggleRow}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.toggleLabel}>Upload after every call</Text>
                <Text style={styles.toggleHint}>
                  Keeps the app active (shows a small ongoing notification) so call
                  recordings upload automatically right after a call ends — even on
                  phones that aggressively close background apps.
                </Text>
              </View>
              {autoUploadBusy
                ? <ActivityIndicator size="small" color={colors.blue} />
                : (
                  <Switch
                    value={autoUpload}
                    onValueChange={handleAutoUploadToggle}
                    trackColor={{ false: colors.border, true: '#1D4ED8' }}
                    thumbColor={autoUpload ? '#60A5FA' : colors.textSec}
                  />
                )}
            </View>
          </View>
        </View>

        {/* Sync Status */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Sync Status</Text>
          <View style={styles.infoCard}>
            <Row icon="cloud-check" label="Last Synced"
              value={lastSyncedAt ? moment(lastSyncedAt).format('DD MMM, hh:mm A') : 'Never'} />
            <Row icon="clock-outline" label="Pending Items"
              value={pendingQueue.length > 0 ? `${pendingQueue.length} queued` : 'None'} />
            <TouchableOpacity style={styles.syncBtn} onPress={triggerManualSync}>
              <Icon name="sync" size={16} color={colors.blue} style={{ marginRight: 6 }} />
              <Text style={styles.syncBtnText}>Sync Now</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Permissions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>App Permissions</Text>
          <View style={styles.infoCard}>
            <PermRow
              label="Make Phone Calls"
              granted={perms.callPhone}
              onRequest={() => requestPerm('call')}
            />
            <PermRow
              label="Read Call Log"
              granted={perms.readCallLog}
              onRequest={() => requestPerm('callLog')}
            />
            <PermRow
              label="Read Storage (Recordings)"
              granted={perms.readStorage}
              onRequest={() => requestPerm('storage')}
            />
            <PermRow
              label="Contacts (Save to Contacts)"
              granted={perms.readContacts}
              onRequest={() => requestPerm('contacts')}
            />
            <PermRow
              label="Location (Client Check-in)"
              granted={perms.location}
              onRequest={() => requestPerm('location')}
            />
          </View>
        </View>

        {/* Recording Folder */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recording Folder</Text>
          <View style={styles.infoCard}>
            {customPath ? (
              <View style={styles.pathRow}>
                <Icon name="folder-music" size={18} color={colors.purple} style={{ marginRight: 10 }} />
                <Text style={styles.pathText} numberOfLines={2}>{customPath}</Text>
                <TouchableOpacity onPress={clearCustomPath} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Icon name="close-circle" size={18} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.pathRow}>
                <Icon name="folder-question" size={18} color={colors.textMuted} style={{ marginRight: 10 }} />
                <Text style={styles.pathHint}>No folder set — app scans all common locations</Text>
              </View>
            )}
            <TouchableOpacity style={styles.browseBtn} onPress={openBrowser}>
              <Icon name="folder-open" size={16} color={colors.purple} style={{ marginRight: 8 }} />
              <Text style={styles.browseBtnText}>{customPath ? 'Change Folder' : 'Browse & Set Folder'}</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.folderHint}>
            Open your Recorder app, note where it saves files, then select that same folder here.
            After setting this once, recordings will auto-fetch after every call.
          </Text>
        </View>

        {/* Appearance */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Appearance</Text>
          <View style={styles.infoCard}>
            <View style={styles.toggleRow}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.toggleLabel}>Dark Mode</Text>
                <Text style={styles.toggleHint}>
                  {dark ? 'Currently using the dark theme.' : 'Currently using the light theme.'}
                </Text>
              </View>
              <Switch
                value={dark}
                onValueChange={toggle}
                trackColor={{ false: '#CBD5E1', true: '#1D4ED8' }}
                thumbColor={dark ? '#60A5FA' : '#F8FAFC'}
              />
            </View>
          </View>
        </View>

        {/* App Info */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>App Info</Text>
          <View style={styles.infoCard}>
            <Row icon="information" label="Version"     value="1.0.0" />
          </View>
        </View>

        {/* Logout */}
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Icon name="logout" size={18} color={colors.red} style={{ marginRight: 8 }} />
          <Text style={styles.logoutText}>Sign Out</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ── Folder Browser Modal ──────────────────────────────────────────── */}
      <Modal
        visible={showBrowser}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setShowBrowser(false)}
      >
        <View style={styles.browserContainer}>
          {/* Header */}
          <View style={styles.browserHeader}>
            <TouchableOpacity
              onPress={browserStack.length > 0 ? navigateBack : () => setShowBrowser(false)}
              style={styles.browserBackBtn}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Icon name={browserStack.length > 0 ? 'arrow-left' : 'close'} size={22} color={colors.textPrimary} />
            </TouchableOpacity>
            <View style={{ flex: 1, marginHorizontal: 12 }}>
              <Text style={styles.browserTitle}>Choose Recording Folder</Text>
              <Text style={styles.browserPath} numberOfLines={1}>{browsedPath || ''}</Text>
            </View>
          </View>

          {/* Select This Folder button */}
          <TouchableOpacity style={styles.selectFolderBtn} onPress={selectCurrentFolder}>
            <Icon name="folder-check" size={16} color="#fff" style={{ marginRight: 8 }} />
            <Text style={styles.selectFolderText}>Use This Folder</Text>
          </TouchableOpacity>

          {/* Folder list */}
          {browseLoading ? (
            <View style={styles.browserLoader}>
              <ActivityIndicator size="large" color={colors.purple} />
              <Text style={styles.browserLoaderText}>Reading folder…</Text>
            </View>
          ) : browseEntries.length === 0 ? (
            <View style={styles.browserEmpty}>
              <Icon name="folder-open-outline" size={48} color={colors.border} />
              <Text style={styles.browserEmptyText}>No sub-folders here</Text>
              <Text style={styles.browserEmptyHint}>Tap "Use This Folder" to select the current location</Text>
            </View>
          ) : (
            <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
              {browseEntries.map((entry, idx) => (
                <TouchableOpacity
                  key={entry.path}
                  style={[styles.browserEntry, idx === 0 && { borderTopWidth: 0 }]}
                  onPress={() => navigateInto(entry)}
                  activeOpacity={0.7}
                >
                  <Icon name="folder" size={20} color={colors.purple} style={{ marginRight: 14 }} />
                  <Text style={styles.browserEntryName} numberOfLines={1}>{entry.name}</Text>
                  <Icon name="chevron-right" size={18} color={colors.textMuted} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>
      </Modal>

    </View>
  );
}

function Row({ icon, label, value }) {
  const { colors } = useTheme();
  const styles = React.useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      <Icon name={icon} size={16} color={colors.textMuted} style={{ marginRight: 10 }} />
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function PermRow({ label, granted, onRequest }) {
  const { colors } = useTheme();
  const styles = React.useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.permRow}>
      <Icon
        name={granted ? 'check-circle' : 'close-circle'}
        size={18}
        color={granted ? colors.green : colors.red}
        style={{ marginRight: 10 }}
      />
      <Text style={styles.permLabel}>{label}</Text>
      {!granted && (
        <TouchableOpacity style={styles.grantBtn} onPress={onRequest}>
          <Text style={styles.grantText}>Grant</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function createStyles(colors) {
  return StyleSheet.create({
  container:    { flex: 1, backgroundColor: colors.bg },
  profileCard:  { alignItems: 'center', paddingTop: 64, paddingBottom: 28,
                  paddingHorizontal: 20 },
  avatar:       { width: 88, height: 88, borderRadius: 28, backgroundColor: colors.blue,
                  alignItems: 'center', justifyContent: 'center', marginBottom: 16,
                  elevation: 8, shadowColor: colors.blue, shadowOpacity: 0.4,
                  shadowOffset: { width: 0, height: 4 }, shadowRadius: 12 },
  avatarText:   { color: '#fff', fontSize: 28, fontWeight: '800' },
  userName:     { fontSize: 22, fontWeight: '800', color: colors.textPrimary },
  userEmail:    { fontSize: 14, color: colors.textMuted, marginTop: 4 },
  roleBadge:    { backgroundColor: colors.blueBg, borderRadius: 20, paddingHorizontal: 14,
                  paddingVertical: 4, marginTop: 10, borderWidth: 1, borderColor: colors.blue + '50' },
  roleText:     { color: colors.blueLight, fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },
  section:      { paddingHorizontal: 20, marginBottom: 20 },
  sectionTitle: { fontSize: 11, fontWeight: '700', color: colors.textMuted,
                  textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 10 },
  infoCard:     { backgroundColor: colors.surface, borderRadius: 18, overflow: 'hidden',
                  borderWidth: 1, borderColor: colors.border },
  toggleRow:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14 },
  toggleLabel:  { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 },
  toggleHint:   { fontSize: 11, color: colors.textMuted, lineHeight: 16 },
  row:          { flexDirection: 'row', alignItems: 'center', padding: 14,
                  borderBottomWidth: 1, borderBottomColor: colors.border },
  rowLabel:     { flex: 1, color: colors.textSec, fontSize: 14 },
  rowValue:     { color: colors.textPrimary, fontSize: 13, fontWeight: '600', maxWidth: '50%', textAlign: 'right' },
  permRow:      { flexDirection: 'row', alignItems: 'center', padding: 14,
                  borderBottomWidth: 1, borderBottomColor: colors.border },
  permLabel:    { flex: 1, color: colors.textSec, fontSize: 14 },
  grantBtn:     { backgroundColor: colors.blueBg, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 4 },
  grantText:    { color: colors.blueLight, fontSize: 12, fontWeight: '700' },
  syncBtn:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  padding: 14 },
  syncBtnText:  { color: colors.blue, fontSize: 14, fontWeight: '700' },
  logoutBtn:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                  backgroundColor: colors.red + '20', marginHorizontal: 20, borderRadius: 16,
                  height: 54, borderWidth: 1, borderColor: colors.red + '40' },
  logoutText:   { color: colors.red, fontSize: 16, fontWeight: '700' },

  // ── Recording folder section ──────────────────────────────────────────────
  pathRow:         { flexDirection: 'row', alignItems: 'center', padding: 14,
                     borderBottomWidth: 1, borderBottomColor: colors.border },
  pathText:        { flex: 1, color: colors.purpleLight, fontSize: 13, fontWeight: '600' },
  pathHint:        { flex: 1, color: colors.textMuted, fontSize: 13 },
  browseBtn:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                     padding: 14 },
  browseBtnText:   { color: colors.purple, fontSize: 14, fontWeight: '700' },
  folderHint:      { fontSize: 12, color: colors.textMuted, marginTop: 8, lineHeight: 18,
                     paddingHorizontal: 4 },

  // ── Folder browser modal ──────────────────────────────────────────────────
  browserContainer: { flex: 1, backgroundColor: colors.bg },
  browserHeader:    { flexDirection: 'row', alignItems: 'center', paddingTop: 52,
                      paddingBottom: 16, paddingHorizontal: 16,
                      borderBottomWidth: 1, borderBottomColor: colors.border,
                      backgroundColor: colors.bg },
  browserBackBtn:   { padding: 4 },
  browserTitle:     { fontSize: 16, fontWeight: '800', color: colors.textPrimary },
  browserPath:      { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  selectFolderBtn:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                      backgroundColor: colors.purple, margin: 16, borderRadius: 14, height: 48 },
  selectFolderText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  browserEntry:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20,
                      paddingVertical: 16, borderTopWidth: 1, borderTopColor: colors.border },
  browserEntryName: { flex: 1, color: colors.textPrimary, fontSize: 15 },
  browserLoader:    { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  browserLoaderText:{ color: colors.textMuted, fontSize: 14, marginTop: 12 },
  browserEmpty:     { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  browserEmptyText: { color: colors.textMuted, fontSize: 16, fontWeight: '700', marginTop: 16 },
  browserEmptyHint: { color: colors.textMuted, fontSize: 13, marginTop: 8, textAlign: 'center' },
  });
}