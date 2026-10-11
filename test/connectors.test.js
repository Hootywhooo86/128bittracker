import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { createEventBus } from '../src/domain/events.js';
import { listItems, findByExternal, getItem } from '../src/domain/library.js';
import { trophyCounts } from '../src/domain/trophies.js';
import { configureConnector, syncConnector, listConnectors } from '../src/integrations/connectors/index.js';
import { isoMinutes } from '../src/integrations/connectors/psn.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

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

test('steam: owned games, play time deltas, achievements → golden controller', async () => {
  let playtime = 600;
  const ctx = ctxWith([
    ['ResolveVanityURL', () => json({ response: { success: 1, steamid: '76561197960287930' } })],
    ['GetOwnedGames', () => json({ response: { game_count: 3, games: [
      { appid: 620, name: 'Portal 2', playtime_forever: playtime, rtime_last_played: 1790000000 },
      { appid: 400, name: 'Portal', playtime_forever: 120, rtime_last_played: 1780000000 },
      { appid: 999, name: 'Never Played', playtime_forever: 0 },
    ] } })],
    ['GetPlayerAchievements', (url) => {
      const appid = new URL(url).searchParams.get('appid');
      if (appid === '620') return json({ playerstats: { achievements: [{ achieved: 1 }, { achieved: 1 }] } });
      if (appid === '400') return json({ playerstats: { achievements: [{ achieved: 1 }, { achieved: 0 }] } });
      return json({ playerstats: { error: 'Requested app has no stats', success: false } }, 400);
    }],
  ]);

  await assert.rejects(() => syncConnector(ctx, 'steam'), /set Steam Web API key/);
  const view = configureConnector(ctx, 'steam', { api_key: 'SECRETKEY', profile: 'https://steamcommunity.com/id/gaben/' });
  assert.equal(view.configured, true);
  assert.equal(view.fields[0].value, undefined, 'secrets are never returned');
  assert.equal(view.fields[0].set, true);

  const first = await syncConnector(ctx, 'steam');
  assert.equal(first.games, 3);
  assert.equal(first.added, 3);
  assert.equal(first.new_trophies.length, 1);
  assert.equal(first.new_trophies[0].kind, 'controller');
  const p2 = findByExternal(ctx, 'steam', '620');
  assert.equal(p2.status, 'active');
  assert.equal(p2.meta.playtime_minutes, 600);
  assert.deepEqual(p2.meta.achievements, { unlocked: 2, total: 2 });
  assert.match(p2.cover_url, /620\/library_600x900/);
  assert.equal(findByExternal(ctx, 'steam', '999').status, 'planned');
  // Importing a library doesn't flood the timeline.
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'item.added'").get().n, 0);

  // Played 45 more minutes → a session, and the total moves.
  playtime = 645;
  const second = await syncConnector(ctx, 'steam');
  assert.equal(second.added, 0);
  assert.equal(second.minutes, 45);
  const after = getItem(ctx, p2.id);
  assert.equal(after.meta.playtime_minutes, 645);
  assert.equal(after.sessions[0].minutes, 45);
  assert.equal(trophyCounts(ctx).controller, 1);

  // The vanity name was resolved once and remembered.
  assert.equal(ctx.calls.filter((c) => c.url.includes('ResolveVanityURL')).length, 1);
  assert.ok(ctx.calls.every((c) => !c.url.includes('ResolveVanityURL') || c.url.includes('vanityurl=gaben')));
  assert.ok(listConnectors(ctx).find((c) => c.name === 'steam').last_sync_at);
});

test('steam: private profile and bad key give clear errors', async () => {
  const ctx = ctxWith([['GetOwnedGames', () => json({ response: {} })]]);
  configureConnector(ctx, 'steam', { api_key: 'k', profile: '76561197960287930' });
  await assert.rejects(() => syncConnector(ctx, 'steam'), /Game details.*Public/);
  const bad = ctxWith([['GetOwnedGames', () => json({}, 403)]]);
  configureConnector(bad, 'steam', { api_key: 'k', profile: '76561197960287930' });
  await assert.rejects(() => syncConnector(bad, 'steam'), /rejected the API key/);
  assert.match(listConnectors(bad).find((c) => c.name === 'steam').last_error, /rejected/);
});

