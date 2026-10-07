// 128bitplay → Tracker.
//
// 128bitplay sends envelopes with source "128bitplay". Each game is keyed by
// data.game.id, so the same game always maps to one Library item.
//
//   game.added         { game }                         → item (planned)
//   game.started       { game }                         → item (active)
//   game.session       { game, minutes, progress? }     → session + play time
//   game.completed     { game }                         → item (done)
//   game.dropped       { game }                         → item (dropped)
//   game.rated         { game, rating }                 → rating (1..10)
//   achievement.unlocked { game, achievement: {name} }  → timeline only
//   score.posted       { game, score }                  → timeline only
//
// game = { id, title, cover_url?, platform?, developer?, year? }
import { HttpError } from '../api/errors.js';
import { createItem, findByExternal, updateItem, addSession, getItem } from '../domain/library.js';

const SOURCE = '128bitplay';

function upsertGame(ctx, game, status) {
  if (!game || game.id == null || !game.title) throw new HttpError(400, 'data.game needs id and title');
  const existing = findByExternal(ctx, SOURCE, game.id);
  if (existing) {
    const patch = {};
    if (game.cover_url && game.cover_url !== existing.cover_url) patch.cover_url = game.cover_url;
    if (status && rank(status) > rank(existing.status)) patch.status = status;
    return Object.keys(patch).length ? updateItem(ctx, existing.id, patch) : getItem(ctx, existing.id);
  }
  return createItem(
    ctx,
    {
      type: 'game',
      title: game.title,
      creator: game.developer ?? null,
      year: game.year ?? null,
      cover_url: game.cover_url ?? null,
      status: status ?? 'planned',
      meta: { platform: game.platform ?? null, url: game.url ?? null },
    },
    { source: SOURCE, externalId: String(game.id) },
  );
}

// Status only moves forward from automation; manual edits can still go anywhere.
const ORDER = ['planned', 'on_hold', 'active', 'dropped', 'done'];
const rank = (s) => ORDER.indexOf(s);

export function applyPlayEvent(ctx, ev) {
  const d = ev.data;
  switch (ev.type) {
    case 'game.added':
      return [{ item_id: upsertGame(ctx, d.game).id }];
    case 'game.started':
      return [{ item_id: upsertGame(ctx, d.game, 'active').id }];
    case 'game.session': {
      const item = upsertGame(ctx, d.game);
      const minutes = Number(d.minutes ?? 0);
      addSession(ctx, item.id, { minutes, progress: d.progress ?? null, note: d.note }, { source: SOURCE, at: ev.occurred_at });
      return [{ item_id: item.id, minutes }];
    }
    case 'game.completed':
      return [{ item_id: upsertGame(ctx, d.game, 'done').id }];
    case 'game.dropped':
      return [{ item_id: upsertGame(ctx, d.game, 'dropped').id }];
    case 'game.rated': {
      const item = upsertGame(ctx, d.game);
      updateItem(ctx, item.id, { rating: d.rating });
      return [{ item_id: item.id, rating: d.rating }];
    }
    default:
      // achievement.unlocked, score.posted, and anything new: timeline only.
      if (d.game?.id != null && d.game?.title) return [{ item_id: upsertGame(ctx, d.game).id }];
      return [];
  }
}
