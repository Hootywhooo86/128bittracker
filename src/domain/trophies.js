// Golden trophies — the 128bit shelf.
//
//   game   100% (every achievement/trophy, or marked 100%) → golden controller
//   movie  finished                                        → golden VHS
//   show   season finished                                 → golden TV with antenna
//   anime  series finished                                 → golden anime girl
//   book   audiobook (meta.format 'audiobook') finished     → golden CD with a book on its cover
//
// One trophy per item. Once earned it stays on the shelf, even if the item
// is later reopened: you did it.

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

/** Award the item's trophy if it just earned one. Returns the new trophy or null. */
export function checkTrophy(ctx, item) {
  const kind = trophyFor(item);
  if (!kind) return null;
  const have = ctx.db.prepare('SELECT 1 FROM trophies WHERE item_id = ?').get(item.id);
  if (have) return null;
  const season = item.meta?.season ? ` · Season ${item.meta.season}` : '';
  const title = `${item.title}${season}`;
  const earned_at = new Date().toISOString();
  ctx.db
    .prepare('INSERT INTO trophies (item_id, kind, title, earned_at) VALUES (?, ?, ?, ?)')
    .run(item.id, kind, title, earned_at);
  ctx.events.emit(
    'trophy.earned',
    { kind, trophy: TROPHIES[kind].name, item_id: item.id, type: item.type, title },
    { title: `🏆 ${TROPHIES[kind].name} — ${title}` },
  );
  return { kind, title, earned_at };
}

export function listTrophies(ctx) {
  return ctx.db
    .prepare(
      `SELECT t.id, t.item_id, t.kind, t.title, t.earned_at, i.cover_url, i.type
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
