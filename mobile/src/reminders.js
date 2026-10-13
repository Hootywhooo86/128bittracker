// Daily habit reminders as local notifications. Nothing leaves the phone.
//
// Android can't ask the app "is this habit done yet?" when the alarm fires,
// so we schedule one-shot notifications for the next week and skip today
// once a habit is done. The plan is rebuilt after every change and whenever
// the app opens, so it stays accurate as long as the app is used weekly.
import { LocalNotifications } from '@capacitor/local-notifications';
import { listTrackers } from '../../src/domain/trackers.js';
import { planReminders } from './reminder-plan.js';

export function createReminders(ctx) {
  let timer = null;
  let asked = false;

  async function apply() {
    const plan = planReminders(listTrackers(ctx));
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length) {
      await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
    }
    if (!plan.length) return 0;
    let perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted' && !asked) {
      asked = true; // ask once per app session, not on every tap
      perm = await LocalNotifications.requestPermissions();
    }
    if (perm.display !== 'granted') return 0;
    await LocalNotifications.schedule({
      notifications: plan.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        schedule: { at: n.at, allowWhileIdle: true },
        smallIcon: 'ic_stat_tracker',
        iconColor: '#ff9f1c',
      })),
    });
    return plan.length;
  }

  return {
    /** Rebuild the schedule soon (changes come in bursts). */
    refresh() {
      clearTimeout(timer);
      timer = setTimeout(() => apply().catch((e) => console.warn('reminders:', e.message)), 400);
    },
  };
}
