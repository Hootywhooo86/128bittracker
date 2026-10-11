// Xbox — via OpenXBL (xbl.io), a third-party service that signs in with your
// Microsoft account; Microsoft has no public API for indie apps.
// Gives every title with achievement / gamerscore progress. Xbox doesn't
// expose reliable play time, so games come in without minutes.
export const xbox = {
  label: 'Xbox',
  official: false,
  help: 'Sign in at xbl.io with your Microsoft account and copy your API key. The free plan allows about 150 requests an hour; one sync uses one.',
  fields: [{ key: 'api_key', label: 'OpenXBL API key', secret: true, required: true }],

  async sync(config, { fetch, upsert }) {
    const res = await fetch('https://xbl.io/api/v2/achievements', {
      headers: { 'X-Authorization': config.api_key, Accept: 'application/json', 'Accept-Language': 'en-US' },
    });
    if (res.status === 401 || res.status === 403) throw new Error('OpenXBL rejected the API key');
    if (res.status === 429) throw new Error('OpenXBL rate limit reached, try again in an hour');
    if (!res.ok) throw new Error(`OpenXBL answered HTTP ${res.status}`);
    const body = await res.json();
    const titles = body.titles ?? body.content?.titles ?? [];
    if (!Array.isArray(titles)) throw new Error('unexpected answer from OpenXBL');

    for (const t of titles) {
      if (!t?.titleId || !t.name) continue;
      // Apps (Netflix, YouTube…) show up in title history too.
      if (t.type && !/game/i.test(t.type)) continue;
      const a = t.achievement ?? {};
      const total = Number(a.totalAchievements ?? 0);
      const unlocked = Number(a.currentAchievements ?? 0);
      const perfect =
        (total > 0 && unlocked >= total) ||
        Number(a.progressPercentage) === 100 ||
        (Number(a.totalGamerscore) > 0 && Number(a.currentGamerscore) >= Number(a.totalGamerscore));
      upsert({
        id: String(t.titleId),
        title: t.name,
        platform: (t.devices ?? []).join(', ') || 'Xbox',
        cover_url: t.displayImage ?? null,
        achievements: total > 0 ? { unlocked, total } : undefined,
        perfect: perfect || undefined,
        last_played: t.titleHistory?.lastTimePlayed ?? undefined,
      });
    }
  },
};
