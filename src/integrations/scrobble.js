// Auto-tracking from media servers: what you finish on Plex, Jellyfin or Emby
// (or anything that can POST JSON: Kodi add-ons, Tautulli, Home Assistant,
// Tasker) becomes a movie.watched / episode.watched event, so movies earn
// golden VHS tapes and seasons earn golden TVs without touching the app.
//
//   Plex      Settings → Webhooks (Plex Pass)            only media.scrobble (90% watched)
//   Jellyfin  Webhook plugin, "Generic" destination       PlaybackStop + PlayedToCompletion, or marked played
//   Emby      Settings → Webhooks                         playback.stop when finished, or item.markplayed
//   generic   { type: "movie"|"episode", title, show?, season?, episode?, year? }
import { HttpError } from '../api/errors.js';
import { toDay } from '../domain/dates.js';

export const SCROBBLERS = ['plex', 'jellyfin', 'emby', 'generic'];

/** A finished movie/episode → a 128bit envelope, or null when the payload isn't one. */
export function scrobbleEvent(service, p) {
  if (!SCROBBLERS.includes(service)) throw new HttpError(404, `unknown scrobbler "${service}"`);
  if (!p || typeof p !== 'object') throw new HttpError(400, 'send the webhook payload');
  const w = PARSERS[service](p);
  if (!w || !(w.kind === 'movie' ? w.title : w.show)) return null;
  const day = toDay(); // the device's own day, not UTC's
  const what = w.kind === 'movie' ? w.title : `${w.show} S${w.season ?? 0}E${w.number ?? 0}`;
  return {
    // One event per thing per day, so a webhook firing twice counts once.
    id: `${service}:${String(w.ref ?? what).toLowerCase().replace(/\s+/g, ' ').slice(0, 160)}:${day}`,
    type: w.kind === 'movie' ? 'movie.watched' : 'episode.watched',
    source: service,
    title: w.kind === 'movie' ? `🎬 Watched ${w.title}` : `📺 ${w.show} · S${w.season ?? '?'} E${w.number ?? '?'}${w.title ? ` · ${w.title}` : ''}`,
    data: w.kind === 'movie'
      ? { title: w.title, year: w.year ?? null }
      : { show: w.show, season: w.season ?? null, number: w.number ?? null, episode: `S${w.season ?? 1} E${w.number ?? 1}${w.title ? ` · ${w.title}` : ''}`, ...(w.anime ? { anime: true } : {}) },
  };
}

const num = (v) => (v == null || v === '' ? null : Number(v) || null);
const yes = (v) => v === true || String(v).toLowerCase() === 'true';

const PARSERS = {
  plex(p) {
    const m = p.Metadata ?? {};
    if (p.event !== 'media.scrobble') return null;
    if (m.type === 'movie') return { kind: 'movie', title: m.title, year: num(m.year), ref: m.guid ?? m.ratingKey };
    if (m.type === 'episode') {
      return { kind: 'episode', show: m.grandparentTitle, season: num(m.parentIndex), number: num(m.index), title: m.title, ref: m.guid ?? m.ratingKey,
        anime: /anime/i.test(m.librarySectionTitle ?? '') };
    }
    return null;
  },
  jellyfin(p) {
    const finished = (p.NotificationType === 'PlaybackStop' && yes(p.PlayedToCompletion)) || (p.NotificationType === 'UserDataSaved' && yes(p.Played) && p.SaveReason === 'TogglePlayed');
    if (!finished) return null;
    if (p.ItemType === 'Movie') return { kind: 'movie', title: p.Name, year: num(p.Year), ref: p.ItemId };
    if (p.ItemType === 'Episode') return { kind: 'episode', show: p.SeriesName, season: num(p.SeasonNumber), number: num(p.EpisodeNumber), title: p.Name, ref: p.ItemId };
    return null;
  },
  emby(p) {
    const i = p.Item ?? {};
    const finished = (p.Event === 'playback.stop' && yes(p.PlaybackInfo?.PlayedToCompletion)) || p.Event === 'item.markplayed';
    if (!finished) return null;
    if (i.Type === 'Movie') return { kind: 'movie', title: i.Name, year: num(i.ProductionYear), ref: i.Id };
    if (i.Type === 'Episode') return { kind: 'episode', show: i.SeriesName, season: num(i.ParentIndexNumber), number: num(i.IndexNumber), title: i.Name, ref: i.Id };
    return null;
  },
  generic(p) {
    if (p.type === 'movie' && p.title) return { kind: 'movie', title: String(p.title), year: num(p.year) };
    if (p.type === 'episode' && p.show) {
      return { kind: 'episode', show: String(p.show), season: num(p.season), number: num(p.episode ?? p.number), title: p.title ?? null, anime: yes(p.anime) };
    }
    throw new HttpError(400, 'send { type: "movie", title } or { type: "episode", show, season, episode }');
  },
};
