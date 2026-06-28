// src/api/authApi.js

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import api          from '../services/api';
import { getPublicIP } from '../services/ipService'; // ✅ use the shared service, not inline copy

const TOKEN_KEY = 'auth_token';
const USER_KEY  = 'auth_user';
const IS_DEV    = __DEV__;

// ─── Parse login response ─────────────────────────────────────────────────────
//  Backend returns a FLAT response — no nested "user" object:
//  { _id, name, email, company, role, token }
//
function parseLoginResponse(data) {
  if (IS_DEV) {
    console.log('[authApi] Raw login response:', JSON.stringify(data, null, 2));
  }

  const body = data?.data ?? data?.result ?? data?.auth ?? data?.payload ?? data;

  const token =
    body?.token        ||
    body?.accessToken  ||
    body?.access_token ||
    data?.token        ||
    null;

  const user =
    body?.user    ||
    body?.profile ||
    body?.account ||
    data?.user    ||
    (body?._id ? {
      _id:     body._id,
      name:    body.name,
      email:   body.email,
      company: body.company,
      role:    body.role,
      contactAccountEmail: body.contactAccountEmail ?? null,
    } : null);

  return { token, user };
}

// ─── loginUser ────────────────────────────────────────────────────────────────

export async function loginUser(email, password) {

  const platform  = Platform.OS ?? null;
  const osVersion = Platform.Version != null ? String(Platform.Version) : null;

  // ✅ FIX: Start IP fetch in background but DON'T await before login.
  //    Old code did `const ip = await ipPromise` BEFORE api.post() —
  //    this blocked login by up to 5 seconds waiting for ipify.org.
  //    Now login fires instantly; IP is patched in after success.
  const ipPromise = getPublicIP();

  const payload = {
    email,
    password,
    ...(platform  && { platform }),
    ...(osVersion && { osVersion }),
  };

  // Login fires immediately — not delayed by IP lookup
  const response = await api.post('/auth/login', payload);

  const { token, user } = parseLoginResponse(response.data);

  if (!token) {
    if (IS_DEV) {
      console.error('[authApi] Could not find token in response:', response.data);
    }
    throw new Error(
      'Login response missing token. ' +
      (IS_DEV ? `Got keys: ${Object.keys(response.data || {}).join(', ')}` : 'Please contact support.')
    );
  }

  if (!user) {
    if (IS_DEV) {
      console.error('[authApi] Could not find user in response:', response.data);
    }
    throw new Error(
      'Login response missing user. ' +
      (IS_DEV ? `Got keys: ${Object.keys(response.data || {}).join(', ')}` : 'Please contact support.')
    );
  }

  // Save auth data — user is now logged in
  await Promise.allSettled([
    AsyncStorage.setItem(TOKEN_KEY, token),
    AsyncStorage.setItem(USER_KEY,  JSON.stringify(user)),
  ]);

  // ✅ FIX: Send IP as fire-and-forget AFTER login succeeds.
  //    Uses PATCH /auth/update-device instead of re-calling POST /auth/login,
  //    which previously re-ran full password verification just to save an IP.
  ipPromise.then(async (ip) => {
    if (!ip) return;
    try {
      await api.patch('/auth/update-device', { ipAddress: ip });
    } catch {
      // Silently ignore — IP capture is best-effort
    }
  }).catch(() => {});

  return user;
}

// ─── logoutUser ───────────────────────────────────────────────────────────────

export async function logoutUser() {
  await Promise.allSettled([
    AsyncStorage.removeItem(TOKEN_KEY),
    AsyncStorage.removeItem(USER_KEY),
  ]);
}

// ─── getStoredUser ────────────────────────────────────────────────────────────

export async function getStoredUser() {
  try {
    const [token, userJson] = await Promise.all([
      AsyncStorage.getItem(TOKEN_KEY),
      AsyncStorage.getItem(USER_KEY),
    ]);
    if (!token || !userJson) return null;
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}