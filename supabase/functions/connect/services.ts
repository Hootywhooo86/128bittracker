// What 128bit Connect knows about each outside service. Pure data + small
// helpers, so it can be tested without Supabase.

export type Env = (name: string) => string | undefined;

/** Services you sign in to with the Connect button (each person's own token). */
export const OAUTH = {
  anilist: {
    label: 'AniList',
    authorize: 'https://anilist.co/api/v2/oauth/authorize',
    token: 'https://anilist.co/api/v2/oauth/token',
    api: 'https://graphql.anilist.co',
    id: 'ANILIST_CLIENT_ID',
    secret: 'ANILIST_CLIENT_SECRET',
    pkce: false,
    form: false,
  },
  trakt: {
    label: 'Trakt',
    authorize: 'https://trakt.tv/oauth/authorize',
    token: 'https://api.trakt.tv/oauth/token',
    api: 'https://api.trakt.tv',
    id: 'TRAKT_CLIENT_ID',
    secret: 'TRAKT_CLIENT_SECRET',
    pkce: false,
    form: false,
  },
  mal: {
    label: 'MyAnimeList',
    authorize: 'https://myanimelist.net/v1/oauth2/authorize',
    token: 'https://myanimelist.net/v1/oauth2/token',
    api: 'https://api.myanimelist.net',
    id: 'MAL_CLIENT_ID',
    secret: 'MAL_CLIENT_SECRET',
    pkce: true, // MAL only does PKCE "plain"
    form: true,
  },
} as const;
export type OAuthService = keyof typeof OAUTH;

/**
 * 128bit's own API keys, lent to signed-in people for read-only lookups so
 * nobody has to make their own. host: the only host each one may reach.
 */
export const KEYED = {
  tmdb: { host: 'api.themoviedb.org', env: ['TMDB_TOKEN'] },
  steam: { host: 'api.steampowered.com', env: ['STEAM_API_KEY'] },
  lastfm: { host: 'ws.audioscrobbler.com', env: ['LASTFM_API_KEY'] },
  igdb: { host: 'api.igdb.com', env: ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'] },
  trakt: { host: 'api.trakt.tv', env: ['TRAKT_CLIENT_ID'] },
  mal: { host: 'api.myanimelist.net', env: ['MAL_CLIENT_ID'] },
  retroachievements: { host: 'retroachievements.org', env: ['RA_API_KEY'] },
  // Books: Google Books (volumes search, release dates) and Hardcover (series, upcoming; GraphQL).
  gbooks: { host: 'www.googleapis.com', env: ['GOOGLE_BOOKS_KEY'] },
  hardcover: { host: 'api.hardcover.app', env: ['HARDCOVER_TOKEN'] },
} as const;
export type KeyedService = keyof typeof KEYED;

export const DAILY_LIMIT = 3000; // per person, per service

export const isOAuth = (s: unknown): s is OAuthService => typeof s === 'string' && s in OAUTH;
export const isKeyed = (s: unknown): s is KeyedService => typeof s === 'string' && s in KEYED;

/** Where the person goes back to after signing in: the app's deep link, or an https page. */
export function safeReturn(url: unknown): string | null {
  const u = String(url ?? '');
  return /^app\.bit128\.tracker:\/\/[\w/?=&.-]*$/.test(u) || /^https:\/\/[^\s]+$/.test(u) ? u : null;
}

export function withQuery(url: string, params: Record<string, string>) {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + new URLSearchParams(params).toString();
}

export function authorizeUrl(service: OAuthService, env: Env, { state, redirectUri, verifier }: { state: string; redirectUri: string; verifier?: string }) {
  const s = OAUTH[service];
  const params: Record<string, string> = { response_type: 'code', client_id: env(s.id) ?? '', redirect_uri: redirectUri, state };
  if (s.pkce && verifier) Object.assign(params, { code_challenge: verifier, code_challenge_method: 'plain' });
  return `${s.authorize}?${new URLSearchParams(params)}`;
}

/** Request to swap a sign-in code (or a refresh token) for tokens. */
export function tokenRequest(service: OAuthService, env: Env, grant: { code?: string; refresh_token?: string; verifier?: string | null; redirectUri: string }) {
  const s = OAUTH[service];
  const body: Record<string, string> = {
    client_id: env(s.id) ?? '',
    client_secret: env(s.secret) ?? '',
    redirect_uri: grant.redirectUri,
    grant_type: grant.code ? 'authorization_code' : 'refresh_token',
  };
  if (grant.code) body.code = grant.code;
  if (grant.refresh_token) body.refresh_token = grant.refresh_token;
  if (s.pkce && grant.verifier) body.code_verifier = grant.verifier;
  return {
    url: s.token,
    init: {
      method: 'POST',
      headers: s.form ? { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: s.form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    },
  };
}

/** Headers that call a service's API as the person who connected it. */
export function userHeaders(service: OAuthService, env: Env, accessToken: string): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  if (service === 'trakt') Object.assign(h, { 'trakt-api-version': '2', 'trakt-api-key': env('TRAKT_CLIENT_ID') ?? '' });
  return h;
}

/**
 * A lookup URL for a keyed service, with 128bit's key put in. Only the
 * service's own host is allowed; any key the caller sent is replaced.
 */
export function keyedRequest(service: KeyedService, env: Env, rawUrl: string, igdbToken?: string) {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('bad url'); }
  if (url.protocol !== 'https:' || url.hostname !== KEYED[service].host) throw new Error(`${service} lookups only go to ${KEYED[service].host}`);
  const headers: Record<string, string> = { Accept: 'application/json' };
  switch (service) {
    case 'tmdb': {
      url.searchParams.delete('api_key');
      const t = env('TMDB_TOKEN') ?? '';
      if (t.length > 40) headers.Authorization = `Bearer ${t}`;
      else url.searchParams.set('api_key', t);
      break;
    }
    case 'steam': url.searchParams.set('key', env('STEAM_API_KEY') ?? ''); break;
    case 'lastfm': url.searchParams.set('api_key', env('LASTFM_API_KEY') ?? ''); break;
    case 'retroachievements': url.searchParams.set('y', env('RA_API_KEY') ?? ''); break;
    case 'gbooks':
      if (!url.pathname.startsWith('/books/')) throw new Error('gbooks lookups only go to /books/');
      url.searchParams.set('key', env('GOOGLE_BOOKS_KEY') ?? '');
      break;
    case 'hardcover':
      if (url.pathname !== '/v1/graphql') throw new Error('hardcover lookups only go to /v1/graphql');
      Object.assign(headers, { Authorization: `Bearer ${(env('HARDCOVER_TOKEN') ?? '').replace(/^Bearer\s+/i, '')}`, 'Content-Type': 'application/json' });
      break;
    case 'trakt': Object.assign(headers, { 'trakt-api-version': '2', 'trakt-api-key': env('TRAKT_CLIENT_ID') ?? '', 'Content-Type': 'application/json' }); break;
    case 'mal': headers['X-MAL-CLIENT-ID'] = env('MAL_CLIENT_ID') ?? ''; break;
    case 'igdb': Object.assign(headers, { 'Client-ID': env('TWITCH_CLIENT_ID') ?? '', Authorization: `Bearer ${igdbToken ?? ''}`, 'Content-Type': 'text/plain' }); break;
  }
  return { url: url.toString(), headers };
}

/** Normalise a token answer: when it runs out, as an ISO time. */
export function expiry(j: { expires_in?: number; created_at?: number }) {
  if (!j.expires_in) return null;
  const from = j.created_at ? j.created_at * 1000 : Date.now();
  return new Date(from + j.expires_in * 1000).toISOString();
}
