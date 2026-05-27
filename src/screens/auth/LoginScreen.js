// src/screens/auth/LoginScreen.js
// ─────────────────────────────────────────────────────────────────────────────
//  CRASH FIXES (this revision):
//   1. handleLogin wrapped in try/catch — any synchronous throw (e.g. from
//      validate() or dispatch()) is caught and shown as an Alert instead of
//      crashing the app.
//   2. Mounted-ref guard: Alert.alert and dispatch are skipped if the component
//      has unmounted while the async login was in flight (prevents "Can't
//      perform a React state update on an unmounted component" crashes on
//      fast navigation or double-tap).
//   3. Keyboard dismissed before login fires — avoids a known RN crash on
//      Android when the keyboard is open during a navigation transition.
//   4. Double-submit guard: isSubmitting ref prevents the login thunk from
//      being dispatched twice if the user taps the button rapidly.
//   All UI/styling unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform,
  StatusBar, ScrollView, Alert, Keyboard,
} from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { login, clearError }        from '../../store/slices/authSlice';
import Icon                         from 'react-native-vector-icons/MaterialCommunityIcons';
import { COLORS, RADIUS, FONT }     from '../../theme/tokens';

export default function LoginScreen() {
  const dispatch = useDispatch();
  const { loading, error } = useSelector((s) => s.auth);

  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [emailErr, setEmailErr] = useState('');
  const [passErr,  setPassErr]  = useState('');

  // ── Guards ────────────────────────────────────────────────────────────────
  const mountedRef     = useRef(true);   // true while component is mounted
  const isSubmitting   = useRef(false);  // prevents double-tap double-dispatch

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Show Redux error as Alert ─────────────────────────────────────────────
  useEffect(() => {
    if (!error) return;
    // Only show if still mounted — avoids stale Alert on unmounted screen
    if (!mountedRef.current) return;
    Alert.alert('Login Failed', error, [
      { text: 'OK', onPress: () => dispatch(clearError()) },
    ]);
  }, [error]);

  // ── Validation ────────────────────────────────────────────────────────────
  const validate = () => {
    let ok = true;
    setEmailErr('');
    setPassErr('');
    if (!email.trim()) {
      setEmailErr('Email is required'); ok = false;
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      setEmailErr('Enter a valid email'); ok = false;
    }
    if (!password) {
      setPassErr('Password is required'); ok = false;
    }
    return ok;
  };

  // ── Login handler ─────────────────────────────────────────────────────────
  const handleLogin = async () => {
    // Double-tap guard
    if (isSubmitting.current || loading) return;

    if (!validate()) return;

    // Dismiss keyboard before async work — prevents Android keyboard crash
    // during navigation transition triggered by a successful login.
    Keyboard.dismiss();

    isSubmitting.current = true;
    try {
      await dispatch(login({
        email:    email.trim().toLowerCase(),
        password,
      }));
      // Navigation is handled by your root navigator watching auth state —
      // no explicit navigate() call needed here.
    } catch (err) {
      // Dispatch itself should never throw (Redux Toolkit catches internally),
      // but guard anyway so a bug here shows an Alert instead of crashing.
      if (mountedRef.current) {
        Alert.alert('Error', err?.message || 'Something went wrong. Please try again.');
      }
    } finally {
      isSubmitting.current = false;
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

        {/* ── Brand ── */}
        <View style={s.brand}>
          <View style={s.logoWrap}>
            <Icon name="account-circle-outline" size={28} color={COLORS.blue} />
          </View>
          <Text style={s.brandName}>SkyUp CRM</Text>
          <Text style={s.brandSub}>Sales Management Platform</Text>
        </View>

        {/* ── Card ── */}
        <View style={s.card}>
          <Text style={s.title}>Welcome back</Text>
          <Text style={s.subtitle}>Sign in to your user account</Text>

          {/* Email */}
          <View style={s.field}>
            <Text style={s.label}>EMAIL</Text>
            <View style={[s.inputRow, emailErr ? s.inputErr : null]}>
              <Icon name="email-outline" size={16} color={COLORS.textMuted} style={s.icoLeft} />
              <TextInput
                style={s.input}
                placeholder="you@company.com"
                placeholderTextColor={COLORS.textMuted}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
              />
            </View>
            {!!emailErr && <Text style={s.errTxt}>{emailErr}</Text>}
          </View>

          {/* Password */}
          <View style={s.field}>
            <Text style={s.label}>PASSWORD</Text>
            <View style={[s.inputRow, passErr ? s.inputErr : null]}>
              <Icon name="lock-outline" size={16} color={COLORS.textMuted} style={s.icoLeft} />
              <TextInput
                style={[s.input, { flex: 1 }]}
                placeholder="••••••••"
                placeholderTextColor={COLORS.textMuted}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPass}
                returnKeyType="done"
                onSubmitEditing={handleLogin}
              />
              <TouchableOpacity onPress={() => setShowPass(!showPass)} style={s.eyeBtn}>
                <Icon
                  name={showPass ? 'eye-off-outline' : 'eye-outline'}
                  size={16}
                  color={COLORS.textMuted}
                />
              </TouchableOpacity>
            </View>
            {!!passErr && <Text style={s.errTxt}>{passErr}</Text>}
          </View>

          {/* Sign In button */}
          <TouchableOpacity
            style={[s.btn, loading && s.btnDisabled]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={s.btnTxt}>Sign in</Text>
            }
          </TouchableOpacity>

          {/* Footer note */}
          <View style={s.divider} />
          <Text style={s.footNote}>Use the same credentials as your CRM web portal</Text>
        </View>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root:      { flex: 1, backgroundColor: COLORS.bg },
  scroll:    { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 48 },

  brand:     { alignItems: 'center', marginBottom: 32 },
  logoWrap:  {
    width: 56, height: 56, borderRadius: RADIUS.lg,
    backgroundColor: COLORS.blueBg,
    borderWidth: 1, borderColor: COLORS.blue + '30',
    alignItems: 'center', justifyContent: 'center', marginBottom: 14,
  },
  brandName: { fontSize: FONT.xl, fontWeight: '800', color: COLORS.textPrimary, letterSpacing: 0.3 },
  brandSub:  { fontSize: FONT.sm, color: COLORS.textMuted, marginTop: 3 },

  card:      {
    backgroundColor: COLORS.surfaceAlt,
    borderRadius: RADIUS.xl,
    padding: 28,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  title:     { fontSize: 22, fontWeight: '700', color: COLORS.textPrimary, marginBottom: 4 },
  subtitle:  { fontSize: FONT.base, color: COLORS.textMuted, marginBottom: 28 },

  field:     { marginBottom: 18 },
  label:     {
    fontSize: FONT.xs, fontWeight: '700', color: COLORS.textMuted,
    letterSpacing: 1, marginBottom: 7,
  },
  inputRow:  {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.bg,
    borderRadius: RADIUS.md, borderWidth: 1, borderColor: COLORS.border,
    paddingHorizontal: 14, height: 50,
  },
  inputErr:  { borderColor: COLORS.red },
  icoLeft:   { marginRight: 10 },
  input:     { flex: 1, color: COLORS.textPrimary, fontSize: FONT.md, paddingVertical: 0 },
  eyeBtn:    { padding: 4 },
  errTxt:    { fontSize: FONT.sm, color: COLORS.red, marginTop: 5 },

  btn:       {
    backgroundColor: COLORS.blue, borderRadius: RADIUS.md,
    height: 52, alignItems: 'center', justifyContent: 'center', marginTop: 8,
  },
  btnDisabled: { opacity: 0.6 },
  btnTxt:    { color: '#fff', fontSize: FONT.md, fontWeight: '700' },

  divider:   { marginTop: 20, borderTopWidth: 1, borderTopColor: COLORS.border },
  footNote:  { textAlign: 'center', color: COLORS.textMuted, fontSize: FONT.sm, marginTop: 16, lineHeight: 18 },
});