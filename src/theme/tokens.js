// src/theme/tokens.js
// Design tokens matching the SkyUp CRM frontend (UserDashboard.jsx / UserLogin.jsx) exactly.
// Every color maps 1:1 to a CSS variable or Tailwind class used in the web app.

export const COLORS = {
  // ── Backgrounds ────────────────────────────────────────────────────────────
  bg:          '#0D0F14',   // dark:bg-[#0D0F14]  — page background
  surface:     '#1A1D27',   // dark:bg-[#1A1D27]  — cards, header
  surfaceAlt:  '#13161E',   // dark:bg-[#13161E]  — table rows, input bg, stat boxes

  // ── Borders ────────────────────────────────────────────────────────────────
  border:      '#262A38',   // dark:border-[#262A38]
  borderLight: '#E4E7EF',   // border-[#E4E7EF]   — light mode

  // ── Text ───────────────────────────────────────────────────────────────────
  textPrimary: '#F0F2FA',   // dark:text-[#F0F2FA]
  textSec:     '#9DA3BB',   // dark:text-[#9DA3BB]
  textMuted:   '#565C75',   // dark:text-[#565C75]

  // ── Blue / Primary ─────────────────────────────────────────────────────────
  blue:        '#2563EB',   // bg-[#2563EB]
  blueLight:   '#4F8EF7',   // dark:text-[#4F8EF7]
  blueBg:      '#1A2540',   // dark:bg-[#1A2540]  — blue chip bg

  // ── Green / Success ────────────────────────────────────────────────────────
  green:       '#059669',   // text-emerald-600
  greenLight:  '#34D399',   // text-emerald-400
  greenBg:     '#052E1C',   // dark:bg-emerald-950/40

  // ── Amber / Warning ────────────────────────────────────────────────────────
  amber:       '#D97706',   // text-amber-600
  amberLight:  '#FCD34D',   // text-amber-300
  amberBg:     '#2D1F00',   // dark:bg-amber-950/40

  // ── Red / Danger ───────────────────────────────────────────────────────────
  red:         '#DC2626',   // text-red-600
  redLight:    '#F87171',   // text-red-400
  redBg:       '#2D0A0A',   // dark:bg-red-950/40

  // ── Purple ─────────────────────────────────────────────────────────────────
  purple:      '#7C3AED',
  purpleLight: '#A78BFA',
  purpleBg:    '#2E1065',
};

export const RADIUS = {
  sm:   8,
  md:   12,
  lg:   16,
  xl:   20,
  full: 9999,
};

export const FONT = {
  xs:   10,
  sm:   11,
  base: 13,
  md:   15,
  lg:   18,
  xl:   22,
  xxl:  28,
};
