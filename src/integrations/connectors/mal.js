// MyAnimeList: your anime and manga lists through the official API v2.
// Needs a free Client ID (myanimelist.net/apiconfig) and a public list.
const API = 'https://api.myanimelist.net/v2';
const STATUS = {
  watching: 'active', reading: 'active', completed: 'done', on_hold: 'on_hold',
  dropped: 'dropped', plan_to_watch: 'planned', plan_to_read: 'planned',
};
const MAX_PAGES = 20;

export const mal = {
  label: 'MyAnimeList',
  group: 'media',
  icon: '📘',
  official: true,
  oauth: 'mal',
  help: 'Tap Connect and sign in to MyAnimeList: that\'s it, and Tracker keeps your list up to date both ways. Or enter a public username (plus a Client ID from myanimelist.net/apiconfig without a 128bit account).',
  fields: [
    { key: 'client_id', label: 'MAL Client ID', secret: true, required: true, hub: true },
    { key: 'username', label: 'MAL username', required: true, oauth: true },
  ],

  async sync(config, { fetch, upsertMedia }) {
    const user = config.username ? encodeURIComponent(String(config.username).trim().replace(/^.*myanimelist\.net\/profile\//, '')) : '@me';
    for (const kind of ['anime', 'manga']) {
      const fields = kind === 'anime'
        ? 'list_status,num_episodes,start_season,main_picture,studios,media_type'
        : 'list_status,num_chapters,start_date,main_picture,authors{first_name,last_name},media_type';
      let url = `${API}/users/${user}/${kind}list?${new URLSearchParams({ fields, limit: '1000', nsfw: 'true' })}`;
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const res = await fetch(url, { headers: { 'X-MAL-CLIENT-ID': config.client_id ?? '' } });
        if (res.status === 401 || res.status === 400) throw new Error('MyAnimeList rejected the Client ID');
        if (res.status === 403 || res.status === 404) throw new Error(`couldn't read ${decodeURIComponent(user)}'s ${kind} list: is it public?`);
        if (!res.ok) throw new Error(`MyAnimeList answered HTTP ${res.status}`);
        const body = await res.json();
        for (const { node: n, list_status: s } of body.data ?? []) {
          const anime = kind === 'anime';
          const a = n.authors?.[0]?.node;
          upsertMedia({
            id: `${kind}:${n.id}`,
            type: kind,
            title: n.title,
            creator: anime ? n.studios?.[0]?.name : a ? `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim() : null,
            year: anime ? n.start_season?.year : Number(String(n.start_date ?? '').slice(0, 4)) || null,
            cover_url: n.main_picture?.large ?? n.main_picture?.medium,
            status: STATUS[s?.status] ?? 'planned',
            progress: anime ? s?.num_episodes_watched : s?.num_chapters_read,
            progress_total: anime ? n.num_episodes : n.num_chapters,
            rating: s?.score || null,
            finished_at: s?.finish_date ? new Date(s.finish_date).toISOString() : null,
            meta: { mal_id: n.id, format: n.media_type },
          });
        }
        url = body.paging?.next ?? null;
      }
    }
  },
};
