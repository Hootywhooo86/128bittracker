// Android transport: runs the Tracker API in-process against the on-device
// database. Same routes and domain code as the server — no network needed.
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { createRouter } from '../../src/api/router.js';
import { addCoreRoutes, metaInfo } from '../../src/api/core-routes.js';
import { HttpError } from '../../src/api/errors.js';
import { createEventBus } from '../../src/domain/events.js';
import { openDevice } from './engine.js';
import { createSync } from './sync.js';
import { createReminders } from './reminders.js';
import { createUpdates } from './updates.js';

export const platform = 'android';

const OWNER = { kind: 'owner', scopes: ['read', 'write'] };
let booting = null;

function boot() {
  booting ??= (async () => {
    const store = await openDevice();
    const ctx = { db: store.db, events: createEventBus(store.db) };
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
      if (!/^\/api\/v1\/(sync|app)\//.test(url.pathname) && url.pathname !== '/api/v1/share-file') sync.markDirty();
      reminders.refresh();
      store.scheduleSave();
    }
    return { status, data: data ?? null };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, data: { error: err.message } };
    console.error(err);
    return { status: 500, data: { error: err.message || 'something went wrong' } };
  }
}

/** Hooks for main.js: persist on background, auto-sync. */
export async function device() {
  return boot();
}
