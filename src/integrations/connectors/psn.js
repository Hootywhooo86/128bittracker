// PlayStation — Sony has no public API. This uses the same private endpoints
// as the PlayStation App, signed in with your NPSSO cookie. It works today,
// but Sony can change or block it any time, and it may break their terms.
// Off until the user accepts that.
const AUTH = 'https://ca.account.sony.com/api/authz/v3/oauth';
const CLIENT_ID = '09515159-7237-4370-9b40-3806e67c0891';
const BASIC = 'Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=';
const REDIRECT = 'com.scee.psxandroid.scecompcall://redirect';

export const psn = {
  label: 'PlayStation',
  official: false,
  accepted: true,
  warning:
    "Sony has no public API. This signs in the way the PlayStation App does, using your NPSSO token. It may break without warning, and using it could go against PlayStation's terms. Your NPSSO is like a password: it stays on this device or your server.",
  help: 'Sign in at playstation.com, then open ca.account.sony.com/api/v1/ssocookie and copy the "npsso" value.',
  fields: [{ key: 'npsso', label: 'NPSSO token', secret: true, required: true }],

  async sync(config, { fetch, remember, state, upsert }) {
    const token = await accessToken(config, state, remember, fetch);
    const auth = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

    // Trophy progress (every game with trophies).
    const tr = await fetch('https://m.np.playstation.com/api/trophy/v1/users/me/trophyTitles?limit=800', { headers: auth });
    if (!tr.ok) throw new Error(`PlayStation trophies answered HTTP ${tr.status}`);
    const trophyTitles = (await tr.json()).trophyTitles ?? [];

    // Play time (PS4/PS5 games played recently enough to be listed).
    const pl = await fetch(
      'https://m.np.playstation.com/api/gamelist/v2/users/me/titles?categories=ps4_game,ps5_native_game&limit=200',
      { headers: auth },
    );
    const played = pl.ok ? (await pl.json()).titles ?? [] : [];

    // Trophy lists and the play list use different ids; join them by name.
    const games = new Map();
    for (const t of trophyTitles) {
      const total = sum(t.definedTrophies);
      const unlocked = sum(t.earnedTrophies);
      games.set(norm(t.trophyTitleName), {
        id: norm(t.trophyTitleName),
        title: t.trophyTitleName,
        platform: t.trophyTitlePlatform ?? 'PlayStation',
        cover_url: t.trophyTitleIconUrl ?? null,
        achievements: total > 0 ? { unlocked, total } : undefined,
        perfect: t.progress === 100 || undefined,
        last_played: t.lastUpdatedDateTime ?? undefined,
      });
    }
    for (const g of played) {
      const k = norm(g.name);
      const base = games.get(k) ?? { id: k, title: g.name, platform: g.category === 'ps5_native_game' ? 'PS5' : 'PS4' };
      games.set(k, {
        ...base,
        cover_url: g.imageUrl ?? base.cover_url ?? null,
        playtime_minutes: isoMinutes(g.playDuration),
        last_played: g.lastPlayedDateTime ?? base.last_played,
      });
    }
    for (const g of games.values()) upsert(g);
  },
};

async function accessToken(config, state, remember, fetch) {
  const t = state.tokens;
  if (t?.access && t.expires > Date.now() + 60_000) return t.access;
  if (t?.refresh && t.refresh_expires > Date.now() + 60_000) {
    const fresh = await tokenRequest(fetch, { refresh_token: t.refresh, grant_type: 'refresh_token', scope: 'psn:mobile.v2.core psn:clientapp' });
    if (fresh) return store(fresh, remember);
  }
  // NPSSO → one-time code (in the redirect's Location header) → tokens.
  const q = new URLSearchParams({ access_type: 'offline', client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: 'psn:mobile.v2.core psn:clientapp' });
  const res = await fetch(`${AUTH}/authorize?${q}`, { headers: { Cookie: `npsso=${config.npsso}` }, redirect: 'manual' });
  const loc = res.headers.get('location') ?? '';
  const code = new URLSearchParams(loc.split('?')[1] ?? '').get('code');
  if (!code) throw new Error('PlayStation didn\'t accept the NPSSO token. Get a fresh one (they expire after about 2 months).');
  const tokens = await tokenRequest(fetch, { code, redirect_uri: REDIRECT, grant_type: 'authorization_code' });
  if (!tokens) throw new Error('PlayStation sign-in failed');
  return store(tokens, remember);
}

async function tokenRequest(fetch, params) {
  const res = await fetch(`${AUTH}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: BASIC },
    body: new URLSearchParams({ ...params, token_format: 'jwt' }).toString(),
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.access_token ? j : null;
}

function store(j, remember) {
  const now = Date.now();
  const tokens = {
    access: j.access_token,
    refresh: j.refresh_token,
    expires: now + (j.expires_in ?? 3600) * 1000,
    refresh_expires: now + (j.refresh_token_expires_in ?? 0) * 1000,
  };
  remember({ tokens });
  return tokens.access;
}

const sum = (t) => (t ? (t.bronze ?? 0) + (t.silver ?? 0) + (t.gold ?? 0) + (t.platinum ?? 0) : 0);
const norm = (s) => String(s ?? '').toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** "PT12H34M5S" → 754 */
export function isoMinutes(d) {
  const m = String(d ?? '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
  if (!m) return undefined;
  const [, days = 0, h = 0, min = 0, s = 0] = m;
  return Number(days) * 1440 + Number(h) * 60 + Number(min) + Math.round(Number(s) / 60);
}
