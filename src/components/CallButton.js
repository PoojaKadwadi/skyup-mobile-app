// src/components/CallButton.js
// ─────────────────────────────────────────────────────────────────────────────
//  CallButton — a thin "dial this number" trigger.
//
//  FIX (call → instant remark popup):
//    CallButton used to register its OWN AppState listener to detect the end of
//    a call. That listener:
//      • had NO minimum-duration guard, so it fired on the very first
//        background→foreground flicker (dual-SIM chooser, permission dialog,
//        notification shade) — long before the real call ended, and
//      • ran in PARALLEL with the identical listener inside LeadDetailScreen,
//        so post-call syncs fired twice and the two listeners raced.
//
//    Post-call detection now lives in ONE place — LeadDetailScreen — where it
//    waits for a genuine call (real background transition + minimum duration)
//    before opening the remark modal. CallButton's job is simply: open the
//    dialer and tell the parent a call was started. No AppState, no sync, no
//    ghost listener left behind on unmount.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { TouchableOpacity, StyleSheet, Vibration, Linking } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';

import { sanitizeForDial } from '../services/phoneService';

export default function CallButton({ phoneNumber, onCallStart, size = 'normal' }) {
  if (!phoneNumber) return null;

  const handlePress = async () => {
    try {
      Vibration.vibrate(30);

      // Shared dial sanitiser so CallButton, LeadDetailScreen and phoneService
      // all build the tel: URI identically (keeps a leading "+" and all digits;
      // strips spaces, dashes, parens, dots and invisible unicode).
      const dialNumber = sanitizeForDial(phoneNumber);
      if (!dialNumber) {
        console.warn('[CallButton] No valid number to dial:', JSON.stringify(phoneNumber));
        return;
      }

      // Notify the parent FIRST so it can arm its post-call detector BEFORE the
      // app leaves the foreground — no background transition is ever missed.
      onCallStart?.(phoneNumber);

      // canOpenURL for tel: can falsely return false on Android 11+ when the
      // dialer package isn't declared in <queries>; openURL handles tel:
      // natively, so call it directly and catch any failure instead of bailing.
      await Linking.openURL(`tel:${dialNumber}`);
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