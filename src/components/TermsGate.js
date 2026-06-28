// src/components/TermsGate.js
// ─────────────────────────────────────────────────────────────────────────────
// Mobile equivalent of the web TermsGate. Blocks the app after login until the
// employee accepts the current Terms & Conditions version. Re-appears whenever
// a new version is published.
//
// RULES:
//   • The mobile app is employee-only, so every user must accept.
//   • The Accept checkbox stays DISABLED until the user scrolls to the bottom
//     of the terms.
//
// Usage (AppNavigator): wrap GatedMainTabs' content — terms BEFORE clock-in:
//   <TermsGate><ClockInGate><MainTabs/></ClockInGate></TermsGate>
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
  StyleSheet, Alert,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import api from '../services/api';
import { COLORS, RADIUS, FONT } from '../theme/tokens';

export default function TermsGate({ children }) {
  const [loading, setLoading]         = useState(true);
  const [mustAccept, setMustAccept]   = useState(false);
  const [terms, setTerms]             = useState(null);
  const [version, setVersion]         = useState(null);

  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const [checked, setChecked]                   = useState(false);
  const [submitting, setSubmitting]             = useState(false);

  const fetchTerms = useCallback(async () => {
    try {
      const { data } = await api.get('/terms/current');
      setMustAccept(!!data?.mustAccept);
      setTerms(data?.terms || null);
      setVersion(data?.version ?? null);
    } catch {
      // Fail open — don't trap the user if the endpoint errors.
      setMustAccept(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTerms(); }, [fetchTerms]);

  const onScroll = useCallback((e) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    const atBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - 12;
    if (atBottom) setScrolledToBottom(true);
  }, []);

  // Short content that doesn't scroll → enable immediately.
  const onContentSizeChange = useCallback((_w, h) => {
    // If content fits without scrolling we can't detect a bottom scroll, so
    // unlock once we know the content height is small. We compare against a
    // generous viewport guess; the onScroll path covers the normal case.
    if (h > 0 && h < 400) setScrolledToBottom(true);
  }, []);

  const handleAccept = async () => {
    if (!checked || !scrolledToBottom || submitting) return;
    setSubmitting(true);
    try {
      await api.post('/terms/accept', { version });
      setMustAccept(false);
    } catch (err) {
      if (err?.response?.data?.code === 'TERMS_VERSION_MISMATCH') {
        setChecked(false);
        setScrolledToBottom(false);
        await fetchTerms();
      } else {
        Alert.alert('Failed', err?.response?.data?.message || 'Could not record acceptance. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={COLORS.blue} size="large" />
        <Text style={s.muted}>Loading…</Text>
      </View>
    );
  }

  if (!mustAccept || !terms) return children;

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Text style={s.title}>{terms.title || 'Terms & Conditions'}</Text>
        {terms.effectiveDate ? (
          <Text style={s.effective}>Effective Date: {terms.effectiveDate}</Text>
        ) : null}
        <Text style={s.warn}>Please scroll to the bottom to read the full terms before you can accept.</Text>
      </View>

      <ScrollView
        style={s.body}
        contentContainerStyle={s.bodyContent}
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
        scrollEventThrottle={16}
      >
        {terms.intro ? <Text style={s.para}>{terms.intro}</Text> : null}
        {(terms.sections || []).map((sec, i) => (
          <Text key={i} style={[s.para, s.section]}>
            {sec.heading ? sec.heading + ' ' : ''}{sec.body || ''}
          </Text>
        ))}
        <Text style={s.end}>— End of Terms & Conditions —</Text>
      </ScrollView>

      <View style={s.footer}>
        {!scrolledToBottom ? (
          <Text style={s.scrollHint}>↓ Scroll down to read all the terms.</Text>
        ) : null}

        <TouchableOpacity
          style={[s.checkRow, !scrolledToBottom && { opacity: 0.5 }]}
          activeOpacity={scrolledToBottom ? 0.7 : 1}
          onPress={() => { if (scrolledToBottom) setChecked(c => !c); }}
          disabled={!scrolledToBottom}
        >
          <Icon
            name={checked ? 'checkbox-marked' : 'checkbox-blank-outline'}
            size={22}
            color={checked ? COLORS.blue : '#64748B'}
          />
          <Text style={s.checkLabel}>
            I have read, understood and agree to the Terms & Conditions.
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.acceptBtn, (!checked || !scrolledToBottom || submitting) && { opacity: 0.5 }]}
          onPress={handleAccept}
          disabled={!checked || !scrolledToBottom || submitting}
          activeOpacity={0.85}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={s.acceptText}>Accept & Continue</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root:   { flex: 1, backgroundColor: '#0B1120' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0B1120' },
  muted:  { color: COLORS.textMuted, marginTop: 12, fontSize: FONT.sm },

  header: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12, borderBottomWidth: 1, borderColor: '#1E2330' },
  title:  { color: '#F1F5F9', fontSize: 18, fontWeight: '800' },
  effective: { color: '#94A3B8', fontSize: 12, marginTop: 4 },
  warn:   { color: '#FCD34D', fontSize: 12, marginTop: 8 },

  body:        { flex: 1 },
  bodyContent: { padding: 20, paddingBottom: 28 },
  section:     { marginBottom: 14 },
  para:        { color: '#CBD5E1', fontSize: 13, lineHeight: 20 },
  end:         { color: '#64748B', fontSize: 11, textAlign: 'center', marginTop: 8 },

  footer:    { padding: 18, borderTopWidth: 1, borderColor: '#1E2330', backgroundColor: '#0F172A' },
  scrollHint:{ color: '#94A3B8', fontSize: 12, marginBottom: 10 },
  checkRow:  { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  checkLabel:{ flex: 1, color: '#CBD5E1', fontSize: 13, lineHeight: 19 },
  acceptBtn: { marginTop: 16, backgroundColor: COLORS.blue || '#2563EB', borderRadius: RADIUS.md, paddingVertical: 14, alignItems: 'center' },
  acceptText:{ color: '#fff', fontSize: FONT.md, fontWeight: '800' },
});