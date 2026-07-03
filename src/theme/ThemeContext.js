// src/theme/ThemeContext.js
// Light/Dark theme provider for the mobile app — mirrors the web frontend's
// src/context/ThemeContext.jsx (same "dark" boolean + toggle() shape), but
// persists the choice with AsyncStorage instead of localStorage.
//
// Usage:
//   const { dark, toggle, colors } = useTheme();
//   <View style={{ backgroundColor: colors.bg }}>...

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getColors } from './tokens';

const STORAGE_KEY = 'skyup_theme'; // 'dark' | 'light'

const ThemeContext = createContext({
  dark: true,
  toggle: () => {},
  setDark: () => {},
  colors: getColors(true),
});

export function ThemeProvider({ children }) {
  // Default to dark — matches the app's existing look for users who haven't
  // chosen a theme yet, so nothing changes for anyone until they opt in.
  const [dark, setDark] = useState(true);
  const [hydrated, setHydrated] = useState(false);

  // Load the saved preference once on startup.
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((value) => {
        if (cancelled) return;
        if (value === 'light') setDark(false);
        else if (value === 'dark') setDark(true);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, []);

  // Persist whenever it changes (after the initial load, so we don't
  // immediately overwrite a stored value with the default).
  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_KEY, dark ? 'dark' : 'light').catch(() => {});
  }, [dark, hydrated]);

  const toggle = () => setDark((prev) => !prev);
  const colors = useMemo(() => getColors(dark), [dark]);

  const value = useMemo(
    () => ({ dark, toggle, setDark, colors }),
    [dark, colors],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);