// Connectors: pull play time + completion from game platforms into the
// Library. Shared by the server and the phone (they only differ in which
// `fetch` they use). Config lives in the kv table as `conn.<name>`.
import { HttpError } from '../../api/errors.js';
import { createItem, findByExternal, updateItem, addSession, getItem } from '../../domain/library.js';
import { steam } from './steam.js';
import { xbox } from './xbox.js';
import { psn } from './psn.js';

export const CONNECTORS = { steam, xbox, psn };

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

/** Public view: never returns secret values, only whether they're set. */
function present(name, c, state) {
  const config = state?.config ?? {};
  return {
    name,
    label: c.label,
    official: c.official,
    warning: c.warning ?? null,
    help: c.help,
    fields: c.fields.map((f) => ({ ...f, value: f.secret ? undefined : config[f.key] ?? '', set: config[f.key] != null && config[f.key] !== '' })),
    configured: c.fields.filter((f) => f.required).every((f) => config[f.key]),
    last_sync_at: state?.last_sync_at ?? null,
    last_result: state?.last_result ?? null,
    last_error: state?.last_error ?? null,
  };
}

export function listConnectors(ctx) {
  return Object.entries(CONNECTORS).map(([name, c]) => present(name, c, load(ctx, name)));
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
  return present(name, c, load(ctx, name));
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
  const missing = c.fields.filter((f) => f.required && !config[f.key]);
  if (missing.length) throw new HttpError(400, `${c.label}: set ${missing.map((f) => f.label).join(', ')} first`);
  if (c.warning && !config.accept_risk) throw new HttpError(400, `${c.label}: accept the risk notice first`);

  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  const summary = { games: 0, added: 0, updated: 0, minutes: 0, perfect: 0, new_trophies: [] };
  const helpers = {
    fetch: fetchImpl,
    /** Persist tokens/derived ids between runs (e.g. a refreshed access token). */
    remember: (patch) => save(ctx, name, { ...(load(ctx, name) ?? {}), ...patch }),
    state,
    upsert: (game) => upsertGame(ctx, name, game, summary),
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
        status: minutes ? 'active' : 'planned',
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
    item = updateItem(ctx, existing.id, patch);
    summary.updated++;
  }
  if (item.new_trophy) summary.new_trophies.push(item.new_trophy);
  if (meta.perfect || (meta.achievements && meta.achievements.total > 0 && meta.achievements.unlocked >= meta.achievements.total)) summary.perfect++;
  return getItem(ctx, item.id);
}
