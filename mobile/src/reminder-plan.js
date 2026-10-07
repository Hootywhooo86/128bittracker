// Pure reminder planning (kept separate so it's testable without Capacitor).

const DAYS_AHEAD = 7;

/** Pure: which notifications should exist right now. */
export function planReminders(trackers, now = new Date()) {
  const plan = [];
  for (const t of trackers) {
    if (!t.remind_at || t.archived) continue;
    const [h, m] = t.remind_at.split(':').map(Number);
    for (let d = 0; d < DAYS_AHEAD; d++) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, h, m, 0, 0);
      if (at <= now) continue;
      if (d === 0 && t.today.done) continue;
      const streak = d === 0 ? t.streak.current : 0;
      plan.push({
        id: t.id * 10 + d,
        title: `${t.icon} ${t.name}`,
        body: streak > 0 ? `Keep your ${streak}-day streak alive 🔥` : "Two taps and it's on the record.",
        at,
      });
    }
  }
  return plan;
}
