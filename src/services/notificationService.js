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

// ── Notification channel IDs ─────────────────────────────────────────────────
const CHANNEL_NEW_LEAD = 'new_lead_channel_v2';
const CHANNEL_FOLLOW_UP = 'followup_channel_v2';

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
  const now     = new Date();
  const trigger = new Date();

  // Target: 9:30 AM today
  trigger.setHours(9, 30, 0, 0);

  if (trigger <= now) {
    // Already past 9:30 AM — fire in 5 minutes as an immediate nudge
    trigger.setTime(now.getTime() + 5 * 60 * 1000);
  }

  // Don't schedule if it's already evening (after 8 PM — shift likely not needed)
  if (now.getHours() >= 20) return;

  await scheduleClockInReminder(trigger);
}

export async function clearNotificationState() {
  try {
    await AsyncStorage.multiRemove([
      SEEN_LEADS_KEY,
      NOTIFIED_FOLLOWUP_KEY,
      REASSIGN_COUNTS_KEY,
      SOCKET_NOTIFIED_KEY,
      SOCKET_REASSIGN_KEY,
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