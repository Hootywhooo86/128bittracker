// REST API v1 (server). Every route declares the scope it needs (null = public).
import { createRouter } from './router.js';
import { HttpError } from './errors.js';
import { addCoreRoutes, metaInfo } from './core-routes.js';
import * as keys from '../domain/apikeys.js';
import * as hooks from '../domain/webhooks.js';
import { normalizeEnvelope } from '../domain/events.js';
import { ingest, ingestBatch } from '../integrations/index.js';

export { API_VERSION } from './core-routes.js';

const id = (p) => {
  const n = Number(p.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'invalid id');
  return n;
};

export function buildRoutes(ctx, auth) {
  const r = createRouter();
  const { db } = ctx;

  // --- meta -----------------------------------------------------------------
  r.get('/api/v1', null, ({ principal }) => ({
    ...metaInfo(),
    platform: 'server',
    authenticated: !!principal,
    principal: principal ? { kind: principal.kind, scopes: principal.scopes, key: principal.key } : null,
    password_required: auth.passwordRequired,
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

  addCoreRoutes(r, ctx);

  // --- ingest -----------------------------------------------------------------
  r.post('/api/v1/events', 'ingest', ({ body, principal }) => {
    const defaultSource = principal.kind === 'key' ? slug(principal.key.name) : undefined;
    if (Array.isArray(body)) {
      if (body.length > 500) throw new HttpError(413, 'max 500 events per batch');
      return [207, ingestBatch(ctx, body, { defaultSource })];
    }
    const res = ingest(ctx, body, { defaultSource });
    return [res.status === 'accepted' ? 201 : res.status === 'rejected' ? 400 : 200, res];
  });

  // --- device sync (the Android app) ---------------------------------------------
  // Inbox: events other apps sent here, in arrival order, for the phone to apply.
  r.get('/api/v1/sync/inbox', 'sync', ({ query }) => {
    const cursor = Math.max(Number(query.cursor) || 0, 0);
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);
    const rows = db
      .prepare(`SELECT rowid AS seq, * FROM events WHERE rowid > ? AND source != '128bittracker' ORDER BY rowid LIMIT ${limit}`)
      .all(cursor);
    return {
      events: rows.map(({ seq, payload, received_at, ...e }) => ({ ...e, data: JSON.parse(payload) })),
      cursor: rows.length ? rows.at(-1).seq : cursor,
      more: rows.length === limit,
    };
  });
  // Outbox: the phone's own events (habit.completed, streak.milestone, ...).
  // Stored on the server timeline and fanned out to webhooks — no other effects.
  r.post('/api/v1/sync/outbox', 'sync', ({ body }) => {
    if (!Array.isArray(body)) throw new HttpError(400, 'send an array of events');
    if (body.length > 500) throw new HttpError(413, 'max 500 events per batch');
    return body.map((raw) => {
      try {
        const ev = normalizeEnvelope(raw);
        if (ev.source !== '128bittracker') throw new HttpError(400, 'outbox only takes source 128bittracker');
        if (!ctx.events.record(ev)) return { id: ev.id, status: 'duplicate' };
        ctx.events.track(Promise.resolve(ctx.notify?.(ev)));
        return { id: ev.id, status: 'accepted' };
      } catch (err) {
        return { id: raw?.id ?? null, status: 'error', error: err.message };
      }
    });
  });

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
