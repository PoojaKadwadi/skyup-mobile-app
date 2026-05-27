// src/store/slices/syncSlice.js
import { createSlice } from '@reduxjs/toolkit';

const syncSlice = createSlice({
  name: 'sync',
  initialState: {
    pendingQueue: [],
    isSyncing:    false,
    lastError:    null,
  },
  reducers: {
    enqueue: (state, action) => {
      state.pendingQueue.push({
        id:         Date.now().toString(),
        retryCount: 0,
        createdAt:  new Date().toISOString(),
        ...action.payload,
      });
    },
    dequeue: (state, action) => {
      state.pendingQueue = state.pendingQueue.filter(
        item => !action.payload.includes(item.id),
      );
    },
    incrementRetry: (state, action) => {
      const item = state.pendingQueue.find(i => i.id === action.payload);
      if (item) item.retryCount += 1;
    },
    removeFailed: (state, action) => {
      state.pendingQueue = state.pendingQueue.filter(item => item.id !== action.payload);
    },
    setSyncing:   (state, action) => { state.isSyncing  = action.payload; },
    setLastError: (state, action) => { state.lastError  = action.payload; },
  },
});

export const { enqueue, dequeue, incrementRetry, removeFailed, setSyncing, setLastError } =
  syncSlice.actions;
export default syncSlice.reducer;

