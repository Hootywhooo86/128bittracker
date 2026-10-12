// Trakt: everything you've watched, rated and want to watch.
// Needs a free Client ID (trakt.tv/oauth/applications → New application,
// redirect uri urn:ietf:wg:oauth:2.0:oob) and a public profile.
//
//   movies       watched → done (golden VHS), watchlist → planned
//   shows        one item per season, progress = episodes watched
//                (a finished season earns the golden TV)
//   anime shows  one item per season as anime (a finished season earns the golden idol)
const API = 'https://api.trakt.tv';
const SEASON_LOOKUPS_PER_SYNC = 40; // the rest catch up on later syncs

export const trakt = {
  label: 'Trakt',
  group: 'media',
  icon: '🍿',
  official: true,
  oauth: 'trakt',
  help: 'Tap Connect and sign in to Trakt: your history, ratings and watchlist come in (private profiles too), and what you watch goes back. Or enter a public username (plus a Client ID from trakt.tv/oauth/applications without a 128bit account).',
  fields: [
    { key: 'client_id', label: 'Trakt Client ID', secret: true, required: true, hub: true },
    { key: 'username', label: 'Trakt username', required: true, oauth: true },
  ],

  async sync(config, { fetch, upsertMedia, remember, state }) {
    const user = config.username ? encodeURIComponent(String(config.username).trim().replace(/^.*trakt\.tv\/users\//, '').replace(/\/.*$/, '')) : 'me';
    const get = async (path) => {
      const res = await fetch(`${API}${path}`, {
        headers: { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': config.client_id ?? '' },
      });
      if (res.status === 401 || res.status === 403) throw new Error('Trakt rejected the Client ID, or the profile is private');
      if (res.status === 404) throw new Error(`no Trakt user "${decodeURIComponent(user)}"`);
      if (!res.ok) throw new Error(`Trakt answered HTTP ${res.status}`);
      return res.json();
    };

    const ratings = new Map();
    for (const r of await get(`/users/${user}/ratings`)) {
      const o = r[r.type];
      const id = o?.ids?.trakt;
      if (!id) continue;
      ratings.set(r.type === 'season' ? `season:${r.show?.ids?.trakt}:${o.number}` : `${r.type}:${id}`, r.rating);
    }

    for (const w of await get(`/users/${user}/watched/movies?extended=full,images`)) {
      const m = w.movie;
      upsertMedia({
        id: `movie:${m.ids.trakt}`,
        type: 'movie',
        title: m.title,
        year: m.year,
        cover_url: poster(m),
        status: 'done',
        rating: ratings.get(`movie:${m.ids.trakt}`),
        finished_at: w.last_watched_at,
        meta: { trakt_id: m.ids.trakt, tmdb_id: m.ids.tmdb ?? null, plays: w.plays },
      });
    }

    // Episode counts per season, cached: they only grow while a show airs.
    const seasons = state.seasons ?? {};
    let lookups = 0;
    const watched = await get(`/users/${user}/watched/shows?extended=full,images`);
    watched.sort((a, b) => Date.parse(b.last_watched_at ?? 0) - Date.parse(a.last_watched_at ?? 0));
    for (const w of watched) {
      const s = w.show;
      const id = s.ids.trakt;
      const anime = (s.genres ?? []).includes('anime');
      const cached = seasons[id];
      const stale = !cached || (s.status !== 'ended' && s.status !== 'canceled' && cached.aired !== s.aired_episodes);
      if (stale && lookups < SEASON_LOOKUPS_PER_SYNC) {
        lookups++;
        const list = await get(`/shows/${id}/seasons?extended=full`);
        seasons[id] = { aired: s.aired_episodes, counts: Object.fromEntries(list.filter((x) => x.number > 0).map((x) => [x.number, x.aired_episodes || x.episode_count || null])) };
      }
      const counts = seasons[id]?.counts ?? {};
      for (const season of w.seasons ?? []) {
        if (!season.number) continue; // specials
        const seen = (season.episodes ?? []).filter((e) => e.plays > 0).length;
        const total = counts[season.number] ?? null;
        const done = total ? seen >= total : false;
        upsertMedia({
          id: `show:${id}:s${season.number}`,
          type: anime ? 'anime' : 'show',
          title: s.title,
          year: s.year,
          cover_url: poster(s),
          status: done ? 'done' : 'active',
          progress: seen,
          progress_total: total,
          rating: ratings.get(`season:${id}:${season.number}`) ?? ratings.get(`show:${id}`),
          finished_at: done ? latest(season.episodes) : null,
          meta: { season: season.number, trakt_id: id, tmdb_id: s.ids.tmdb ?? null },
        });
      }
    }
    remember({ seasons });

    for (const w of await get(`/users/${user}/watchlist?extended=full,images`)) {
      const o = w[w.type];
      if (!o?.ids?.trakt || (w.type !== 'movie' && w.type !== 'show')) continue;
      upsertMedia({
        id: w.type === 'movie' ? `movie:${o.ids.trakt}` : `show:${o.ids.trakt}:watchlist`,
        type: w.type === 'show' && (o.genres ?? []).includes('anime') ? 'anime' : w.type,
        title: o.title,
        year: o.year,
        cover_url: poster(o),
        meta: { trakt_id: o.ids.trakt },
      });
    }
  },
};

/** Trakt image paths come without a scheme. */
function poster(o) {
  const p = o.images?.poster?.[0];
  return p ? (p.startsWith('http') ? p : `https://${p}`) : null;
}

function latest(episodes = []) {
  const t = Math.max(...episodes.map((e) => Date.parse(e.last_watched_at ?? '') || 0));
  return t > 0 ? new Date(t).toISOString() : null;
}
