import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { createEventBus } from '../src/domain/events.js';
import { listItems } from '../src/domain/library.js';
import { createTracker, logTracker, getTracker } from '../src/domain/trackers.js';
import { trophyCounts } from '../src/domain/trophies.js';
import { familySignIn, familySync, familyStatus, familySignOut, FAMILY } from '../src/integrations/family-account.js';

const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

/** A tiny fake of the family Supabase project: auth + get_events/log_events. */
function fakeFamily() {
  const feed = []; // newest first, like get_events
  const posted = [];
  let tokenN = 0;
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('https://api.tvmaze.com/singlesearch')) {
      return json({ id: 1, name: 'Severance', _embedded: { seasons: [{ number: 1, episodeOrder: 2 }, { number: 2, episodeOrder: 10 }] } });
    }
    assert.ok(u.startsWith(FAMILY.url), u);
    assert.equal(init.headers.apikey, FAMILY.key);
    const body = init.body ? JSON.parse(init.body) : {};
    if (u.endsWith('/auth/v1/token?grant_type=password')) {
      if (body.password !== 'hunter22') return json({ error_description: 'Invalid login credentials' }, 400);
      return json({ access_token: `AT${++tokenN}`, refresh_token: 'RT', expires_in: 3600, user: { id: 'u1', email: body.email } });
    }
    if (u.endsWith('/auth/v1/token?grant_type=refresh_token')) return json({ access_token: `AT${++tokenN}`, refresh_token: 'RT2', expires_in: 3600 });
    if (u.endsWith('/auth/v1/logout')) return new Response(null, { status: 204 });
    assert.match(init.headers.Authorization, /^Bearer AT\d+$/);
    if (u.endsWith('/rest/v1/rpc/get_events')) {
      const list = feed.filter((e) => body.before_ms == null || e.at < body.before_ms).slice(0, body.max_rows);
      return json(list);
    }
    if (u.endsWith('/rest/v1/rpc/log_events')) {
      posted.push(...body.events);
      for (const e of body.events) feed.unshift(e);
      return json(body.events.length);
    }
    return json({ message: 'not found' }, 404);
  };
  const add = (e) => { feed.unshift({ at: Date.now(), data: {}, ...e }); feed.sort((a, b) => b.at - a.at); };
  return { fetch, feed, posted, add, calls };
}

function ctxFor(fam) {
  const db = openDb(':memory:');
  return { db, events: createEventBus(db), fetch: fam.fetch };
}

test('sign in with the family account; wrong password is a clear 400', async () => {
  const fam = fakeFamily();
  const ctx = ctxFor(fam);
  await assert.rejects(() => familySignIn(ctx, { email: 'me@x.com', password: 'nope' }), /Invalid login credentials/);
  const s = await familySignIn(ctx, { email: 'me@x.com', password: 'hunter22' });
  assert.equal(s.signed_in, true);
  assert.equal(s.email, 'me@x.com');
  assert.equal(s.project, null, 'uses the 128bit family project by default');
});

test('pull: Play media + Fit workouts land in the library and habits; season finale earns the golden TV', async () => {
  const fam = fakeFamily();
  const ctx = ctxFor(fam);
  const workout = createTracker(ctx, { preset: 'workout' });
  await familySignIn(ctx, { email: 'me@x.com', password: 'hunter22' });
  const t0 = Date.now() - 60_000;
  fam.add({ id: 'p1', app: 'play', type: 'movie.watched', at: t0, data: { title: 'Alien' } });
  fam.add({ id: 'p2', app: 'play', type: 'book.finished', at: t0 + 1, data: { title: 'Dune', author: 'Frank Herbert' } });
  fam.add({ id: 'p3', app: 'play', type: 'episode.watched', at: t0 + 2, data: { show: 'Severance', episode: 'S1 E1 · Good News About Hell' } });
  fam.add({ id: 'p4', app: 'play', type: 'episode.watched', at: t0 + 3, data: { show: 'Severance', episode: 'S1 E2 · Half Loop' } });
  fam.add({ id: 'p5', app: 'play', type: 'chapter.read', at: t0 + 4, data: { comic: 'Saga' } });
  fam.add({ id: 'f1', app: 'fit', type: 'workout.logged', at: t0 + 5, data: { kind: 'strength', name: 'Push day', minutes: 45, exercises: 5, sets: 15 } });
  fam.add({ id: 'fit-health-today', app: 'fit', type: 'health.day', at: t0 + 6, data: { steps: 4000 } });

  const r = await familySync(ctx);
  assert.equal(r.error, undefined);
  assert.equal(r.pulled, 7);
  assert.equal(listItems(ctx, { type: 'movie' })[0].status, 'done');
  assert.equal(listItems(ctx, { type: 'audiobook' })[0].creator, 'Frank Herbert', "Play's books are audiobooks: the audiobook filter");
  const season = listItems(ctx, { type: 'show' })[0];
  assert.equal(season.meta.season, 1);
  assert.equal(season.progress, 2);
  assert.equal(season.progress_total, 2);
  assert.equal(season.status, 'done');
  assert.deepEqual(trophyCounts(ctx), { controller: 0, vhs: 1, tv: 1, anime: 0, cd: 1 }, "Play's finished book is an audiobook: golden CD");
  assert.equal(listItems(ctx, { type: 'comic' })[0].progress, 1);
  assert.equal(getTracker(ctx, workout.id).today.done, true);
  const ev = ctx.db.prepare("SELECT source, title FROM events WHERE id = 'p1'").get();
  assert.deepEqual({ ...ev }, { source: '128bitplay', title: '🎬 Watched Alien' });

  // Things those events caused here (item.completed, trophies, habit.completed) aren't echoed back.
  const echo = await familySync(ctx);
  assert.equal(echo.pushed, 0);
  assert.equal(fam.posted.length, 0);

  // Replaced events (today's steps go up) update in place.
  fam.feed.find((e) => e.id === 'fit-health-today').data = { steps: 9000 };
  await familySync(ctx);
  assert.match(ctx.db.prepare("SELECT payload FROM events WHERE id = 'fit-health-today'").get().payload, /9000/);
  // TVmaze looked up once per show.
  assert.equal(fam.calls.filter((c) => c.includes('tvmaze')).length, 1);
});

