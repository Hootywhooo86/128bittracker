// API keys for 128bitplay and other clients. Only a SHA-256 hash is stored;
// the plaintext key is shown once, at creation.
import { randomBytes, createHash } from 'node:crypto';
import { HttpError, notFound } from '../api/errors.js';

// read   — GET anything (library, trackers, timeline, stats)
// write  — create/update trackers, items, logs, sessions
// ingest — POST 128bit events (what 128bitplay needs)
// admin  — manage API keys and webhooks
export const SCOPES = ['read', 'write', 'ingest', 'admin'];

const hash = (key) => createHash('sha256').update(key).digest('hex');

export function createApiKey(db, { name, scopes = ['read', 'ingest'] } = {}) {
  const n = String(name ?? '').trim();
  if (!n || n.length > 60) throw new HttpError(400, 'name is required (max 60 chars)');
  if (!Array.isArray(scopes) || !scopes.length || scopes.some((s) => !SCOPES.includes(s))) {
    throw new HttpError(400, `scopes must be a non-empty subset of ${SCOPES.join(', ')}`);
  }
  const key = `tb128_${randomBytes(24).toString('base64url')}`;
  const res = db
    .prepare('INSERT INTO api_keys (name, prefix, hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(n, key.slice(0, 12), hash(key), [...new Set(scopes)].join(','), new Date().toISOString());
  return { ...getApiKey(db, Number(res.lastInsertRowid)), key };
}

function present(row) {
  const { hash: _h, ...rest } = row;
  return { ...rest, scopes: row.scopes.split(','), revoked: !!row.revoked_at };
}

export function getApiKey(db, id) {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  if (!row) throw notFound('api key');
  return present(row);
}

export function listApiKeys(db) {
  return db.prepare('SELECT * FROM api_keys ORDER BY id DESC').all().map(present);
}

export function revokeApiKey(db, id) {
  getApiKey(db, id);
  db.prepare('UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(new Date().toISOString(), id);
  return getApiKey(db, id);
}

/** Resolve a bearer token to its key, or null. Touches last_used_at. */
export function authenticateKey(db, token) {
  if (typeof token !== 'string' || !token.startsWith('tb128_')) return null;
  const row = db.prepare('SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL').get(hash(token));
  if (!row) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return present(row);
}
