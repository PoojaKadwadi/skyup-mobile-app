// src/components/PendingCallResumer.js
// Mounted inside the clock-in gate (so it only runs once the app is usable).
// If Android killed the app during a call, this reopens the lead and its
// Remark popup after the call ends. See services/pendingCallService.js.
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import {
  getPendingCall, clearPendingCall, hasLiveCallListener,
} from '../services/pendingCallService';
import { getCallLogsForNumber } from '../services/phoneService';
import { getCallState } from '../services/callStateService';

const NO_LOG_GIVE_UP_MS = 15 * 60 * 1000; // no call-log entry after 15 min → call never happened

export default function PendingCallResumer() {
  const navigation = useNavigation();
  const busyRef    = useRef(false);

  useEffect(() => {
    const check = async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        // A live LeadDetail is still waiting for this call — it will handle it.
        if (hasLiveCallListener()) return;

        const p = await getPendingCall();
        if (!p) return;

        // Still on the call → wait for the next foreground.
        try { if (getCallState() !== 'idle') return; } catch {}

        // Confirm the call actually happened/ended: Android writes the call-log
        // row only when the call finishes.
        let confirmed = true;
        try {
          const logs  = await getCallLogsForNumber(p.number);
          const since = (p.startedAt || 0) - 60 * 1000;
          confirmed   = logs.some(l => parseInt(l.timestamp, 10) >= since);
        } catch { confirmed = true; } // no call-log permission → trust the record

        if (!confirmed) {
          if (Date.now() - p.startedAt > NO_LOG_GIVE_UP_MS) await clearPendingCall();
          return; // maybe not written yet — try again on next foreground
        }

        await clearPendingCall();
        navigation.navigate('LeadDetail', {
          leadId:        p.leadId,
          resumeRemark:  true,
          callNumber:    p.number,
          callStartedAt: p.startedAt,
        });
      } finally {
        busyRef.current = false;
      }
    };

    // Small delay so the tabs finish mounting before we push a screen.
    const t   = setTimeout(check, 800);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') setTimeout(check, 1500); // after LeadDetail's own listener
    });
    return () => { clearTimeout(t); sub.remove(); };
  }, [navigation]);

  return null;
}
