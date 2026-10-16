import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { createEventBus } from '../src/domain/events.js';
import { listItems } from '../src/domain/library.js';
import { trophyCounts } from '../src/domain/trophies.js';
import { importFile, parseCsv } from '../src/integrations/imports.js';
import { searchTitles, showSeasons } from '../src/integrations/metadata.js';
import { configureService } from '../src/integrations/services.js';

function ctx(fetch) {
  const db = openDb(':memory:');
  return { db, events: createEventBus(db), fetch };
}

test('csv parser handles quotes, commas and newlines', () => {
  const rows = parseCsv('a,b,c\r\n"x, y","say ""hi""","line1\nline2"\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'say "hi"', 'line1\nline2']]);
});

test('goodreads export', () => {
  const c = ctx();
  const csv = [
    'Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies',
    '54493401,Project Hail Mary,Andy Weir,"Weir, Andy",,"=""0593135202""","=""9780593135204""",5,4.52,Ballantine Books,Hardcover,476,2021,2021,2024/03/02,2023/12/01,,,read,"Loved it.<br/>Rocky!",,,1,0',
    '44767458,Dune,Frank Herbert,"Herbert, Frank",,,,0,4.27,Ace,Paperback,658,2005,1965,,2024/01/05,to-read,to-read (#1),to-read,,,,0,0',
    '1,Currently,Someone,,,,,0,4,,,300,2020,2020,,2024/01/05,,,currently-reading,,,,0,0',
  ].join('\n');
  const r = importFile(c, { text: csv, filename: 'goodreads_library_export.csv' });
  assert.equal(r.format, 'Goodreads');
  assert.equal(r.added, 3);
  const phm = listItems(c, { q: 'Hail Mary' })[0];
  assert.equal(phm.status, 'done');
  assert.equal(phm.rating, 10);
  assert.equal(phm.progress, 476);
  assert.equal(phm.review, 'Loved it.\nRocky!');
  assert.equal(phm.finished_at.slice(0, 10), '2024-03-02');
  assert.equal(listItems(c, { q: 'Dune' })[0].year, 1965);
  assert.equal(listItems(c, { q: 'Currently' })[0].status, 'active');
  // Same file again: updates, no duplicates.
  const again = importFile(c, { text: csv });
  assert.equal(again.added, 0);
  assert.equal(again.updated, 3);
  assert.equal(listItems(c).length, 3);
  // Bulk imports stay off the timeline.
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'item.added'").get().n, 0);
});

test('letterboxd export → finished movies earn golden VHS', () => {
  const c = ctx();
  const csv = 'Date,Name,Year,Letterboxd URI,Rating\n2024-05-01,Alien,1979,https://boxd.it/2bfA,4.5\n2024-05-03,"Crouching Tiger, Hidden Dragon",2000,https://boxd.it/1x,\n';
  const r = importFile(c, { text: csv, filename: 'ratings.csv' });
  assert.equal(r.format, 'Letterboxd');
  assert.equal(r.added, 2);
  assert.equal(r.trophies, 2);
  assert.equal(trophyCounts(c).vhs, 2);
  assert.equal(listItems(c, { q: 'Alien' })[0].rating, 9);
  const wl = importFile(ctx(), { text: 'Date,Name,Year,Letterboxd URI\n2024-01-01,Dune Part Three,2026,https://boxd.it/zz\n', filename: 'watchlist.csv' });
  assert.equal(wl.trophies, 0);
});

test('storygraph export', () => {
  const c = ctx();
  const csv = 'Title,Authors,Contributors,ISBN/UID,Format,Read Status,Date Added,Last Date Read,Dates Read,Read Count,Moods,Pace,Character- or Plot-Driven?,Strong Character Development?,Loveable Characters?,Diverse Characters?,Flawed Characters?,Star Rating,Review,Content Warnings,Content Warning Description,Tags,Owned?\n'
    + 'Piranesi,"Susanna Clarke, Someone Else",,9781635575637,paperback,read,2024/01/01,2024/02/10,2024/02/01-2024/02/10,1,,,,,,,,4.25,Strange and lovely,,,,No\n';
  const r = importFile(c, { text: csv });
  assert.equal(r.format, 'StoryGraph');
  const p = listItems(c)[0];
  assert.equal(p.creator, 'Susanna Clarke');
  assert.equal(p.rating, 9);
  assert.equal(p.status, 'done');
});

test('myanimelist xml → anime trophies, manga progress', () => {
  const c = ctx();
  const xml = `<?xml version="1.0" encoding="UTF-8" ?><myanimelist><myinfo><user_export_type>1</user_export_type></myinfo>
  <anime><series_animedb_id>52991</series_animedb_id><series_title><![CDATA[Sousou no Frieren]]></series_title><series_episodes>28</series_episodes>
    <my_watched_episodes>28</my_watched_episodes><my_finish_date>2024-03-22</my_finish_date><my_score>10</my_score><my_status>Completed</my_status></anime>
  <anime><series_animedb_id>1</series_animedb_id><series_title><![CDATA[Cowboy Bebop]]></series_title><series_episodes>26</series_episodes>
    <my_watched_episodes>5</my_watched_episodes><my_finish_date>0000-00-00</my_finish_date><my_score>0</my_score><my_status>Watching</my_status></anime>
  <manga><manga_mangadb_id>2</manga_mangadb_id><manga_title><![CDATA[Berserk &amp; Co]]></manga_title><manga_chapters>0</manga_chapters>
    <my_read_chapters>120</my_read_chapters><my_score>9</my_score><my_status>Reading</my_status></manga>
  </myanimelist>`;
  const r = importFile(c, { text: xml, filename: 'animelist.xml' });
  assert.equal(r.format, 'MyAnimeList');
  assert.equal(r.added, 3);
  assert.equal(r.trophies, 1);
  const f = listItems(c, { q: 'Frieren' })[0];
  assert.equal(f.progress, 28);
  assert.equal(f.rating, 10);
  assert.equal(listItems(c, { type: 'manga' })[0].title, 'Berserk & Co');
  assert.equal(listItems(c, { q: 'Bebop' })[0].rating, null);
});

test('unknown files are rejected', () => {
  assert.throws(() => importFile(ctx(), { text: 'foo,bar\n1,2\n' }), /not a Goodreads/);
  assert.throws(() => importFile(ctx(), { text: '' }), /empty/);
});

test('search routes each type to the right provider', async () => {
  const seen = [];
  const fetch = async (url, init = {}) => {
    seen.push(String(url));
    const u = String(url);
    const body = (x) => new Response(JSON.stringify(x), { status: 200 });
    if (u.includes('openlibrary')) return body({ docs: [{ key: '/works/OL1W', title: 'Dune', author_name: ['Frank Herbert'], first_publish_year: 1965, cover_i: 42, number_of_pages_median: 600 }] });
    if (u.includes('anilist')) {
      const { variables } = JSON.parse(init.body);
      return body({ data: { Page: { media: [{ id: 7, title: { english: null, romaji: 'Frieren' }, episodes: variables.type === 'ANIME' ? 28 : null, chapters: 140, seasonYear: 2023, coverImage: { large: 'https://c/f.jpg' }, studios: { nodes: [{ name: 'Madhouse' }] } }] } } });
    }
    if (u.includes('itunes')) return body({ results: [{ collectionId: 9, collectionName: 'Serial', artistName: 'NYT', releaseDate: '2014-10-03T08:00:00Z', artworkUrl100: 'https://a/100x100bb.jpg', trackCount: 9 }] });
    if (u.includes('tvmaze.com/search')) return body([{ show: { id: 44933, name: 'Severance', premiered: '2022-02-18', image: { original: 'https://tvm/s.jpg' }, webChannel: { name: 'Apple TV+' } } }]);
    if (u.includes('tvmaze.com/shows/44933/seasons')) return body([{ number: 1, episodeOrder: 9, premiereDate: '2022-02-18' }, { number: 2, episodeOrder: 10, premiereDate: '2025-01-17' }]);
    if (u.includes('store.steampowered')) return body({ items: [{ id: 1145350, name: 'Hades II' }] });
    if (u.includes('themoviedb')) {
      assert.equal(init.headers.Authorization, `Bearer ${'x'.repeat(60)}`);
      return body({ results: [{ id: 603, title: 'The Matrix', release_date: '1999-03-30', poster_path: '/p.jpg' }] });
    }
    if (u.includes('id.twitch.tv')) return body({ access_token: 'TW', expires_in: 5000 });
    if (u.includes('api.igdb.com')) {
      assert.equal(init.headers['Client-ID'], 'CID');
      assert.match(init.body, /search "Celeste"/);
      return body([{ id: 5, name: 'Celeste', first_release_date: 1516838400, cover: { image_id: 'co1' }, involved_companies: [{ developer: true, company: { name: 'Maddy Makes Games' } }] }]);
    }
    return new Response('{}', { status: 404 });
  };
  const c = ctx(fetch);
  const book = (await searchTitles(c, { type: 'book', q: 'dune' }))[0];
  assert.equal(book.cover_url, 'https://covers.openlibrary.org/b/id/42-L.jpg');
  assert.equal(book.progress_total, 600);
  const anime = (await searchTitles(c, { type: 'anime', q: 'frieren' }))[0];
  assert.equal(anime.progress_total, 28);
  assert.equal(anime.creator, 'Madhouse');
  const show = (await searchTitles(c, { type: 'show', q: 'severance' }))[0];
  assert.equal(show.creator, 'Apple TV+');
  const seasons = await showSeasons(c, { provider: show.provider, id: show.provider_id });
  assert.deepEqual(seasons.map((x) => [x.number, x.episodes]), [[1, 9], [2, 10]]);
  const pod = (await searchTitles(c, { type: 'podcast', q: 'serial' }))[0];
  assert.equal(pod.cover_url, 'https://a/600x600bb.jpg');
  const game = (await searchTitles(c, { type: 'game', q: 'hades' }))[0];
  assert.match(game.cover_url, /1145350\/library_600x900/);
  // With keys: TMDB and IGDB take over.
  configureService(c, 'tmdb', { token: 'x'.repeat(60) });
  assert.equal((await searchTitles(c, { type: 'movie', q: 'matrix' }))[0].year, 1999);
  configureService(c, 'igdb', { client_id: 'CID', client_secret: 'SECRET' });
  const celeste = (await searchTitles(c, { type: 'game', q: 'Celeste' }))[0];
  assert.equal(celeste.creator, 'Maddy Makes Games');
  assert.equal(celeste.year, 2018);
  await searchTitles(c, { type: 'game', q: 'Celeste' });
  assert.equal(seen.filter((u) => u.includes('id.twitch.tv')).length, 1, 'IGDB token is cached');
  await assert.rejects(() => searchTitles(c, { type: 'book', q: 'x' }), /at least 2/);
});

test('books: Open Library then Google Books (deduped); audiobooks: Audible first, saved as format audiobook', async () => {
  const seen = [];
  let gbooksDown = false;
  const fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    const body = (x) => new Response(JSON.stringify(x), { status: 200 });
    if (u.includes('openlibrary')) return body({ docs: [{ key: '/works/OL1W', title: 'Dune', author_name: ['Frank Herbert'], first_publish_year: 1965 }] });
    if (u.includes('googleapis.com/books')) {
      if (gbooksDown) return new Response(JSON.stringify({ error: { code: 429 } }), { status: 429 });
      return body({ items: [
        { id: 'g1', volumeInfo: { title: 'Dune', authors: ['Frank Herbert'], publishedDate: '1990-09-01' } },
        { id: 'g2', volumeInfo: { title: 'Book of the Dead', authors: ['RinoZ'], publishedDate: '2025-07-15', pageCount: 600, imageLinks: { thumbnail: 'http://books.google.com/x&edge=curl' }, industryIdentifiers: [{ type: 'ISBN_13', identifier: '978' }] } },
      ] });
    }
    if (u.includes('api.audible.com/1.0/catalog/products')) {
      assert.match(u, /keywords=Masquerade/);
      assert.match(u, /response_groups=[^&]*series/);
      return body({ products: [{
        asin: 'B0FFBMSL71', title: 'Masquerade: A LitRPG Adventure', subtitle: 'Book of the Dead, Book 3',
        authors: [{ asin: 'B09TDCYJSX', name: 'RinoZ' }], narrators: [{ name: 'Phil Thron' }],
        release_date: '2025-07-15', runtime_length_min: 1333, publisher_name: 'Aethon Audio',
        product_images: { 500: 'https://m.media-amazon.com/images/I/51Ehm7VRTeL._SL500_.jpg' },
        series: [{ asin: 'B0CPHQTMHN', sequence: '3', title: 'Book of the Dead' }],
      }] });
    }
    return new Response('{}', { status: 404 });
  };
  const c = ctx(fetch);
  const books = await searchTitles(c, { type: 'book', q: 'dune' });
  assert.deepEqual(books.map((b) => b.provider), ['openlibrary', 'gbooks'], 'the same Dune from Google Books is dropped');
  assert.equal(books[1].cover_url, 'https://books.google.com/x');
  assert.equal(books[1].progress_total, 600);
  assert.equal(books[1].meta.release_date, '2025-07-15');

  const audio = await searchTitles(c, { type: 'audiobook', q: 'Masquerade Book of the Dead' });
  const m = audio[0];
  assert.equal(m.provider, 'audible');
  assert.equal(m.provider_id, 'B0FFBMSL71');
  assert.equal(m.creator, 'RinoZ');
  assert.equal(m.year, 2025);
  assert.equal(m.cover_url, 'https://m.media-amazon.com/images/I/51Ehm7VRTeL._SL500_.jpg');
  assert.deepEqual({ ...m.meta, publisher: undefined }, {
    format: 'audiobook', asin: 'B0FFBMSL71', narrator: 'Phil Thron', runtime_min: 1333,
    series: 'Book of the Dead', series_position: '3', series_asin: 'B0CPHQTMHN', release_date: '2025-07-15', publisher: undefined,
  });
  assert.ok(audio.length >= 3, 'Google Books and Open Library follow');
  assert.ok(audio.every((r) => r.meta.format === 'audiobook'), 'every pick saves as an audiobook');

  // Google Books' shared quota used up (not signed in): the other sources still answer.
  gbooksDown = true;
  assert.deepEqual((await searchTitles(c, { type: 'book', q: 'dune' })).map((b) => b.provider), ['openlibrary']);
  assert.equal((await searchTitles(c, { type: 'audiobook', q: 'Masquerade' }))[0].provider, 'audible');
});