test('xbox: achievements and gamerscore from OpenXBL, apps skipped', async () => {
  const ctx = ctxWith([['xbl.io/api/v2/achievements', (url, init) => {
    assert.equal(init.headers['X-Authorization'], 'XBLKEY');
    return json({ xuid: '1', titles: [
      { titleId: '1', name: 'Halo Infinite', type: 'Game', devices: ['XboxSeries'], displayImage: 'https://img/halo.png',
        achievement: { currentAchievements: 119, totalAchievements: 119, currentGamerscore: 1600, totalGamerscore: 1600, progressPercentage: 100 } },
      { titleId: '2', name: 'Forza', type: 'Game', achievement: { currentAchievements: 3, totalAchievements: 50, progressPercentage: 6 } },
      { titleId: '3', name: 'Halo 3 (360)', type: 'Game', achievement: { currentAchievements: 0, totalAchievements: 0, currentGamerscore: 1000, totalGamerscore: 1000 } },
      { titleId: '4', name: 'YouTube', type: 'App', achievement: {} },
    ] });
  }]]);
  configureConnector(ctx, 'xbox', { api_key: 'XBLKEY' });
  const r = await syncConnector(ctx, 'xbox');
  assert.equal(r.added, 3);
  assert.equal(r.new_trophies.length, 2);
  assert.equal(listItems(ctx, { type: 'game' }).length, 3);
  assert.equal(findByExternal(ctx, 'xbox', '4'), undefined);
});

test('psn: opt-in, NPSSO sign-in, trophies + play time joined by name', async () => {
  const ctx = ctxWith([
    ['/oauth/authorize', (url, init) => {
      assert.equal(init.headers.Cookie, 'npsso=NPSSO');
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'com.scee.psxandroid.scecompcall://redirect/?code=v3.ABC&cid=x' } });
    }],
    ['/oauth/token', (url, init) => {
      assert.match(init.body, /code=v3.ABC/);
      return json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, refresh_token_expires_in: 5184000 });
    }],
    ['trophyTitles', (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer AT');
      return json({ trophyTitles: [
        { trophyTitleName: "Marvel's Spider-Man 2", trophyTitlePlatform: 'PS5', progress: 100, trophyTitleIconUrl: 'https://img/spidey.png',
          definedTrophies: { bronze: 30, silver: 10, gold: 3, platinum: 1 }, earnedTrophies: { bronze: 30, silver: 10, gold: 3, platinum: 1 } },
        { trophyTitleName: 'Astro Bot', trophyTitlePlatform: 'PS5', progress: 40, definedTrophies: { bronze: 40, silver: 5, gold: 1, platinum: 1 }, earnedTrophies: { bronze: 18, silver: 1 } },
      ] });
    }],
    ['gamelist/v2', () => json({ titles: [
      { name: 'Marvel’s Spider-Man 2', category: 'ps5_native_game', playDuration: 'PT31H20M5S', imageUrl: 'https://img/spidey-cover.png' },
      { name: 'Astro Bot', category: 'ps5_native_game', playDuration: 'PT9H' },
    ] })],
  ]);
  configureConnector(ctx, 'psn', { npsso: 'NPSSO' });
  await assert.rejects(() => syncConnector(ctx, 'psn'), /accept the risk/);
  configureConnector(ctx, 'psn', { accept_risk: true });
  const r = await syncConnector(ctx, 'psn');
  assert.equal(r.added, 2);
  assert.equal(r.new_trophies.length, 1);
  const spidey = listItems(ctx, { q: 'Spider' })[0];
  assert.equal(spidey.meta.playtime_minutes, 1880);
  assert.deepEqual(spidey.meta.achievements, { unlocked: 44, total: 44 });
  // Tokens are cached: a second sync doesn't sign in again.
  await syncConnector(ctx, 'psn');
  assert.equal(ctx.calls.filter((c) => c.url.includes('/oauth/authorize')).length, 1);
});

test('psn: expired NPSSO says so', async () => {
  const ctx = ctxWith([['/oauth/authorize', () => new Response(null, { status: 302, headers: { location: 'com.scee.psxandroid.scecompcall://redirect/?error=login_required' } })]]);
  configureConnector(ctx, 'psn', { npsso: 'OLD', accept_risk: true });
  await assert.rejects(() => syncConnector(ctx, 'psn'), /fresh one/);
});

test('iso durations', () => {
  assert.equal(isoMinutes('PT12H34M5S'), 754);
  assert.equal(isoMinutes('PT45M'), 45);
  assert.equal(isoMinutes('P1DT2H'), 1560);
  assert.equal(isoMinutes(undefined), undefined);
});
