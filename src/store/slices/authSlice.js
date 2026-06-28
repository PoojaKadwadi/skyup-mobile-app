// src/store/slices/authSlice.js
// ─────────────────────────────────────────────────────────────────────────────
//  CRASH FIXES (this revision):
//   1. login thunk wraps loginUser in a try/catch that normalises ANY throw
//      (including TypeError from null IP access, JSON parse errors, etc.)
//      into a clean rejectWithValue string — no unhandled promise rejection.
//   2. forceLogout and logout still clear notification state; .catch(() => {})
//      guards added so a failing clearNotificationState never crashes logout.
//   3. restoreSession guarded — a corrupt stored user now resolves to null
//      instead of crashing the app on launch.
// ─────────────────────────────────────────────────────────────────────────────

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { loginUser, logoutUser, getStoredUser } from '../../api/authApi';
import { clearNotificationState }              from '../../services/notificationService';

// ─── Thunks ───────────────────────────────────────────────────────────────────

export const login = createAsyncThunk(
  'auth/login',
  async ({ email, password }, { rejectWithValue }) => {
    try {
      const user = await loginUser(email, password);

      // Defensive: loginUser should always return an object, but guard anyway
      if (!user || typeof user !== 'object') {
        return rejectWithValue('Unexpected response from server. Please try again.');
      }

      return user;
    } catch (error) {
      // Normalise every possible error shape into a user-readable string.
      // This is the single place that converts crashes → clean Redux errors.
      const message =
        error?.userMessage ||                    // set by api.js interceptor
        error?.response?.data?.message ||        // backend validation message
        error?.message ||                        // JS Error.message
        'Login failed. Check your credentials and network.';

      // Backend sends `field` ("email" | "password") for credential errors so
      // the login screen can highlight the specific input inline.
      const field = error?.response?.data?.field || null;

      return rejectWithValue({ message, field });
    }
  },
);

export const logout = createAsyncThunk('auth/logout', async () => {
  // Guard: clearNotificationState failing must never crash logout
  await clearNotificationState().catch(() => {});
  await logoutUser();
});

export const restoreSession = createAsyncThunk('auth/restoreSession', async () => {
  try {
    return await getStoredUser(); // returns null on corrupt storage
  } catch {
    return null; // never crash the app on launch
  }
});

// Called by api.js interceptor when a 401 is detected mid-session
export const forceLogout = createAsyncThunk('auth/forceLogout', async () => {
  await clearNotificationState().catch(() => {});
  await logoutUser();
});

// ─── Slice ────────────────────────────────────────────────────────────────────

const authSlice = createSlice({
  name: 'auth',
  initialState: {
    user:    null,
    loading: false,
    error:   null,
    errorField: null,   // "email" | "password" | null — for inline field highlight
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
        // payload is { message, field } from the thunk; tolerate a bare string too.
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
      state.user  = null;
      state.error = 'Session expired. Please log in again.';
      state.errorField = null;
    });
    builder.addCase(restoreSession.fulfilled, (state, action) => {
      // action.payload may be null — that is valid (logged out state)
      state.user = action.payload ?? null;
    });
  },
});

export const { clearError } = authSlice.actions;
export default authSlice.reducer;