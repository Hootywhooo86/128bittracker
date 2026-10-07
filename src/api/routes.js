// REST API v1. Every route declares the scope it needs (null = public).
import { createRouter } from './router.js';
import { HttpError } from './errors.js';
import * as trackers from '../domain/trackers.js';
import * as library from '../domain/library.js';
import * as stats from '../domain/stats.js';
import * as keys from '../domain/apikeys.js';
import * as hooks from '../domain/webhooks.js';
import { listEvents } from '../domain/events.js';
import { ingest, ingestBatch } from '../integrations/index.js';

const id = (p) => {
  const n = Number(p.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'invalid id');
  return n;
};

export const API_VERSION = '1';

export function buildRoutes(ctx, auth) {
  const r = createRouter();
  const { db } = ctx;

  // --- meta -----------------------------------------------------------------
  r.get('/api/v1', null, ({ principal }) => ({
    name: '128bit Tracker',
    api_version: API_VERSION,
    authenticated: !!principal,
    principal: principal ? { kind: principal.kind, scopes: principal.scopes, key: principal.key } : null,
    password_required: auth.passwordRequired,
    item_types: library.ITEM_TYPES,
    statuses: library.STATUSES,
    tracker_kinds: trackers.KINDS,
    presets: trackers.PRESETS,
    scopes: keys.SCOPES,
  }));

  r.post('/api/v1/session', null, ({ body, setHeader }) => {
    if (!auth.checkPassword(body?.password)) throw new HttpError(401, 'wrong password');
    setHeader('set-cookie', auth.issueCookie());
    return { ok: true };
  });
  r.delete('/api/v1/session', null, ({ setHeader }) => {
    setHeader('set-cookie', auth.clearCookie);
    return { ok: true };
  });

  // --- habit trackers ---------------------------------------------------------
  r.get('/api/v1/trackers', 'read', ({ query }) => trackers.listTrackers(ctx, { includeArchived: query.archived === 'true' }));
  r.post('/api/v1/trackers', 'write', ({ body }) => [201, trackers.createTracker(ctx, body ?? {})]);
  r.get('/api/v1/trackers/:id', 'read', ({ params }) => trackers.getTracker(ctx, id(params)));
  r.patch('/api/v1/trackers/:id', 'write', ({ params, body }) => trackers.updateTracker(ctx, id(params), body ?? {}));
  r.delete('/api/v1/trackers/:id', 'write', ({ params }) => (trackers.deleteTracker(ctx, id(params)), [204]));
  r.post('/api/v1/trackers/:id/log', 'write', ({ params, body }) => [201, trackers.logTracker(ctx, id(params), body ?? {})]);
  r.post('/api/v1/trackers/:id/undo', 'write', ({ params, body }) => trackers.undoLastLog(ctx, id(params), body?.day));
  r.post('/api/v1/trackers/:id/freeze', 'write', ({ params, body }) => trackers.freezeDay(ctx, id(params), body?.day));
  r.get('/api/v1/trackers/:id/logs', 'read', ({ params, query }) => trackers.listLogs(ctx, id(params), query));

  // --- library ----------------------------------------------------------------
  r.get('/api/v1/items', 'read', ({ query }) => library.listItems(ctx, query));
  r.post('/api/v1/items', 'write', ({ body }) => [201, library.createItem(ctx, body ?? {})]);
  r.get('/api/v1/items/:id', 'read', ({ params }) => library.getItem(ctx, id(params)));
  r.patch('/api/v1/items/:id', 'write', ({ params, body }) => library.updateItem(ctx, id(params), body ?? {}));
  r.delete('/api/v1/items/:id', 'write', ({ params }) => (library.deleteItem(ctx, id(params)), [204]));
  r.post('/api/v1/items/:id/sessions', 'write', ({ params, body }) => [201, library.addSession(ctx, id(params), body ?? {})]);
  r.get('/api/v1/lookup/:source/:externalId', 'read', ({ params }) => {
    const item = library.findByExternal(ctx, params.source, params.externalId);
    if (!item) throw new HttpError(404, 'item not found');
    return library.getItem(ctx, item.id);
  });

  r.get('/api/v1/collections', 'read', () => library.listCollections(ctx));
  r.post('/api/v1/collections', 'write', ({ body }) => [201, library.createCollection(ctx, body ?? {})]);
  r.delete('/api/v1/collections/:id', 'write', ({ params }) => (library.deleteCollection(ctx, id(params)), [204]));
  r.put('/api/v1/collections/:id/items/:itemId', 'write', ({ params }) => {
    library.setCollectionMembership(ctx, id(params), id({ id: params.itemId }), true);
    return [204];
  });
  r.delete('/api/v1/collections/:id/items/:itemId', 'write', ({ params }) => {
    library.setCollectionMembership(ctx, id(params), id({ id: params.itemId }), false);
    return [204];
  });

  // --- timeline + ingest --------------------------------------------------------
  r.get('/api/v1/events', 'read', ({ query }) => listEvents(db, query));
  r.post('/api/v1/events', 'ingest', ({ body, principal }) => {
    const defaultSource = principal.kind === 'key' ? slug(principal.key.name) : undefined;
    if (Array.isArray(body)) {
      if (body.length > 500) throw new HttpError(413, 'max 500 events per batch');
      return [207, ingestBatch(ctx, body, { defaultSource })];
    }
    const res = ingest(ctx, body, { defaultSource });
    return [res.status === 'accepted' ? 201 : res.status === 'rejected' ? 400 : 200, res];
  });

  // --- stats + export -------------------------------------------------------------
  r.get('/api/v1/stats', 'read', () => stats.overview(ctx));
  r.get('/api/v1/stats/year/:year', 'read', ({ params }) => {
    const y = Number(params.year);
    if (!Number.isInteger(y) || y < 1970 || y > 2999) throw new HttpError(400, 'invalid year');
    return stats.yearInPixels(ctx, y);
  });
  r.get('/api/v1/export', 'read', () => exportAll(db));

  // --- admin: keys + webhooks --------------------------------------------------------
  r.get('/api/v1/keys', 'admin', () => keys.listApiKeys(db));
  r.post('/api/v1/keys', 'admin', ({ body }) => [201, keys.createApiKey(db, body ?? {})]);
  r.delete('/api/v1/keys/:id', 'admin', ({ params }) => keys.revokeApiKey(db, id(params)));
  r.get('/api/v1/webhooks', 'admin', () => hooks.listWebhooks(db));
  r.post('/api/v1/webhooks', 'admin', ({ body }) => [201, hooks.createWebhook(db, body ?? {})]);
  r.patch('/api/v1/webhooks/:id', 'admin', ({ params, body }) => hooks.updateWebhook(db, id(params), body ?? {}));
  r.delete('/api/v1/webhooks/:id', 'admin', ({ params }) => (hooks.deleteWebhook(db, id(params)), [204]));

  return r;
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'api';
}

function exportAll(db) {
  const all = (t) => db.prepare(`SELECT * FROM ${t}`).all();
  return {
    format: '128bittracker-export',
    version: 1,
    exported_at: new Date().toISOString(),
    trackers: all('trackers'),
    logs: all('logs'),
    freezes: all('freezes'),
    items: all('items').map((i) => ({ ...i, meta: JSON.parse(i.meta) })),
    sessions: all('sessions'),
    collections: all('collections'),
    collection_items: all('collection_items'),
    events: all('events').map(({ payload, ...e }) => ({ ...e, data: JSON.parse(payload) })),
  };
}
