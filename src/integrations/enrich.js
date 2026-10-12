// Fill in what an episode.watched event leaves out, before it's applied:
//   season / number   parsed from "S2 E3 · Name"
//   season_episodes   from TVmaze, so the last episode finishes the season
//                     (→ golden TV, or golden idol for anime)
//   anime             TVmaze says Japanese animation / genre Anime, or AniList knows it
// Shared by the family feed pull and the Plex/Jellyfin/Emby scrobbler. Never
// throws: offline just means the event goes in without the extras.
const CACHE = 'media.shows';
const TTL = 7 * 86400_000;

const read = (ctx) => {
  const v = ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(CACHE)?.value;
  return v ? JSON.parse(v) : {};
};
const write = (ctx, v) =>
  ctx.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CACHE, JSON.stringify(v));

export async function enrichEpisode(ctx, ev) {
  if (ev.type !== 'episode.watched' || !ev.data?.show) return;
  const m = String(ev.data.episode ?? '').match(/S(\d+)\s*E(\d+)/i);
  const season = Number(ev.data.season ?? m?.[1]) || null;
  const number = Number(ev.data.number ?? m?.[2]) || null;
  ev.data = { ...ev.data, ...(season ? { season } : {}), ...(number ? { number } : {}) };

  const cache = read(ctx);
  const key = ev.data.show.toLowerCase().trim();
  let info = cache[key];
  if (!info || Date.now() - (info.at ?? 0) > TTL) {
    const fresh = await lookup(ctx.fetch ?? globalThis.fetch, ev.data.show);
    if (fresh === undefined) {
      if (!info) return; // offline: try again next time
    } else {
      info = cache[key] = { ...fresh, at: Date.now() };
      write(ctx, cache);
    }
  }
  if (info.anime && ev.data.anime == null) ev.data.anime = true;
  const total = season ? info.seasons?.[season] : null;
  if (total && !ev.data.season_episodes) ev.data.season_episodes = total;
}

/** { anime, seasons: {n: episodes} }; undefined when the lookup itself failed. */
async function lookup(fetch, show) {
  try {
    const res = await fetch(`https://api.tvmaze.com/singlesearch/shows?${new URLSearchParams({ q: show, embed: 'seasons' })}`);
    if (res.ok) {
      const s = await res.json();
      const anime = (s.genres ?? []).includes('Anime') || (s.type === 'Animation' && s.language === 'Japanese');
      return { anime, seasons: Object.fromEntries((s._embedded?.seasons ?? []).map((x) => [x.number, x.episodeOrder ?? null])) };
    }
    if (res.status !== 404) return undefined;
    // TVmaze doesn't know it: AniList might (lots of anime only live there).
    return { anime: await isAnime(fetch, show), seasons: {} };
  } catch {
    return undefined;
  }
}

async function isAnime(fetch, show) {
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: 'query($q:String){Media(search:$q,type:ANIME){title{english romaji}synonyms}}', variables: { q: show } }),
    });
    if (!res.ok) return false;
    const t = (await res.json()).data?.Media;
    if (!t) return false;
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    return [t.title?.english, t.title?.romaji, ...(t.synonyms ?? [])].some((x) => x && norm(x) === norm(show));
  } catch {
    return false;
  }
}
