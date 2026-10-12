// The 128bit family account: one sign-in for Play, Fit, Gold, Tracker…
//
// It's the shared Supabase project that 128bitPlay (Settings → Account) and
// 128bitfit (Settings → 128bit family) already use. Every app posts to the
// account's family feed (supabase/family.sql): Tracker pulls what the others
// post into the Library/habits, and posts its own wins (habits, streaks,
// trophies, finished things) back for everyone else.
//
// Works the same on the server and the phone; only `ctx.fetch` differs.
import { HttpError } from '../api/errors.js';
import { ingest } from './index.js';
import { enrichEpisode } from './enrich.js';
import { tx } from '../db/tx.js';

// The family project. Its publishable key is meant to be public; the tables
// are only reachable through the family functions, per signed-in user.
export const FAMILY = { url: 'https://wvflpwtaszpstmjpkrhu.supabase.co', key: 'sb_publishable_dO8uP74cTV1tbuqESgxysw_323C7lWh' };

// What Tracker shares to the feed. Per-tap logs and bookkeeping stay local.
const SHARED_TYPES = new Set(['habit.completed', 'streak.milestone', 'streak.frozen', 'trophy.earned', 'item.completed', 'item.started', 'item.rated']);
const PAGE = 200;
const FIRST_PULL_MAX = 2000;
const REPLACE_WINDOW_MS = 3 * 86400_000; // events can be replaced (a day's steps); re-read the last few days

const get = (ctx, k) => {
  const v = ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value;
  return v ? JSON.parse(v) : null;
};
const put = (ctx, k, v) =>
  ctx.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v == null ? null : JSON.stringify(v));

const account = (ctx) => get(ctx, 'family.account');
const state = (ctx) => get(ctx, 'family.state') ?? {};
const setState = (ctx, patch) => put(ctx, 'family.state', { ...state(ctx), ...patch });
const maxOwnSeq = (ctx) => ctx.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM events WHERE source = '128bittracker'").get().m;

export function familyStatus(ctx) {
  const a = account(ctx);
  const s = state(ctx);
  return {
    signed_in: !!a?.refresh,
    email: a?.email ?? null,
    project: a?.url && a.url !== FAMILY.url ? a.url : null,
    last_sync_at: s.last_sync_at ?? null,
    last_error: s.last_error ?? null,
    pulled_total: s.pulled_total ?? 0,
    pushed_total: s.pushed_total ?? 0,
  };
}

