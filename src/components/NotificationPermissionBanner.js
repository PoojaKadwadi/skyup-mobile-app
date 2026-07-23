// src/components/NotificationPermissionBanner.js
// ─────────────────────────────────────────────────────────────────────────────
// Shows a small persistent banner when POST_NOTIFICATIONS is not granted.
// Rendered inside DashboardScreen (or any main screen) once after login.
//
// Why this is needed:
//   Android 13+ requires the user to explicitly tap "Allow" on a system dialog
//   for POST_NOTIFICATIONS. notifee.requestPermission() does nothing on Android.
//   If the user dismissed the dialog without allowing, we must send them to
//   Settings. This banner handles both cases.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Linking, PermissionsAndroid } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';

const POST_NOTIF = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;

export default function NotificationPermissionBanner() {
  const [status, setStatus] = useState(null); // null | 'denied' | 'blocked'

  useEffect(() => {
    if (Platform.OS !== 'android' || Platform.Version < 33 || !POST_NOTIF) return;
    checkStatus();
  }, []);

  const checkStatus = async () => {
    try {
      const granted = await PermissionsAndroid.check(POST_NOTIF);
      setStatus(granted ? null : 'denied');
    } catch {}
  };

  const handleAllow = async () => {
    if (status === 'blocked') {
      // Can't request again — send to Settings
      Linking.openSettings();
      return;
    }
    try {
      const result = await PermissionsAndroid.request(POST_NOTIF);
      if (result === PermissionsAndroid.RESULTS.GRANTED) setStatus(null);
      else if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) setStatus('blocked');
      else setStatus('denied');
    } catch {}
  };

  if (!status) return null;

  return (
    <View style={styles.banner}>
      <Icon name="bell-off-outline" size={18} color="#FCD34D" style={{ marginRight: 8 }} />
      <Text style={styles.text} numberOfLines={2}>
        Notifications are off — you won't receive lead or follow-up alerts.
      </Text>
      <TouchableOpacity style={styles.btn} onPress={handleAllow}>
        <Text style={styles.btnText}>{status === 'blocked' ? 'Settings' : 'Enable'}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => setStatus(null)} style={{ paddingLeft: 8 }}>
        <Icon name="close" size={16} color="#94A3B8" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection:   'row',
    alignItems:      'center',
    backgroundColor: '#1C1A07',
    borderColor:     '#CA8A04',
    borderWidth:     1,
    borderRadius:    10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginHorizontal: 16,
    marginBottom:    12,
  },
  text: {
    flex:       1,
    color:      '#FCD34D',
    fontSize:   12,
    lineHeight: 17,
  },
  btn: {
    backgroundColor: '#CA8A04',
    borderRadius:    7,
    paddingVertical: 5,
    paddingHorizontal: 10,
    marginLeft:      8,
  },
  btnText: {
    color:      '#000',
    fontSize:   12,
    fontWeight: '700',
  },
});