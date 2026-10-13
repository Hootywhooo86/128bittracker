// Letterboxd: your diary through its public RSS feed. No key needed.
// The feed holds your ~50 latest entries, so each sync picks up new watches;
// import the CSV export (Library → Import) once for your full history.
import { rssItems, tag } from './rss.js';

export const letterboxd = {
  label: 'Letterboxd',
  group: 'media',
  icon: '🎞️',
  official: true,
  help: 'Your Letterboxd username. Picks up new diary entries from your public feed. For your full history, import your Letterboxd export once (Library → Import).',
  fields: [{ key: 'username', label: 'Letterboxd username', required: true }],

  async sync(config, { fetch, upsertMedia }) {
    const user = String(config.username).trim().replace(/^.*letterboxd\.com\//, '').replace(/\/.*$/, '');
    const res = await fetch(`https://letterboxd.com/${encodeURIComponent(user)}/rss/`, { headers: { 'User-Agent': '128bitTracker', Accept: 'application/rss+xml' } });
    if (res.status === 404) throw new Error(`no Letterboxd user "${user}"`);
    if (!res.ok) throw new Error(`Letterboxd answered HTTP ${res.status}`);
    for (const item of rssItems(await res.text())) {
      const title = tag(item, 'letterboxd:filmTitle');
      if (!title) continue; // lists and other posts
      const year = Number(tag(item, 'letterboxd:filmYear')) || null;
      const tmdb = tag(item, 'tmdb:movieId');
      const stars = Number(tag(item, 'letterboxd:memberRating'));
      const watched = tag(item, 'letterboxd:watchedDate');
      const img = (tag(item, 'description') ?? '').match(/<img[^>]+src="([^"]+)"/)?.[1] ?? null;
      upsertMedia({
        id: tmdb ? `movie:tmdb:${tmdb}` : `movie:${title.toLowerCase()}|${year ?? ''}`,
        type: 'movie',
        title,
        year,
        cover_url: img,
        status: 'done',
        rating: stars > 0 ? stars * 2 : null,
        finished_at: watched ? new Date(`${watched}T12:00:00Z`).toISOString() : null,
        meta: { tmdb_id: tmdb ? Number(tmdb) : null, url: tag(item, 'link') },
      });
    }
  },
};
