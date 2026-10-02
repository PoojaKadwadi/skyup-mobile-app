// src/services/customizationService.js
// ─────────────────────────────────────────────────────────────────────────────
// Company customization (configured per company in the CRM's developer panel →
// Customize CRM): industries, services, lead-field rules, statuses, outcomes…
//
//   loadCustomization(force)  → GET /customization (cached 10 min + on disk)
//   getCustomization()        → current config (defaults until loaded)
//   subscribeCustomization(fn)
//   clearCustomization()      → on logout
//
// The defaults below mirror the CRM's defaults, so the app behaves exactly as
// before when the server can't be reached.
// ─────────────────────────────────────────────────────────────────────────────
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '../api/apiClient';

const CACHE_KEY = 'customization_cache_v1';
const TTL_MS = 10 * 60 * 1000;

export const DEFAULT_CUSTOMIZATION = {
  lists: {
    industries: [
      'Healthcare', 'Education', 'Real Estate', 'Logistics', 'Finance',
      'IT Solutions', 'Digital Marketing', 'Construction', 'Local Business',
      'Interior Designers', 'Professional Services',
    ],
    services: [
      'SEO', 'Paid Ads', 'Website Design & Development', 'AI Automation',
      'CRM', 'Video Editing', 'Graphic Design', 'Social Media Marketing',
      'AI Voice Agent', 'Custom Software', 'WhatsApp Automation & Chatbots',
      'ERP Systems', 'Mobile Applications', 'Branding',
    ],
  },
  leadFields: {
    industry: { visible: true, required: false, label: 'Industry', allowOther: true },
    service:  { visible: true, required: false, label: 'Service', multiple: true, allowOther: false },
  },
};

let _state = DEFAULT_CUSTOMIZATION;
let _loadedAt = 0;
let _inflight = null;
const _subs = new Set();

function emit() { _subs.forEach((fn) => { try { fn(_state); } catch { /* ignore */ } }); }

function merge(server) {
  if (!server || typeof server !== 'object') return DEFAULT_CUSTOMIZATION;
  return {
    ...DEFAULT_CUSTOMIZATION,
    ...server,
    lists: { ...DEFAULT_CUSTOMIZATION.lists, ...(server.lists || {}) },
    leadFields: {
      ...DEFAULT_CUSTOMIZATION.leadFields,
      ...(server.leadFields || {}),
      industry: { ...DEFAULT_CUSTOMIZATION.leadFields.industry, ...(server.leadFields?.industry || {}) },
      service:  { ...DEFAULT_CUSTOMIZATION.leadFields.service,  ...(server.leadFields?.service  || {}) },
    },
  };
}

export function getCustomization() { return _state; }
export function subscribeCustomization(fn) { _subs.add(fn); return () => _subs.delete(fn); }

export async function loadCustomization(force = false) {
  if (!force && _loadedAt && Date.now() - _loadedAt < TTL_MS) return _state;
  if (_inflight) return _inflight;
  // Instant start from the on-disk copy, then refresh from the server.
  if (!_loadedAt) {
    try {
      const raw = await AsyncStorage.getItem(CACHE_KEY);
      if (raw) { _state = merge(JSON.parse(raw)); emit(); }
    } catch { /* ignore */ }
  }
  _inflight = apiClient.get('/customization')
    .then(({ data }) => {
      const c = data?.customization;
      if (c) {
        _state = merge(c);
        _loadedAt = Date.now();
        emit();
        AsyncStorage.setItem(CACHE_KEY, JSON.stringify(c)).catch(() => {});
      }
      return _state;
    })
    .catch(() => _state)
    .finally(() => { _inflight = null; });
  return _inflight;
}

export async function clearCustomization() {
  _state = DEFAULT_CUSTOMIZATION; _loadedAt = 0; emit();
  try { await AsyncStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
export const industriesList = (c = _state) => (Array.isArray(c?.lists?.industries) ? c.lists.industries : []);
export const servicesList   = (c = _state) => (Array.isArray(c?.lists?.services) ? c.lists.services : []);
export const leadField      = (key, c = _state) => c?.leadFields?.[key] || { visible: true, label: key };

/** A lead's services as an array (new services[] or old single/comma `service`). */
export function leadServicesOf(lead) {
  if (Array.isArray(lead?.services) && lead.services.length) return lead.services.filter(Boolean);
  return lead?.service ? String(lead.service).split(/\s*[,|]\s*/).filter(Boolean) : [];
}

// ── Lead statuses (company-customised) ───────────────────────────────────────
const NAMED_COLORS = {
  blue: '#3B82F6', amber: '#F59E0B', yellow: '#EAB308', orange: '#F97316', purple: '#8B5CF6',
  violet: '#8B5CF6', green: '#10B981', emerald: '#10B981', red: '#EF4444', rose: '#F43F5E',
  pink: '#EC4899', teal: '#14B8A6', cyan: '#06B6D4', indigo: '#6366F1', slate: '#64748B', gray: '#64748B',
};
function findStatus(key, c = _state) {
  const list = Array.isArray(c?.statuses) ? c.statuses : [];
  const k = String(key || '').toLowerCase();
  return list.find((x) => String(x.key).toLowerCase() === k)
      || list.find((x) => String(x.label || '').toLowerCase() === k)
      || list.find((x) => (x.aliases || []).some((a) => String(a).toLowerCase() === k))
      || null;
}
/** Display label for a stored status key (falls back to the key itself). */
export const statusLabel = (key, c = _state) => (findStatus(key, c)?.label || key || '');
/** Hex colour for a status (company colour name → hex), or null if unknown. */
export function statusColor(key, c = _state) {
  const col = findStatus(key, c)?.color;
  if (!col) return null;
  return col.startsWith('#') ? col : (NAMED_COLORS[col] || null);
}
