import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { createEventBus } from '../src/domain/events.js';
import { createItem } from '../src/domain/library.js';
import { seriesFromTitle } from '../src/domain/series.js';
import { seriesHistory } from '../src/integrations/series.js';

test('series read from book titles', () => {
  assert.deepEqual(seriesFromTitle('Azarinth Healer, Book 7'), { series: 'Azarinth Healer', position: 7 });
  assert.deepEqual(seriesFromTitle('Azarinth Healer Book Seven'), { series: 'Azarinth Healer', position: 7 });
  assert.deepEqual(seriesFromTitle('The Delves: Book 5 of Ajax\'s Ascension'), { series: "Ajax's Ascension", position: 5 });
  assert.deepEqual(seriesFromTitle("Ajax's Ascension: The Duchy"), { series: "Ajax's Ascension", position: null });
  assert.equal(seriesFromTitle('Vengeance'), null);
});

test('stats history: audiobooks by series (Audible), in order, with what is next', async () => {
  const fetch = async (url) => {
    const u = new URL(String(url));
    const q = u.searchParams.get('keywords') ?? '';
    const series = /vengeance|masquerade/i.test(q) ? { title: 'Book of the Dead', sequence: /vengeance/i.test(q) ? '2' : '1' } : null;
    return new Response(JSON.stringify({ products: [{ asin: 'A' + q.length, title: q.split(' RinoZ')[0], authors: [{ name: 'RinoZ' }], series: series ? [series] : [] }] }), { status: 200 });
  };
  const db = openDb(':memory:');
  const c = { db, events: createEventBus(db), fetch };
  const a = { type: 'book', creator: 'RinoZ', meta: { format: 'audiobook' } };
  createItem(c, { ...a, title: 'Vengeance', status: 'active', meta: { format: 'audiobook', pct: 1 } });
  createItem(c, { ...a, title: 'Masquerade', status: 'done' });
  createItem(c, { ...a, title: 'Azarinth Healer, Book 2', creator: 'Rhaegar', status: 'done' });
  createItem(c, { ...a, title: 'Azarinth Healer, Book 1', creator: 'Rhaegar', status: 'done' });
  createItem(c, { ...a, title: 'Azarinth Healer, Book 3', creator: 'Rhaegar', status: 'planned' });
  createItem(c, { ...a, title: 'Lonely Book', creator: 'X', status: 'done' });
  createItem(c, { type: 'book', title: 'Paper book', status: 'done' }); // a book, not an audiobook
  const h = await seriesHistory(c, 'audiobook');
  const by = Object.fromEntries(h.groups.map((g) => [g.name, g]));
  assert.deepEqual(by['Book of the Dead'].items.map((i) => i.title), ['Masquerade', 'Vengeance']);
  assert.deepEqual(by['Azarinth Healer'].items.map((i) => i.position), [1, 2]);
  assert.equal(by['Azarinth Healer'].next.title, 'Azarinth Healer, Book 3');
  assert.deepEqual(h.singles.map((i) => i.title), ['Lonely Book']);
});

test('stats history: shows with their seasons', async () => {
  const db = openDb(':memory:');
  const c = { db, events: createEventBus(db) };
  createItem(c, { type: 'show', title: 'Dexter: Resurrection', status: 'active', meta: { season: 2, seasons: { 1: { p: 10, n: 10, done: '2026-10-16' }, 2: { p: 1, n: 3 } } } });
  createItem(c, { type: 'show', title: 'Not started', status: 'planned' });
  const h = await seriesHistory(c, 'show');
  assert.equal(h.groups.length, 1);
  assert.deepEqual(h.groups[0].items.map((s) => [s.title, s.status, s.pct]), [['Season 1', 'done', 100], ['Season 2', 'active', 33]]);
});
