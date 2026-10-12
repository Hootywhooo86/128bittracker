// Connectors: pull your history from other services into the Library.
//   group "games": play time + achievements (Steam, Xbox, PlayStation, RetroAchievements)
//   group "media": lists and watch/read history (AniList, MyAnimeList, Trakt,
//                  Hardcover, Letterboxd, Goodreads, Last.fm)
// Shared by the server and the phone (they only differ in which `fetch`
// they use). Config lives in the kv table as `conn.<name>`.
import { HttpError } from '../../api/errors.js';
import { createItem, findByExternal, updateItem, addSession, getItem } from '../../domain/library.js';
import { steam } from './steam.js';
import { xbox } from './xbox.js';
import { psn } from './psn.js';
import { retroachievements } from './retroachievements.js';
import { anilist } from './anilist.js';
import { mal } from './mal.js';
import { trakt } from './trakt.js';
import { hardcover } from './hardcover.js';
import { letterboxd } from './letterboxd.js';
import { goodreads } from './goodreads.js';
import { lastfm } from './lastfm.js';
import { hubOn, isConnected, routedFetch } from '../hub.js';
import { payloadFor, rememberSent } from '../writeback.js';

export const CONNECTORS = { steam, xbox, psn, retroachievements, anilist, mal, trakt, hardcover, letterboxd, goodreads, lastfm };

const key = (name) => `conn.${name}`;

function load(ctx, name) {
  const row = ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(key(name));
  return row?.value ? JSON.parse(row.value) : null;
}

function save(ctx, name, value) {
  ctx.db
    .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key(name), value == null ? null : JSON.stringify(value));
}

function connector(name) {
  const c = CONNECTORS[name];
  if (!c) throw new HttpError(404, `unknown connector "${name}"`);
  return c;
}

/**
 * Fields still needed. With the 128bit account signed in, keys marked `hub`
 * come from 128bit Connect; with the service connected (Connect button),
 * fields marked `oauth` (the username) aren't needed either.
 */
function missingFields(ctx, c, config) {
  const hub = hubOn(ctx);
  const connected = !!c.oauth && hub && isConnected(ctx, c.oauth);
  return c.fields.filter((f) => f.required && !config[f.key] && !(f.hub && hub) && !(f.oauth && connected));
}

/** Public view: never returns secret values, only whether they're set. */
function present(ctx, name, c, state) {
  const config = state?.config ?? {};
  const hub = hubOn(ctx);
  return {
    name,
    label: c.label,
    group: c.group ?? 'games',
    icon: c.icon ?? null,
    official: c.official,
    warning: c.warning ?? null,
    help: c.help,
    fields: c.fields.map((f) => ({
      ...f, value: f.secret ? undefined : config[f.key] ?? '', set: config[f.key] != null && config[f.key] !== '',
      optional: !!(f.hub && hub) || !!(f.oauth && c.oauth && hub && isConnected(ctx, c.oauth)),
    })),
    oauth: c.oauth ?? null,
    connected: !!c.oauth && hub && isConnected(ctx, c.oauth),
    hub,
    configured: missingFields(ctx, c, config).length === 0 && (c.fields.some((f) => config[f.key]) || (!!c.oauth && hub && isConnected(ctx, c.oauth))),
    last_sync_at: state?.last_sync_at ?? null,
    last_result: state?.last_result ?? null,
    last_error: state?.last_error ?? null,
  };
}

export function listConnectors(ctx) {
  return Object.entries(CONNECTORS).map(([name, c]) => present(ctx, name, c, load(ctx, name)));
}

export function configureConnector(ctx, name, input = {}) {
  const c = connector(name);
  const state = load(ctx, name) ?? {};
  const config = { ...state.config };
  for (const f of c.fields) {
    if (input[f.key] === undefined) continue;
    const v = String(input[f.key] ?? '').trim();
    if (f.secret && v === '' && input[f.key] !== null) continue; // blank secret = keep the saved one
    if (v.length > 4000) throw new HttpError(400, `${f.label} is too long`);
    config[f.key] = v || null;
  }
  if (c.accepted && input.accept_risk !== undefined) config.accept_risk = !!input.accept_risk;
  // New credentials invalidate cached tokens.
  save(ctx, name, { ...state, config, tokens: null, last_error: null });
  return present(ctx, name, c, load(ctx, name));
}

export function removeConnector(ctx, name) {
  connector(name);
  save(ctx, name, null);
}

/** Run one connector. Returns a summary; errors are stored and rethrown as 400/502. */
export async function syncConnector(ctx, name) {
  const c = connector(name);
  const state = load(ctx, name) ?? {};
  const config = state.config ?? {};
  const missing = missingFields(ctx, c, config);
  if (missing.length) throw new HttpError(400, `${c.label}: set ${missing.map((f) => f.label).join(', ')} first`);
  if (c.warning && !config.accept_risk) throw new HttpError(400, `${c.label}: accept the risk notice first`);

  const fetchImpl = routedFetch(ctx);
  const summary = { items: 0, games: 0, added: 0, updated: 0, minutes: 0, perfect: 0, new_trophies: [] };
  const helpers = {
    fetch: fetchImpl,
    /** Persist tokens/derived ids between runs (e.g. a refreshed access token). */
    remember: (patch) => save(ctx, name, { ...(load(ctx, name) ?? {}), ...patch }),
    state,
    upsert: (game) => upsertGame(ctx, name, game, summary),
    upsertMedia: (entry) => upsertMedia(ctx, name, entry, summary),
  };
  try {
    await c.sync(config, helpers);
    const result = { ...summary, new_trophies: summary.new_trophies.length };
    save(ctx, name, { ...(load(ctx, name) ?? {}), last_sync_at: new Date().toISOString(), last_result: result, last_error: null });
    return summary;
  } catch (err) {
    save(ctx, name, { ...(load(ctx, name) ?? {}), last_error: err.message });
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, `${c.label}: ${err.message}`);
  }
}

