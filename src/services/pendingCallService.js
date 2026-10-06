// src/services/pendingCallService.js
// ─────────────────────────────────────────────────────────────────────────────
// Survive Android killing the app during a call.
//
// PROBLEM: on longer calls (≈3+ min) many phones (Xiaomi/Redmi, Realme/Oppo,
// Vivo, Samsung A/M) kill SkyUp in the background to free memory for the
// dialer + call recorder. When the agent returns, Android cold-starts the app:
//   splash spinner → "Checking attendance…" → Dashboard (first tab)
// and the LeadDetail screen — including the AppState listener that was waiting
// to open the Remark popup — no longer exists. So no remark page.
//
// FIX: when a call starts from LeadDetail we persist {leadId, number, startedAt}.
//   • Normal case (app survived): LeadDetail's own listener shows the remark
//     and clears the record.
//   • App was killed: <PendingCallResumer> (mounted after the clock-in gate)
//     finds the record on cold start, confirms the call really ended, and
//     navigates to LeadDetail with resumeRemark:true, which opens the popup.
// ─────────────────────────────────────────────────────────────────────────────
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY        = 'crm_pending_remark_call_v1';
const MAX_AGE_MS = 3 * 60 * 60 * 1000; // ignore calls older than 3h

// In-memory only: true while a mounted LeadDetail is listening for the call
// end. After a process kill this resets to false, which is exactly the signal
// the resumer needs ("nobody alive is going to show the remark").
let _liveListener = false;
export function setLiveCallListener(alive) { _liveListener = !!alive; }
export function hasLiveCallListener()      { return _liveListener; }

export async function savePendingCall({ leadId, number, startedAt }) {
  if (!leadId || !number) return;
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify({ leadId, number, startedAt: startedAt || Date.now() }));
  } catch {}
}

export async function getPendingCall() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p?.leadId || !p?.number || Date.now() - (p.startedAt || 0) > MAX_AGE_MS) {
      await AsyncStorage.removeItem(KEY);
      return null;
    }
    return p;
  } catch { return null; }
}

export async function clearPendingCall() {
  try { await AsyncStorage.removeItem(KEY); } catch {}
}
