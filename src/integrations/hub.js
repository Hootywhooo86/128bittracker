// 128bit Connect (supabase/functions/connect): one-tap sign-in to AniList,
// Trakt and MyAnimeList, and lookups with 128bit's own keys (TMDB, Steam,
// Last.fm, IGDB, RetroAchievements…) so nobody has to make their own.
//
// routedFetch(ctx) is a drop-in fetch for connectors and search: a request to
// one of those services that carries no key of its own goes through Connect
// (with the person's 128bit sign-in), and a request to a service they
// connected goes out as them. Everything else is a plain fetch.
import { HttpError } from '../api/errors.js';
import { familySession, familySignedIn, familyRpc } from './family-account.js';

const kvGet = (ctx, k) => {
  const v = ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value;
  return v ? JSON.parse(v) : null;
};
const kvPut = (ctx, k, v) =>
  ctx.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));

export const OAUTH_SERVICES = { anilist: 'AniList', trakt: 'Trakt', mal: 'MyAnimeList' };
const OAUTH_HOSTS = { 'graphql.anilist.co': 'anilist', 'api.trakt.tv': 'trakt', 'api.myanimelist.net': 'mal' };

/** Which keyed service a request is for, if it carries no key of its own. */
function keylessService(url, headers) {
  const q = url.searchParams;
  switch (url.hostname) {
    case 'api.themoviedb.org': return !q.get('api_key') && !headers.get('authorization') ? 'tmdb' : null;
    case 'api.steampowered.com': return !q.get('key') ? 'steam' : null;
    case 'ws.audioscrobbler.com': return !q.get('api_key') ? 'lastfm' : null;
    case 'retroachievements.org': return !q.get('y') ? 'retroachievements' : null;
    case 'api.igdb.com': return !headers.get('client-id') ? 'igdb' : null;
    case 'api.trakt.tv': return !headers.get('trakt-api-key') ? 'trakt' : null;
    case 'api.myanimelist.net': return !headers.get('x-mal-client-id') ? 'mal' : null;
    case 'www.googleapis.com': return url.pathname.startsWith('/books/') && !q.get('key') ? 'gbooks' : null;
    case 'api.hardcover.app': return !headers.get('authorization') ? 'hardcover' : null;
    default: return null;
  }
}

export const hubOn = (ctx) => familySignedIn(ctx);
export const connections = (ctx) => kvGet(ctx, 'hub.connections') ?? [];
export const isConnected = (ctx, service) => connections(ctx).some((c) => c.service === service);

async function call(ctx, route, body) {
  const a = await familySession(ctx);
  const fetch = ctx.fetch ?? globalThis.fetch;
  const res = await fetch(`${a.url}/functions/v1/connect${route}`, {
    method: 'POST',
    headers: { apikey: a.key, Authorization: `Bearer ${a.access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 404 && !(await res.clone().text()).includes('"error"')) {
    throw new HttpError(503, '128bit Connect isn\'t set up on the account server yet (docs/SUPABASE-SETUP.md)');
  }
  return res;
}

async function errorOf(res) {
  const j = await res.json().catch(() => ({}));
  return j.error ?? `128bit Connect answered ${res.status}`;
}

export function routedFetch(ctx) {
  const plain = ctx.fetch ?? globalThis.fetch;
  return async (input, init = {}) => {
    if (!hubOn(ctx)) return plain(input, init);
    let url;
    try { url = new URL(String(input)); } catch { return plain(input, init); }
    const headers = new Headers(init.headers);
    const oauth = OAUTH_HOSTS[url.hostname];
    if (oauth && isConnected(ctx, oauth)) {
      let body = init.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = Object.fromEntries(new URLSearchParams(body)); }
      }
      return call(ctx, '/api', { service: oauth, method: init.method ?? 'GET', path: url.pathname + url.search, body: body ?? null });
    }
    const keyed = keylessService(url, headers);
    if (keyed) return call(ctx, '/key', { service: keyed, url: url.toString(), method: init.method ?? 'GET', body: init.body ?? null });
    return plain(input, init);
  };
}

/** The same context, with fetch going through Connect where that helps. */
export const withHub = (ctx) => ({ ...ctx, fetch: routedFetch(ctx) });

// ---------- Connect buttons ----------

export async function refreshConnections(ctx) {
  if (!hubOn(ctx)) return [];
  try {
    const list = await familyRpc(ctx, 'tracker_connections_status', {});
    kvPut(ctx, 'hub.connections', Array.isArray(list) ? list : []);
  } catch { /* cloud library not installed yet */ }
  return connections(ctx);
}

export async function hubStatus(ctx) {
  return { available: hubOn(ctx), connections: hubOn(ctx) ? await refreshConnections(ctx) : [] };
}

export async function connectStart(ctx, { service, return_to } = {}) {
  if (!OAUTH_SERVICES[service]) throw new HttpError(400, 'service is anilist, trakt or mal');
  if (!hubOn(ctx)) throw new HttpError(400, 'sign in to your 128bit account first (Sync → 128bit family account)');
  const res = await call(ctx, '/start', { service, return_to });
  if (!res.ok) throw new HttpError(res.status === 503 ? 503 : 502, await errorOf(res));
  return res.json();
}

export async function connectRemove(ctx, { service } = {}) {
  if (!OAUTH_SERVICES[service]) throw new HttpError(400, 'service is anilist, trakt or mal');
  await familyRpc(ctx, 'tracker_disconnect', { service });
  return refreshConnections(ctx);
}