/**
 * Create or update one game from a platform.
 * game = { id, title, cover_url?, platform?, playtime_minutes?, achievements?: {unlocked,total}, perfect?, last_played? }
 * Play time is a running total from the platform; increases become sessions
 * (so they reach habits and the timeline), the total lives in meta.
 */
function upsertGame(ctx, source, game, summary) {
  summary.games++;
  summary.items++;
  const existing = findByExternal(ctx, source, game.id);
  const minutes = game.playtime_minutes == null ? null : Math.max(0, Math.round(game.playtime_minutes));
  const meta = { platform: game.platform ?? source };
  if (minutes != null) meta.playtime_minutes = minutes;
  if (game.achievements) meta.achievements = game.achievements;
  if (game.perfect) meta.perfect = true;
  if (game.last_played) meta.last_played = game.last_played;

  let item;
  if (!existing) {
    item = createItem(
      ctx,
      {
        type: 'game',
        title: game.title,
        cover_url: game.cover_url ?? null,
        status: game.status ?? (minutes ? 'active' : 'planned'),
        meta,
      },
      { source, externalId: String(game.id), quiet: true },
    );
    summary.added++;
  } else {
    const before = existing.meta?.playtime_minutes ?? null;
    const delta = minutes != null && before != null ? minutes - before : 0;
    if (delta > 0) {
      // A sync can cover several days of play; sessions are capped at a day.
      addSession(ctx, existing.id, { minutes: Math.min(delta, 1440), note: `${source} sync` }, { source });
      summary.minutes += delta;
    }
    const patch = { meta };
    if (!existing.cover_url && game.cover_url) patch.cover_url = game.cover_url;
    if (game.status && game.status !== existing.status) patch.status = game.status;
    item = updateItem(ctx, existing.id, patch);
    summary.updated++;
  }
  if (item.new_trophy) summary.new_trophies.push(item.new_trophy);
  if (meta.perfect || (meta.achievements && meta.achievements.total > 0 && meta.achievements.unlocked >= meta.achievements.total)) summary.perfect++;
  return getItem(ctx, item.id);
}

/**
 * Create or update one list entry from a media service. The service is the
 * source of truth for what it reports; fields it leaves out are untouched.
 * entry = { id, type, title, creator?, year?, cover_url?, status?, progress?,
 *           progress_total?, rating? (1–10), finished_at? (ISO), meta? }
 */
function upsertMedia(ctx, source, entry, summary) {
  if (!entry?.id || !entry.title || !entry.type) return null;
  summary.items++;
  const existing = findByExternal(ctx, source, String(entry.id));
  const fields = {};
  for (const k of ['creator', 'year', 'cover_url', 'status', 'progress', 'progress_total', 'rating']) {
    if (entry[k] != null && entry[k] !== '') fields[k] = entry[k];
  }
  if (fields.rating != null) fields.rating = Math.min(10, Math.max(1, Math.round(fields.rating)));
  if (fields.progress != null) fields.progress = Math.max(0, Math.round(fields.progress));
  if (fields.progress_total != null) fields.progress_total = Math.round(fields.progress_total) || null;
  if (fields.year != null) fields.year = Number(fields.year) > 0 ? Number(fields.year) : null;
  let item;
  if (!existing) {
    item = createItem(ctx, { type: entry.type, title: String(entry.title).slice(0, 200), status: 'planned', ...fields, meta: entry.meta ?? {} },
      { source, externalId: String(entry.id), quiet: true });
    summary.added++;
  } else {
    const patch = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'cover_url' && existing.cover_url) continue;
      if (existing[k] !== v) patch[k] = v;
    }
    if (entry.meta && Object.entries(entry.meta).some(([k, v]) => JSON.stringify(existing.meta?.[k] ?? null) !== JSON.stringify(v ?? null))) {
      patch.meta = entry.meta;
    }
    item = Object.keys(patch).length ? updateItem(ctx, existing.id, patch) : existing;
    summary.updated++;
  }
  if (entry.finished_at && item.status === 'done' && !existing?.finished_at) {
    ctx.db.prepare('UPDATE items SET finished_at = ? WHERE id = ?').run(entry.finished_at, item.id);
  }
  if (item.new_trophy) summary.new_trophies.push(item.new_trophy);
  // Came from this service: it already has it, so two-way sync won't send it back.
  const p = payloadFor(source, getItem(ctx, item.id));
  if (p) rememberSent(ctx, item.id, source, p);
  return item;
}
