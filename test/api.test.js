import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db/index.js';
import { verifySignature } from '../src/domain/webhooks.js';
import { toDay } from '../src/domain/dates.js';

let base;
let app;
const delivered = [];
const fakeFetch = async (url, init) => {
  delivered.push({ url, init });
  return new Response(null, { status: 200 });
};

before(async () => {
  app = createApp({ db: openDb(':memory:'), fetchImpl: fakeFetch, secret: 'test' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.server.close());

async function call(method, path, body, headers = { 'x-128bit-client': 'web' }) {
  const res = await fetch(base + path, {
    method,
    headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('unauthenticated requests are rejected', async () => {
  const r = await call('GET', '/api/v1/trackers', undefined, {});
  assert.equal(r.status, 401);
});

test('two-tap habit logging with streak + events', async () => {
  const { body: t } = await call('POST', '/api/v1/trackers', { preset: 'water' });
  assert.equal(t.name, 'Water');
  assert.equal(t.target, 8);
  for (let i = 0; i < 8; i++) await call('POST', `/api/v1/trackers/${t.id}/log`, {});
  const { body: after } = await call('GET', `/api/v1/trackers/${t.id}`);
  assert.equal(after.today.total, 8);
  assert.equal(after.today.done, true);
  assert.equal(after.streak.current, 1);
  const { body: evs } = await call('GET', '/api/v1/events?type=habit.completed');
  assert.equal(evs.length, 1);

  const undo = await call('POST', `/api/v1/trackers/${t.id}/undo`, {});
  assert.equal(undo.body.today.done, false);
});

test('validation errors are 400s', async () => {
  assert.equal((await call('POST', '/api/v1/trackers', { name: '' })).status, 400);
  assert.equal((await call('POST', '/api/v1/items', { title: 'X', rating: 11 })).status, 400);
  assert.equal((await call('GET', '/api/v1/nope')).status, 404);
});

test('library items + sessions', async () => {
  const { body: book } = await call('POST', '/api/v1/items', { type: 'book', title: 'Dune', progress_total: 412 });
  assert.equal(book.status, 'planned');
  const { body: s } = await call('POST', `/api/v1/items/${book.id}/sessions`, { minutes: 45, progress: 60 });
  assert.equal(s.status, 'active');
  assert.equal(s.progress, 60);
  const { body: done } = await call('PATCH', `/api/v1/items/${book.id}`, { status: 'done', rating: 9 });
  assert.equal(done.progress, 412);
  assert.ok(done.finished_at);
  const { body: list } = await call('GET', '/api/v1/items?type=book&status=done');
  assert.equal(list.length, 1);
});

test('128bitplay: API key ingest syncs the library and is idempotent', async () => {
  const { body: key } = await call('POST', '/api/v1/keys', { name: '128bitplay', scopes: ['read', 'ingest'] });
  assert.match(key.key, /^tb128_/);
  const h = { authorization: `Bearer ${key.key}` };

  // key without write scope can't create trackers directly
  assert.equal((await call('POST', '/api/v1/trackers', { name: 'x' }, h)).status, 403);

  const { body: habit } = await call('POST', '/api/v1/trackers', { preset: 'gaming' });
  assert.deepEqual(habit.listens, ['game.session']);

  const game = { id: 'g-42', title: 'Pixel Quest', platform: 'web' };
  const r1 = await call('POST', '/api/v1/events', { id: 'evt-1', type: 'game.started', data: { game } }, h);
  assert.equal(r1.status, 201);
  const dup = await call('POST', '/api/v1/events', { id: 'evt-1', type: 'game.started', data: { game } }, h);
  assert.equal(dup.body.status, 'duplicate');

  const batch = await call('POST', '/api/v1/events', [
    { id: 'evt-2', type: 'game.session', data: { game, minutes: 35 } },
    { id: 'evt-3', type: 'achievement.unlocked', data: { game, achievement: { name: 'First Blood' } } },
    { id: 'evt-4', type: 'game.completed', data: { game } },
    { id: 'evt-5', type: 'game.session', data: {} },
  ], h);
  assert.equal(batch.status, 207);
  assert.deepEqual(batch.body.map((b) => b.status), ['accepted', 'accepted', 'accepted', 'error']);

  const { body: item } = await call('GET', '/api/v1/lookup/128bitplay/g-42', undefined, h);
  assert.equal(item.status, 'done');
  assert.equal(item.minutes_total, 35);

  const { body: playTime } = await call('GET', `/api/v1/trackers/${habit.id}`);
  assert.equal(playTime.today.total, 35);
  assert.equal(playTime.today.done, true);

  // A failed event isn't stored, so a fixed retry with the same id works.
  const retry = await call('POST', '/api/v1/events', { id: 'evt-5', type: 'game.session', data: { game, minutes: 5 } }, h);
  assert.equal(retry.body.status, 'accepted');

  // The tracker's own namespace can't be spoofed.
  const spoof = await call('POST', '/api/v1/events', { type: 'habit.completed', source: '128bittracker' }, h);
  assert.equal(spoof.status, 400);

  // Revoked keys stop working.
  await call('DELETE', `/api/v1/keys/${key.id}`);
  assert.equal((await call('GET', '/api/v1/items', undefined, h)).status, 401);
});

test('sibling events feed listening trackers', async () => {
  const { body: key } = await call('POST', '/api/v1/keys', { name: '128bitfit', scopes: ['ingest'] });
  const { body: t } = await call('POST', '/api/v1/trackers', { preset: 'workout' });
  const r = await call('POST', '/api/v1/events', { type: 'workout.logged', data: { minutes: 40 } }, { authorization: `Bearer ${key.key}` });
  assert.equal(r.body.effects[0].tracker_id, t.id);
  const { body: evs } = await call('GET', '/api/v1/events?source=128bitfit');
  assert.equal(evs.length, 1);
});

test('webhooks are signed and filtered', async () => {
  const { body: hook } = await call('POST', '/api/v1/webhooks', { url: 'https://play.example/hooks/tracker', event_types: ['streak.*', 'habit.completed'] });
  assert.match(hook.secret, /^whsec_/);
  delivered.length = 0;
  const { body: t } = await call('POST', '/api/v1/trackers', { name: 'Stretch', kind: 'check' });
  await call('POST', `/api/v1/trackers/${t.id}/log`, {});
  await app.ctx.events.flush();
  const types = delivered.map((d) => d.init.headers['x-128bit-event']);
  assert.deepEqual(types, ['habit.completed']);
  const { headers, body } = delivered[0].init;
  assert.ok(verifySignature(hook.secret, headers['x-128bit-timestamp'], body, headers['x-128bit-signature']));
  assert.equal(JSON.parse(body).data.day, toDay());
});

test('stats + export', async () => {
  const { body: s } = await call('GET', '/api/v1/stats');
  assert.ok(s.habits.count >= 3);
  assert.equal(s.library.game.done, 1);
  const { body: y } = await call('GET', `/api/v1/stats/year/${new Date().getFullYear()}`);
  assert.ok(y.days.length >= 365);
  const { body: ex } = await call('GET', '/api/v1/export');
  assert.equal(ex.format, '128bittracker-export');
  assert.ok(ex.items.length >= 2);
});

test('device sync: inbox returns other apps\' events, outbox fans out to webhooks', async () => {
  const { body: phone } = await call('POST', '/api/v1/keys', { name: 'phone', scopes: ['sync'] });
  const ph = { authorization: `Bearer ${phone.key}` };
  const first = await call('GET', '/api/v1/sync/inbox?cursor=0', undefined, ph);
  assert.equal(first.status, 200);
  assert.ok(first.body.events.length > 0);
  assert.ok(first.body.events.every((e) => e.source !== '128bittracker'));
  const again = await call('GET', `/api/v1/sync/inbox?cursor=${first.body.cursor}`, undefined, ph);
  assert.equal(again.body.events.length, 0);

  delivered.length = 0;
  const ev = { id: 'phone-1', type: 'streak.milestone', source: '128bittracker', occurred_at: new Date().toISOString(), data: { days: 7 } };
  const pushed = await call('POST', '/api/v1/sync/outbox', [ev, ev, { type: 'game.started', source: '128bitplay' }], ph);
  assert.deepEqual(pushed.body.map((p) => p.status), ['accepted', 'duplicate', 'error']);
  await app.ctx.events.flush();
  assert.deepEqual(delivered.map((d) => d.init.headers['x-128bit-event']), ['streak.milestone']);

  // sync keys can't read the library
  assert.equal((await call('GET', '/api/v1/items', undefined, ph)).status, 403);
});
