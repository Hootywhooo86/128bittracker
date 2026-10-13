// Health Connect reader (Android). Pulls workouts plus daily steps, active
// calories and distance, and hands them to the shared /health/sync route.
import { Health } from 'capacitor-health';

const PERMISSIONS = ['READ_WORKOUTS', 'READ_STEPS', 'READ_ACTIVE_CALORIES', 'READ_DISTANCE'];
const DAY_MS = 86_400_000;

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function healthAvailable() {
  try {
    return (await Health.isHealthAvailable()).available;
  } catch {
    return false;
  }
}

/** Ask for access. Returns true when at least workouts or steps were granted. */
export async function connectHealth() {
  if (!(await healthAvailable())) {
    await Health.showHealthConnectInPlayStore().catch(() => {});
    return { ok: false, reason: 'Install Health Connect from the Play Store, then tap again.' };
  }
  const { permissions } = await Health.requestHealthPermissions({ permissions: PERMISSIONS });
  // Android returns { READ_STEPS: true, … }; the typings say an array of those.
  const granted = Array.isArray(permissions) ? Object.assign({}, ...permissions) : { ...(permissions ?? {}) };
  const ok = Object.values(granted).some(Boolean);
  return ok ? { ok: true, granted } : { ok: false, reason: 'No access was given. You can allow it in Health Connect settings.' };
}

export const openHealthSettings = () => Health.openHealthConnectSettings();

async function daily(dataType, start, end) {
  try {
    const { aggregatedData } = await Health.queryAggregated({ startDate: start.toISOString(), endDate: end.toISOString(), dataType, bucket: 'day' });
    return aggregatedData ?? [];
  } catch {
    return []; // that permission wasn't granted
  }
}

/** Read the last `days` days (today included) and post them to Tracker. */
export async function pullHealth(request, { days = 7 } = {}) {
  const end = new Date();
  const start = new Date(end);
  start.setHours(0, 0, 0, 0);
  start.setTime(start.getTime() - (days - 1) * DAY_MS);

  let workouts = [];
  try {
    ({ workouts } = await Health.queryWorkouts({ startDate: start.toISOString(), endDate: end.toISOString(), includeHeartRate: false, includeRoute: false, includeSteps: true }));
  } catch { /* no workout access */ }

  const byDay = new Map();
  const put = (rows, key, scale = 1) => {
    for (const r of rows) {
      if (r.value == null) continue;
      // Buckets start at local midnight: "2026-10-13T00:00".
      const day = String(r.startDate).slice(0, 10);
      byDay.set(day, { ...(byDay.get(day) ?? { day }), [key]: r.value * scale });
    }
  };
  put(await daily('steps', start, end), 'steps');
  put(await daily('active-calories', start, end), 'active_calories');
  put(await daily('distance', start, end), 'distance_m');

  const { status, data } = await request('POST', '/health/sync', { workouts: workouts ?? [], days: [...byDay.values()] });
  if (status >= 400) throw new Error(data?.error ?? 'Health sync failed');
  return { ...data, today: byDay.get(localDay(end)) ?? null };
}
