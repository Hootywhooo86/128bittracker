// Outbound webhooks: Tracker pushes its own events (habit.completed,
// streak.milestone, item.completed, ...) to 128bitplay, 128bitlife, etc.
import { randomBytes } from 'node:crypto';
import { HttpError, notFound } from '../api/errors.js';

function present(row, { reveal = false } = {}) {
  const { secret, ...rest } = row;
  return { ...rest, active: !!row.active, event_types: row.event_types.split(','), ...(reveal ? { secret } : {}) };
}

function parseTypes(types) {
  const list = (Array.isArray(types) ? types : String(types ?? '*').split(',')).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length || list.some((t) => t !== '*' && !/^[a-z][a-z0-9_]*(\.([a-z][a-z0-9_]*|\*))+$/.test(t))) {
    throw new HttpError(400, 'event_types must be "*" or event types like habit.completed');
  }
  return list.join(',');
}

function parseUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new HttpError(400, 'url must be a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'url must be http(s)');
  return u.toString();
}

export function createWebhook(db, { url, event_types = '*' } = {}) {
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const res = db
    .prepare('INSERT INTO webhooks (url, secret, event_types, created_at) VALUES (?, ?, ?, ?)')
    .run(parseUrl(url), secret, parseTypes(event_types), new Date().toISOString());
  return present(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(Number(res.lastInsertRowid)), { reveal: true });
}

export function listWebhooks(db) {
  return db.prepare('SELECT * FROM webhooks ORDER BY id DESC').all().map((r) => present(r));
}

export function updateWebhook(db, id, { active, event_types, url } = {}) {
  const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
  if (!row) throw notFound('webhook');
  db.prepare('UPDATE webhooks SET active = ?, event_types = ?, url = ? WHERE id = ?').run(
    active === undefined ? row.active : active ? 1 : 0,
    event_types === undefined ? row.event_types : parseTypes(event_types),
    url === undefined ? row.url : parseUrl(url),
    id,
  );
  return present(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id));
}

export function deleteWebhook(db, id) {
  if (!db.prepare('DELETE FROM webhooks WHERE id = ?').run(id).changes) throw notFound('webhook');
}