test('audiobooks: finishing one earns the golden CD; a paper book does not', async () => {
  const { createItem, updateItem } = await import('../src/domain/library.js');
  const c = ctx();
  const paper = createItem(c, { type: 'book', title: 'Dune', status: 'active' });
  assert.equal(updateItem(c, paper.id, { status: 'done' }).new_trophy, undefined);
  const audio = createItem(c, { type: 'book', title: 'Masquerade', status: 'active', meta: { format: 'audiobook', asin: 'B0FFBMSL71' } });
  const done = updateItem(c, audio.id, { status: 'done' });
  assert.equal(done.new_trophy.kind, 'cd');
  assert.equal(trophyCounts(c).cd, 1);
  const ev = c.db.prepare("SELECT title FROM events WHERE type = 'trophy.earned'").get();
  assert.equal(ev.title, '🏆 Golden CD — Masquerade');
});

test('calendar: next episodes and game releases, cached', async () => {
  const { upcoming } = await import('../src/integrations/calendar.js');
  const { createItem } = await import('../src/domain/library.js');
  let calls = 0;
  const soon = new Date(Date.now() + 5 * 86400_000);
  const later = new Date(Date.now() + 9 * 86400_000);
  const day = (d) => d.toISOString().slice(0, 10);
  const fetch = async (url, init = {}) => {
    calls++;
    const u = String(url);
    const body = (x) => new Response(JSON.stringify(x), { status: 200 });
    if (u.includes('tvmaze.com/singlesearch')) return body({ id: 44933 });
    if (u.includes('tvmaze.com/shows/44933/episodes')) {
      return body([
        { airdate: '2020-01-01', season: 2, number: 10, name: 'Old' },
        { airdate: soon.toISOString().slice(0, 10), season: 3, number: 1, name: 'Return' },
        { airdate: later.toISOString().slice(0, 10), season: 3, number: 2, name: 'Next' },
      ]);
    }
    if (u.includes('googleapis.com/books')) return body({ items: [{ volumeInfo: { title: 'Wind and Truth II', publishedDate: later.toISOString().slice(0, 10) } }] });
    if (u.includes('anilist')) {
      const v = JSON.parse(init.body).variables;
      if (v.ids?.length) return body({ data: { byId: { media: [{ id: 7, airingSchedule: { nodes: [{ airingAt: Math.floor(soon.getTime() / 1000) + 86400, episode: 12 }] } }] }, byName: null } });
      return body({ data: { byId: { media: [] }, byName: null } });
    }
    if (u.includes('appdetails')) return body({ 1145350: { success: true, data: { release_date: { coming_soon: true, date: 'Q4 2026' } } } });
    return new Response('{}', { status: 404 });
  };
  const c = ctx(fetch);
  createItem(c, { type: 'show', title: 'Severance', status: 'active', meta: { season: 2 } });
  createItem(c, { type: 'show', title: 'Severance', status: 'planned', meta: { season: 3 } });
  createItem(c, { type: 'anime', title: 'Frieren S3', status: 'active', meta: { anilist_id: 7 } });
  createItem(c, { type: 'game', title: 'Hades III', status: 'planned', meta: { provider: 'steam', provider_id: '1145350' } });
  createItem(c, { type: 'show', title: 'Finished Show', status: 'done' });
  createItem(c, { type: 'book', title: 'Wind and Truth II', creator: 'Brandon Sanderson', status: 'planned', meta: { format: 'audiobook' } });
  createItem(c, { type: 'movie', title: 'Set By Hand', status: 'planned', meta: { release_date: day(later) } });
  const list = await upcoming(c);
  assert.deepEqual(list.map((e) => [e.title, e.detail, e.type]), [
    ['Severance', 'S3 E1 · Return', 'show'],
    ['Frieren S3', 'Episode 12', 'anime'],
    ['Severance', 'S3 E2 · Next', 'show'],
    ['Wind and Truth II', 'Audiobook out', 'book'],
    ['Set By Hand', 'In cinemas', 'movie'],
    ['Hades III', 'Coming Q4 2026', undefined],
  ]);
  const n = calls;
  await upcoming(c);
  assert.equal(calls, n, 'cached');
});
