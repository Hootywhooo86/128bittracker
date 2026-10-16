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
//
// Media events 128bitPlay posts to the family feed (docs/EVENTS.md). These are
// also accepted from any other source (Plex, Jellyfin, Emby, scripts):
//   book.finished   { title, author? }          → book (done); from 128bitPlay an
//                   audiobook (meta.format) → golden CD
//   movie.watched   { title }                   → movie (done → golden VHS)
//   episode.watched { show, episode: "S2 E3 · Name" } → that season's item; the
//                   last episode of the season finishes it (→ golden TV). With
//                   data.anime (set by enrich.js) the season is an anime item
//                   instead (→ golden idol).
//   chapter.read    { comic }                   → comic (+1 issue)
import { HttpError } from '../api/errors.js';
import { createItem, findByExternal, updateItem, addSession, getItem } from '../domain/library.js';

const key = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Find-or-create a non-game item keyed by a stable external id. */
function upsertMedia(ctx, externalId, fields) {
  const existing = findByExternal(ctx, SOURCE, externalId);
  return existing ?? createItem(ctx, fields, { source: SOURCE, externalId });
}

// Every media item from events lives under this source, whoever sent the
// event, so a movie watched on Plex and in 128bitPlay is one item.
const SOURCE = '128bitplay';

export const MEDIA_EVENTS = new Set(['book.finished', 'movie.watched', 'episode.watched', 'chapter.read']);

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
    case 'book.finished': {
      if (!d.title) return [];
      // 128bitPlay's books are audiobooks: finishing one earns the golden CD.
      const audio = ev.source === '128bitplay' || d.format === 'audiobook';
      const item = upsertMedia(ctx, `book:${key(d.title)}|${key(d.author)}`, { type: 'book', title: d.title, creator: d.author ?? null, ...(audio ? { meta: { format: 'audiobook' } } : {}) });
      return [{ item_id: updateItem(ctx, item.id, { status: 'done', ...(audio ? { meta: { format: 'audiobook' } } : {}) }).id }];
    }
    case 'movie.watched': {
      if (!d.title) return [];
      const item = upsertMedia(ctx, `movie:${key(d.title)}`, { type: 'movie', title: d.title });
      return [{ item_id: updateItem(ctx, item.id, { status: 'done' }).id }];
    }
    case 'episode.watched': {
      if (!d.show) return [];
      const season = Number(d.season ?? String(d.episode ?? '').match(/S(\d+)/i)?.[1]) || null;
      const number = Number(d.number ?? String(d.episode ?? '').match(/E(\d+)/i)?.[1]) || null;
      const type = d.anime ? 'anime' : 'show';
      const item = upsertMedia(ctx, `${type}:${key(d.show)}${season ? `:s${season}` : ''}`, {
        type, title: d.show, status: 'active', meta: season ? { season } : {},
      });
      const total = Number(d.season_episodes) || item.progress_total || null;
      const progress = Math.max(item.progress ?? 0, number ?? (item.progress ?? 0) + 1);
      const patch = { progress };
      if (total && !item.progress_total) patch.progress_total = total;
      if (total && progress >= total) patch.status = 'done';
      else if (item.status === 'planned' || item.status === 'on_hold') patch.status = 'active';
      return [{ item_id: updateItem(ctx, item.id, patch).id }];
    }
    case 'chapter.read': {
      if (!d.comic) return [];
      const item = upsertMedia(ctx, `comic:${key(d.comic)}`, { type: 'comic', title: d.comic, status: 'active' });
      return [{ item_id: updateItem(ctx, item.id, { progress: (item.progress ?? 0) + 1 }).id }];
    }
    default:
      // achievement.unlocked, score.posted, and anything new: timeline only.
      if (d.game?.id != null && d.game?.title) return [{ item_id: upsertGame(ctx, d.game).id }];
      return [];
  }
}
