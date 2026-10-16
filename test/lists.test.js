import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { createEventBus } from '../src/domain/events.js';
import { createItem, createCollection, updateCollection, setCollectionMembership, reorderCollection, deleteCollection, deleteItem, getCollection, listItems, upNext } from '../src/domain/library.js';
import { familyOAuthStart, familyOAuthFinish, familySignIn, FAMILY } from '../src/integrations/family-account.js';

const ctxOf = (fetch) => { const db = openDb(':memory:'); return { db, events: createEventBus(db), fetch }; };

test('lists: kinds, show in 128bitPlay, order, and deletes remembered for the cloud', () => {
  const ctx = ctxOf();
  const a = createItem(ctx, { type: 'movie', title: 'Alien' });
  const b = createItem(ctx, { type: 'movie', title: 'Aliens' });
  const c = createItem(ctx, { type: 'movie', title: 'Alien 3' });
  const list = createCollection(ctx, { name: 'Xenomorphs', kind: 'movie' });
  assert.equal(list.show_in_play, true, 'lists show in Play unless you say no');
  assert.throws(() => createCollection(ctx, { name: 'x', kind: 'nope' }), /kind must be/);
  for (const i of [a, b, c]) setCollectionMembership(ctx, list.id, i.id, true);
  assert.deepEqual(listItems(ctx, { collection: list.id, sort: 'position' }).map((i) => i.title), ['Alien', 'Aliens', 'Alien 3']);
  reorderCollection(ctx, list.id, [c.id, a.id]);
  assert.deepEqual(listItems(ctx, { collection: list.id, sort: 'position' }).map((i) => i.title), ['Alien 3', 'Alien', 'Aliens']);
  const updated = updateCollection(ctx, list.id, { is_public: true, show_in_play: false, name: 'Xeno' });
  assert.deepEqual([updated.name, updated.is_public, updated.show_in_play, updated.item_count], ['Xeno', true, false, 3]);

  // Deletes of synced things leave tombstones.
  ctx.db.prepare("UPDATE items SET uid = 'i-a' WHERE id = ?").run(a.id);
  ctx.db.prepare("UPDATE collections SET uid = 'l-1' WHERE id = ?").run(list.id);
  setCollectionMembership(ctx, list.id, a.id, false);
  deleteItem(ctx, a.id);
  deleteCollection(ctx, list.id);
  assert.deepEqual(ctx.db.prepare('SELECT kind, uid FROM tombstones ORDER BY kind').all().map((r) => `${r.kind}:${r.uid}`),
    ['item:i-a', 'list:l-1', 'list_item:l-1|i-a']);
  assert.throws(() => getCollection(ctx, list.id), /not found/);
});

test('up next: shows and anime in progress with the next episode', () => {
  const ctx = ctxOf();
  createItem(ctx, { type: 'show', title: 'Severance', status: 'active', progress: 2, progress_total: 9, meta: { season: 2 } });
  createItem(ctx, { type: 'anime', title: 'Frieren', status: 'active', progress: 0 });
  createItem(ctx, { type: 'show', title: 'Done', status: 'done', progress: 9, progress_total: 9 });
  createItem(ctx, { type: 'movie', title: 'Alien', status: 'active' });
  const u = upNext(ctx);
  assert.deepEqual(u.map((i) => `${i.title} S${i.next.season}E${i.next.number}`).sort(), ['Frieren S1E1', 'Severance S2E3']);
});

test('Google / Apple: PKCE start + finish; another account\'s sign-in is refused with its session', async () => {
  let exchanged = null;
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init) => {
    const u = String(url);
    const body = JSON.parse(init.body);
    if (u.endsWith('grant_type=pkce')) {
      exchanged = body;
      return json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, user: { id: body.auth_code === 'good' ? 'u-1' : 'u-2', email: 'g@x.com' } });
    }
    if (u.endsWith('grant_type=password')) return json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, user: { id: 'u-3', email: body.email } });
    return json({}, 404);
  };
  const ctx = ctxOf(fetch);
  const { url } = await familyOAuthStart(ctx, { provider: 'google', redirect: 'app.bit128.tracker://auth' });
  const q = new URL(url).searchParams;
  assert.ok(url.startsWith(`${FAMILY.url}/auth/v1/authorize?`));
  assert.equal(q.get('provider'), 'google');
  assert.equal(q.get('redirect_to'), 'app.bit128.tracker://auth');
  assert.equal(q.get('code_challenge_method'), 's256');
  const challenge = q.get('code_challenge');
  const s = await familyOAuthFinish(ctx, { code: 'good' });
  assert.equal(s.signed_in, true);
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(exchanged.code_verifier))).toString('base64url');
  assert.equal(digest, challenge, 'the verifier matches the challenge');
  await assert.rejects(() => familyOAuthFinish(ctx, { code: 'good' }), /old/);

  // This Tracker's library belongs to u-1 once it has synced.
  ctx.db.prepare("INSERT INTO kv (key, value) VALUES ('cloud.owner', '\"u-1\"')").run();
  await assert.rejects(() => familySignIn(ctx, { email: 'other@x.com', password: 'pw' }),
    (err) => err.status === 409 && err.extra.code === 'other_account' && err.extra.account.user_id === 'u-3' && err.extra.account.refresh === 'RT');
});

