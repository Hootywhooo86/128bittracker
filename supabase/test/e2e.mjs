// End to end on a real Postgres with family.sql + tracker.sql: two devices on one
// account stay in step, 128bitPlay's watches land in the library, a second
// account gets its own library, and one Tracker never mixes two accounts.
//   PGHOST=… PGPORT=… node supabase/test/e2e.mjs   (supabase/test/run.sh does this)
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.js';
import { createEventBus } from '../../src/domain/events.js';
import { createItem, createCollection, setCollectionMembership, listItems, listCollections, deleteItem, updateItem, findByExternal } from '../../src/domain/library.js';
import { familySignIn, familySync, FAMILY, familyRpc } from '../../src/integrations/family-account.js';
import { trophyCounts } from '../../src/domain/trophies.js';

const USERS = { 'a@x.com': 'aaaaaaaa-0000-0000-0000-000000000001', 'b@x.com': 'bbbbbbbb-0000-0000-0000-000000000002' };
const sql = (uid, query) => execFileSync('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c',
  `select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated; ${query}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const lit = (v) => (v == null ? 'NULL' : typeof v === 'object' ? `'${JSON.stringify(v).replace(/'/g, "''")}'` : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v));

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function fetch(url, init = {}) {
  const u = String(url);
  if (!u.startsWith(FAMILY.url)) return json({}, 404); // TVmaze etc: offline here
  if (u.includes('/auth/v1/token')) {
    const b = JSON.parse(init.body);
    const id = USERS[b.email] ?? Object.values(USERS).find((x) => b.refresh_token === `r-${x}`);
    if (!id) return json({ error_description: 'Invalid login credentials' }, 400);
    return json({ access_token: `t-${id}`, refresh_token: `r-${id}`, expires_in: 3600, user: { id, email: b.email } });
  }
  const fn = u.match(/rest\/v1\/rpc\/(\w+)/)?.[1];
  const uid = init.headers.Authorization.slice('Bearer t-'.length);
  const args = JSON.parse(init.body || '{}');
  try {
    const out = sql(uid, `select public.${fn}(${Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ')});`).split('\n').filter(Boolean).pop();
    return new Response(out ?? 'null', { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return json({ message: String(err.stderr).replace(/^.*ERROR:\s*/s, '').split('\n')[0] }, 400);
  }
}
const device = () => { const db = openDb(':memory:'); return { db, events: createEventBus(db), fetch }; };

// Phone 1: A builds a library and a list for 128bitPlay.
const p1 = device();
await familySignIn(p1, { email: 'a@x.com', password: 'pw' });
const sev = createItem(p1, { type: 'show', title: 'Severance', status: 'active', progress: 2, progress_total: 9, meta: { season: 1, imdb_id: 'tt11280740' } });
const alien = createItem(p1, { type: 'movie', title: 'Alien', status: 'planned', meta: { imdb_id: 'tt0078748', tmdb_id: 348 } });
const list = createCollection(p1, { name: 'Sci-fi night', kind: 'movie', show_in_play: true });
setCollectionMembership(p1, list.id, alien.id, true);
let r = await familySync(p1);
assert.equal(r.error, undefined, r.error);
assert.ok(r.cloud.pushed >= 3, 'pushed to the cloud');

// What 128bitPlay sees for A.
const asA = (q) => JSON.parse(sql(USERS['a@x.com'], `select ${q};`).trim().split('\n').pop());
const lists = asA('public.get_lists(\'movie\', true)');
assert.equal(lists.length, 1);
const items = asA(`public.get_list_items('${lists[0].id}')`);
assert.equal(items[0].ids.imdb, 'tt0078748', 'Play gets the IMDb id it opens titles by');
assert.equal(asA('public.get_up_next()')[0].next.number, 3);

// Phone 2, same account: gets everything.
const p2 = device();
await familySignIn(p2, { email: 'a@x.com', password: 'pw' });
r = await familySync(p2);
assert.equal(r.error, undefined, r.error);
assert.equal(listItems(p2, {}).length, 2);
assert.equal(listCollections(p2)[0].name, 'Sci-fi night');
assert.equal(listCollections(p2)[0].item_count, 1);

// A watches in 128bitPlay: the cloud applies it, both phones pick it up.
await familyRpc(p1, 'log_events', { events: [{ id: 'play-1', app: 'play', type: 'episode.watched', at: Date.now(),
  data: { show: 'Severance', episode: 'S1 E3', imdb: 'tt11280740', season_episodes: 9 } }] });
await familyRpc(p1, 'log_events', { events: [{ id: 'play-2', app: 'play', type: 'movie.watched', at: Date.now(), data: { title: 'Alien', imdb: 'tt0078748' } }] });
await familySync(p1);
await familySync(p2);
for (const p of [p1, p2]) {
  const s = listItems(p, { type: 'show' });
  assert.equal(s.length, 1, 'no duplicate from the feed');
  assert.equal(s[0].progress, 3);
  assert.equal(listItems(p, { type: 'movie' })[0].status, 'done');
}
assert.equal(trophyCounts(p2).vhs, 1, 'trophy earned from Play');
await familySync(p1); await familySync(p2);
assert.equal(asA('jsonb_array_length(public.tracker_pull(null) -> \'trophies\')'), 1, 'one trophy, not one per phone');

// Edits on phone 2 reach phone 1; deletes too.
const sev2 = listItems(p2, { type: 'show' })[0];
updateItem(p2, sev2.id, { rating: 9 });
const extra = createItem(p2, { type: 'book', title: 'Dune' });
await familySync(p2);
await familySync(p1);
assert.equal(listItems(p1, { type: 'show' })[0].rating, 9);
assert.equal(listItems(p1, { type: 'book' }).length, 1);
deleteItem(p2, extra.id);
await familySync(p2);
await familySync(p1);
assert.equal(listItems(p1, { type: 'book' }).length, 0, 'delete synced');

// Play adds to A's list; it shows up on the phones.
asA(`public.add_to_list('${lists[0].id}', '{"type":"movie","title":"Dune: Part Two","ids":{"imdb":"tt15239678"}}')`);
await familySync(p1);
assert.equal(listCollections(p1)[0].item_count, 2);

// B: own account, own (empty) library.
const p3 = device();
await familySignIn(p3, { email: 'b@x.com', password: 'pw' });
r = await familySync(p3);
assert.equal(r.error, undefined, r.error);
assert.equal(listItems(p3, {}).length, 0, 'B sees none of A');
assert.deepEqual(listCollections(p3).map((l) => l.item_count), [0, 0, 0, 0, 0], 'B gets its own five empty starter lists');

// B on A's phone: refused, with the sign-in to open B's own library instead.
await assert.rejects(() => familySignIn(p1, { email: 'b@x.com', password: 'pw' }), (err) => err.status === 409 && err.extra.code === 'other_account' && err.extra.account.user_id === USERS['b@x.com']);
assert.equal(listItems(p1, {}).length, 3, 'A\'s phone untouched');
console.log('cloud e2e: all checks passed');
