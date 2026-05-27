// src/config/config.js
export const BASE_URL = 'https://skyup-crm-backend.onrender.com/api';

// FIX: Raised from 10000 → 30000ms.
// The sync POST can send up to 500 call-log records in one request.
// On a slow mobile connection (3G, weak WiFi) 10s was not enough —
// the request would abort mid-upload and the whole sync would silently fail.
// 30s covers real-world slow connections while still failing fast on dead links.
export const API_TIMEOUT    = 30000;
export const API_TIMEOUT_MS = 30000;

export const IS_DEV = __DEV__;