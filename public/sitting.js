// One listening / watching sitting (listen.session, watch.session from 128bitPlay):
// how long it really was and where it started and stopped. Shared by the
// timeline (app.js) and the titles Tracker stores (family-account.js).

// "42 min" / "1h 5m"
export const sittingMins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)} min`);

/**
 * Minutes of a sitting. Play counts ticks, which stop with the screen off, so
 * the reported minutes can be far too low. When the start and stop positions
 * are in the same chapter (or the item has no chapters), the distance moved is
 * a better count: the larger of the two wins, never more than the wall-clock
 * time between start and stop. Across chapters the ones in between can't be
 * measured here, so the ticks stand.
 */
export function sittingMinutes(d = {}, endAt = null) {
  const ticks = Number(d.minutes) > 0 ? Number(d.minutes) : 0;
  const from = Number(d.from_s), to = Number(d.to_s);
  if (d.from_s == null || d.to_s == null || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return ticks;
  if (String(d.from_chapter ?? '') !== String(d.to_chapter ?? '')) return ticks;
  let moved = Math.round((to - from) / 60);
  const start = Date.parse(d.started_at ?? ''), end = Date.parse(endAt ?? d.ended_at ?? '');
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) moved = Math.min(moved, Math.round((end - start) / 60000));
  return Math.max(ticks, moved);
}

// 42:10 / 1:12:30
export const fmtPos = (sec) => {
  const t = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};

/** "Ch 1 59:41 → Ch 1 1:03:10", "42:10 → 1:12:30", or '' when no positions came with it. */
export function sittingWhere(d = {}) {
  const end = (ch, s) => [ch != null && ch !== '' ? `Ch ${ch}` : null, s != null && s !== '' && Number.isFinite(Number(s)) ? fmtPos(s) : null].filter(Boolean).join(' ');
  const from = end(d.from_chapter, d.from_s), to = end(d.to_chapter, d.to_s);
  if (!from && !to) return '';
  return `${from || '…'} → ${to || '…'}`;
}

/** A stored title with the sitting's real minutes (titles saved before the fix said fewer). */
export function fixSittingTitle(title, d = {}, endAt = null) {
  const real = sittingMinutes(d, endAt);
  const ticks = Number(d.minutes) > 0 ? Number(d.minutes) : 0;
  if (!title || real <= ticks) return title;
  if (ticks && title.includes(` · ${sittingMins(ticks)}`)) return title.replace(` · ${sittingMins(ticks)}`, ` · ${sittingMins(real)}`);
  const name = d.title ?? d.show;
  if (!ticks && name && title.includes(name)) {
    const at = title.indexOf(name) + name.length;
    // after "Show · S1 E2" for episodes
    const ep = d.episode && title.slice(at).startsWith(` · ${d.episode}`) ? ` · ${d.episode}`.length : 0;
    return `${title.slice(0, at + ep)} · ${sittingMins(real)}${title.slice(at + ep)}`;
  }
  return title;
}
