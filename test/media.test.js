import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { createEventBus } from '../src/domain/events.js';
import { createApp } from '../src/server.js';
import { listItems, findByExternal } from '../src/domain/library.js';
import { trophyCounts } from '../src/domain/trophies.js';
import { configureConnector, syncConnector, listConnectors } from '../src/integrations/connectors/index.js';
import { createApiKey } from '../src/domain/apikeys.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const xml = (body) => new Response(body, { status: 200, headers: { 'content-type': 'application/rss+xml' } });

function ctxWith(routes) {
  const db = openDb(':memory:');
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of routes) if (String(url).includes(match)) return handler(String(url), init);
    return json({ error: 'no route' }, 404);
  };
  return { db, events: createEventBus(db), fetch, calls };
}

test('connectors are grouped into game platforms and media accounts', () => {
  const ctx = ctxWith([]);
  const groups = Object.fromEntries(listConnectors(ctx).map((c) => [c.name, c.group]));
  assert.equal(groups.steam, 'games');
  assert.equal(groups.retroachievements, 'games');
  for (const n of ['anilist', 'mal', 'trakt', 'hardcover', 'letterboxd', 'goodreads', 'lastfm']) assert.equal(groups[n], 'media', n);
});

test('anilist: anime + manga lists; finished anime earns the golden idol; re-sync updates in place', async () => {
  let progress = 3;
  const ctx = ctxWith([['graphql.anilist.co', (_, init) => {
    const { variables } = JSON.parse(init.body);
    assert.equal(variables.user, 'pixelfan');
    if (variables.type === 'ANIME') {
      return json({ data: { MediaListCollection: { lists: [{ entries: [
        { status: 'COMPLETED', progress: 28, score: 9, completedAt: { year: 2024, month: 3, day: 22 },
          media: { id: 154587, format: 'TV', episodes: 28, seasonYear: 2023, title: { english: 'Frieren: Beyond Journey\'s End', romaji: 'Sousou no Frieren' }, coverImage: { large: 'https://img/frieren.jpg' }, studios: { nodes: [{ name: 'Madhouse' }] } } },
        { status: 'CURRENT', progress, score: 0, completedAt: {},
          media: { id: 21, format: 'TV', episodes: null, seasonYear: 1999, title: { english: null, romaji: 'One Piece' }, coverImage: { large: null }, studios: { nodes: [] } } },
      ] }] } } });
    }
    return json({ data: { MediaListCollection: { lists: [{ entries: [
      { status: 'PLANNING', progress: 0, score: 0, media: { id: 30013, format: 'MANGA', chapters: 162, startDate: { year: 2014 }, title: { english: 'Berserk' }, coverImage: { large: 'https://img/b.jpg' }, staff: { nodes: [{ name: { full: 'Kentarou Miura' } }] } } },
    ] }] } } });
  }]]);
  configureConnector(ctx, 'anilist', { username: 'https://anilist.co/user/pixelfan/' });
  const r = await syncConnector(ctx, 'anilist');
  assert.equal(r.items, 3);
  assert.equal(r.added, 3);
  assert.equal(r.new_trophies.length, 1);
  assert.equal(r.new_trophies[0].kind, 'anime');
  const frieren = findByExternal(ctx, 'anilist', 'anime:154587');
  assert.equal(frieren.type, 'anime');
  assert.equal(frieren.status, 'done');
  assert.equal(frieren.rating, 9);
  assert.equal(frieren.creator, 'Madhouse');
  assert.equal(frieren.finished_at, '2024-03-22T00:00:00.000Z');
  assert.equal(findByExternal(ctx, 'anilist', 'manga:30013').creator, 'Kentarou Miura');

  progress = 4;
  const again = await syncConnector(ctx, 'anilist');
  assert.equal(again.added, 0);
  assert.equal(again.new_trophies.length, 0);
  assert.equal(findByExternal(ctx, 'anilist', 'anime:21').progress, 4);
  assert.equal(listItems(ctx, {}).length, 3);
});

