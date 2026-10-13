// Android transport: runs the Tracker API in-process against the on-device
// database. Same routes and domain code as the server — no network needed.
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { createRouter } from '../../src/api/router.js';
import { addCoreRoutes, metaInfo } from '../../src/api/core-routes.js';
import { HttpError } from '../../src/api/errors.js';
import { createEventBus } from '../../src/domain/events.js';
import { openDevice, setActiveDbKey, activeDbKey } from './engine.js';
import { Browser } from '@capacitor/browser';
import { familyAdopt } from '../../src/integrations/family-account.js';
import { createSync } from './sync.js';
import { createReminders } from './reminders.js';
import { createUpdates } from './updates.js';
import { connectHealth, pullHealth, openHealthSettings } from './health.js';
import { setHealthEnabled } from '../../src/integrations/health.js';

export const platform = 'android';

const OWNER = { kind: 'owner', scopes: ['read', 'write'] };
let booting = null;

function boot() {
  booting ??= (async () => {
    const store = await openDevice();
    // fetch goes through Capacitor's native HTTP (no CORS), so Steam/Xbox/PSN work from the phone.
    const ctx = { db: store.db, events: createEventBus(store.db), fetch: (...a) => fetch(...a) };
    // Just switched accounts: this library is theirs, signed in.
    try {
      const pending = JSON.parse(localStorage.getItem('128bit.tracker.pending-account') || 'null');
      if (pending) {
        localStorage.removeItem('128bit.tracker.pending-account');
        familyAdopt(ctx, pending);
        await store.flush?.();
        store.scheduleSave();
      }
    } catch (err) {
      console.warn('switch account:', err.message);
    }
    // Remember whose library this is, so switching back finds it.
    try {
      const owner = JSON.parse(store.db.prepare("SELECT value FROM kv WHERE key = 'cloud.owner'").get()?.value ?? 'null');
      if (owner) {
        const known = JSON.parse(localStorage.getItem('128bit.tracker.dbs') || '{}');
        if (!known[owner]) {
          known[owner] = activeDbKey();
          localStorage.setItem('128bit.tracker.dbs', JSON.stringify(known));
        }
      }
    } catch { /* no storage */ }
    const sync = createSync(ctx, { scheduleSave: store.scheduleSave });
    const reminders = createReminders(ctx);
    const updates = createUpdates();
    const r = createRouter();

    r.get('/api/v1', null, () => ({ ...metaInfo(), platform, authenticated: true, password_required: false }));
    addCoreRoutes(r, ctx);
    r.get('/api/v1/sync/settings', null, () => sync.settings());
    r.put('/api/v1/sync/settings', null, ({ body }) => sync.configure(body ?? {}));
    r.post('/api/v1/sync/run', null, () => sync.run());
    r.post('/api/v1/sync/backup', null, () => sync.backupNow());
    r.post('/api/v1/sync/restore', null, async ({ body }) => {
      const res = await sync.restore(body?.id ?? 'latest');
      reminders.refresh();
      return res;
    });
    r.get('/api/v1/app/update', null, () => updates.check());
    r.post('/api/v1/app/open-url', null, async ({ body }) => {
      const url = String(body?.url ?? '');
      if (!/^https:\/\//.test(url)) throw new HttpError(400, 'https links only');
      await Browser.open({ url });
      return [204];
    });
    // Another account signing in: open (or create) that account's own library and restart into it.
    r.post('/api/v1/device/switch-account', null, async ({ body }) => {
      const account = body?.account;
      if (!account?.user_id || !account.refresh) throw new HttpError(400, 'no account to switch to');
      await store.flush();
      const known = JSON.parse(localStorage.getItem('128bit.tracker.dbs') || '{}');
      const key = known[account.user_id] ?? `tracker-${account.user_id}.db`;
      known[account.user_id] = key;
      localStorage.setItem('128bit.tracker.dbs', JSON.stringify(known));
      localStorage.setItem('128bit.tracker.pending-account', JSON.stringify(account));
      setActiveDbKey(key);
      setTimeout(() => location.reload(), 50);
      return [202, { switching: true }];
    });
    // Health Connect: ask once, then read workouts + daily steps.
    r.post('/api/v1/health/connect', null, async () => {
      const res = await connectHealth();
      if (!res.ok) return res;
      setHealthEnabled(ctx, true);
      return { ok: true, ...(await pullHealth(request, { days: 30 })) };
    });
    r.post('/api/v1/health/pull', null, () => pullHealth(request, { days: 7 }));
    r.post('/api/v1/health/settings', null, async () => (await openHealthSettings(), [204]));
    r.post('/api/v1/app/open-update', null, async ({ body }) => (await updates.open(body?.url), [204]));
    r.post('/api/v1/share-file', null, async ({ body }) => {
      const name = String(body?.name ?? 'export.json').replace(/[^\w.-]+/g, '_');
      const { uri } = await Filesystem.writeFile({ path: name, data: String(body?.text ?? ''), directory: Directory.Cache, encoding: Encoding.UTF8 });
      await Share.share({ title: name, url: uri, dialogTitle: 'Save your Tracker export' });
      return [204];
    });

    // A file import replaces history too: same bookkeeping as a server restore.
    const fileImport = r.match('POST', '/api/v1/import').route;
    const importHandler = fileImport.handler;
    fileImport.handler = (req) => {
      const res = importHandler(req);
      sync.afterRestore();
      sync.markDirty();
      return res;
    };

    return { r, store, sync, reminders, updates };
  })();
  return booting;
}

/** Same contract as the web transport: resolves { status, data }. */
export async function request(method, path, body) {
  const { r, store, sync, reminders } = await boot();
  const url = new URL('http://device/api/v1' + path);
  try {
    const { route, params, pathMatched } = r.match(method, url.pathname);
    if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'method not allowed' : 'no such endpoint');
    const out = await route.handler({
      params,
      query: Object.fromEntries(url.searchParams),
      body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)),
      principal: OWNER,
      setHeader() {},
    });
    const [status, data] = Array.isArray(out) && typeof out[0] === 'number' ? out : [200, out];
    if (method !== 'GET') {
      const bookkeeping = /^\/api\/v1\/(sync|app|family)\//.test(url.pathname) || url.pathname === '/api/v1/share-file';
      if (!bookkeeping || (url.pathname === '/api/v1/family/sync' && data?.pulled)) sync.markDirty();
      reminders.refresh();
      store.scheduleSave();
    }
    return { status, data: data ?? null };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, data: { ...err.extra, error: err.message } };
    console.error(err);
    return { status: 500, data: { error: err.message || 'something went wrong' } };
  }
}

/** Hooks for main.js: persist on background, auto-sync. */
export async function device() {
  return boot();
}