test('starter lists, local: the five once, never a second one of what you have', async () => {
  const { localStarterLists } = await import('../src/integrations/starter-lists.js');
  const { listCollections } = await import('../src/domain/library.js');
  const ctx = ctxOf();
  createCollection(ctx, { name: 'Amine', kind: 'show' }); // your own, mis-kinded: counts as Anime
  createCollection(ctx, { name: 'My audiobooks', kind: 'mixed' });
  createCollection(ctx, { name: 'TV to watch', kind: 'show' });
  assert.equal(localStarterLists(ctx, { signedIn: true }).length, 0, 'signed in: the cloud makes them');
  const made = localStarterLists(ctx);
  assert.deepEqual(made.map((l) => `${l.name}:${l.kind}`), ['Movies:movie', 'Comics:comic']);
  assert.equal(localStarterLists(ctx).length, 0, 'only once');
  deleteCollection(ctx, made[0].id);
  assert.equal(localStarterLists(ctx).length, 0, 'a deleted one stays deleted');
  assert.equal(listCollections(ctx).length, 4);
});

test('starter lists, signed in: starter_lists() once per account, untouched local ones make way', async () => {
  const { localStarterLists } = await import('../src/integrations/starter-lists.js');
  const { cloudSync } = await import('../src/integrations/cloud.js');
  const { listCollections } = await import('../src/domain/library.js');
  const ctx = ctxOf(async () => new Response('{}', { status: 404 }));
  // First run on this phone, before signing in: the five, then a movie goes on Movies.
  const local = localStarterLists(ctx);
  assert.equal(local.length, 5);
  const alien = createItem(ctx, { type: 'movie', title: 'Alien' });
  setCollectionMembership(ctx, local[0].id, alien.id, true);
  // The account already has its lists in the cloud (made on another phone).
  const at = new Date(Date.now() + 1000).toISOString();
  const cloud = [{ id: 'l-other-phone', name: 'Anime', kind: 'anime', show_in_play: true, position: 0, updated_at: at }];
  const calls = [];
  const rpc = async (fn, args) => {
    calls.push(fn);
    if (fn === 'tracker_push') { for (const l of args.payload.lists ?? []) cloud.push(l); return {}; }
    if (fn === 'starter_lists') {
      for (const [key, kind, name] of [['movie', 'movie', 'Movies'], ['show', 'show', 'Shows'], ['anime', 'anime', 'Anime'], ['audiobooks', 'book', 'Audiobooks'], ['comic', 'comic', 'Comics']]) {
        if (!cloud.some((l) => l.name === name)) cloud.push({ id: `l-${key}`, name, kind, show_in_play: true, position: cloud.length, updated_at: at });
      }
      return Object.fromEntries(cloud.map((l) => [l.name, l.id]));
    }
    if (fn === 'tracker_pull') return { at, items: [], lists: cloud.map((l) => ({ ...l, updated_at: at })), list_items: [], trophies: [] };
    return null;
  };
  const r = await cloudSync(ctx, { rpc, userId: 'u1' });
  assert.equal(r.error, undefined);
  assert.equal(calls.filter((c) => c === 'starter_lists').length, 1);
  assert.deepEqual(cloud.filter((l) => l.name === 'Movies').length, 1, 'Movies (with Alien on it) went up; the cloud reused it');
  const names = listCollections(ctx).map((l) => l.name).sort();
  assert.deepEqual(names, ['Anime', 'Audiobooks', 'Comics', 'Movies', 'Shows'], 'no doubles');
  await cloudSync(ctx, { rpc, userId: 'u1' });
  assert.equal(calls.filter((c) => c === 'starter_lists').length, 1, 'once per account');
});
