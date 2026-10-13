// Last.fm: the albums you listen to most, with play counts. Free API key.
const API = 'https://ws.audioscrobbler.com/2.0/';
const ALBUMS = 200;

export const lastfm = {
  label: 'Last.fm',
  group: 'media',
  icon: '🎧',
  official: true,
  help: 'Your Last.fm username. Adds your top 200 albums with play counts. Without a 128bit account, also add a free API key from last.fm/api/account/create.',
  fields: [
    { key: 'api_key', label: 'Last.fm API key', secret: true, required: true, hub: true },
    { key: 'username', label: 'Last.fm username', required: true },
  ],

  async sync(config, { fetch, upsertMedia }) {
    const url = `${API}?${new URLSearchParams({ method: 'user.gettopalbums', user: config.username.trim(), api_key: config.api_key ?? '', period: 'overall', limit: String(ALBUMS), format: 'json' })}`;
    const res = await fetch(url);
    const body = await res.json().catch(() => null);
    if (body?.error === 10 || body?.error === 26) throw new Error('Last.fm rejected the API key');
    if (body?.error === 6) throw new Error(`no Last.fm user "${config.username}"`);
    if (!res.ok || body?.error) throw new Error(body?.message ?? `Last.fm answered HTTP ${res.status}`);
    for (const a of body.topalbums?.album ?? []) {
      const artist = a.artist?.name ?? '';
      const cover = (a.image ?? []).find((i) => i.size === 'extralarge')?.['#text'] || null;
      upsertMedia({
        id: `album:${a.mbid || `${artist}|${a.name}`.toLowerCase()}`,
        type: 'music',
        title: a.name,
        creator: artist,
        cover_url: cover,
        status: 'done',
        meta: { plays: Number(a.playcount) || 0, url: a.url },
      });
    }
  },
};
