// Ready-made lists: Movies, Shows, Anime, Audiobooks, Comics for everyone.
//
//   signed in   the cloud library makes them (supabase/tracker.sql starter_lists(),
//               which also places them on their 128bitPlay tab), once per account,
//               and the next pull brings them here
//   local only  made here, once, for any that has no list yet
//
// Never duplicated: a list whose name looks like one (your own "Amine",
// "Audiobooks", "TV"…) or, failing that, any list of that kind counts.
import { createCollection, listCollections } from '../domain/library.js';

// Same matching as starter_lists() in supabase/tracker.sql.
export const STARTER_LISTS = [
  { key: 'movie', kind: 'movie', name: 'Movies', pat: /^(movie|film)/ },
  { key: 'show', kind: 'show', name: 'Shows', pat: /(show|tv|series)/ },
  { key: 'anime', kind: 'anime', name: 'Anime', pat: /(anim|amine)/ },
  { key: 'audiobooks', kind: 'book', name: 'Audiobooks', pat: /(audio|book)/ },
  { key: 'comic', kind: 'comic', name: 'Comics', pat: /(comic|manga|manhwa)/ },
];
const ANIME = /(anim|amine)/;

const kvGet = (ctx, k) => {
  const v = ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value;
  return v ? JSON.parse(v) : null;
};
const kvPut = (ctx, k, v) =>
  ctx.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));

/** The existing list that stands for a starter list, if any. */
export function matchStarter(lists, s, taken = new Set()) {
  const free = lists.filter((l) => !taken.has(l.id) && !(s.key === 'show' && ANIME.test(l.name.toLowerCase())));
  const byName = free.filter((l) => s.pat.test(l.name.toLowerCase())).sort((a, b) => Number(b.kind === s.kind) - Number(a.kind === s.kind));
  return byName[0] ?? free.find((l) => l.kind === s.kind) ?? null;
}

/** Not signed in: make the five lists once, skipping any you already have. */
export function localStarterLists(ctx, { signedIn = false } = {}) {
  if (signedIn || kvGet(ctx, 'lists.starter')) return [];
  const lists = listCollections(ctx);
  const taken = new Set();
  const made = [];
  for (const s of STARTER_LISTS) {
    const have = matchStarter(lists, s, taken);
    if (have) { taken.add(have.id); continue; }
    try {
      made.push(createCollection(ctx, { name: s.name, kind: s.kind, show_in_play: true }));
    } catch { /* a list by that exact name appeared meanwhile */ }
  }
  // The ones made here, so signing in to an account that has its own can drop them while still empty.
  kvPut(ctx, 'lists.starter', { at: new Date().toISOString(), made: made.map((l) => l.id) });
  return made;
}

/**
 * Before the first cloud sync of an account: starter lists made here that are
 * still empty and never synced go, so the account's own (or new ones from the
 * cloud) come down instead of a second "Movies". Returns what was dropped.
 */
export function dropUntouchedStarters(ctx) {
  const mark = kvGet(ctx, 'lists.starter');
  const dropped = [];
  for (const id of mark?.made ?? []) {
    const l = ctx.db.prepare('SELECT id, name, kind, uid, created_at, updated_at FROM collections WHERE id = ?').get(id);
    if (!l || l.uid || (l.updated_at && l.updated_at !== l.created_at)) continue;
    if (ctx.db.prepare('SELECT 1 FROM collection_items WHERE collection_id = ?').get(id)) continue;
    ctx.db.prepare('DELETE FROM collections WHERE id = ?').run(id);
    dropped.push({ name: l.name, kind: l.kind });
  }
  if (mark) kvPut(ctx, 'lists.starter', { ...mark, made: [] });
  return dropped;
}

/** Put dropped starter lists back (the cloud couldn't make them). */
export function restoreStarters(ctx, dropped) {
  const made = [];
  for (const l of dropped) {
    try { made.push(createCollection(ctx, { name: l.name, kind: l.kind, show_in_play: true }).id); } catch { /* exists */ }
  }
  const mark = kvGet(ctx, 'lists.starter');
  if (made.length) kvPut(ctx, 'lists.starter', { ...(mark ?? { at: new Date().toISOString() }), made: [...(mark?.made ?? []), ...made] });
}

const cloudKey = (userId) => `cloud.starter.${userId ?? 'me'}`;

/**
 * Signed in, once per account: run around the first push. Untouched local
 * starters go first; after the push the cloud makes (or finds) the five lists,
 * and the pull that follows brings them down.
 */
export async function withCloudStarters(ctx, rpc, userId, pushFn) {
  if (kvGet(ctx, cloudKey(userId))) return pushFn();
  const dropped = dropUntouchedStarters(ctx);
  let pushed;
  try {
    pushed = await pushFn();
  } catch (err) {
    restoreStarters(ctx, dropped);
    throw err;
  }
  try {
    const ids = await rpc('starter_lists', {});
    kvPut(ctx, cloudKey(userId), { at: new Date().toISOString(), ids: ids ?? null });
  } catch (err) {
    restoreStarters(ctx, dropped);
    // An account server without starter_lists(): the lists made here are the starters.
    if (/starter_lists|does not exist|Could not find the function|missing the family feed/i.test(err.message)) {
      kvPut(ctx, cloudKey(userId), { at: new Date().toISOString(), skipped: true });
    }
  }
  return pushed;
}
