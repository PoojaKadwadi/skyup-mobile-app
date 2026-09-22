// src/components/TermsGate.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX (this revision) — fail-open removed:
//
//   The original catch block called setMustAccept(false) on ANY API error,
//   which silently bypassed the terms gate whenever the /terms/current
//   endpoint was unreachable. The spec requires:
//     "Do not assume terms are accepted when the API fails."
//     States: Loading | Accepted | Not Accepted | Error
//
//   Now:
//     • Loading     — fetch in flight
//     • mustAccept=false, terms=null  — server says no terms needed (or
//                                       user already accepted) — render children
//     • mustAccept=true, terms≠null   — show gate; user must scroll + accept
//     • fetchError=true               — API failed; show error with retry
//
//   On API error we render a retry screen instead of passing the user through.
//   If the server explicitly says mustAccept=false (no terms configured), we
//   still pass the user through — that is intended behaviour, not fail-open.
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
  const [loading,    setLoading]    = useState(true);
  const [fetchError, setFetchError] = useState(false); // FIX: track API error separately
  const [mustAccept, setMustAccept] = useState(false);
  const [terms,      setTerms]      = useState(null);
  const [version,    setVersion]    = useState(null);

  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const [checked,          setChecked]           = useState(false);
  const [submitting,       setSubmitting]         = useState(false);

  const fetchTerms = useCallback(async () => {
    setLoading(true);
    setFetchError(false);
    try {
      const { data } = await api.get('/terms/current');
      // FIX: only set mustAccept=false when the SERVER explicitly says so.
      // A network/parse error must NOT reach this path.
      setMustAccept(!!data?.mustAccept);
      setTerms(data?.terms || null);
      setVersion(data?.version ?? null);
    } catch {
      // FIX: do NOT call setMustAccept(false) here — that was the fail-open bug.
      // Instead, set a separate error flag and show a retry screen.
      setFetchError(true);
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

  const onContentSizeChange = useCallback((_w, h) => {
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

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={COLORS.blue} size="large" />
        <Text style={s.muted}>Loading…</Text>
      </View>
    );
  }

  // ── FIX: API error — show retry screen, do NOT pass user through ──────────
  if (fetchError) {
    return (
      <View style={s.center}>
        <Icon name="wifi-off" size={48} color={COLORS.red} style={{ marginBottom: 16 }} />
        <Text style={[s.muted, { fontSize: 16, color: '#F1F5F9', marginBottom: 8 }]}>
          Could not load Terms
        </Text>
        <Text style={s.muted}>
          Unable to reach the server. Please check your connection and try again.
        </Text>
        <TouchableOpacity
          style={s.retryBtn}
          onPress={fetchTerms}
          activeOpacity={0.8}
        >
          <Icon name="refresh" size={16} color="#fff" style={{ marginRight: 6 }} />
          <Text style={s.retryBtnText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── No terms required or already accepted — pass through ─────────────────
  if (!mustAccept || !terms) return children;

  // ── Terms gate ────────────────────────────────────────────────────────────
  return (
    <View style={s.root}>
      <View style={s.header}>
        <Text style={s.title}>{terms.title || 'Terms & Conditions'}</Text>
        {terms.effectiveDate ? <Text style={s.effective}>Effective Date: {terms.effectiveDate}</Text> : null}
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
        {!scrolledToBottom ? <Text style={s.scrollHint}>↓ Scroll down to read all the terms.</Text> : null}

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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0B1120', paddingHorizontal: 32 },
  muted:  { color: COLORS.textMuted, marginTop: 12, fontSize: FONT.sm, textAlign: 'center' },
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
  retryBtn: { flexDirection: 'row', alignItems: 'center', marginTop: 24, backgroundColor: COLORS.blue || '#2563EB', borderRadius: RADIUS.md, paddingVertical: 12, paddingHorizontal: 28 },
  retryBtnText: { color: '#fff', fontWeight: '700', fontSize: FONT.md },
});
