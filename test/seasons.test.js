import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { createEventBus } from '../src/domain/events.js';
import { createItem, getItem, updateItem, upNext } from '../src/domain/library.js';
import { listTrophies } from '../src/domain/trophies.js';
import { setSeasonProgress, withCatalog, watchEpisode } from '../src/domain/seasons.js';
import { applyPlayEvent as applyMedia } from '../src/integrations/play.js';
import { refreshShow } from '../src/integrations/episodes.js';

function ctx(fetch) {
  const db = openDb(':memory:');
  return { db, events: createEventBus(db), fetch };
}

test('one show, seasons inside: a finished season earns its trophy, a new season brings it back to Up Next', () => {
  const c = ctx();
  let show = createItem(c, { type: 'show', title: 'Dexter: Resurrection', status: 'active' });
  // Watched all 10 episodes of season 1 (Play sends each one).
  for (let e = 1; e <= 10; e++) show = updateItem(c, show.id, watchEpisode(getItem(c, show.id), 1, e, 10));
  show = getItem(c, show.id);
  assert.equal(show.status, 'done', 'caught up: nothing more out there yet');
  assert.deepEqual(listTrophies(c).map((t) => [t.kind, t.title, t.season]), [['tv', 'Dexter: Resurrection · Season 1', 1]]);
  assert.equal(upNext(c).length, 0);

  // Season 2 announced for Oct 20: back in progress, at S2 E1.
  show = updateItem(c, show.id, withCatalog(show, [{ season: 1, episodes: 10 }, { season: 2, episodes: 0, first_air: '2026-10-20' }]));
  assert.equal(show.status, 'active');
  assert.equal(show.meta.season, 2);
  assert.equal(show.progress, 0);
  assert.deepEqual(upNext(c).map((i) => [i.title, i.next]), [['Dexter: Resurrection', { season: 2, number: 1 }]]);

  // Season 2 (8 episodes) watched: its own trophy; the show is one item the whole time.
  show = updateItem(c, show.id, withCatalog(getItem(c, show.id), [{ season: 2, episodes: 8, first_air: '2026-10-20' }]));
  for (let e = 1; e <= 8; e++) show = updateItem(c, show.id, watchEpisode(getItem(c, show.id), 2, e));
  assert.equal(getItem(c, show.id).status, 'done');
  assert.deepEqual(listTrophies(c).map((t) => t.season).sort(), [1, 2]);
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM items WHERE type = 'show'").get().n, 1);
});

test('episode tracker: tick up to an episode, un-tick, and marking done finishes the season', () => {
  const c = ctx();
  let show = createItem(c, { type: 'show', title: 'Crystal Lake', status: 'planned' });
  show = updateItem(c, show.id, withCatalog(show, [{ season: 1, episodes: 6 }, { season: 2, episodes: 6 }]));
  assert.equal(show.status, 'planned', 'nothing watched yet');
  show = updateItem(c, show.id, setSeasonProgress(show, 1, 3));
  assert.equal(show.status, 'active');
  assert.equal(show.progress, 3);
  assert.equal(show.progress_total, 6);
  show = updateItem(c, show.id, setSeasonProgress(show, 1, 2));
  assert.equal(show.meta.seasons[1].p, 2, 'un-ticked');
  // "done" by hand: season 1 finished (trophy), season 2 is out there so it's still in progress at S2.
  show = updateItem(c, show.id, { status: 'done' });
  assert.equal(show.status, 'active');
  assert.equal(show.meta.season, 2);
  assert.deepEqual(listTrophies(c).map((t) => t.title), ['Crystal Lake · Season 1']);
});

test("Play's episodes land on the one show, whatever season", () => {
  const c = ctx();
  applyMedia(c, { type: 'episode.watched', source: '128bitplay', data: { show: 'Black Torch', season: 1, number: 1, season_episodes: 2, imdb: 'tt37532893' } });
  applyMedia(c, { type: 'episode.watched', source: '128bitplay', data: { show: 'Black Torch', season: 1, number: 2 } });
  applyMedia(c, { type: 'episode.watched', source: '128bitplay', data: { show: 'Black Torch', season: 2, number: 1 } });
  const rows = c.db.prepare("SELECT * FROM items WHERE type = 'show'").all();
  assert.equal(rows.length, 1);
  const show = getItem(c, rows[0].id);
  assert.deepEqual(show.meta.seasons, { 1: { p: 2, n: 2, done: show.meta.seasons[1].done }, 2: { p: 1 } });
  assert.equal(show.meta.season, 2);
  assert.equal(listTrophies(c).length, 1);
});

test('refreshShow: TVmaze seasons and an announced season', async () => {
  const fetch = async (url) => {
    const u = String(url);
    const body = (x) => new Response(JSON.stringify(x), { status: 200 });
    if (u.includes('lookup/shows')) return body({ id: 78665 });
    if (u.endsWith('/shows/78665/seasons')) return body([{ number: 1, premiereDate: '2025-07-13', episodeOrder: 10 }, { number: 2, premiereDate: '2026-10-20', episodeOrder: null }]);
    if (u.endsWith('/shows/78665/episodes')) return body(Array.from({ length: 10 }, (_, i) => ({ season: 1, number: i + 1, name: `E${i + 1}`, airdate: '2025-07-13' })));
    return new Response('{}', { status: 404 });
  };
  const c = ctx(fetch);
  let show = createItem(c, { type: 'show', title: 'Dexter: Resurrection', status: 'active', progress: 10, meta: { imdb_id: 'tt33043892' } });
  show = await refreshShow(c, show);
  assert.equal(show.meta.tvmaze_id, 78665);
  assert.equal(show.meta.seasons[1].n, 10);
  assert.ok(show.meta.seasons[1].done, 'season 1 finished');
  assert.equal(show.meta.seasons[2].a, '2026-10-20');
  assert.equal(show.status, 'active', 'season 2 is coming: stays in Up Next');
  assert.deepEqual(upNext(c)[0].next, { season: 2, number: 1 });
  assert.equal(listTrophies(c).length, 1);
});
