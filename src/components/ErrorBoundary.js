// src/components/ErrorBoundary.js
// ─────────────────────────────────────────────────────────────────────────────
// Top-level React error boundary.
//
// WHY: The app previously had NO error boundary anywhere. Any uncaught render
// error in any screen would unmount the entire React tree and show the native
// crash / red screen — i.e. the "app suddenly crashed sometimes" reports.
// A render error in one screen should NOT take down the whole app.
//
// WHAT THIS DOES:
//   • Catches render-phase exceptions thrown by any descendant.
//   • Shows a recoverable fallback screen with a "Try Again" button that
//     resets the boundary so the user can keep using the app.
//   • Logs the error + component stack to the console (visible in Logcat via
//     `adb logcat | grep ReactNativeJS`) so you can identify the exact screen
//     and line that threw.
//
// NOTE: Error boundaries only catch errors during rendering, in lifecycle
// methods, and in constructors of the tree below them. They do NOT catch:
//   • errors inside event handlers (use try/catch there),
//   • async errors (promise rejections),
//   • errors in the boundary itself.
// Those are already largely guarded elsewhere; this covers the render path,
// which is the usual source of a full white-screen crash.
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // Surface the real cause in Logcat so the offending screen is identifiable.
    console.error(
      '[ErrorBoundary] Caught render error:',
      error?.message,
      '\nComponent stack:',
      info?.componentStack,
    );
    this.setState({ info });
    // If you later add crashlytics, report here:
    // try { require('@react-native-firebase/crashlytics').default().recordError(error); } catch {}
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, info: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <View style={s.root}>
        <ScrollView contentContainerStyle={s.content}>
          <Text style={s.emoji}>⚠️</Text>
          <Text style={s.title}>Something went wrong</Text>
          <Text style={s.subtitle}>
            The screen ran into an unexpected error. You can try again — the rest
            of the app is still working.
          </Text>

          {this.state.error ? (
            <View style={s.devBox}>
              <Text style={s.devLabel}>
                {__DEV__ ? 'Error (dev only):' : 'Error details (tap to screenshot for support):'}
              </Text>
              <Text style={s.devText}>{String(this.state.error?.message || this.state.error)}</Text>
            </View>
          ) : null}

          <TouchableOpacity style={s.btn} onPress={this.handleReset} activeOpacity={0.85}>
            <Text style={s.btnText}>Try Again</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0B1120' },
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emoji: { fontSize: 44, marginBottom: 16 },
  title: { color: '#F1F5F9', fontSize: 20, fontWeight: '800', marginBottom: 10, textAlign: 'center' },
  subtitle: { color: '#94A3B8', fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: 24 },
  devBox: {
    alignSelf: 'stretch', backgroundColor: '#1A1D27', borderRadius: 10,
    padding: 12, borderWidth: 1, borderColor: '#3F2530', marginBottom: 24,
  },
  devLabel: { color: '#F87171', fontSize: 11, fontWeight: '700', marginBottom: 6, textTransform: 'uppercase' },
  devText: { color: '#FCA5A5', fontSize: 12, fontFamily: 'monospace' },
  btn: {
    backgroundColor: '#2563EB', borderRadius: 12,
    paddingVertical: 14, paddingHorizontal: 48, alignSelf: 'stretch', alignItems: 'center',
  },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});