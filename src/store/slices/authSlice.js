// src/store/slices/authSlice.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX (this revision) — clear per-user caches on logout/forceLogout:
//
//   clearAutoSyncCache() was exported from DashboardScreen but never called
//   on logout. On a shared device, after User A logged out and User B logged
//   in, User B would not be prompted for the recording-sync setup because
//   _autoSyncSetupCache was still 'true' from User A's session.
//
//   Fix: both logout and forceLogout now call clearAutoSyncCache() (via a
//   safe lazy require to avoid a circular import at module load time).
//
// RETAINED: all previous crash fixes (login normalisation, restoreSession
//   guard, forceLogout guard on clearNotificationState).
// ─────────────────────────────────────────────────────────────────────────────

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { loginUser, logoutUser, getStoredUser } from '../../api/authApi';
import { clearNotificationState }              from '../../services/notificationService';

// ── Per-user cache cleanup ────────────────────────────────────────────────────
// Called on every logout so the next user gets a clean slate.
// Uses lazy require to avoid circular dependency (DashboardScreen imports
// authSlice indirectly via useSelector).
function clearPerUserCaches() {
  try {
    const { clearAutoSyncCache } = require('../../screens/dashboard/DashboardScreen');
    if (typeof clearAutoSyncCache === 'function') clearAutoSyncCache();
  } catch { /* non-critical */ }
}

// ─── Thunks ───────────────────────────────────────────────────────────────────

export const login = createAsyncThunk(
  'auth/login',
  async ({ email, password }, { rejectWithValue }) => {
    try {
      const user = await loginUser(email, password);
      if (!user || typeof user !== 'object') {
        return rejectWithValue('Unexpected response from server. Please try again.');
      }
      return user;
    } catch (error) {
      const message =
        error?.userMessage ||
        error?.response?.data?.message ||
        error?.message ||
        'Login failed. Check your credentials and network.';
      const field = error?.response?.data?.field || null;
      return rejectWithValue({ message, field });
    }
  },
);

export const logout = createAsyncThunk('auth/logout', async () => {
  await clearNotificationState().catch(() => {});
  // FIX: clear per-user caches so next user gets a clean slate
  clearPerUserCaches();
  await logoutUser();
});

export const restoreSession = createAsyncThunk('auth/restoreSession', async () => {
  try {
    return await getStoredUser();
  } catch {
    return null;
  }
});

// Called by api.js interceptor when a genuine 401 is detected mid-session
export const forceLogout = createAsyncThunk('auth/forceLogout', async () => {
  await clearNotificationState().catch(() => {});
  // FIX: clear per-user caches on forced logout too
  clearPerUserCaches();
  await logoutUser();
});

// ─── Slice ────────────────────────────────────────────────────────────────────

const authSlice = createSlice({
  name: 'auth',
  initialState: {
    user:       null,
    loading:    false,
    error:      null,
    errorField: null,
  },
  reducers: {
    clearError: (state) => { state.error = null; state.errorField = null; },
  },
  extraReducers: (builder) => {
    builder
      .addCase(login.pending,   (state) => { state.loading = true;  state.error = null; state.errorField = null; })
      .addCase(login.fulfilled, (state, action) => {
        state.loading = false;
        state.user    = action.payload;
      })
      .addCase(login.rejected, (state, action) => {
        state.loading = false;
        const p = action.payload;
        if (p && typeof p === 'object') {
          state.error      = p.message ?? 'Something went wrong. Please try again.';
          state.errorField = p.field ?? null;
        } else {
          state.error      = p ?? 'Something went wrong. Please try again.';
          state.errorField = null;
        }
      });

    builder.addCase(logout.fulfilled,      (state) => { state.user = null; });
    builder.addCase(forceLogout.fulfilled, (state) => {
      state.user       = null;
      state.error      = 'Session expired. Please log in again.';
      state.errorField = null;
    });
    builder.addCase(restoreSession.fulfilled, (state, action) => {
      state.user = action.payload ?? null;
    });
  },
});

export const { clearError } = authSlice.actions;
export default authSlice.reducer;
