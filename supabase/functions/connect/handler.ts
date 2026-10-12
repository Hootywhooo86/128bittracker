// 128bit Connect: the Supabase Edge Function behind Tracker's Connect buttons.
//
//   POST /connect/start     {service, return_to}  → {url}: AniList / Trakt / MyAnimeList sign-in page
//   GET  /connect/callback  ?code&state           ← the service sends the person back here;
//                                                  tokens are saved, then back to the app
//   POST /connect/api       {service, method, path, body}  → that service's API, as the person
//   POST /connect/key       {service, url, method, body}   → a lookup with 128bit's own key
//                                                  (TMDB, Steam, Last.fm, IGDB, Trakt, MAL, RA)
//
// Everything except /callback needs the person's 128bit sign-in. Tokens never
// leave the server. Keys come from Edge Function secrets (docs/SUPABASE-SETUP.md).
import {
  DAILY_LIMIT, KEYED, OAUTH, authorizeUrl, expiry, isKeyed, isOAuth, keyedRequest, safeReturn, tokenRequest, userHeaders, withQuery,
  type Env, type KeyedService, type OAuthService,
} from './services.ts';

export type Deps = { env: Env; fetch: typeof fetch };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (status: number, error: string) => json({ error }, status);

export function createHandler({ env, fetch }: Deps) {
  const SB = (env('SUPABASE_URL') ?? '').replace(/\/+$/, '');
  const SERVICE = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const callbackUrl = `${SB}/functions/v1/connect/callback`;
  const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

  const rest = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...admin, ...(init.headers ?? {}) } });
    const text = await res.text();
    if (!res.ok) throw new Error(`database: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };

  /** The signed-in 128bit account calling us, from its access token. */
  async function caller(req: Request): Promise<string | null> {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return null;
    const res = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SERVICE, Authorization: auth } });
    if (!res.ok) return null;
    const u = await res.json();
    return u?.id && !u.is_anonymous ? u.id : null;
  }

  // ---------- sign in to a service ----------

  async function start(userId: string, body: Record<string, unknown>) {
    const service = body.service;
    if (!isOAuth(service)) return fail(400, 'service is anilist, trakt or mal');
    if (!env(OAUTH[service].id) || !env(OAUTH[service].secret)) return fail(503, `${OAUTH[service].label} isn't set up on this 128bit account server yet`);
    const returnTo = safeReturn(body.return_to) ?? 'app.bit128.tracker://connect';
    const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    // MAL's PKCE is "plain": the verifier is the challenge. 43–128 characters.
    const verifier = OAUTH[service].pkce ? (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '') : null;
    await rest('tracker_oauth_states', {
      method: 'POST',
      body: JSON.stringify({ state, user_id: userId, service, verifier, redirect: returnTo }),
    });
    return json({ url: authorizeUrl(service, env, { state, redirectUri: callbackUrl, verifier: verifier ?? undefined }) });
  }

  async function account(service: OAuthService, token: string) {
    const h = userHeaders(service, env, token);
    try {
      if (service === 'anilist') {
        const r = await fetch(OAUTH.anilist.api, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ Viewer { id name } }' }) });
        const v = (await r.json())?.data?.Viewer;
        return v ? { id: v.id, name: v.name } : {};
      }
      if (service === 'trakt') {
        const r = await fetch(`${OAUTH.trakt.api}/users/settings`, { headers: h });
        const u = (await r.json())?.user;
        return u ? { id: u.ids?.slug, name: u.username } : {};
      }
      const r = await fetch(`${OAUTH.mal.api}/v2/users/@me`, { headers: h });
      const u = await r.json();
      return u?.name ? { id: u.id, name: u.name } : {};
    } catch {
      return {};
    }
  }

  async function callback(url: URL) {
    const state = url.searchParams.get('state') ?? '';
    const rows = state ? await rest(`tracker_oauth_states?state=eq.${encodeURIComponent(state)}&select=*`) : [];
    const pending = rows?.[0];
    if (!pending) return new Response('This sign-in link is old or was already used. Go back to 128bit Tracker and tap Connect again.', { status: 400 });
    await rest(`tracker_oauth_states?state=eq.${encodeURIComponent(state)}`, { method: 'DELETE' });
    const back = (params: Record<string, string>) => new Response(null, { status: 302, headers: { Location: withQuery(pending.redirect, { service: pending.service, ...params }) } });
    if (Date.now() - Date.parse(pending.created_at) > 15 * 60_000) return back({ error: 'took too long, try again' });
    const service = pending.service as OAuthService;
    const code = url.searchParams.get('code');
    if (!code) return back({ error: url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'cancelled' });

    const t = tokenRequest(service, env, { code, verifier: pending.verifier, redirectUri: callbackUrl });
    const res = await fetch(t.url, t.init);
    const tok = await res.json().catch(() => ({}));
    if (!res.ok || !tok.access_token) return back({ error: `${OAUTH[service].label} said no (${res.status})` });
    const who = await account(service, tok.access_token);
    await rest('tracker_connections', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        user_id: pending.user_id, service, access_token: tok.access_token, refresh_token: tok.refresh_token ?? null,
        expires_at: expiry(tok), account: who, updated_at: new Date().toISOString(),
      }),
    });
    return back({ ok: '1', account: String((who as { name?: string }).name ?? '') });
  }

  // ---------- call a service as the person ----------

  async function connection(userId: string, service: OAuthService) {
    const rows = await rest(`tracker_connections?user_id=eq.${userId}&service=eq.${service}&select=*`);
    let c = rows?.[0];
    if (!c) return null;
    // Refresh a day before it runs out (Trakt: 3 months, MAL: 1 month; AniList lasts a year, no refresh).
    if (c.refresh_token && c.expires_at && Date.parse(c.expires_at) - Date.now() < 86400_000) {
      const t = tokenRequest(service, env, { refresh_token: c.refresh_token, redirectUri: callbackUrl });
      const res = await fetch(t.url, t.init);
      const tok = await res.json().catch(() => ({}));
      if (res.ok && tok.access_token) {
        c = { ...c, access_token: tok.access_token, refresh_token: tok.refresh_token ?? c.refresh_token, expires_at: expiry(tok) };
        await rest(`tracker_connections?user_id=eq.${userId}&service=eq.${service}`, {
          method: 'PATCH',
          body: JSON.stringify({ access_token: c.access_token, refresh_token: c.refresh_token, expires_at: c.expires_at, updated_at: new Date().toISOString() }),
        });
      }
    }
    return c;
  }

  async function api(userId: string, body: Record<string, unknown>) {
    const service = body.service;
    if (!isOAuth(service)) return fail(400, 'service is anilist, trakt or mal');
    const path = String(body.path ?? '/');
    if (!path.startsWith('/') || path.includes('..') || path.includes('//')) return fail(400, 'bad path');
    const method = String(body.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return fail(400, 'bad method');
    const c = await connection(userId, service);
    if (!c) return fail(404, `connect ${OAUTH[service].label} first`);
    const headers = userHeaders(service, env, c.access_token);
    let payload: string | undefined;
    if (body.body != null && method !== 'GET') {
      if (service === 'mal' && method !== 'DELETE') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        payload = new URLSearchParams(body.body as Record<string, string>).toString();
      } else {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body.body);
      }
    }
    const res = await fetch(OAUTH[service].api + (service === 'anilist' ? '' : path), { method, headers, body: payload });
    if (res.status === 401) {
      await rest(`tracker_connections?user_id=eq.${userId}&service=eq.${service}`, { method: 'DELETE' });
      return fail(401, `${OAUTH[service].label} signed you out: tap Connect again`);
    }
    return new Response(res.body, { status: res.status, headers: { ...CORS, 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' } });
  }

  // ---------- lookups with 128bit's keys ----------

  let igdb: { token: string; until: number } | null = null;
  async function igdbToken() {
    if (igdb && igdb.until > Date.now() + 60_000) return igdb.token;
    const res = await fetch(`https://id.twitch.tv/oauth2/token?${new URLSearchParams({ client_id: env('TWITCH_CLIENT_ID') ?? '', client_secret: env('TWITCH_CLIENT_SECRET') ?? '', grant_type: 'client_credentials' })}`, { method: 'POST' });
    const j = await res.json();
    if (!res.ok) throw new Error('Twitch refused 128bit\'s IGDB keys');
    igdb = { token: j.access_token, until: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return igdb.token;
  }

  async function keyed(userId: string, body: Record<string, unknown>) {
    const service = body.service;
    if (!isKeyed(service)) return fail(400, 'unknown service');
    const missing = KEYED[service as KeyedService].env.filter((k) => !env(k));
    if (missing.length) return fail(503, `${service} isn't set up on this 128bit account server yet`);
    const used = await rest('rpc/tracker_bump_usage', { method: 'POST', body: JSON.stringify({ who: userId, svc: service }) });
    if (Number(used) > DAILY_LIMIT) return fail(429, `daily ${service} limit reached, try again tomorrow`);
    const method = String(body.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && !(method === 'POST' && service === 'igdb')) return fail(400, 'lookups are read-only');
    let reqd;
    try {
      reqd = keyedRequest(service, env, String(body.url ?? ''), service === 'igdb' ? await igdbToken() : undefined);
    } catch (err) {
      return fail(400, (err as Error).message);
    }
    const res = await fetch(reqd.url, { method, headers: reqd.headers, body: method === 'POST' ? String(body.body ?? '') : undefined });
    return new Response(res.body, { status: res.status, headers: { ...CORS, 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' } });
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const route = url.pathname.replace(/^.*\/connect/, '') || '/';
    try {
      if (route === '/callback' && req.method === 'GET') return await callback(url);
      if (req.method !== 'POST') return fail(404, 'no such route');
      const userId = await caller(req);
      if (!userId) return fail(401, 'sign in to your 128bit account first');
      const body = await req.json().catch(() => ({}));
      if (route === '/start') return await start(userId, body);
      if (route === '/api') return await api(userId, body);
      if (route === '/key') return await keyed(userId, body);
      return fail(404, 'no such route');
    } catch (err) {
      console.error(err);
      return fail(500, 'something went wrong');
    }
  };
}
