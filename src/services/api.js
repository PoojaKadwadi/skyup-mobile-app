// src/services/api.js
// ─────────────────────────────────────────────────────────────────────────────
//  CENTRALIZED API SERVICE
//
//  FIX (this revision) — 401 handling:
//   The response interceptor previously cleared the keychain token and
//   AsyncStorage on a genuine 401, but NEVER dispatched forceLogout to Redux
//   and NEVER navigated to the Login screen.  Result: the user stayed on the
//   current screen while all subsequent requests silently failed with 401 again
//   (no token). This fix:
//     1. Imports the Redux store lazily (avoids circular-import boot-time crash).
//     2. Dispatches forceLogout() on genuine mid-session 401s.
//     3. Navigates to Login via the global navigationRef.
//   Only GENUINE auth failures trigger this flow (see isAuthError guard).
//   Network timeouts, 500s, and any other error do NOT cause logout.
//
//  RETAINED (previous revision):
//   • Content-Type fix for FormData uploads.
//   • Retry interceptor for cold-start 502/503.
//   • Server-time recording on every success response.
//   • buildUserMessage for friendly error strings.
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BASE_URL, API_TIMEOUT, IS_DEV } from '../config/config';
import { getToken, removeToken } from './tokenStorage';
import crash from './crashReporting';
import { recordServerDate } from './serverTime';

const dlog  = IS_DEV ? (...a) => console.log(...a)  : () => {};
const dwarn = IS_DEV ? (...a) => console.warn(...a) : () => {};

// ── Lazy store/nav imports to avoid circular dependency at boot ───────────────
// These are imported INSIDE the interceptor callback, not at the top level.
// By the time any API call can fire a 401, both modules are fully initialized.
let _store = null;
let _navRef = null;

export function _injectStoreAndNav(store, navRef) {
  _store  = store;
  _navRef = navRef;
}

// ─── Axios instance ───────────────────────────────────────────────────────────
const api = axios.create({
  baseURL: BASE_URL,
  timeout: API_TIMEOUT,
  headers: {
    Accept: 'application/json',
    // NOTE: Content-Type NOT set here — set conditionally in request interceptor.
  },
});

// ─── Request interceptor ─────────────────────────────────────────────────────
api.interceptors.request.use(
  async (config) => {
    try {
      const token = await getToken();
      if (token) config.headers.Authorization = `Bearer ${token}`;
    } catch { /* No token — proceed unauthenticated */ }

    if (!(config.data instanceof FormData)) {
      config.headers['Content-Type'] = 'application/json';
    }

    dlog(`[API →] ${config.method?.toUpperCase()} ${config.baseURL}${config.url}`);
    return config;
  },
  (error) => Promise.reject(error),
);

// ─── Retry interceptor (cold-start 502/503) ───────────────────────────────────
api.interceptors.response.use(
  res => res,
  async err => {
    const cfg    = err.config;
    const status = err.response?.status;
    const isRetryable =
      !err.response ||
      err.code === 'ECONNABORTED' ||
      status === 502 || status === 503 || status === 504;

    if (cfg && isRetryable && cfg.method === 'get' && (cfg._retry || 0) < 2) {
      cfg._retry = (cfg._retry || 0) + 1;
      const delay = cfg._retry * 1500;
      await new Promise(r => setTimeout(r, delay));
      return api(cfg);
    }
    return Promise.reject(err);
  }
);

