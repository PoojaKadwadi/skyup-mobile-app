// src/config/config.js
export const BASE_URL = 'https://skyup-crm-backend.onrender.com/api';

// FIX: Reduced from 30000 → 15000ms.
// 30s was triggering Android ANR ("SkyUp CRM isn't responding") because
// the system perceived the app as frozen while waiting on a slow/hung
// server request. 15s is sufficient for real 3G connections and fails fast
// enough to avoid the ANR threshold (typically ~5-10s of UI unresponsiveness
// visible to the user). The call-log sync now batches to 50 records which
// easily fits within 15s even on poor connections.
export const API_TIMEOUT    = 15000;
export const API_TIMEOUT_MS = 15000;

export const IS_DEV = __DEV__;