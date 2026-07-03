// src/services/notificationService.js

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Safe import — app will not crash if notifee is not installed yet ──────────
let notifee = null;
let AndroidImportance = null;
let AndroidStyle = null;
let EventType = null;

try {
  const mod = require('@notifee/react-native');

  // notifee v5+ exports default + named; v7+ may export differently
  notifee = mod.default ?? mod;
  AndroidImportance =
    mod.AndroidImportance ?? mod.default?.AndroidImportance;
  AndroidStyle = mod.AndroidStyle ?? mod.default?.AndroidStyle;
  EventType = mod.EventType ?? mod.default?.EventType;

  // Validate import
  if (typeof notifee?.displayNotification !== 'function') {
    console.warn(
      '[Notifications] @notifee/react-native loaded but displayNotification missing — check version'
    );
    notifee = null;
  } else {
    console.log(
      '[Notifications] ✅ notifee loaded. AndroidImportance:',
      !!AndroidImportance
    );
  }
} catch (e) {
  console.warn(
    '[Notifications] @notifee/react-native not installed.\n' +
      'Run: npm install @notifee/react-native && cd ios && pod install\n' +
      'Error:',
    e.message
  );
}

// HIGH importance required for heads-up + sound
const IMPORTANCE_HIGH = AndroidImportance?.HIGH ?? 4;

// ── AsyncStorage keys ─────────────────────────────────────────────────────────
const SEEN_LEADS_KEY = 'notif_seen_lead_ids';
const NOTIFIED_FOLLOWUP_KEY = 'notif_notified_followup_ids';
const REASSIGN_COUNTS_KEY = 'notif_reassign_counts';
const SOCKET_NOTIFIED_KEY = 'notif_socket_notified_ids';
const SOCKET_REASSIGN_KEY = 'notif_socket_reassign_ids';
const MEETING_NOTIFIED_KEY = 'notif_meeting_notified_ids';
const MEETING_SUMMARY_KEY = 'notif_meeting_summary_date';

// ── Notification channel IDs ─────────────────────────────────────────────────
const CHANNEL_NEW_LEAD = 'new_lead_channel_v2';
const CHANNEL_FOLLOW_UP = 'followup_channel_v2';
const CHANNEL_MEETING = 'meeting_channel_v1';

// old channels
const CHANNEL_NEW_LEAD_OLD = 'new_lead_channel';
const CHANNEL_FOLLOW_UP_OLD = 'followup_channel';

// ── Quality emoji ────────────────────────────────────────────────────────────
const QUALITY_EMOJI = {
  Hot: '🔥',
  Warm: '🌤️',
  Cold: '❄️',
};

// ── Internal flag ────────────────────────────────────────────────────────────
let _notifChannelsReady = false;

// ── Badge count ───────────────────────────────────────────────────────────────
const BADGE_COUNT_KEY = 'notif_badge_count';
let _badgeCount = 0;

async function _loadBadgeCount() {
  try {
    const raw = await AsyncStorage.getItem(BADGE_COUNT_KEY);
    _badgeCount = raw ? parseInt(raw, 10) || 0 : 0;
  } catch { _badgeCount = 0; }
}

async function _incrementBadge(n = 1) {
  _badgeCount = Math.max(0, _badgeCount + n);
  try {
    await AsyncStorage.setItem(BADGE_COUNT_KEY, String(_badgeCount));
    if (notifee && typeof notifee.setBadgeCount === 'function') {
      await notifee.setBadgeCount(_badgeCount);
    }
  } catch {}
  return _badgeCount;
}

export async function resetBadgeCount() {
  _badgeCount = 0;
  try {
    await AsyncStorage.setItem(BADGE_COUNT_KEY, '0');
    if (notifee && typeof notifee.setBadgeCount === 'function') {
      await notifee.setBadgeCount(0);
    }
  } catch {}
}

export function getBadgeCount() { return _badgeCount; }