test('trakt: movies, per-season shows (anime → idol), ratings, watchlist', async () => {
  const ctx = ctxWith([
    ['/users/me/ratings', () => json([{ type: 'movie', rating: 8, movie: { ids: { trakt: 1 } } }])],
    ['/users/me/watched/movies', () => json([{ plays: 2, last_watched_at: '2025-01-01T20:00:00.000Z', movie: { title: 'Alien', year: 1979, ids: { trakt: 1, tmdb: 348 }, images: { poster: ['walter-r2.trakt.tv/alien.jpg'] } } }])],
    ['/users/me/watched/shows', () => json([
      { last_watched_at: '2025-02-01T00:00:00Z', show: { title: 'Severance', year: 2022, status: 'returning series', aired_episodes: 19, genres: ['drama'], ids: { trakt: 10 } },
        seasons: [{ number: 1, episodes: Array.from({ length: 9 }, (_, i) => ({ number: i + 1, plays: 1, last_watched_at: '2025-02-01T00:00:00Z' })) },
                  { number: 2, episodes: [{ number: 1, plays: 1 }] }] },
      { last_watched_at: '2025-01-15T00:00:00Z', show: { title: 'Cowboy Bebop', year: 1998, status: 'ended', aired_episodes: 26, genres: ['anime', 'action'], ids: { trakt: 20 } },
        seasons: [{ number: 1, episodes: Array.from({ length: 26 }, (_, i) => ({ number: i + 1, plays: 1 })) }] },
    ])],
    ['/shows/10/seasons', () => json([{ number: 0, episode_count: 3 }, { number: 1, aired_episodes: 9 }, { number: 2, aired_episodes: 10 }])],
    ['/shows/20/seasons', () => json([{ number: 1, aired_episodes: 26 }])],
    ['/users/me/watchlist', () => json([{ type: 'movie', movie: { title: 'Dune', year: 2021, ids: { trakt: 3 } } }, { type: 'movie', movie: { title: 'Alien', year: 1979, ids: { trakt: 1 } } }])],
  ]);
  configureConnector(ctx, 'trakt', { client_id: 'CID', username: 'me' });
  await syncConnector(ctx, 'trakt');
  assert.equal(ctx.calls[0].init.headers['trakt-api-key'], 'CID');
  const alien = findByExternal(ctx, 'trakt', 'movie:1');
  assert.equal(alien.status, 'done', 'being on the watchlist too doesn\'t un-watch it');
  assert.equal(alien.rating, 8);
  assert.equal(alien.cover_url, 'https://walter-r2.trakt.tv/alien.jpg');
  assert.equal(findByExternal(ctx, 'trakt', 'movie:3').status, 'planned');
  const s1 = findByExternal(ctx, 'trakt', 'show:10:s1');
  assert.equal(s1.status, 'done');
  assert.equal(s1.progress, 9);
  const s2 = findByExternal(ctx, 'trakt', 'show:10:s2');
  assert.deepEqual([s2.status, s2.progress, s2.progress_total], ['active', 1, 10]);
  assert.equal(findByExternal(ctx, 'trakt', 'show:20:s1').type, 'anime');
  assert.deepEqual(trophyCounts(ctx), { controller: 0, vhs: 1, tv: 1, anime: 1, cd: 0 });

  // Season counts are cached: an ended show isn't looked up again.
  await syncConnector(ctx, 'trakt');
  assert.equal(ctx.calls.filter((c) => c.url.includes('/shows/20/seasons')).length, 1);
});

test('trakt: a private profile says so', async () => {
  const ctx = ctxWith([['api.trakt.tv', () => json({}, 401)]]);
  configureConnector(ctx, 'trakt', { client_id: 'CID', username: 'me' });
  await assert.rejects(() => syncConnector(ctx, 'trakt'), /Client ID, or the profile is private/);
});