// ─── Response interceptor ─────────────────────────────────────────────────────
api.interceptors.response.use(
  (response) => {
    try { recordServerDate(response.headers?.date); } catch {}
    dlog(`[API ✓] ${response.status} ${response.config.url}`);
    return response;
  },
  async (error) => {
    const status  = error.response?.status;
    const message = error.response?.data?.message || '';
    const url     = error.config?.url || '';

    // ─── 401 handling — only for GENUINE session expiry ──────────────────────
    // Conditions for a "genuine" expired-session 401:
    //   1. The response is actually 401 (not a timeout / network error).
    //   2. It is NOT from the /auth/login endpoint (that 401 means wrong
    //      credentials, not an expired session — we must not log out on it).
    //   3. The body message mentions session/token expiry keywords.
    //      (Some backends always return 401 for any auth problem; others return
    //       it for missing roles too — we only logout on clear expiry signals.)
    //
    // FIX: Previously this block cleared storage but then did nothing with Redux
    // or navigation, leaving the user on a broken authenticated screen.
    if (status === 401 && !url.includes('/auth/login')) {
      const isAuthError =
        message.toLowerCase().includes('invalid')   ||
        message.toLowerCase().includes('expired')   ||
        message.toLowerCase().includes('jwt')        ||
        message.toLowerCase().includes('no token')   ||
        message.toLowerCase().includes('unauthorized');

      if (isAuthError) {
        // 1. Clear stored credentials
        try { await removeToken(); } catch {}
        try { await AsyncStorage.removeItem('auth_user'); } catch {}

        // 2. Dispatch forceLogout to Redux so AppManager runs cleanup
        //    (stops background sync, call detector, FCM, socket, etc.)
        if (_store) {
          try {
            // Lazy import avoids circular dependency at module load time
            const { forceLogout } = require('../store/slices/authSlice');
            _store.dispatch(forceLogout());
          } catch (e) {
            dwarn('[API] forceLogout dispatch failed:', e.message);
          }
        }

        // 3. Navigate to Login screen
        //    Use a short delay so Redux state update propagates first (the
        //    navigator reads user from Redux; dispatching forceLogout sets
        //    user=null which causes AppNavigator to render the Login screen,
        //    so we don't technically NEED to navigate — but explicit nav
        //    handles edge cases where the navigator hasn't re-rendered yet).
        if (_navRef?.current) {
          try {
            setTimeout(() => {
              if (_navRef.current?.isReady()) {
                _navRef.current.reset({ index: 0, routes: [{ name: 'Login' }] });
              }
            }, 100);
          } catch {}
        }

        dwarn('[API] Session expired — forced logout dispatched');
      }
    }

    error.userMessage = buildUserMessage(error);
    dwarn(`[API ✗] ${error.userMessage}`, error.response?.data);

    if (!status || status >= 500) {
      crash.recordError(error, `API ${error.config?.method?.toUpperCase() || ''} ${error.config?.url || ''}`);
    }
    return Promise.reject(error);
  },
);

// ─── User-friendly error messages ────────────────────────────────────────────
function buildUserMessage(error) {
  if (!error.response) {
    if (error.code === 'ECONNABORTED')
      return 'The server is taking too long to respond. Please check your internet and try again.';
    return 'Cannot connect to the server. Please check your internet connection and try again.';
  }

  const { status, data } = error.response;
  const serverMsg = data?.message || data?.error || '';

  // Always prefer the server's own reason (e.g. "Incorrect password",
  // "No account found with this email", "Company is suspended",
  // "Too many attempts, try after 15 minutes").
  if (serverMsg) return serverMsg;

  switch (status) {
    case 400: return 'Invalid request. Please check your input.';
    case 401: return 'Session expired. Please log in again.';
    case 403: return 'You do not have permission to do that.';
    case 404: return 'Not found.';
    case 422: return 'Validation failed.';
    case 429: return 'Too many attempts. Please wait a few minutes and try again.';
    case 500: return 'Server error. Please try again later.';
    case 503: return 'Server is temporarily unavailable. Please try again shortly.';
    default:  return `Unexpected error (${status}). Please try again.`;
  }
}

// ─── apiRequest helper ───────────────────────────────────────────────────────
export async function apiRequest(endpoint, method = 'GET', body = null, token = null, params = null, headers = {}) {
  const config = { url: endpoint, method: method.toLowerCase(), params, headers };
  if (token) config.headers = { ...config.headers, Authorization: `Bearer ${token}` };
  if (body) config.data = body;
  const response = await api(config);
  return response.data;
}

// ─── Health check ────────────────────────────────────────────────────────────
export async function checkHealth() {
  try {
    const res = await api.get('/health', { timeout: 5000 });
    dlog('[Health] ✅ Backend reachable:', res.data);
    return { ok: true, data: res.data };
  } catch (error) {
    dwarn('[Health] ❌ Backend unreachable:', error.userMessage || error.message);
    return { ok: false, error: error.userMessage || error.message };
  }
}

// ─── Warm-up ping ────────────────────────────────────────────────────────────
export async function warmUpBackend() {
  const COLD_START_TIMEOUT = 60000;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await api.get('/health', { timeout: COLD_START_TIMEOUT });
      dlog(`[WarmUp] ✅ Backend awake (attempt ${attempt})`);
      return true;
    } catch (e) {
      dwarn(`[WarmUp] attempt ${attempt} failed:`, e?.message);
    }
  }
  return false;
}

export const BASE_URL_EXPORT = BASE_URL;
export default api;
