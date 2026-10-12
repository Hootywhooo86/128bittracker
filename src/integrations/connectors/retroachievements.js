// RetroAchievements: achievements in classic games (NES to PS2).
// Mastering a game (every achievement, hardcore) earns the golden controller.
const API = 'https://retroachievements.org/API';
const PAGE = 500;

export const retroachievements = {
  label: 'RetroAchievements',
  icon: '👾',
  official: true,
  help: 'Your username and Web API key from retroachievements.org/settings (Keys section). Pulls every game you have achievements in; mastered games earn the golden controller.',
  fields: [
    { key: 'username', label: 'RetroAchievements username', required: true },
    { key: 'api_key', label: 'Web API key', secret: true, required: true },
  ],

  async sync(config, { fetch, upsert }) {
    for (let offset = 0; offset < 20 * PAGE; offset += PAGE) {
      const url = `${API}/API_GetUserCompletionProgress.php?${new URLSearchParams({ u: config.username.trim(), y: config.api_key, c: String(PAGE), o: String(offset) })}`;
      const res = await fetch(url);
      if (res.status === 401 || res.status === 403) throw new Error('RetroAchievements rejected the username / API key');
      if (!res.ok) throw new Error(`RetroAchievements answered HTTP ${res.status}`);
      const body = await res.json();
      const results = body.Results ?? [];
      for (const g of results) {
        const award = String(g.HighestAwardKind ?? '');
        const mastered = award === 'mastered' || award === 'completed';
        upsert({
          id: String(g.GameID),
          title: g.Title,
          platform: g.ConsoleName ?? 'Retro',
          cover_url: g.ImageIcon ? `https://media.retroachievements.org${g.ImageIcon}` : undefined,
          achievements: g.MaxPossible ? { unlocked: Math.max(g.NumAwarded ?? 0, g.NumAwardedHardcore ?? 0), total: g.MaxPossible } : undefined,
          perfect: mastered || undefined,
          status: mastered || award.startsWith('beaten') ? 'done' : 'active',
          last_played: g.MostRecentAwardedDate ? new Date(g.MostRecentAwardedDate).toISOString() : undefined,
        });
      }
      if (results.length < PAGE || offset + PAGE >= (body.Total ?? 0)) break;
    }
  },
};