test('push: Tracker\'s own wins go to the feed as app "tracker"; per-tap logs stay local', async () => {
  const fam = fakeFamily();
  const ctx = ctxFor(fam);
  const water = createTracker(ctx, { preset: 'water' });
  logTracker(ctx, water.id, { value: 8 }); // before linking: not shared
  await familySignIn(ctx, { email: 'me@x.com', password: 'hunter22' });
  const meds = createTracker(ctx, { preset: 'meds' });
  logTracker(ctx, meds.id, {});
  const r = await familySync(ctx);
  assert.equal(r.pushed, 1);
  assert.equal(fam.posted[0].app, 'tracker');
  assert.equal(fam.posted[0].type, 'habit.completed');
  assert.equal(fam.posted[0].data.tracker, 'Meds');
  assert.equal(typeof fam.posted[0].at, 'number');
  // Our own events coming back in the feed are ignored.
  const again = await familySync(ctx);
  assert.equal(again.pulled, 0);
  assert.equal(familyStatus(ctx).pushed_total, 1);
});

test('expired session refreshes; sign out forgets it', async () => {
  const fam = fakeFamily();
  const ctx = ctxFor(fam);
  await familySignIn(ctx, { email: 'me@x.com', password: 'hunter22' });
  const a = JSON.parse(ctx.db.prepare("SELECT value FROM kv WHERE key = 'family.account'").get().value);
  ctx.db.prepare("UPDATE kv SET value = ? WHERE key = 'family.account'").run(JSON.stringify({ ...a, expires: 0 }));
  await familySync(ctx);
  assert.ok(fam.calls.some((c) => c.endsWith('grant_type=refresh_token')));
  const out = await familySignOut(ctx);
  assert.equal(out.signed_in, false);
  assert.equal((await familySync(ctx)).error, 'not signed in');
});

test('pull: watch / listen / read sittings land on the timeline with time and how far', async () => {
  const fam = fakeFamily();
  const ctx = ctxFor(fam);
  await familySignIn(ctx, { email: 'me@x.com', password: 'hunter22' });
  const t0 = Date.now() - 60_000;
  fam.add({ id: 's1', app: 'play', type: 'watch.session', at: t0, data: { kind: 'episode', show: 'Severance', episode: 'S2 E5 · Trojan', season: 2, number: 5, minutes: 23, from_pct: 12, to_pct: 37 } });
  fam.add({ id: 's2', app: 'play', type: 'watch.session', at: t0 + 1, data: { kind: 'movie', title: 'Alien', minutes: 71, from_pct: 40, to_pct: 100, finished: 1 } });
  fam.add({ id: 's3', app: 'play', type: 'listen.session', at: t0 + 2, data: { title: 'Dune', minutes: 95, from_pct: 20, to_pct: 31 } });
  fam.add({ id: 's4', app: 'play', type: 'read.session', at: t0 + 3, data: { comic: 'Saga', chapter: 'Ch. 12', minutes: 15, chapters: 2 } });
  await familySync(ctx);
  const title = (id) => ctx.db.prepare('SELECT title FROM events WHERE id = ?').get(id).title;
  assert.equal(title('s1'), '▶ Severance · S2 E5 · Trojan · 23 min · 12% → 37%');
  assert.equal(title('s2'), '🎬 Alien · 1h 11m · ✓ finished');
  assert.equal(title('s3'), '🎧 Dune · 1h 35m · 20% → 31%');
  assert.equal(title('s4'), '💥 Saga · Ch. 12 · 15 min · 2 chapters read');
  // Sittings are timeline only: nothing new in the library.
  assert.equal(listItems(ctx, {}).length, 0);
});

test('steps: Fit and Health Connect fill the Steps tracker once (the higher count wins)', async () => {
  const { applyHealth } = await import('../src/integrations/health.js');
  const { toDay } = await import('../src/domain/dates.js');
  const fam = fakeFamily();
  const ctx = ctxFor(fam);
  const steps = createTracker(ctx, { preset: 'steps' });
  await familySignIn(ctx, { email: 'me@x.com', password: 'hunter22' });
  fam.add({ id: 'fit-health-today', app: 'fit', type: 'health.day', at: Date.now() - 1000, data: { steps: 4000 } });
  await familySync(ctx);
  assert.equal(getTracker(ctx, steps.id).today.total, 4000, 'Fit steps count');
  // Fit replaces today's event as you walk.
  fam.feed.find((e) => e.id === 'fit-health-today').data = { steps: 9000 };
  await familySync(ctx);
  assert.equal(getTracker(ctx, steps.id).today.total, 9000, 'replaced count catches up');
  // Health Connect saw the same walk: no double count.
  applyHealth(ctx, { days: [{ day: toDay(), steps: 7000 }] });
  assert.equal(getTracker(ctx, steps.id).today.total, 9000);
  applyHealth(ctx, { days: [{ day: toDay(), steps: 12000 }] });
  assert.equal(getTracker(ctx, steps.id).today.total, 12000, 'the higher count wins');
});
