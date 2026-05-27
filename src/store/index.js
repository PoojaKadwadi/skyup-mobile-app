import { configureStore } from '@reduxjs/toolkit';
import { persistStore, persistReducer, FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER } from 'redux-persist';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { combineReducers } from '@reduxjs/toolkit';

import authReducer  from './slices/authSlice';
import callsReducer from './slices/callsSlice';
import leadsReducer from './slices/leadsSlice';
import syncReducer  from './slices/syncSlice';

const rootReducer = combineReducers({
  auth:  authReducer,
  calls: callsReducer,
  leads: leadsReducer,
  sync:  syncReducer,
});

const persistConfig = {
  key:     'root',
  storage: AsyncStorage,
  whitelist: ['auth'] // FIX: leads removed — always re-fetched on login, persisting causes slow startup, // only persist what you need
};

const persistedReducer = persistReducer(persistConfig, rootReducer);

export const store = configureStore({
  reducer: persistedReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }),
});

export const persistor = persistStore(store);

export default store;