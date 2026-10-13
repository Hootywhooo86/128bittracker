import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { createEventBus } from '../src/domain/events.js';
import { createItem, updateItem, findByExternal } from '../src/domain/library.js';
import { FAMILY } from '../src/integrations/family-account.js';
import { routedFetch } from '../src/integrations/hub.js';
import { searchTitles } from '../src/integrations/metadata.js';
import { writeBack } from '../src/integrations/writeback.js';
import { configureConnector, syncConnector, listConnectors } from '../src/integrations/connectors/index.js';

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

/** A Tracker signed in to a 128bit account, with fake Connect behind it. */
function signedIn({ connected = [], onApi = () => json({}), onKey = () => json({}) } = {}) {
  const db = openDb(':memory:');
  const calls = [];
  const put = (k, v) => db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
  put('family.account', { url: FAMILY.url, key: FAMILY.key, access: 'AT', refresh: 'RT', expires: Date.now() / 1000 + 3600, user_id: 'u1' });
  put('hub.connections', connected.map((service) => ({ service })));
  const fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    if (u === `${FAMILY.url}/functions/v1/connect/api`) return onApi(JSON.parse(init.body));
    if (u === `${FAMILY.url}/functions/v1/connect/key`) return onKey(JSON.parse(init.body));
    if (u.includes('/rest/v1/rpc/tracker_connections_status')) return json(connected.map((service) => ({ service })));
    return json({ error: 'direct ' + u }, 599);
  };
  return { db, events: createEventBus(db), fetch, calls };
}

test('no keys needed when signed in: keyless lookups go through 128bit Connect', async () => {
  const ctx = signedIn({ onKey: (b) => {
    assert.equal(b.service, 'tmdb');
    assert.match(b.url, /^https:\/\/api\.themoviedb\.org\/3\/search\/movie\?/);
    return json({ results: [{ id: 348, title: 'Alien', release_date: '1979-05-25', poster_path: '/a.jpg' }] });
  } });
  const r = await searchTitles(ctx, { type: 'movie', q: 'alien' });
  assert.equal(r[0].provider, 'tmdb');
  assert.equal(r[0].meta.tmdb_id, 348);
  assert.equal(ctx.calls[0].body.url.includes('api_key=&') || ctx.calls[0].body.url.endsWith('api_key='), true, 'no key of our own sent');
  // Own key set: straight to TMDB, not through Connect.
  const direct = await routedFetch(ctx)('https://api.themoviedb.org/3/search/movie?api_key=MINE');
  assert.equal(direct.status, 599);
});

test('Steam with only a profile: the key comes from Connect', async () => {
  const ctx = signedIn({ onKey: (b) => {
    assert.equal(b.service, 'steam');
    if (b.url.includes('GetOwnedGames')) return json({ response: { games: [{ appid: 620, name: 'Portal 2', playtime_forever: 60 }] } });
    return json({}, 400);
  } });
  const view = listConnectors(ctx).find((c) => c.name === 'steam');
  assert.equal(view.fields.find((f) => f.key === 'api_key').optional, true);
  configureConnector(ctx, 'steam', { profile: '76561197960287930' });
  const r = await syncConnector(ctx, 'steam');
  assert.equal(r.games, 1);
});

test('connected AniList: no username needed, reads as you, and two-way sync sends only real changes', async () => {
  const sent = [];
  const ctx = signedIn({ connected: ['anilist'], onApi: (b) => {
    assert.equal(b.service, 'anilist');
    const q = b.body.query;
    if (q.includes('Viewer')) return json({ data: { Viewer: { name: 'pixelfan' } } });
    if (q.includes('SaveMediaListEntry')) { sent.push(b.body.variables); return json({ data: { SaveMediaListEntry: { id: 1 } } }); }
    if (b.body.variables.type === 'ANIME') {
      return json({ data: { MediaListCollection: { lists: [{ entries: [{ status: 'CURRENT', progress: 3, score: 0, completedAt: {},
        media: { id: 154587, format: 'TV', episodes: 28, title: { english: 'Frieren' }, coverImage: {}, studios: { nodes: [] } } }] }] } } });
    }
    return json({ data: { MediaListCollection: { lists: [] } } });
  } });
  const view = listConnectors(ctx).find((c) => c.name === 'anilist');
  assert.deepEqual([view.connected, view.configured], [true, true]);
  await syncConnector(ctx, 'anilist');
  const frieren = findByExternal(ctx, 'anilist', 'anime:154587');
  assert.equal(frieren.progress, 3);

  await writeBack(ctx);
  assert.equal(sent.length, 0, 'what came from AniList is not sent back');
  updateItem(ctx, frieren.id, { progress: 4, rating: 9 });
  await writeBack(ctx);
  assert.deepEqual(sent, [{ id: 154587, s: 'CURRENT', p: 4, sc: 90 }]);
  await writeBack(ctx);
  assert.equal(sent.length, 1, 'sent once');
});

test('connected Trakt: only new episodes and finished movies go to history; your old library isn\'t replayed', async () => {
  const posts = [];
  const ctx = signedIn({ connected: ['trakt'], onApi: (b) => { posts.push(b); return json({ added: {} }, 201); } });
  const show = createItem(ctx, { type: 'show', title: 'Severance', status: 'active', progress: 2, meta: { season: 1, imdb_id: 'tt11280740' } });
  const movie = createItem(ctx, { type: 'movie', title: 'Alien', status: 'planned', meta: { tmdb_id: 348 } });
  createItem(ctx, { type: 'movie', title: 'Already seen', status: 'done', meta: { tmdb_id: 1 } });
  await writeBack(ctx);
  assert.equal(posts.length, 0, 'connecting doesn\'t resend what you had');

  updateItem(ctx, show.id, { progress: 4 });
  updateItem(ctx, movie.id, { status: 'done' });
  await writeBack(ctx);
  const history = posts.filter((p) => p.path === '/sync/history').map((p) => p.body);
  assert.deepEqual(history.find((h) => h.shows)?.shows[0].seasons[0], { number: 1, episodes: [{ number: 3 }, { number: 4 }] });
  assert.deepEqual(history.find((h) => h.movies)?.movies[0].ids, { tmdb: 348 });
  const before = posts.length;
  await writeBack(ctx);
  assert.equal(posts.length, before, 'nothing twice');
});