test('hardcover: shelves, half-star ratings, progress; falls back to a basic query', async () => {
  let full = true;
  const ctx = ctxWith([['api.hardcover.app', (_, init) => {
    assert.equal(init.headers.Authorization, 'Bearer TOKEN');
    const { query } = JSON.parse(init.body);
    if (query.includes('user_book_reads') && !full) return json({ errors: [{ message: 'field "user_book_reads" not found' }] });
    return json({ data: { me: [{ user_books: [
      { status_id: 3, rating: 4.5, book: { id: 1, title: 'Dune', slug: 'dune', release_year: 1965, pages: 412, image: { url: 'https://hc/dune.jpg' }, contributions: [{ author: { name: 'Frank Herbert' } }] }, user_book_reads: [{ finished_at: '2025-05-01' }] },
      { status_id: 2, rating: null, book: { id: 2, title: 'Hyperion', pages: 482, contributions: [] }, user_book_reads: [{ progress_pages: 120 }] },
      { status_id: 1, book: { id: 3, title: 'Neuromancer' } },
    ] }] } });
  }]]);
  configureConnector(ctx, 'hardcover', { token: 'Bearer TOKEN' });
  const r = await syncConnector(ctx, 'hardcover');
  assert.equal(r.added, 3);
  const dune = findByExternal(ctx, 'hardcover', 'book:1');
  assert.deepEqual([dune.status, dune.rating, dune.progress, dune.creator], ['done', 9, 412, 'Frank Herbert']);
  assert.equal(findByExternal(ctx, 'hardcover', 'book:2').progress, 120);
  assert.equal(findByExternal(ctx, 'hardcover', 'book:3').status, 'planned');
  full = false;
  const again = await syncConnector(ctx, 'hardcover');
  assert.equal(again.updated, 3);
});

test('mal: paged anime list with the client id header', async () => {
  const ctx = ctxWith([
    ['animelist?', (url, init) => {
      assert.equal(init.headers['X-MAL-CLIENT-ID'], 'MALID');
      return json({ data: [{ node: { id: 1, title: 'Cowboy Bebop', num_episodes: 26, start_season: { year: 1998 }, main_picture: { large: 'https://mal/cb.jpg' }, studios: [{ name: 'Sunrise' }] },
        list_status: { status: 'completed', score: 10, num_episodes_watched: 26, finish_date: '2020-01-02' } }], paging: { next: 'https://api.myanimelist.net/v2/users/me/animelist-page2' } });
    }],
    ['animelist-page2', () => json({ data: [{ node: { id: 2, title: 'Trigun', num_episodes: 26 }, list_status: { status: 'plan_to_watch', score: 0, num_episodes_watched: 0 } }], paging: {} })],
    ['mangalist', () => json({ data: [], paging: {} })],
  ]);
  configureConnector(ctx, 'mal', { client_id: 'MALID', username: 'me' });
  const r = await syncConnector(ctx, 'mal');
  assert.equal(r.items, 2);
  assert.equal(r.new_trophies[0].kind, 'anime');
  assert.equal(findByExternal(ctx, 'mal', 'anime:2').status, 'planned');
});

