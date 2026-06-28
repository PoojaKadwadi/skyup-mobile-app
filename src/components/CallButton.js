// src/components/CallButton.js
// FIXES:
//  1. useEffect cleanup removes AppState listener on unmount — prevents ghost
//     syncs and memory leak when navigating away during an active call.
//  2. appStateRef always reflects the latest state (was already correct).

import React, { useRef, useEffect } from 'react';
import { TouchableOpacity, StyleSheet, Vibration, AppState, Linking } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';

import { triggerPostCallRecordingSync } from '../services/backgroundSyncService';
import { syncCallLogs }                 from '../api/callLogsApi';
import { getCallLogsForNumber, sanitizeForDial } from '../services/phoneService';

export default function CallButton({ phoneNumber, onCallStart, onCallEnd, size = 'normal' }) {
  const appStateRef = useRef(AppState.currentState);
  const listenerRef = useRef(null);

  // FIX: Remove listener when component unmounts.
  // Previously no cleanup existed — navigating away mid-call left a dangling
  // AppState listener that kept firing on every foreground transition.
  useEffect(() => {
    return () => {
      listenerRef.current?.remove();
      listenerRef.current = null;
    };
  }, []);

  if (!phoneNumber) return null;

  const handlePress = async () => {
    try {
      Vibration.vibrate(30);

      // Use the shared dial sanitiser so CallButton, LeadDetailScreen, and
      // phoneService all build the tel: URI identically (keeps a leading "+"
      // and all digits; strips spaces, dashes, parens, dots, invisible unicode).
      const dialNumber = sanitizeForDial(phoneNumber);

      // Guard: nothing dialable → don't launch an empty dialer.
      if (!dialNumber) {
        console.warn('[CallButton] No valid number to dial:', JSON.stringify(phoneNumber));
        return;
      }

      const dialUri = `tel:${dialNumber}`;

      // NOTE: canOpenURL for tel: can falsely return false on Android 11+ when
      // the dialer package isn't declared in <queries>. openURL handles tel:
      // natively, so call it directly and catch any failure instead of bailing.
      await Linking.openURL(dialUri);
      onCallStart?.(phoneNumber);

      listenerRef.current?.remove();
      listenerRef.current = AppState.addEventListener('change', async (nextState) => {
        if (appStateRef.current.match(/inactive|background/) && nextState === 'active') {
          listenerRef.current?.remove();
          listenerRef.current = null;

          const callEndedAt = Date.now();

          try {
            const logs = await getCallLogsForNumber(phoneNumber);
            if (logs.length > 0) await syncCallLogs(logs.slice(0, 5));
          } catch {}

          try {
            await triggerPostCallRecordingSync(phoneNumber, callEndedAt);
          } catch {}

          onCallEnd?.(phoneNumber);
        }
        appStateRef.current = nextState;
      });

    } catch (e) {
      console.warn('[CallButton] error:', e.message);
    }
  };

  const iconSize = size === 'small' ? 18 : size === 'large' ? 24 : 20;

  return (
    <TouchableOpacity
      style={[styles.btn, styles[`btn_${size}`]]}
      onPress={handlePress}
      activeOpacity={0.75}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Icon name="phone" size={iconSize} color="#fff" />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn:        { backgroundColor: '#059669', borderRadius: 10, alignItems: 'center', justifyContent: 'center', elevation: 2 },
  btn_small:  { width: 36, height: 36 },
  btn_normal: { width: 42, height: 42, borderRadius: 12 },
  btn_large:  { width: 56, height: 56, borderRadius: 16 },
});