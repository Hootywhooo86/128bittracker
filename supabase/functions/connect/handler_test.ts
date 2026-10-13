// deno test supabase/functions/connect/
import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1';
import { createHandler } from './handler.ts';

const SB = 'https://proj.supabase.co';
const ENV: Record<string, string> = {
  SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: 'SERVICE',
  ANILIST_CLIENT_ID: 'al-id', ANILIST_CLIENT_SECRET: 'al-secret',
  TRAKT_CLIENT_ID: 'tr-id', TRAKT_CLIENT_SECRET: 'tr-secret',
  MAL_CLIENT_ID: 'mal-id', MAL_CLIENT_SECRET: 'mal-secret',
  TMDB_TOKEN: 'x'.repeat(60), STEAM_API_KEY: 'STEAMKEY',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

function world() {
  const db = { states: [] as Record<string, unknown>[], conns: [] as Record<string, unknown>[], usage: 0 };
  const calls: { url: string; init?: RequestInit }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    const h = new Headers(init?.headers);
    if (url === `${SB}/auth/v1/user`) {
      const tok = h.get('Authorization');
      return tok === 'Bearer user-a' ? json({ id: 'A' }) : tok === 'Bearer user-b' ? json({ id: 'B' }) : json({}, 401);
    }
    if (url.startsWith(`${SB}/rest/v1/`)) {
      assertEquals(h.get('apikey'), 'SERVICE');
      const u = new URL(url);
      const table = u.pathname.split('/').pop();
      const eq = (k: string) => u.searchParams.get(k)?.replace(/^eq\./, '');
      if (table === 'tracker_oauth_states') {
        if (init?.method === 'POST') { db.states.push({ ...JSON.parse(String(init.body)), created_at: new Date().toISOString() }); return json(null, 201); }
        if (init?.method === 'DELETE') { db.states = db.states.filter((s) => s.state !== eq('state')); return new Response(null, { status: 204 }); }
        return json(db.states.filter((s) => s.state === eq('state')));
      }
      if (table === 'tracker_connections') {
        const mine = (c: Record<string, unknown>) => c.user_id === eq('user_id') && c.service === eq('service');
        if (init?.method === 'POST') { const row = JSON.parse(String(init.body)); db.conns = db.conns.filter((c) => !(c.user_id === row.user_id && c.service === row.service)); db.conns.push(row); return json(null, 201); }
        if (init?.method === 'PATCH') { db.conns = db.conns.map((c) => (mine(c) ? { ...c, ...JSON.parse(String(init.body)) } : c)); return new Response(null, { status: 204 }); }
        if (init?.method === 'DELETE') { db.conns = db.conns.filter((c) => !mine(c)); return new Response(null, { status: 204 }); }
        return json(db.conns.filter(mine));
      }
      if (table === 'tracker_bump_usage') return json(++db.usage);
    }
    if (url === 'https://anilist.co/api/v2/oauth/token') {
      const b = JSON.parse(String(init?.body));
      assertEquals([b.client_secret, b.code, b.grant_type], ['al-secret', 'CODE', 'authorization_code']);
      return json({ access_token: 'AL-TOKEN', expires_in: 31536000 });
    }
    if (url === 'https://myanimelist.net/v1/oauth2/token') {
      const b = new URLSearchParams(String(init?.body));
      if (b.get('grant_type') === 'refresh_token') return json({ access_token: 'MAL-2', refresh_token: 'MAL-R2', expires_in: 2592000 });
      assert(b.get('code_verifier'), 'MAL sends the PKCE verifier');
      return json({ access_token: 'MAL-1', refresh_token: 'MAL-R1', expires_in: 60 });
    }
    if (url === 'https://graphql.anilist.co') {
      assertEquals(h.get('Authorization'), 'Bearer AL-TOKEN');
      return json({ data: { Viewer: { id: 7, name: 'pixelfan' } } });
    }
    if (url === 'https://api.myanimelist.net/v2/users/@me') return json({ id: 9, name: 'malfan' });
    if (url.startsWith('https://api.myanimelist.net/v2/anime/1/my_list_status')) {
      assertEquals(h.get('Authorization'), 'Bearer MAL-2', 'refreshed before use');
      assertEquals(String(init?.body), 'status=completed&num_watched_episodes=26');
      return json({ status: 'completed' });
    }
    if (url.startsWith('https://api.themoviedb.org/')) {
      assertEquals(h.get('Authorization'), `Bearer ${'x'.repeat(60)}`);
      return json({ results: [] });
    }
    if (url.startsWith('https://api.steampowered.com/')) {
      assertEquals(new URL(url).searchParams.get('key'), 'STEAMKEY');
      return json({ response: {} });
    }
    return json({ error: 'unexpected ' + url }, 599);
  }) as typeof fetch;
  const handle = createHandler({ env: (k) => ENV[k], fetch: fakeFetch });
  const post = (path: string, body: unknown, who = 'user-a') =>
    handle(new Request(`${SB}/functions/v1/connect${path}`, { method: 'POST', headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return { db, calls, handle, post };
}

Deno.test('connect AniList: sign-in page, callback saves the token, back to the app', async () => {
  const w = world();
  assertEquals((await w.post('/start', { service: 'anilist' }, 'nobody')).status, 401);
  const r = await w.post('/start', { service: 'anilist', return_to: 'app.bit128.tracker://connect' });
  const { url } = await r.json();
  const q = new URL(url).searchParams;
  assertMatch(url, /^https:\/\/anilist\.co\/api\/v2\/oauth\/authorize\?/);
  assertEquals(q.get('client_id'), 'al-id');
  assertEquals(q.get('redirect_uri'), `${SB}/functions/v1/connect/callback`);
  assert(!url.includes('al-secret'), 'the secret never goes to the browser');

  const back = await w.handle(new Request(`${SB}/functions/v1/connect/callback?code=CODE&state=${q.get('state')}`));
  assertEquals(back.status, 302);
  assertMatch(back.headers.get('Location')!, /^app\.bit128\.tracker:\/\/connect\?service=anilist&ok=1&account=pixelfan$/);
  assertEquals(w.db.conns[0].user_id, 'A');
  assertEquals(w.db.conns[0].access_token, 'AL-TOKEN');
  // A state works once.
  assertEquals((await w.handle(new Request(`${SB}/functions/v1/connect/callback?code=CODE&state=${q.get('state')}`))).status, 400);
});

Deno.test('MAL: PKCE, refresh before it runs out, calls as the person; B can\'t use A\'s connection', async () => {
  const w = world();
  const { url } = await (await w.post('/start', { service: 'mal' })).json();
  const q = new URL(url).searchParams;
  assertEquals(q.get('code_challenge_method'), 'plain');
  await w.handle(new Request(`${SB}/functions/v1/connect/callback?code=C&state=${q.get('state')}`));
  const r = await w.post('/api', { service: 'mal', method: 'PATCH', path: '/v2/anime/1/my_list_status', body: { status: 'completed', num_watched_episodes: 26 } });
  assertEquals(r.status, 200);
  assertEquals(w.db.conns[0].access_token, 'MAL-2');
  assertEquals((await w.post('/api', { service: 'mal', path: '/v2/users/@me' }, 'user-b')).status, 404, 'B has no MAL connection');
  assertEquals((await w.post('/api', { service: 'mal', path: '/../evil' })).status, 400);
});

Deno.test('lookups with 128bit keys: right host only, keys added, counted per person', async () => {
  const w = world();
  assertEquals((await w.post('/key', { service: 'tmdb', url: 'https://api.themoviedb.org/3/search/movie?query=alien' })).status, 200);
  assertEquals((await w.post('/key', { service: 'steam', url: 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?steamid=1&key=' })).status, 200);
  assertEquals((await w.post('/key', { service: 'tmdb', url: 'https://evil.example/steal' })).status, 400);
  assertEquals((await w.post('/key', { service: 'tmdb', url: 'https://api.themoviedb.org/3/x', method: 'DELETE' })).status, 400);
  assertEquals((await w.post('/key', { service: 'lastfm', url: 'https://ws.audioscrobbler.com/2.0/' })).status, 503, 'not set up yet');
  assertEquals(w.db.usage, 4);
});