async function auth(ctx, a, path, body) {
  const res = await (ctx.fetch ?? globalThis.fetch)(`${a.url}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: a.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status >= 500 ? 502 : 400, j.error_description || j.msg || j.message || `account service answered ${res.status}`);
  return j;
}

function saveSession(ctx, a, j) {
  put(ctx, 'family.account', {
    url: a.url,
    key: a.key,
    access: j.access_token,
    refresh: j.refresh_token,
    expires: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
    email: j.user?.email ?? a.email ?? null,
    user_id: j.user?.id ?? a.user_id ?? null,
  });
}

function project(input) {
  const url = String(input?.url ?? '').trim().replace(/\/+$/, '');
  const key = String(input?.key ?? '').trim();
  if (!url && !key) return { ...FAMILY };
  if (!/^https:\/\/[^/\s]+$/.test(url)) throw new HttpError(400, 'the project URL looks like https://abcd1234.supabase.co');
  if (key.length < 20) throw new HttpError(400, 'paste the anon / publishable key from Supabase → Settings → API');
  return { url, key };
}

/** Starting point for a fresh link: share only what happens from now on. */
function startCursors(ctx) {
  put(ctx, 'family.state', { pushed_seq: maxOwnSeq(ctx), skip: [], pulled_until: null, pulled_total: 0, pushed_total: 0 });
}

export async function familySignIn(ctx, { email, password, ...proj } = {}) {
  if (!email || !password) throw new HttpError(400, 'email and password are required');
  const a = project(proj);
  const j = await auth(ctx, a, 'token?grant_type=password', { email: String(email).trim(), password: String(password) });
  saveSession(ctx, { ...a, email }, j);
  startCursors(ctx);
  return familyStatus(ctx);
}

export async function familySignUp(ctx, { email, password, ...proj } = {}) {
  if (!email || String(password ?? '').length < 6) throw new HttpError(400, 'pick a password of at least 6 characters');
  const a = project(proj);
  const j = await auth(ctx, a, 'signup', { email: String(email).trim(), password: String(password) });
  if (!j.access_token) return { ...familyStatus(ctx), confirm_email: true };
  saveSession(ctx, { ...a, email }, j);
  startCursors(ctx);
  return familyStatus(ctx);
}

export async function familySignOut(ctx) {
  const a = account(ctx);
  if (a?.access) {
    (ctx.fetch ?? globalThis.fetch)(`${a.url}/auth/v1/logout`, { method: 'POST', headers: { apikey: a.key, Authorization: `Bearer ${a.access}` } }).catch(() => {});
  }
  put(ctx, 'family.account', null);
  put(ctx, 'family.state', null);
  return familyStatus(ctx);
}

async function token(ctx) {
  const a = account(ctx);
  if (!a?.refresh) throw new HttpError(401, 'sign in to your 128bit family account first');
  if (a.expires - 60 > Date.now() / 1000) return a;
  try {
    const j = await auth(ctx, a, 'token?grant_type=refresh_token', { refresh_token: a.refresh });
    saveSession(ctx, a, j);
    return account(ctx);
  } catch (err) {
    if (/invalid|not found|revoked|expired/i.test(err.message)) {
      put(ctx, 'family.account', { url: a.url, key: a.key, email: a.email });
      throw new HttpError(401, 'your family sign-in expired, sign in again');
    }
    throw err;
  }
}

async function rpc(ctx, fn, args) {
  const a = await token(ctx);
  const res = await (ctx.fetch ?? globalThis.fetch)(`${a.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: a.key, Authorization: `Bearer ${a.access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    let msg = body?.message || `family feed answered ${res.status}`;
    if (/function .* does not exist|Could not find the function/i.test(msg)) msg = 'this Supabase project is missing the family feed (run supabase/family.sql)';
    throw new HttpError(502, msg);
  }
  return body;
}

/** A family event → the 128bit envelope Tracker stores. */
export function fromFamily(e) {
  const d = e.data ?? {};
  const app = String(e.app ?? 'custom');
  return {
    id: String(e.id),
    type: String(e.type),
    source: /^[a-z0-9_.-]+$/.test(app) ? (app.startsWith('128bit') || app === 'custom' ? app : `128bit${app}`) : 'custom',
    occurred_at: new Date(Number(e.at) || Date.now()).toISOString(),
    title: titleFor(e.type, d),
    data: d,
  };
}

function titleFor(type, d) {
  switch (type) {
    case 'book.finished': return `📚 Finished ${d.title}${d.author ? ` by ${d.author}` : ''}`;
    case 'movie.watched': return `🎬 Watched ${d.title}`;
    case 'episode.watched': return `📺 ${d.show}${d.episode ? ` · ${d.episode}` : ''}`;
    case 'chapter.read': return `💥 Read ${d.comic}`;
    case 'workout.logged': return `💪 ${d.name ?? 'Workout'}${d.minutes ? ` · ${d.minutes} min` : ''}`;
    case 'health.day': return `❤️ ${d.steps != null ? `${Number(d.steps).toLocaleString()} steps` : 'Health'}${d.sleepMinutes != null ? ` · ${Math.round(d.sleepMinutes / 6) / 10}h sleep` : ''}`;
    default: return d.title ?? d.name ?? d.text ?? null;
  }
}

/** Tracker's own event → a family event. */
function toFamily(row) {
  const data = JSON.parse(row.payload);
  return { id: row.id, app: 'tracker', type: row.type, at: Date.parse(row.occurred_at), data: { ...data, title: row.title ?? undefined } };
}

async function pull(ctx) {
  const s = state(ctx);
  const until = s.pulled_until ? s.pulled_until - REPLACE_WINDOW_MS : null;
  const fresh = [];
  let before = null;
  for (;;) {
    const batch = await rpc(ctx, 'get_events', { before_ms: before, max_rows: PAGE });
    if (!Array.isArray(batch) || !batch.length) break;
    let reachedOld = false;
    for (const e of batch) {
      if (until != null && Number(e.at) < until) { reachedOld = true; break; }
      fresh.push(e);
    }
    if (reachedOld || batch.length < PAGE || fresh.length >= FIRST_PULL_MAX) break;
    before = batch[batch.length - 1].at;
  }
  // Oldest first, so finishing happens after starting. Skip our own echoes.
  const theirs = fresh.filter((e) => e.app !== 'tracker').reverse().map(fromFamily);
  for (const ev of theirs) await enrichEpisode(ctx, ev);

  let applied = 0;
  const seqBefore = maxOwnSeq(ctx);
  tx(ctx.db, () => {
    for (const ev of theirs) {
      try {
        const r = ingest(ctx, ev);
        if (r.status === 'accepted') applied++;
        else if (r.status === 'duplicate') {
          // Family events can be replaced (today's steps go up): keep the latest.
          ctx.db.prepare('UPDATE events SET payload = ?, title = ?, occurred_at = ? WHERE id = ?').run(JSON.stringify(ev.data), ev.title, ev.occurred_at, ev.id);
        }
      } catch (err) {
        console.warn('family: skipped', ev.id, err.message);
      }
    }
  });
  // What those events triggered here (item.completed, trophies…) isn't echoed back.
  const seqAfter = maxOwnSeq(ctx);
  const skip = state(ctx).skip ?? [];
  if (seqAfter > seqBefore) skip.push([seqBefore + 1, seqAfter]);
  const newest = fresh.reduce((m, e) => Math.max(m, Number(e.at) || 0), s.pulled_until ?? 0);
  setState(ctx, { skip, pulled_until: newest || s.pulled_until || Date.now() });
  return applied;
}

async function push(ctx) {
  let sent = 0;
  for (;;) {
    const s = state(ctx);
    const rows = ctx.db
      .prepare("SELECT rowid AS seq, * FROM events WHERE source = '128bittracker' AND rowid > ? ORDER BY rowid LIMIT 500")
      .all(s.pushed_seq ?? 0);
    if (!rows.length) break;
    const skip = s.skip ?? [];
    const batch = rows
      .filter((r) => SHARED_TYPES.has(r.type) && !skip.some(([a, b]) => r.seq >= a && r.seq <= b))
      .map(toFamily);
    if (batch.length) {
      await rpc(ctx, 'log_events', { events: batch });
      sent += batch.length;
    }
    const last = rows.at(-1).seq;
    setState(ctx, { pushed_seq: last, skip: skip.filter(([, b]) => b > last) });
  }
  return sent;
}

const running = new WeakMap(); // one sync at a time per database
/** Push Tracker's news, pull everyone else's. Never throws for the caller's convenience. */
export function familySync(ctx) {
  if (!account(ctx)?.refresh) return Promise.resolve({ pulled: 0, pushed: 0, error: 'not signed in' });
  if (running.has(ctx.db)) return running.get(ctx.db);
  const job = (async () => {
    try {
      const pushed = await push(ctx);
      const pulled = await pull(ctx);
      const s = state(ctx);
      setState(ctx, {
        last_sync_at: new Date().toISOString(),
        last_error: null,
        pulled_total: (s.pulled_total ?? 0) + pulled,
        pushed_total: (s.pushed_total ?? 0) + pushed,
      });
      return { pulled, pushed };
    } catch (err) {
      setState(ctx, { last_error: err.message });
      return { pulled: 0, pushed: 0, error: err.message };
    } finally {
      running.delete(ctx.db);
    }
  })();
  running.set(ctx.db, job);
  return job;
}
