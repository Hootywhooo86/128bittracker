// AniList: your anime and manga lists. Public lists need only your username.
// Finished anime earns the golden idol.
const API = 'https://graphql.anilist.co';

const QUERY = `query ($user: String, $type: MediaType) {
  MediaListCollection(userName: $user, type: $type) {
    lists { entries {
      status progress progressVolumes score(format: POINT_10)
      completedAt { year month day }
      media { id format episodes chapters seasonYear startDate { year } siteUrl
        title { english romaji } coverImage { large }
        studios(isMain: true) { nodes { name } } staff(perPage: 1) { nodes { name { full } } } }
    } }
  }
}`;

const STATUS = { CURRENT: 'active', REPEATING: 'active', PLANNING: 'planned', COMPLETED: 'done', DROPPED: 'dropped', PAUSED: 'on_hold' };

export const anilist = {
  label: 'AniList',
  group: 'media',
  icon: '🌸',
  official: true,
  help: 'Your AniList username. Your anime and manga lists must be public (they are by default). No key needed.',
  fields: [{ key: 'username', label: 'AniList username', required: true }],

  async sync(config, { fetch, upsertMedia }) {
    const user = String(config.username).trim().replace(/^.*anilist\.co\/user\//, '').replace(/\/.*$/, '');
    for (const type of ['ANIME', 'MANGA']) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { user, type } }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.errors) {
        const msg = body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
        if (/not found|private/i.test(msg)) throw new Error(`couldn't read ${user}'s list: check the username and that the list is public`);
        throw new Error(msg);
      }
      for (const list of body.data?.MediaListCollection?.lists ?? []) {
        for (const e of list.entries ?? []) {
          const m = e.media;
          const anime = type === 'ANIME';
          const c = e.completedAt;
          upsertMedia({
            id: `${anime ? 'anime' : 'manga'}:${m.id}`,
            type: anime ? 'anime' : 'manga',
            title: m.title.english ?? m.title.romaji,
            creator: anime ? m.studios?.nodes?.[0]?.name : m.staff?.nodes?.[0]?.name?.full,
            year: m.seasonYear ?? m.startDate?.year,
            cover_url: m.coverImage?.large,
            status: STATUS[e.status] ?? 'planned',
            progress: e.progress ?? 0,
            progress_total: anime ? m.episodes : m.chapters,
            rating: e.score || null,
            finished_at: c?.year ? new Date(Date.UTC(c.year, (c.month ?? 1) - 1, c.day ?? 1)).toISOString() : null,
            meta: { anilist_id: m.id, format: m.format, url: m.siteUrl },
          });
        }
      }
    }
  },
};
