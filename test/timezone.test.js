// Days follow the device's own time zone, never UTC (Sunday list item 11).
// Runs in a child process with TZ=America/Edmonton and the clock fixed at
// 7 PM and 11:30 PM local, when UTC already says tomorrow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function inEdmonton(nowIso, body) {
  const script = `
    const RealDate = Date;
    const fixed = RealDate.parse(${JSON.stringify(nowIso)});
    globalThis.Date = class extends RealDate {
      constructor(...a) { super(...(a.length ? a : [fixed])); }
      static now() { return fixed; }
    };
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(out));`;
  const res = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], {
    cwd: root, env: { ...process.env, TZ: 'America/Edmonton' }, encoding: 'utf8',
  });
  return JSON.parse(res);
}

const BODY = `
  const { toDay } = await import('./src/domain/dates.js');
  const { scrobbleEvent } = await import('./src/integrations/scrobble.js');
  const { openDb } = await import('./src/db/index.js');
  const { createEventBus } = await import('./src/domain/events.js');
  const { createItem } = await import('./src/domain/library.js');
  const { upcoming } = await import('./src/integrations/calendar.js');
  const db = openDb(':memory:');
  // AniList: an episode airing at 01:30 UTC on Oct 17 is the evening of Oct 16 in Edmonton.
  const airingAt = Math.floor(Date.parse('2026-10-17T01:30:00Z') / 1000);
  const fetch = async (url) => new Response(JSON.stringify(String(url).includes('anilist')
    ? { data: { byId: { media: [{ id: 1, airingSchedule: { nodes: [{ airingAt, episode: 5 }] } }] } } }
    : {}), { status: 200 });
  const ctx = { db, events: createEventBus(db), fetch };
  createItem(ctx, { type: 'anime', title: 'Frieren', status: 'active', meta: { anilist_id: 1 } });
  const cal = await upcoming(ctx, { refresh: true });
  return {
    today: toDay(),
    scrobble: scrobbleEvent('generic', { type: 'movie', title: 'Alien' }).id,
    anime: cal.find((e) => e.type === 'anime')?.date ?? null,
  };`;

test('7 PM in Edmonton is still today (UTC already says tomorrow)', () => {
  const r = inEdmonton('2026-10-16T01:00:00Z', BODY); // Oct 15, 7:00 PM MDT
  assert.equal(r.today, '2026-10-15');
  assert.match(r.scrobble, /:2026-10-15$/);
  assert.equal(r.anime, '2026-10-16', 'airs Oct 16 at 7:30 PM local');
});

test('11:30 PM in Edmonton is still today', () => {
  const r = inEdmonton('2026-10-16T05:30:00Z', BODY); // Oct 15, 11:30 PM MDT
  assert.equal(r.today, '2026-10-15');
  assert.match(r.scrobble, /:2026-10-15$/);
});
