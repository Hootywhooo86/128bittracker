import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { createEventBus } from '../src/domain/events.js';
import { createItem, listItems } from '../src/domain/library.js';
import { overview, yearInPixels } from '../src/domain/stats.js';
import { ingest } from '../src/integrations/index.js';
import { toDay } from '../src/domain/dates.js';

function ctx() {
  const db = openDb(':memory:');
  return { db, events: createEventBus(db) };
}

test("stats: Play's sittings count as time, and colour the day by what you did most", () => {
  const c = ctx();
  createItem(c, { type: 'book', title: 'Vengeance', meta: { format: 'audiobook' } });
  createItem(c, { type: 'book', title: 'Dune' });
  const now = new Date();
  const at = (min) => new Date(now.getTime() - min * 60000).toISOString();
  ingest(c, { id: 'l1', type: 'listen.session', source: '128bitplay', occurred_at: at(1), data: { title: 'Vengeance', minutes: 50 } }, { applyMedia: false });
  ingest(c, { id: 'w1', type: 'watch.session', source: '128bitplay', occurred_at: at(2), data: { show: 'Shangri-La Frontier', anime: true, minutes: 20, finished: true } }, { applyMedia: false });
  ingest(c, { id: 'w2', type: 'watch.session', source: '128bitplay', occurred_at: at(3), data: { kind: 'movie', title: 'Spider-Man', minutes: 30 } }, { applyMedia: false });

  const s = overview(c);
  assert.equal(s.library.audiobook.total, 1, 'audiobooks apart from books');
  assert.equal(s.library.book.total, 1);
  assert.equal(s.library.audiobook.minutes, 50);
  assert.equal(s.library.anime.minutes, 20);
  assert.equal(s.library.movie.minutes, 30);

  const day = yearInPixels(c).days.find((d) => d.day === toDay(at(1)));
  assert.equal(day.top, 'audiobook');
  assert.equal(day.minutes, 100);
  assert.deepEqual(day.kinds.anime, { n: 1, minutes: 20 });

  assert.deepEqual(listItems(c, { type: 'audiobook' }).map((i) => i.title), ['Vengeance']);
  assert.deepEqual(listItems(c, { type: 'book' }).map((i) => i.title), ['Dune']);
});

test('migration 6: books from Hardcover are audiobooks', () => {
  const db = openDb(':memory:');
  db.exec('PRAGMA user_version = 5');
  const now = new Date().toISOString();
  db.prepare("INSERT INTO items (type, title, source, meta, created_at, updated_at) VALUES ('book', 'The Divine Witness', 'hardcover', '{}', ?, ?), ('book', 'Dune', 'manual', '{}', ?, ?)").run(now, now, now, now);
  db.exec('PRAGMA user_version = 5');
  return import('../src/db/schema.js').then(({ migrate: m }) => {
    m(db);
    const rows = db.prepare("SELECT title, json_extract(meta, '$.format') AS f FROM items ORDER BY title").all();
    assert.deepEqual(rows.map((r) => [r.title, r.f]), [['Dune', null], ['The Divine Witness', 'audiobook']]);
  });
});