test('letterboxd + goodreads: public RSS feeds', async () => {
  const lb = `<?xml version="1.0"?><rss xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org"><channel>
    <item><title>Alien, 1979 - ★★★★½</title><link>https://letterboxd.com/me/film/alien/</link>
      <letterboxd:watchedDate>2025-06-01</letterboxd:watchedDate><letterboxd:filmTitle>Alien</letterboxd:filmTitle><letterboxd:filmYear>1979</letterboxd:filmYear>
      <letterboxd:memberRating>4.5</letterboxd:memberRating><tmdb:movieId>348</tmdb:movieId>
      <description><![CDATA[ <p><img src="https://a.ltrbxd.com/alien.jpg"/></p> ]]></description></item>
    <item><title>My list</title><link>https://letterboxd.com/me/list/x/</link></item>
  </channel></rss>`;
  const gr = (shelf) => `<rss><channel>${shelf === 'read' ? `<item><title><![CDATA[The Hobbit]]></title><book_id>5907</book_id><author_name>J.R.R. Tolkien</author_name>
    <user_rating>5</user_rating><user_read_at><![CDATA[Sat, 01 Mar 2025 00:00:00 -0800]]></user_read_at><book_published>1937</book_published>
    <book_large_image_url><![CDATA[https://gr/hobbit.jpg]]></book_large_image_url><book><num_pages>310</num_pages></book></item>` : ''}</channel></rss>`;
  const ctx = ctxWith([
    ['letterboxd.com/me/rss/', () => xml(lb)],
    ['goodreads.com/review/list_rss/12345', (url) => {
      const q = new URL(url).searchParams;
      return xml(q.get('page') === '1' ? gr(q.get('shelf')) : '<rss><channel></channel></rss>');
    }],
  ]);
  configureConnector(ctx, 'letterboxd', { username: 'me' });
  configureConnector(ctx, 'goodreads', { profile: 'https://www.goodreads.com/user/show/12345-me' });
  const a = await syncConnector(ctx, 'letterboxd');
  assert.equal(a.items, 1, 'lists are skipped');
  const alien = findByExternal(ctx, 'letterboxd', 'movie:tmdb:348');
  assert.deepEqual([alien.status, alien.rating, alien.year, alien.cover_url], ['done', 9, 1979, 'https://a.ltrbxd.com/alien.jpg']);
  await syncConnector(ctx, 'goodreads');
  const hobbit = findByExternal(ctx, 'goodreads', 'book:5907');
  assert.deepEqual([hobbit.title, hobbit.status, hobbit.rating, hobbit.progress, hobbit.creator], ['The Hobbit', 'done', 10, 310, 'J.R.R. Tolkien']);
});

test('retroachievements: mastered games earn the golden controller', async () => {
  const ctx = ctxWith([['API_GetUserCompletionProgress', () => json({ Count: 2, Total: 2, Results: [
    { GameID: 1, Title: 'Sonic the Hedgehog', ImageIcon: '/Images/1.png', ConsoleName: 'Genesis/Mega Drive', MaxPossible: 23, NumAwarded: 23, NumAwardedHardcore: 23, HighestAwardKind: 'mastered' },
    { GameID: 2, Title: 'Super Mario World', ConsoleName: 'SNES', MaxPossible: 90, NumAwarded: 10, NumAwardedHardcore: 0, HighestAwardKind: null },
  ] })]]);
  configureConnector(ctx, 'retroachievements', { username: 'me', api_key: 'K' });
  const r = await syncConnector(ctx, 'retroachievements');
  assert.equal(r.perfect, 1);
  assert.equal(r.new_trophies[0].kind, 'controller');
  assert.equal(findByExternal(ctx, 'retroachievements', '1').status, 'done');
  assert.equal(findByExternal(ctx, 'retroachievements', '2').meta.platform, 'SNES');
});

test('lastfm: top albums with play counts', async () => {
  const ctx = ctxWith([['audioscrobbler', () => json({ topalbums: { album: [
    { name: 'Discovery', playcount: '420', mbid: 'abc', url: 'https://last.fm/discovery', artist: { name: 'Daft Punk' }, image: [{ size: 'extralarge', '#text': 'https://lfm/d.png' }] },
  ] } })]]);
  configureConnector(ctx, 'lastfm', { api_key: 'K', username: 'me' });
  await syncConnector(ctx, 'lastfm');
  const d = findByExternal(ctx, 'lastfm', 'album:abc');
  assert.deepEqual([d.type, d.creator, d.meta.plays], ['music', 'Daft Punk', 420]);
});

test('scrobble: Plex multipart, Jellyfin and generic JSON; anime is detected; key in the URL', async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('tvmaze.com/singlesearch') && u.includes('Frieren')) {
      return json({ name: 'Frieren', type: 'Animation', language: 'Japanese', genres: ['Anime', 'Fantasy'], _embedded: { seasons: [{ number: 1, episodeOrder: 2 }] } });
    }
    if (u.includes('tvmaze.com/singlesearch')) return json({ name: 'Severance', type: 'Scripted', language: 'English', genres: ['Drama'], _embedded: { seasons: [{ number: 1, episodeOrder: 9 }] } });
    return new Response(null, { status: 200 });
  };
  const db = openDb(':memory:');
  const app = createApp({ db, fetchImpl, secret: 'test' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const { key } = createApiKey(db, { name: 'plex', scopes: ['ingest'] });
    const readOnly = createApiKey(db, { name: 'ro', scopes: ['read'] }).key;

    const boundary = 'xYzZY';
    const plex = (payload) => `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="thumb"; filename="t.jpg"\r\nContent-Type: image/jpeg\r\n\r\n\xff\xd8binary\r\n--${boundary}--\r\n`;
    const post = (path, body, type = 'application/json') => fetch(base + path, { method: 'POST', headers: { 'content-type': type }, body });

    assert.equal((await post('/api/v1/scrobble/plex', '{}')).status, 401);
    assert.equal((await post(`/api/v1/scrobble/plex?key=${readOnly}`, '{}')).status, 403);

    const movie = { event: 'media.scrobble', Metadata: { type: 'movie', title: 'Alien', year: 1979, guid: 'plex://movie/1' } };
    let res = await post(`/api/v1/scrobble/plex?key=${key}`, plex(movie), `multipart/form-data; boundary=${boundary}`);
    assert.equal(res.status, 201);
    res = await post(`/api/v1/scrobble/plex?key=${key}`, plex(movie), `multipart/form-data; boundary=${boundary}`);
    assert.equal((await res.json()).status, 'duplicate', 'the same movie on the same day counts once');
    res = await post(`/api/v1/scrobble/plex?key=${key}`, plex({ event: 'media.pause', Metadata: { type: 'movie', title: 'Alien' } }), `multipart/form-data; boundary=${boundary}`);
    assert.equal((await res.json()).status, 'ignored');

    for (const n of [1, 2]) {
      res = await post(`/api/v1/scrobble/jellyfin?key=${key}`, JSON.stringify({ NotificationType: 'PlaybackStop', PlayedToCompletion: 'True', ItemType: 'Episode', SeriesName: 'Frieren', SeasonNumber: 1, EpisodeNumber: n, Name: `Ep ${n}`, ItemId: `f${n}` }));
      assert.equal(res.status, 201);
    }
    res = await post(`/api/v1/scrobble/generic?key=${key}`, JSON.stringify({ type: 'episode', show: 'Severance', season: 1, episode: 1 }));
    assert.equal(res.status, 201);
    assert.equal((await post(`/api/v1/scrobble/generic?key=${key}`, JSON.stringify({ type: 'nope' }))).status, 400);

    const ctx = app.ctx;
    assert.equal(listItems(ctx, { type: 'movie' })[0].status, 'done');
    const anime = listItems(ctx, { type: 'anime' })[0];
    assert.deepEqual([anime.title, anime.progress, anime.progress_total, anime.status], ['Frieren', 2, 2, 'done']);
    const show = listItems(ctx, { type: 'show' })[0];
    assert.deepEqual([show.title, show.progress, show.progress_total, show.status], ['Severance', 1, 9, 'active']);
    assert.deepEqual(trophyCounts(ctx), { controller: 0, vhs: 1, tv: 0, anime: 1, cd: 0 });
    assert.equal(db.prepare("SELECT source FROM events WHERE type = 'movie.watched'").get().source, 'plex');
  } finally {
    app.server.close();
  }
});
