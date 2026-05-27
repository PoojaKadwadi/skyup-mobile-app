// src/store/slices/callsSlice.js
// CHANGE: fetchSyncedCallLogs thunk updated to use fetchTodayServerLogs()
//         instead of the removed getSyncedCallLogs() function.
//         Admin panel continues to store all logs via the backend DB.
//         Mobile slice now tracks todayLogs (server-fetched today-only list).

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { fetchTodayServerLogs } from '../../api/callLogsApi';

// Thunk: load today's already-synced logs from the server.
// Called by CallLogsScreen on mount and after a manual sync.
export const fetchTodayCallLogs = createAsyncThunk(
  'calls/fetchTodayCallLogs',
  async (_, { rejectWithValue }) => {
    try { return await fetchTodayServerLogs(); }
    catch (error) { return rejectWithValue(error.response?.data?.message || 'Failed to fetch today\'s call logs'); }
  },
);

const callsSlice = createSlice({
  name: 'calls',
  initialState: {
    deviceLogs:   [],   // raw device logs (used by backgroundSyncService before upload)
    todayLogs:    [],   // server-fetched today-only synced logs (shown in mobile UI)
    loading:      false,
    error:        null,
    lastSyncedAt: null,
  },
  reducers: {
    setDeviceLogs:   (state, action) => { state.deviceLogs  = action.payload; },
    // CHANGE: setTodayLogs stores only the server-returned today logs.
    setTodayLogs:    (state, action) => { state.todayLogs   = action.payload; },
    markSynced:      (state)         => { state.lastSyncedAt = Date.now(); },
    clearCallsError: (state)         => { state.error        = null; },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchTodayCallLogs.pending,   (state) => { state.loading = true;  state.error = null; })
      .addCase(fetchTodayCallLogs.fulfilled, (state, action) => {
        state.loading   = false;
        // action.payload is the array from fetchTodayServerLogs()
        state.todayLogs = Array.isArray(action.payload) ? action.payload : [];
      })
      .addCase(fetchTodayCallLogs.rejected,  (state, action) => {
        state.loading = false;
        state.error   = action.payload;
      });
  },
});

export const { setDeviceLogs, setTodayLogs, markSynced, clearCallsError } = callsSlice.actions;
export default callsSlice.reducer;
