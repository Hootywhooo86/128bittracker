// Golden trophies — the 128bit shelf.
//
//   game   100% (every achievement/trophy, or marked 100%) → golden controller
//   movie  finished                                        → golden VHS
//   show   season finished                                 → golden TV with antenna
//   anime  series finished                                 → golden anime girl
//   book   audiobook (meta.format 'audiobook') finished     → golden CD with a book on its cover
//
// One trophy per item, and for shows and anime one per finished season (the
// seasons live inside the one show, src/domain/seasons.js). Once earned it stays
// on the shelf, even if the item is later reopened: you did it.
import { isShow, seasonsOf } from './seasons.js';

export const TROPHIES = {
  controller: { name: 'Golden Controller', for: '100% a game' },
  vhs:        { name: 'Golden VHS',        for: 'finish a movie' },
  tv:         { name: 'Golden TV',         for: 'finish a show season' },
  anime:      { name: 'Golden Idol',       for: 'finish an anime series' },
  cd:         { name: 'Golden CD',         for: 'finish an audiobook' },
};

/** Is a game 100%? From synced achievements, or the player's own "100%" mark. */
export function isPerfect(item) {
  const a = item.meta?.achievements;
  if (a && a.total > 0 && a.unlocked >= a.total) return true;
  return item.meta?.perfect === true;
}

/** Which trophy (if any) this item has earned right now. */
export function trophyFor(item) {
  switch (item.type) {
    case 'game':  return isPerfect(item) ? 'controller' : null;
    case 'movie': return item.status === 'done' ? 'vhs' : null;
    case 'show':  return item.status === 'done' ? 'tv' : null;
    case 'anime': return item.status === 'done' ? 'anime' : null;
    case 'book':  return item.status === 'done' && item.meta?.format === 'audiobook' ? 'cd' : null;
    default:      return null;
  }
}

function award(ctx, item, kind, season = null) {
  const have = ctx.db.prepare('SELECT 1 FROM trophies WHERE item_id = ? AND COALESCE(season, 0) = ?').get(item.id, season ?? 0);
  if (have) return null;
  const title = `${item.title}${season ? ` · Season ${season}` : ''}`;
  // Already earned on its own item (a season that used to be an item of its own): pick it back up.
  const loose = ctx.db.prepare('SELECT id FROM trophies WHERE item_id IS NULL AND kind = ? AND title = ?').get(kind, title);
  if (loose) {
    ctx.db.prepare('UPDATE trophies SET item_id = ?, season = ? WHERE id = ?').run(item.id, season, loose.id);
    return null;
  }
  const earned_at = new Date().toISOString();
  ctx.db
    .prepare('INSERT INTO trophies (item_id, season, kind, title, earned_at) VALUES (?, ?, ?, ?, ?)')
    .run(item.id, season, kind, title, earned_at);
  ctx.events.emit(
    'trophy.earned',
    { kind, trophy: TROPHIES[kind].name, item_id: item.id, type: item.type, title, ...(season ? { season } : {}) },
    { title: `🏆 ${TROPHIES[kind].name} — ${title}` },
  );
  return { kind, title, earned_at, ...(season ? { season } : {}) };
}

/** Award the item's trophy (a show: each finished season's) if it just earned one. Returns the newest or null. */
export function checkTrophy(ctx, item) {
  if (isShow(item)) {
    const kind = item.type === 'anime' ? 'anime' : 'tv';
    let last = null;
    const seasons = seasonsOf(item);
    for (const s of Object.keys(seasons).map(Number).sort((a, b) => a - b)) {
      if (s > 0 && seasons[s].done) last = award(ctx, item, kind, s) ?? last;
    }
    return last;
  }
  const kind = trophyFor(item);
  return kind ? award(ctx, item, kind) : null;
}

export function listTrophies(ctx) {
  return ctx.db
    .prepare(
      `SELECT t.id, t.item_id, t.season, t.kind, t.title, t.earned_at, i.cover_url, i.type
         FROM trophies t LEFT JOIN items i ON i.id = t.item_id
        ORDER BY t.earned_at DESC, t.id DESC`,
    )
    .all()
    .map((t) => ({ ...t, name: TROPHIES[t.kind]?.name ?? t.kind }));
}

export function trophyCounts(ctx) {
  const counts = Object.fromEntries(Object.keys(TROPHIES).map((k) => [k, 0]));
  for (const r of ctx.db.prepare('SELECT kind, COUNT(*) AS n FROM trophies GROUP BY kind').all()) counts[r.kind] = r.n;
  return counts;
}
