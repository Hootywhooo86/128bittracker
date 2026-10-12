// Steam — official Steam Web API.
// Needs a Web API key (steamcommunity.com/dev/apikey) and a profile whose
// "Game details" are public. Pulls every owned game with play time, plus
// achievement progress for games you've played (100% → golden controller).
const API = 'https://api.steampowered.com';
const ACHIEVEMENT_CHECKS_PER_SYNC = 60; // the rest catch up on later syncs

export const steam = {
  label: 'Steam',
  official: true,
  help: 'Your Steam profile. Signed in to your 128bit account? That\'s all you need. Otherwise add a free Web API key from steamcommunity.com/dev/apikey. Your profile and its "Game details" must be public.',
  fields: [
    { key: 'api_key', label: 'Steam Web API key', secret: true, required: true, hub: true },
    { key: 'profile', label: 'Steam profile (URL, custom name or 17-digit ID)', required: true },
  ],

  async sync(config, { fetch, upsert, remember, state }) {
    const get = async (path, params) => {
      const url = `${API}${path}?${new URLSearchParams({ key: config.api_key ?? '', format: 'json', ...params })}`;
      const res = await fetch(url);
      if (res.status === 403 || res.status === 401) throw new Error('Steam rejected the API key');
      if (!res.ok) throw new Error(`Steam answered HTTP ${res.status}`);
      return res.json();
    };

    const steamid = await resolveId(config.profile, get, state, remember);
    const owned = await get('/IPlayerService/GetOwnedGames/v1/', {
      steamid,
      include_appinfo: '1',
      include_played_free_games: '1',
    });
    const games = owned.response?.games;
    if (!games) throw new Error('No games visible: set your Steam profile\'s "Game details" to Public');

    // Achievement lookups are one request per game: do the ones whose
    // play time changed since we last looked, most recently played first.
    const checked = state.achievements_checked ?? {};
    const toCheck = games
      .filter((g) => g.playtime_forever > 0 && checked[g.appid] !== g.playtime_forever)
      .sort((a, b) => (b.rtime_last_played ?? 0) - (a.rtime_last_played ?? 0))
      .slice(0, ACHIEVEMENT_CHECKS_PER_SYNC);
    const cached = state.achievements ?? {};
    for (const g of toCheck) {
      cached[g.appid] = await achievementsFor(g.appid, steamid, config.api_key ?? '', fetch);
      checked[g.appid] = g.playtime_forever;
    }
    remember({ achievements_checked: checked, achievements: cached });

    for (const g of games) {
      upsert({
        id: String(g.appid),
        title: g.name ?? `Steam app ${g.appid}`,
        platform: 'Steam',
        cover_url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/library_600x900.jpg`,
        playtime_minutes: g.playtime_forever ?? 0,
        achievements: cached[g.appid] ?? undefined,
        last_played: g.rtime_last_played ? new Date(g.rtime_last_played * 1000).toISOString() : undefined,
      });
    }
  },
};

async function resolveId(profile, get, state, remember) {
  const p = String(profile).trim();
  const id = p.match(/(?:profiles\/)?(\d{17})/);
  if (id) return id[1];
  const vanity = p.match(/id\/([^/?#]+)/)?.[1] ?? p;
  if (state.resolved?.vanity === vanity) return state.resolved.steamid;
  const res = await get('/ISteamUser/ResolveVanityURL/v1/', { vanityurl: vanity });
  if (res.response?.success !== 1) throw new Error(`couldn't find the Steam profile "${vanity}"`);
  remember({ resolved: { vanity, steamid: res.response.steamid } });
  return res.response.steamid;
}

/** {unlocked, total} or null for games without achievements. */
async function achievementsFor(appid, steamid, key, fetch) {
  const url = `${API}/ISteamUserStats/GetPlayerAchievements/v1/?${new URLSearchParams({ key, steamid, appid: String(appid) })}`;
  const res = await fetch(url);
  if (!res.ok) return null; // 400 "Requested app has no stats" is normal
  const body = await res.json().catch(() => null);
  const list = body?.playerstats?.achievements;
  if (!Array.isArray(list) || !list.length) return null;
  return { unlocked: list.filter((a) => a.achieved === 1).length, total: list.length };
}
