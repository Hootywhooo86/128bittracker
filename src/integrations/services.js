// API keys for metadata services (TMDB, IGDB). Stored in kv as `svc.<name>`;
// values are never sent back to clients, only whether they're set.
import { HttpError } from '../api/errors.js';

export const SERVICES = {
  tmdb: {
    label: 'TMDB (movies & TV)',
    help: 'Free at themoviedb.org → Settings → API. Paste the "API Read Access Token" (long) or the v3 API key. Adds movie/TV search, season episode counts and upcoming episodes.',
    fields: [{ key: 'token', label: 'API read access token or v3 key', secret: true, required: true }],
  },
  igdb: {
    label: 'IGDB (games)',
    help: 'Free via a Twitch developer app at dev.twitch.tv/console → Register Your Application. Adds game search with covers and upcoming release dates.',
    fields: [
      { key: 'client_id', label: 'Twitch Client ID', required: true },
      { key: 'client_secret', label: 'Twitch Client Secret', secret: true, required: true },
    ],
  },
};

const k = (name) => `svc.${name}`;

export function serviceConfig(ctx, name) {
  const row = ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(k(name));
  return row?.value ? JSON.parse(row.value) : {};
}

function store(ctx, name, value) {
  ctx.db
    .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(k(name), JSON.stringify(value));
}

export function listServices(ctx) {
  return Object.entries(SERVICES).map(([name, s]) => {
    const c = serviceConfig(ctx, name);
    return {
      name,
      label: s.label,
      help: s.help,
      fields: s.fields.map((f) => ({ ...f, value: f.secret ? undefined : c[f.key] ?? '', set: !!c[f.key] })),
      configured: s.fields.filter((f) => f.required).every((f) => c[f.key]),
    };
  });
}

export function configureService(ctx, name, input = {}) {
  const s = SERVICES[name];
  if (!s) throw new HttpError(404, `unknown service "${name}"`);
  const c = serviceConfig(ctx, name);
  for (const f of s.fields) {
    if (input[f.key] === undefined) continue;
    const v = String(input[f.key] ?? '').trim();
    if (f.secret && v === '' && input[f.key] !== null) continue;
    c[f.key] = v || null;
  }
  delete c.token_cache;
  store(ctx, name, c);
  return listServices(ctx).find((x) => x.name === name);
}

export function rememberService(ctx, name, patch) {
  store(ctx, name, { ...serviceConfig(ctx, name), ...patch });
}