// ─────────────────────────────────────────────────────────────────────────────
// setupNotifications()
// ─────────────────────────────────────────────────────────────────────────────
export async function setupNotifications() {
  if (!notifee) return;

  await _loadBadgeCount();

  // ── Permissions ────────────────────────────────────────────────────────────
  try {
    if (Platform.OS === 'android') {
      if (Platform.Version >= 33) {
        let granted = false;

        try {
          const {
            request,
            PERMISSIONS,
            RESULTS,
          } = require('react-native-permissions');

          const result = await request(
            PERMISSIONS.ANDROID.POST_NOTIFICATIONS
          );

          granted = result === RESULTS.GRANTED;
        } catch {
          try {
            const settings = await notifee.requestPermission();
            granted = settings?.authorizationStatus === 1;
          } catch (fallbackErr) {
            console.warn(
              '[Notifications] Permission request failed:',
              fallbackErr.message
            );
          }
        }

        if (!granted) {
          console.warn(
            '[Notifications] POST_NOTIFICATIONS not granted'
          );
        }
      }
    } else {
      await notifee.requestPermission();
    }
  } catch (permErr) {
    console.warn(
      '[Notifications] Permission setup error:',
      permErr.message
    );
  }

  // ── Channels ───────────────────────────────────────────────────────────────
  // FIX BUG 4: _notifChannelsReady is set to true unconditionally after the
  // createChannel calls, even if deleteChannel threw. createChannel() is
  // idempotent on Android — calling it again for an existing channel is a no-op
  // and never throws. The only reason to NOT mark ready is if notifee itself is
  // null, which is already guarded above. Previously, clearNotificationState()
  // set _notifChannelsReady = false on logout, and if setupNotifications() then
  // threw during the deleteChannel step, the flag stayed false for the entire
  // session — silently dropping every notification after re-login.
  try {
    if (Platform.OS === 'android') {
      try {
        await notifee.deleteChannel(CHANNEL_NEW_LEAD_OLD);
      } catch {}

      try {
        await notifee.deleteChannel(CHANNEL_FOLLOW_UP_OLD);
      } catch {}

      console.log(
        '[Notifications] Old channels deleted (if existed)'
      );
    }

    await notifee.createChannel({
      id: CHANNEL_NEW_LEAD,
      name: 'New Lead Assigned',
      importance: IMPORTANCE_HIGH,
      sound: 'default',
      vibration: true,
      vibrationPattern: [300, 500],
      badge: true,
    });

    await notifee.createChannel({
      id: CHANNEL_FOLLOW_UP,
      name: 'Follow-Up Reminders',
      importance: IMPORTANCE_HIGH,
      sound: 'default',
      vibration: true,
      vibrationPattern: [300, 500],
      badge: true,
    });

    await notifee.createChannel({
      id: CHANNEL_MEETING,
      name: 'Client Meetings',
      importance: IMPORTANCE_HIGH,
      sound: 'default',
      vibration: true,
      vibrationPattern: [300, 500],
      badge: true,
    });
  } catch (err) {
    console.warn(
      '[Notifications] Channel creation error:',
      err.message
    );
    // FIX BUG 4: Do NOT return here. createChannel failures are usually
    // transient (race with Android channel registry). Mark ready anyway —
    // the channels likely already exist from the previous session, and
    // displayNotification will succeed with the existing channel config.
  }

  // FIX BUG 4: Always mark ready after attempting channel creation.
  // This is safe because createChannel is idempotent: calling it for an
  // already-registered channel is a guaranteed no-op on Android 8+.
  _notifChannelsReady = true;
  console.log(
    '[Notifications] ✅ Channels ready:',
    CHANNEL_NEW_LEAD, CHANNEL_FOLLOW_UP
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// checkAndNotifyNewLeads()
// ─────────────────────────────────────────────────────────────────────────────
export async function checkAndNotifyNewLeads(leads) {
  console.log(
    '[Notifications] checkAndNotifyNewLeads called',
    !!notifee,
    _notifChannelsReady
  );

  if (!notifee || !_notifChannelsReady || !leads?.length) {
    return;
  }

  try {
    const raw = await AsyncStorage.getItem(SEEN_LEADS_KEY);

    let seenIds = new Set();

    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);

        if (Array.isArray(parsed)) {
          seenIds = new Set(parsed.map(String));
        } else {
          console.warn(
            '[Notifications] SEEN_LEADS_KEY invalid'
          );

          await AsyncStorage.removeItem(SEEN_LEADS_KEY);

          await AsyncStorage.setItem(
            SEEN_LEADS_KEY,
            JSON.stringify(leads.map(l => String(l.id)))
          );

          return;
        }
      } catch (parseErr) {
        console.warn(
          '[Notifications] Parse error:',
          parseErr.message
        );

        await AsyncStorage.removeItem(SEEN_LEADS_KEY);

        await AsyncStorage.setItem(
          SEEN_LEADS_KEY,
          JSON.stringify(leads.map(l => String(l.id)))
        );

        return;
      }
    }

    const newLeads = leads.filter(
      l => l.id && !seenIds.has(String(l.id))
    );

    // First run
    if (raw === null) {
      await AsyncStorage.setItem(
        SEEN_LEADS_KEY,
        JSON.stringify(leads.map(l => String(l.id)))
      );

      return;
    }

    await AsyncStorage.setItem(
      SEEN_LEADS_KEY,
      JSON.stringify(leads.map(l => String(l.id)))
    );

    if (newLeads.length === 0) return;

    const qualityBadge = lead =>
      lead.Quality
        ? ` · ${QUALITY_EMOJI[lead.Quality] ?? ''} ${lead.Quality}`
        : '';

    const sourceBadge = lead =>
      lead.source && lead.source !== '—'
        ? ` via ${lead.source}`
        : '';

    let title;
    let body;

    if (newLeads.length === 1) {
      const lead = newLeads[0];

      title = '🎯 New Lead Assigned';

      body = `${lead.name}${sourceBadge(
        lead
      )}${qualityBadge(lead)}`;
    } else {
      title = `🎯 ${newLeads.length} New Leads Assigned`;

      const preview = newLeads
        .slice(0, 3)
        .map(l => l.name)
        .join(', ');

      body =
        preview +
        (newLeads.length > 3
          ? ` +${newLeads.length - 3} more`
          : '');
    }

    const badge = await _incrementBadge(newLeads.length);

    await notifee.displayNotification({
      id: `new_leads_${Date.now()}`,
      title,
      body,

      android: {
        channelId: CHANNEL_NEW_LEAD,
        importance: IMPORTANCE_HIGH,
        smallIcon: 'ic_notification',
        asForegroundService: false,
        showWhen: true,
        badgeCount: badge,
        badgeIconType: 1,

        ...(newLeads.length > 1 && {
          style: {
            type: AndroidStyle.INBOX,
            lines: newLeads.slice(0, 5).map(
              l =>
                `${l.name}${qualityBadge(
                  l
                )}${sourceBadge(l)}`
            ),
            summary: `${newLeads.length} new leads`,
          },
        }),

        pressAction: {
          id: 'open_leads',
        },
      },

      ios: {
        sound: 'default',
        badge,
        foregroundPresentationOptions: {
          alert: true,
          sound: true,
          badge: true,
        },
      },
    });
  } catch (err) {
    console.warn(
      '[Notifications] checkAndNotifyNewLeads error:',
      err.message
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// checkAndNotifyFollowUps()
// ─────────────────────────────────────────────────────────────────────────────
export async function checkAndNotifyFollowUps(leads) {
  console.log(
    '[Notifications] checkAndNotifyFollowUps called'
  );

  if (!notifee || !_notifChannelsReady || !leads?.length) {
    return;
  }

  try {
    const now = Date.now();
    const WINDOW_AHEAD_MS = 15 * 60 * 1000;
    const WINDOW_BEHIND_MS = 24 * 60 * 60 * 1000;

    const raw = await AsyncStorage.getItem(
      NOTIFIED_FOLLOWUP_KEY
    );

    const notifiedSet = new Set(
      raw ? JSON.parse(raw) : []
    );

    const newlyFired = [];

    for (const lead of leads) {
      const candidates = [];

      if (Array.isArray(lead.scheduledCalls)) {
        for (const sc of lead.scheduledCalls) {
          if (!sc.done && sc.scheduledAt) {
            candidates.push({
              isoDate: sc.scheduledAt,
              label:
                sc.type === 'verification'
                  ? 'Verification call'
                  : 'Follow-up call',
              note: sc.note,
            });
          }
        }
      }

      if (lead.followUpDate) {
        const alreadyCovered = candidates.some(
          c => c.isoDate === lead.followUpDate
        );

        if (!alreadyCovered) {
          candidates.push({
            isoDate: lead.followUpDate,
            label: 'Follow-up call',
            note: null,
          });
        }
      }

      for (const candidate of candidates) {
        const schedMs = new Date(
          candidate.isoDate
        ).getTime();

        if (isNaN(schedMs)) continue;

        const isOverdue  = schedMs >= now - WINDOW_BEHIND_MS && schedMs < now;
        const isUpcoming = schedMs >= now && schedMs <= now + WINDOW_AHEAD_MS;
        if (!isOverdue && !isUpcoming) continue;

        const dedupKey = `${lead.id}_${candidate.isoDate}`;

        if (notifiedSet.has(dedupKey)) continue;

        const minsUntil = Math.round(
          (schedMs - now) / 60000
        );

        const timeLabel =
          minsUntil < -60
            ? `overdue by ${Math.round(-minsUntil / 60)}h`
            : minsUntil < 0
              ? `overdue by ${-minsUntil} min`
              : minsUntil <= 1
                ? 'now'
                : `in ${minsUntil} min`;

        const followupBadge = await _incrementBadge(1);

        await notifee.displayNotification({
          id: `followup_${dedupKey}`,

          title: `📞 ${candidate.label} — ${timeLabel}`,

          body:
            `${lead.name}${
              candidate.note
                ? ` · ${candidate.note}`
                : ''
            }` +
            (lead.Quality
              ? ` ${QUALITY_EMOJI[lead.Quality] ?? ''}`
              : ''),

          android: {
            channelId: CHANNEL_FOLLOW_UP,
            importance: IMPORTANCE_HIGH,
            smallIcon: 'ic_notification',
            timestamp: schedMs,
            showTimestamp: true,
            badgeCount: followupBadge,
            badgeIconType: 1,

            data: {
              leadId: String(lead.id),
            },

            pressAction: {
              id: 'open_lead',
            },
          },

          ios: {
            sound: 'default',
            badge: followupBadge,
            foregroundPresentationOptions: {
              alert: true,
              sound: true,
              badge: true,
            },
          },
        });

        notifiedSet.add(dedupKey);
        newlyFired.push(dedupKey);
      }
    }

    if (newlyFired.length === 0) return;

    const cutoff = now - WINDOW_BEHIND_MS;

    const pruned = [...notifiedSet].filter(key => {
      const isoTs = key.substring(
        key.lastIndexOf('_') + 1
      );

      const ts = new Date(isoTs).getTime();

      return !isNaN(ts) && ts > cutoff;
    });

    await AsyncStorage.setItem(
      NOTIFIED_FOLLOWUP_KEY,
      JSON.stringify(pruned)
    );
  } catch (err) {
    console.warn(
      '[Notifications] checkAndNotifyFollowUps error:',
      err.message
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// registerNotificationHandlers()
// ─────────────────────────────────────────────────────────────────────────────
export function registerNotificationHandlers(
  navigationRef
) {
  if (!notifee || !EventType) return;

  const navigate = (screen, params) => {
    const nav = navigationRef?.current;

    if (!nav) return;

    nav.navigate('Main');

    if (screen !== 'Main') {
      setTimeout(() => {
        nav.navigate(screen, params);
      }, 120);
    }
  };

  const handlePress = notification => {
    if (!notification) return;

    if (
      notification.id?.startsWith('followup_')
    ) {
      const leadId = notification.data?.leadId;

      leadId
        ? navigate('LeadDetail', { leadId })
        : navigate('Leads');
    } else if (
      notification.id?.startsWith('meeting_')
    ) {
      navigate('ClientMeeting');
    } else if (
      notification.id?.startsWith('new_leads_') ||
      notification.id?.startsWith('reassigned_')
    ) {
      navigate('Leads');
    }
  };

  notifee.onForegroundEvent(
    ({ type, detail }) => {
      if (type === EventType.PRESS) {
        handlePress(detail.notification);
      }
    }
  );

  notifee.onBackgroundEvent(
    async ({ type, detail }) => {
      if (type === EventType.PRESS) {
        handlePress(detail.notification);
      }
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// checkAndNotifyReassignedLeads()
// ─────────────────────────────────────────────────────────────────────────────
export async function checkAndNotifyReassignedLeads(
  leads
) {
  if (!notifee || !_notifChannelsReady || !leads?.length) {
    return;
  }

  try {
    const raw = await AsyncStorage.getItem(
      REASSIGN_COUNTS_KEY
    );

    const stored = raw ? JSON.parse(raw) : null;

    // First run
    if (!stored) {
      const seed = {};

      leads.forEach(l => {
        if (l.id) {
          seed[l.id] = l.reassignCount || 0;
        }
      });

      await AsyncStorage.setItem(
        REASSIGN_COUNTS_KEY,
        JSON.stringify(seed)
      );

      return;
    }

    const updated = { ...stored };
    const reassigned = [];

    for (const lead of leads) {
      if (!lead.id) continue;

      const prevCount =
        stored[lead.id] ?? 0;

      const currCount =
        lead.reassignCount || 0;

      if (currCount > prevCount) {
        reassigned.push(lead);
      }

      updated[lead.id] = currCount;
    }

    await AsyncStorage.setItem(
      REASSIGN_COUNTS_KEY,
      JSON.stringify(updated)
    );

    if (reassigned.length === 0) return;

    const qualityBadge = lead =>
      lead.Quality
        ? ` · ${QUALITY_EMOJI[lead.Quality] ?? ''} ${lead.Quality}`
        : '';

    const sourceBadge = lead =>
      lead.source && lead.source !== '—'
        ? ` via ${lead.source}`
        : '';

    let title;
    let body;

    if (reassigned.length === 1) {
      const lead = reassigned[0];

      title = '🔄 Lead Reassigned to You';

      body = `${lead.name}${sourceBadge(
        lead
      )}${qualityBadge(lead)}`;
    } else {
      title = `🔄 ${reassigned.length} Leads Reassigned to You`;

      const preview = reassigned
        .slice(0, 3)
        .map(l => l.name)
        .join(', ');

      body =
        preview +
        (reassigned.length > 3
          ? ` +${reassigned.length - 3} more`
          : '');
    }

    const reassignBadge = await _incrementBadge(reassigned.length);

    await notifee.displayNotification({
      id: `reassigned_${Date.now()}`,
      title,
      body,

      android: {
        channelId: CHANNEL_NEW_LEAD,
        importance: IMPORTANCE_HIGH,
        smallIcon: 'ic_notification',
        badgeCount: reassignBadge,
        badgeIconType: 1,
        showWhen: true,

        pressAction: {
          id: 'open_leads',
        },
      },

      ios: {
        sound: 'default',
        badge: reassignBadge,
        foregroundPresentationOptions: {
          alert: true,
          sound: true,
          badge: true,
        },
      },
    });
  } catch (err) {
    console.warn(
      '[Notifications] checkAndNotifyReassignedLeads error:',
      err.message
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// clearNotificationState()
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// scheduleClockInReminder()
// ─────────────────────────────────────────────────────────────────────────────
// Schedules a local notification to fire at the given time if the employee
// hasn't clocked in yet. Called from DashboardScreen after the attendance
// record is loaded and the employee is still not clocked in.
//
// We use notifee.createTriggerNotification() with a TimestampTrigger so the
// notification fires even if the app is in the background.
//
// If the employee has already clocked in, cancelClockInReminder() is called
// to cancel any pending reminder so they don't get a spurious alert.
// ─────────────────────────────────────────────────────────────────────────────

const CHANNEL_CLOCK_IN    = 'clock_in_reminder_v1';
const CLOCK_IN_NOTIF_ID   = 'clock_in_reminder';
let   _clockInChannelReady = false;

async function _ensureClockInChannel() {
  if (!notifee || _clockInChannelReady) return;
  try {
    await notifee.createChannel({
      id:          CHANNEL_CLOCK_IN,
      name:        'Clock-In Reminder',
      importance:  IMPORTANCE_HIGH,
      sound:       'default',
      vibration:   true,
      badge:       true,
    });
    _clockInChannelReady = true;
  } catch {}
}

export async function scheduleClockInReminder(triggerDate) {
  if (!notifee) return;
  try {
    await _ensureClockInChannel();
    // Cancel any existing reminder before scheduling a new one
    await cancelClockInReminder();

    const TriggerType = notifee.TriggerType ?? require('@notifee/react-native').TriggerType;
    const trigger = {
      type:      TriggerType?.TIMESTAMP ?? 0,
      timestamp: triggerDate instanceof Date ? triggerDate.getTime() : triggerDate,
    };

    await notifee.createTriggerNotification(
      {
        id:    CLOCK_IN_NOTIF_ID,
        title: '⏰ You haven\'t clocked in yet',
        body:  'Your shift may have started. Please clock in to start tracking your attendance.',
        android: {
          channelId: CHANNEL_CLOCK_IN,
          importance: IMPORTANCE_HIGH,
          smallIcon: 'ic_notification',
          pressAction: { id: 'open_app', launchActivity: 'default' },
          actions: [
            {
              title:       'Open App',
              pressAction: { id: 'open_app', launchActivity: 'default' },
            },
          ],
        },
        ios: {
          sound:    'default',
          critical: false,
        },
      },
      trigger,
    );
    console.log('[Notifications] ⏰ Clock-in reminder scheduled for', triggerDate);
  } catch (e) {
    console.warn('[Notifications] scheduleClockInReminder error:', e.message);
  }
}

export async function cancelClockInReminder() {
  if (!notifee) return;
  try {
    await notifee.cancelNotification(CLOCK_IN_NOTIF_ID);
    await notifee.cancelTriggerNotification(CLOCK_IN_NOTIF_ID);
  } catch {}
}

// checkAndScheduleClockInReminder(attendanceRecord)
// Call this whenever attendance data is refreshed:
//   - If record is null / no loginTime → schedule a reminder at 9:30 AM today
//     (or +5 min from now if already past 9:30, for immediate reminder)
//   - If loginTime exists → cancel any pending reminder
export async function checkAndScheduleClockInReminder(record) {
  if (record?.loginTime) {
    // Already clocked in — cancel any pending reminder
    await cancelClockInReminder();
    return;
  }

  // Not clocked in — schedule a reminder
  //
  // FIX (clock/timezone bug): trigger.setHours(9, 30, 0, 0) sets 9:30 AM in
  // the DEVICE's local timezone. The company's shift start (and the
  // "late" cutoff enforced server-side) is 9:30 AM IST specifically — so on
  // a phone whose timezone isn't Asia/Kolkata (auto-updated while
  // traveling, a misconfigured device, an emulator, etc.) this reminder
  // fired at the wrong wall-clock moment relative to the actual shift
  // start. Compute "9:30 AM IST today" as an absolute instant instead, so
  // the reminder always lines up with the real shift start regardless of
  // the device's own timezone setting.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +05:30
  const now      = new Date();
  const istNow   = new Date(now.getTime() + IST_OFFSET_MS);
  const istHour  = istNow.getUTCHours();

  // Midnight IST today, expressed as a real (UTC) instant.
  const istMidnightUTC = new Date(istNow.getTime());
  istMidnightUTC.setUTCHours(0, 0, 0, 0);
  const todayMidnightIST = new Date(istMidnightUTC.getTime() - IST_OFFSET_MS);

  // Target: 9:30 AM IST today.
  let trigger = new Date(todayMidnightIST.getTime() + (9 * 60 + 30) * 60 * 1000);

  if (trigger <= now) {
    // Already past 9:30 AM IST — fire in 5 minutes as an immediate nudge.
    trigger = new Date(now.getTime() + 5 * 60 * 1000);
  }

  // Don't schedule if it's already evening in IST (after 8 PM IST — shift
  // likely not needed).
  if (istHour >= 20) return;

  await scheduleClockInReminder(trigger);
}

// ─────────────────────────────────────────────────────────────────────────────
// MEETING / FOLLOW-UP NOTIFICATIONS (Client Visit Log)
// ─────────────────────────────────────────────────────────────────────────────
// A meeting remark logged in ClientMeetingScreen may carry a followUpDate.
// We notify the rep in three ways:
//   1. A scheduled reminder REMINDER_BEFORE_MIN minutes before the follow-up.
//   2. A scheduled notification AT the follow-up time.
//   3. A daily summary (fired on first sync of the day) of today's follow-ups.
//
// (1) and (2) use notifee trigger notifications so they fire even when the app
// is backgrounded/killed. (3) is an immediate notification shown once per day.
// All three guard against duplicates via AsyncStorage dedup keys.
// ─────────────────────────────────────────────────────────────────────────────

const REMINDER_BEFORE_MIN = 30; // minutes before the meeting to nudge

async function _ensureMeetingChannel() {
  if (!notifee) return;
  try {
    await notifee.createChannel({
      id:         CHANNEL_MEETING,
      name:       'Client Meetings',
      importance: IMPORTANCE_HIGH,
      sound:      'default',
      vibration:  true,
      badge:      true,
    });
  } catch {}
}

// scheduleMeetingFollowUp(meeting)
// meeting: { id, leadName, followUpDate (ISO), meetingType?, location? }
// Schedules a "before" reminder and an "at-time" notification.
// Safe to call repeatedly — trigger IDs are deterministic so re-scheduling
// simply replaces the pending triggers (no duplicates).
export async function scheduleMeetingFollowUp(meeting) {
  if (!notifee || !meeting?.followUpDate) return;

  const whenMs = new Date(meeting.followUpDate).getTime();
  if (isNaN(whenMs)) return;

  const now = Date.now();
  // Nothing to schedule if the follow-up is already in the past.
  if (whenMs <= now) return;

  await _ensureMeetingChannel();

  const TriggerType =
    notifee.TriggerType ?? require('@notifee/react-native').TriggerType;

  const baseId = `meeting_${meeting.id || meeting.leadName || 'x'}_${whenMs}`;
  const lead   = meeting.leadName || 'Client';
  const typeStr = meeting.meetingType ? ` (${meeting.meetingType})` : '';

  // ── (1) Reminder BEFORE the meeting ──────────────────────────────────────
  const beforeMs = whenMs - REMINDER_BEFORE_MIN * 60 * 1000;
  if (beforeMs > now) {
    try {
      await notifee.createTriggerNotification(
        {
          id:    `${baseId}_before`,
          title: `🗓️ Upcoming meeting in ${REMINDER_BEFORE_MIN} min`,
          body:  `${lead}${typeStr}${meeting.location ? ` · ${meeting.location}` : ''}`,
          android: {
            channelId:   CHANNEL_MEETING,
            importance:  IMPORTANCE_HIGH,
            smallIcon:   'ic_notification',
            pressAction: { id: 'open_meetings', launchActivity: 'default' },
            data:        { meetingId: String(meeting.id || ''), leadName: lead },
          },
          ios: { sound: 'default' },
        },
        { type: TriggerType?.TIMESTAMP ?? 0, timestamp: beforeMs },
      );
    } catch (e) {
      console.warn('[Notifications] scheduleMeetingFollowUp before error:', e.message);
    }
  }

  // ── (2) Notification AT the meeting time ─────────────────────────────────
  try {
    await notifee.createTriggerNotification(
      {
        id:    `${baseId}_attime`,
        title: `📅 Client meeting now`,
        body:  `${lead}${typeStr}${meeting.location ? ` · ${meeting.location}` : ''}`,
        android: {
          channelId:   CHANNEL_MEETING,
          importance:  IMPORTANCE_HIGH,
          smallIcon:   'ic_notification',
          pressAction: { id: 'open_meetings', launchActivity: 'default' },
          data:        { meetingId: String(meeting.id || ''), leadName: lead },
        },
        ios: { sound: 'default' },
      },
      { type: TriggerType?.TIMESTAMP ?? 0, timestamp: whenMs },
    );
  } catch (e) {
    console.warn('[Notifications] scheduleMeetingFollowUp attime error:', e.message);
  }
}

// checkAndScheduleMeetingFollowUps(meetings)
// Given an array of meeting remarks (each with id + followUpDate + leadName),
// schedules triggers for any future follow-ups not already scheduled, and
// fires a once-per-day summary of today's follow-ups.
export async function checkAndScheduleMeetingFollowUps(meetings) {
  if (!notifee || !Array.isArray(meetings) || meetings.length === 0) return;

  try {
    const raw = await AsyncStorage.getItem(MEETING_NOTIFIED_KEY);
    const scheduledSet = new Set(raw ? JSON.parse(raw) : []);
    const now = Date.now();
    const newlyScheduled = [];

    // Today's window for the summary
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay   = new Date(); endOfDay.setHours(23, 59, 59, 999);
    const todaysFollowUps = [];

    for (const m of meetings) {
      if (!m?.followUpDate) continue;
      const whenMs = new Date(m.followUpDate).getTime();
      if (isNaN(whenMs)) continue;

      // Collect today's upcoming follow-ups for the summary
      if (whenMs >= startOfDay.getTime() && whenMs <= endOfDay.getTime() && whenMs >= now) {
        todaysFollowUps.push(m);
      }

      // Schedule future triggers (dedup by id+timestamp)
      const dedupKey = `${m.id || m.leadName}_${whenMs}`;
      if (whenMs > now && !scheduledSet.has(dedupKey)) {
        await scheduleMeetingFollowUp(m);
        scheduledSet.add(dedupKey);
        newlyScheduled.push(dedupKey);
      }
    }

    if (newlyScheduled.length > 0) {
      // Keep only future entries to stop the set growing unbounded
      const pruned = [...scheduledSet].filter((key) => {
        const ts = parseInt(key.substring(key.lastIndexOf('_') + 1));
        return !isNaN(ts) && ts > now;
      });
      await AsyncStorage.setItem(MEETING_NOTIFIED_KEY, JSON.stringify(pruned));
    }

    // ── (3) Daily summary — fired at most once per calendar day ──────────────
    await _maybeShowMeetingSummary(todaysFollowUps);
  } catch (e) {
    console.warn('[Notifications] checkAndScheduleMeetingFollowUps error:', e.message);
  }
}

async function _maybeShowMeetingSummary(todaysFollowUps) {
  if (!notifee || !todaysFollowUps?.length) return;
  try {
    const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const lastShown = await AsyncStorage.getItem(MEETING_SUMMARY_KEY);
    if (lastShown === todayStr) return; // already summarised today

    await _ensureMeetingChannel();
    const count = todaysFollowUps.length;
    const names = todaysFollowUps.slice(0, 4).map((m) => m.leadName || 'Client');

    const badge = await _incrementBadge(1);
    await notifee.displayNotification({
      id:    `meeting_summary_${todayStr}`,
      title: `🗓️ ${count} client meeting${count > 1 ? 's' : ''} today`,
      body:  names.join(', ') + (count > names.length ? ` +${count - names.length} more` : ''),
      android: {
        channelId:     CHANNEL_MEETING,
        importance:    IMPORTANCE_HIGH,
        smallIcon:     'ic_notification',
        badgeCount:    badge,
        badgeIconType: 1,
        pressAction:   { id: 'open_meetings' },
        ...(count > 1 && AndroidStyle && {
          style: {
            type:    AndroidStyle.INBOX,
            lines:   todaysFollowUps.slice(0, 5).map((m) => m.leadName || 'Client'),
            summary: `${count} meetings`,
          },
        }),
      },
      ios: {
        sound: 'default',
        badge,
        foregroundPresentationOptions: { alert: true, sound: true, badge: true },
      },
    });

    await AsyncStorage.setItem(MEETING_SUMMARY_KEY, todayStr);
  } catch (e) {
    console.warn('[Notifications] _maybeShowMeetingSummary error:', e.message);
  }
}

// cancelMeetingFollowUp(meetingId, followUpDate) — cancels pending triggers
export async function cancelMeetingFollowUp(meetingId, followUpDate) {
  if (!notifee) return;
  try {
    const whenMs = new Date(followUpDate).getTime();
    if (isNaN(whenMs)) return;
    const baseId = `meeting_${meetingId}_${whenMs}`;
    await notifee.cancelTriggerNotification(`${baseId}_before`);
    await notifee.cancelTriggerNotification(`${baseId}_attime`);
  } catch {}
}

export async function clearNotificationState() {
  try {
    await AsyncStorage.multiRemove([
      SEEN_LEADS_KEY,
      NOTIFIED_FOLLOWUP_KEY,
      REASSIGN_COUNTS_KEY,
      SOCKET_NOTIFIED_KEY,
      SOCKET_REASSIGN_KEY,
      MEETING_NOTIFIED_KEY,
      MEETING_SUMMARY_KEY,
    ]);

    if (notifee) {
      await notifee.cancelAllNotifications();
    }

    // FIX BUG 4: Do NOT set _notifChannelsReady = false here.
    //
    // The old code set it to false on logout so that setupNotifications()
    // would re-run the channel creation on the next login. But this caused
    // a race: if setupNotifications() threw (e.g. during deleteChannel) the
    // flag stayed false permanently, silently blocking ALL notifications for
    // the rest of the session — checkAndNotifyNewLeads, showNewLeadNotification,
    // checkAndNotifyFollowUps all guard on _notifChannelsReady and return early.
    //
    // The fix is safe because Android notification channels are persistent
    // (they survive app restarts). createChannel() is a guaranteed no-op if the
    // channel already exists. There is no reason to re-create channels on each
    // login cycle; leaving _notifChannelsReady = true is correct.
  } catch {
    // swallow
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// showNewLeadNotification()
// ─────────────────────────────────────────────────────────────────────────────
export async function showNewLeadNotification({
  leadId,
  leadName,
  source,
}) {
  if (!notifee || !_notifChannelsReady) return;

  if (!leadId) return;

  try {
    const raw = await AsyncStorage.getItem(SOCKET_NOTIFIED_KEY);

    const seenIds = raw
      ? JSON.parse(raw)
      : [];

    const normalizedSeenIds =
      Array.isArray(seenIds)
        ? seenIds.map(String)
        : [];

    if (
      normalizedSeenIds.includes(
        String(leadId)
      )
    ) {
      console.log(
        '[Notifications] socket lead already notified',
        leadId
      );

      return;
    }

    const updated = [
      ...normalizedSeenIds,
      String(leadId),
    ];

    const pruned = updated.slice(-500);

    await AsyncStorage.setItem(
      SOCKET_NOTIFIED_KEY,
      JSON.stringify(pruned)
    );

    const sourceLine =
      source && source !== '—'
        ? ` via ${source}`
        : '';

    const socketBadge = await _incrementBadge(1);

    await notifee.displayNotification({
      id: `socket_lead_${leadId}`,

      title: '🎯 New Lead Assigned',

      body: `${leadName}${sourceLine}`,

      android: {
        channelId: CHANNEL_NEW_LEAD,
        importance: IMPORTANCE_HIGH,
        smallIcon: 'ic_notification',
        badgeCount: socketBadge,
        badgeIconType: 1,
        showWhen: true,

        pressAction: {
          id: 'open_leads',
        },
      },

      ios: {
        sound: 'default',
        badge: socketBadge,
        foregroundPresentationOptions: {
          alert: true,
          sound: true,
          badge: true,
        },
      },
    });

    console.log(
      '[Notifications] ✅ showNewLeadNotification fired'
    );
  } catch (err) {
    console.warn(
      '[Notifications] showNewLeadNotification error:',
      err.message
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// showReassignedLeadNotification()
// ─────────────────────────────────────────────────────────────────────────────
export async function showReassignedLeadNotification({ leadId, leadName }) {
  if (!notifee || !_notifChannelsReady) return;
  if (!leadId) return;

  try {
    const raw     = await AsyncStorage.getItem(SOCKET_REASSIGN_KEY);
    const seenIds = raw ? JSON.parse(raw) : [];
    const normalized = Array.isArray(seenIds) ? seenIds.map(String) : [];

    if (normalized.includes(String(leadId))) {
      console.log('[Notifications] socket reassign already notified', leadId);
      return;
    }

    await AsyncStorage.setItem(
      SOCKET_REASSIGN_KEY,
      JSON.stringify([...normalized, String(leadId)].slice(-500))
    );

    const badge = await _incrementBadge(1);

    await notifee.displayNotification({
      id:    `reassigned_${leadId}`,
      title: '🔄 Lead Reassigned to You',
      body:  `${leadName} has been assigned to you`,
      android: {
        channelId:     CHANNEL_NEW_LEAD,
        importance:    IMPORTANCE_HIGH,
        smallIcon:     'ic_notification',
        badgeCount:    badge,
        badgeIconType: 1,
        showWhen:      true,
        pressAction:   { id: 'open_leads' },
      },
      ios: {
        sound: 'default',
        badge,
        foregroundPresentationOptions: { alert: true, sound: true, badge: true },
      },
    });

    console.log('[Notifications] ✅ showReassignedLeadNotification fired');
  } catch (err) {
    console.warn('[Notifications] showReassignedLeadNotification error:', err.message);
  }
}