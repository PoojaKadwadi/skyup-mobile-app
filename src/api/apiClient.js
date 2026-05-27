// src/api/apiClient.js
// Compatibility shim — all imports from './apiClient' still work.
// Real implementation is in src/services/api.js
export { default, apiRequest, checkHealth, BASE_URL_EXPORT as BASE_URL } from '../services/api';

