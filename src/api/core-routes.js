// Routes shared by the server and the Android app (which runs them
// in-process against its on-device database). No Node-only imports.
import { HttpError } from './errors.js';
import * as trackers from '../domain/trackers.js';
import * as library from '../domain/library.js';
import * as stats from '../domain/stats.js';
import { listEvents } from '../domain/events.js';
import { exportAll, importAll } from '../domain/backup.js';

export const API_VERSION = '1';

const id = (p) => {
  const n = Number(p.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'invalid id');
  return n;
};

/** Static facts the UI needs: types, statuses, presets. */
export function metaInfo() {
  return {
    name: '128bit Tracker',
    api_version: API_VERSION,
    item_types: library.ITEM_TYPES,
    statuses: library.STATUSES,
    tracker_kinds: trackers.KINDS,
    presets: trackers.PRESETS,
  };
}

export function addCoreRoutes(r, ctx) {
  const { db } = ctx;

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

  // --- timeline (read) ------------------------------------------------------------
  r.get('/api/v1/events', 'read', ({ query }) => listEvents(db, query));

  // --- stats + export -------------------------------------------------------------
  r.get('/api/v1/stats', 'read', () => stats.overview(ctx));
  r.get('/api/v1/stats/year/:year', 'read', ({ params }) => {
    const y = Number(params.year);
    if (!Number.isInteger(y) || y < 1970 || y > 2999) throw new HttpError(400, 'invalid year');
    return stats.yearInPixels(ctx, y);
  });
  r.get('/api/v1/export', 'read', () => exportAll(db));
  r.post('/api/v1/import', 'write', ({ body }) => importAll(db, body));
}
