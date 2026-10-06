// src/services/remarkBus.js
// ─────────────────────────────────────────────────────────────────────────────
// Tiny in-memory bus for "an agent just saved a remark on lead X".
// Lead Detail closes its remark form instantly and saves in the background;
// Calls by Day used to reload BEFORE that save finished and kept showing
// "Remark pending". Now:
//   • the call is shown as done immediately (optimistic), and
//   • Calls by Day reloads again the moment the save actually completes.
// ─────────────────────────────────────────────────────────────────────────────
const _recent = new Map();     // leadId -> { text, at }
const _subs = new Set();
const KEEP_MS = 12 * 60 * 60 * 1000;

export function noteRemark(leadId, text) {
  if (!leadId) return;
  _recent.set(String(leadId), { text: String(text || '').trim(), at: Date.now() });
  _emit('noted', String(leadId));
}

export function remarkSaved(leadId) {
  if (leadId) _emit('saved', String(leadId));
}

export function remarkFailed(leadId) {
  if (!leadId) return;
  _recent.delete(String(leadId));
  _emit('failed', String(leadId));
}

/** A remark saved on this lead after `sinceMs` (call start minus slack), or null. */
export function getRecentRemark(leadId, sinceMs = 0) {
  const r = leadId ? _recent.get(String(leadId)) : null;
  if (!r) return null;
  if (Date.now() - r.at > KEEP_MS) { _recent.delete(String(leadId)); return null; }
  return r.at >= sinceMs ? r : null;
}

export function onRemark(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

function _emit(type, leadId) {
  _subs.forEach((fn) => { try { fn(type, leadId); } catch { /* ignore */ } });
}

/** Forget everything — called on logout so the next user starts clean. */
export function clearRemarks() {
  _recent.clear();
}
