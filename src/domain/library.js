// The Library: anything you play, watch, read or listen to.
// Games, shows, movies, books, anime, manga, podcasts, music — or your own type.
import { HttpError, notFound } from '../api/errors.js';
import { tx } from '../db/tx.js';

export const ITEM_TYPES = {
  game:    { icon: '🎮', unit: '%' },
  movie:   { icon: '🎬', unit: null },
  show:    { icon: '📺', unit: 'episodes' },
  book:    { icon: '📚', unit: 'pages' },
  anime:   { icon: '🌸', unit: 'episodes' },
  manga:   { icon: '🗯️', unit: 'chapters' },
  comic:   { icon: '💥', unit: 'issues' },
  podcast: { icon: '🎙️', unit: 'episodes' },
  music:   { icon: '💿', unit: 'tracks' },
  course:  { icon: '🎓', unit: 'lessons' },
  other:   { icon: '📦', unit: null },
};
export const STATUSES = ['planned', 'active', 'on_hold', 'done', 'dropped'];
const STATUS_EVENT = { active: 'item.started', done: 'item.completed', dropped: 'item.dropped' };

function validate(input, partial) {
  const out = {};
  const str = (k, max) => {
    if (input[k] === undefined) return;
    out[k] = input[k] == null || input[k] === '' ? null : String(input[k]).slice(0, max);
  };
  if (!partial || input.title !== undefined) {
    const title = String(input.title ?? '').trim();
    if (!title || title.length > 200) throw new HttpError(400, 'title is required (max 200 chars)');
    out.title = title;
  }
  if (!partial || input.type !== undefined) {
    const type = String(input.type ?? 'other');
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(type)) throw new HttpError(400, 'type must be a lowercase slug');
    out.type = type;
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
    out.status = input.status;
  }
  if (input.rating !== undefined) {
    const r = input.rating == null ? null : Number(input.rating);
    if (r != null && !(Number.isInteger(r) && r >= 1 && r <= 10)) throw new HttpError(400, 'rating must be an integer 1..10');
    out.rating = r;
  }
  for (const k of ['progress', 'progress_total', 'year']) {
    if (input[k] === undefined) continue;
    const n = input[k] == null || input[k] === '' ? null : Number(input[k]);
    if (n != null && (!Number.isFinite(n) || n < 0)) throw new HttpError(400, `${k} must be a non-negative number`);
    out[k] = k === 'progress' ? n ?? 0 : n;
  }
  str('creator', 120);
  str('cover_url', 1000);
  str('review', 5000);
  if (out.cover_url && !/^https?:\/\//.test(out.cover_url)) throw new HttpError(400, 'cover_url must be http(s)');
  if (input.meta !== undefined) {
    if (typeof input.meta !== 'object' || input.meta == null || Array.isArray(input.meta)) throw new HttpError(400, 'meta must be an object');
    out.meta = JSON.stringify(input.meta);
  }
  return out;
}

function hydrate(row) {
  if (!row) return row;
  return { ...row, meta: JSON.parse(row.meta), icon: ITEM_TYPES[row.type]?.icon ?? '📦' };
}

function getRow(ctx, id) {
  const row = ctx.db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!row) throw notFound('item');
  return row;
}

export function getItem(ctx, id) {
  const item = hydrate(getRow(ctx, id));
  item.sessions = ctx.db.prepare('SELECT * FROM sessions WHERE item_id = ? ORDER BY at DESC LIMIT 50').all(id);
  item.minutes_total = ctx.db.prepare('SELECT COALESCE(SUM(minutes),0) AS m FROM sessions WHERE item_id = ?').get(id).m;
  item.collections = ctx.db
    .prepare('SELECT c.id, c.name FROM collections c JOIN collection_items ci ON ci.collection_id = c.id WHERE ci.item_id = ?')
    .all(id);
  return item;
}

export function findByExternal(ctx, source, externalId) {
  return hydrate(ctx.db.prepare('SELECT * FROM items WHERE source = ? AND external_id = ?').get(source, String(externalId)));
}

export function listItems(ctx, { type, status, q, collection, sort = 'updated', limit = 100, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (type) { where.push('i.type = ?'); args.push(type); }
  if (status) { where.push('i.status = ?'); args.push(status); }
  if (q) { where.push('(i.title LIKE ? OR i.creator LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  if (collection) {
    where.push('i.id IN (SELECT item_id FROM collection_items WHERE collection_id = ?)');
    args.push(Number(collection));
  }
  const order = { updated: 'i.updated_at DESC', title: 'i.title COLLATE NOCASE', rating: 'i.rating DESC NULLS LAST, i.title', created: 'i.created_at DESC' }[sort];
  if (!order) throw new HttpError(400, 'sort must be updated|title|rating|created');
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const o = Math.max(Number(offset) || 0, 0);
  return ctx.db
    .prepare(`SELECT i.* FROM items i ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${n} OFFSET ${o}`)
    .all(...args)
    .map(hydrate);
}

export function createItem(ctx, input, { source = 'manual', externalId = null } = {}) {
  const v = validate(input, false);
  const now = new Date().toISOString();
  const status = v.status ?? 'planned';
  const res = ctx.db
    .prepare(
      `INSERT INTO items (type, title, creator, year, cover_url, status, progress, progress_total, rating, review, source, external_id, meta, started_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      v.type, v.title, v.creator ?? null, v.year ?? null, v.cover_url ?? null, status, v.progress ?? 0,
      v.progress_total ?? null, v.rating ?? null, v.review ?? null, source, externalId, v.meta ?? '{}',
      status === 'active' || status === 'done' ? now : null, status === 'done' ? now : null, now, now,
    );
  const item = getItem(ctx, Number(res.lastInsertRowid));
  ctx.events.emit('item.added', ref(item), { title: `${item.icon} Added ${item.title}` });
  if (STATUS_EVENT[status]) emitStatus(ctx, item, status);
  return item;
}

export function updateItem(ctx, id, input) {
  const before = getRow(ctx, id);
  const v = validate(input, true);
  const now = new Date().toISOString();
  if (v.status && v.status !== before.status) {
    if (v.status === 'active' && !before.started_at) v.started_at = now;
    if (v.status === 'done') {
      v.finished_at = now;
      if (!before.started_at) v.started_at = now;
      if (before.progress_total && v.progress === undefined) v.progress = before.progress_total;
    }
  }
  const keys = Object.keys(v);
  if (keys.length) {
    v.updated_at = now;
    keys.push('updated_at');
    ctx.db.prepare(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => v[k]), id);
  }
  const item = getItem(ctx, id);
  if (v.status && v.status !== before.status && STATUS_EVENT[v.status]) emitStatus(ctx, item, v.status);
  if (v.rating != null && v.rating !== before.rating) {
    ctx.events.emit('item.rated', { ...ref(item), rating: v.rating }, { title: `⭐ Rated ${item.title} ${v.rating}/10` });
  }
  return item;
}

export function deleteItem(ctx, id) {
  getRow(ctx, id);
  ctx.db.prepare('DELETE FROM items WHERE id = ?').run(id);
}

/** Log a play/watch/read session: time spent and/or new progress. */
export function addSession(ctx, id, input = {}, { source = 'manual', at } = {}) {
  const item = getRow(ctx, id);
  const minutes = input.minutes == null ? 0 : Number(input.minutes);
  if (!(minutes >= 0) || minutes > 24 * 60) throw new HttpError(400, 'minutes must be 0..1440');
  const progress = input.progress == null ? null : Number(input.progress);
  if (progress != null && !(progress >= 0)) throw new HttpError(400, 'progress must be >= 0');
  if (minutes === 0 && progress == null) throw new HttpError(400, 'session needs minutes or progress');
  const when = at ?? new Date().toISOString();
  tx(ctx.db, () => {
    ctx.db
      .prepare('INSERT INTO sessions (item_id, minutes, progress, note, at, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, minutes, progress, input.note ? String(input.note).slice(0, 500) : null, when, source);
    const patch = { updated_at: new Date().toISOString() };
    if (progress != null) patch.progress = progress;
    if (item.status === 'planned' || item.status === 'on_hold') {
      patch.status = 'active';
      patch.started_at = item.started_at ?? when;
    }
    const keys = Object.keys(patch);
    ctx.db.prepare(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), id);
  });
  const updated = getItem(ctx, id);
  const what = minutes ? `${Math.round(minutes)} min` : `progress ${progress}`;
  ctx.events.emit('item.session', { ...ref(updated), minutes, progress }, { title: `${updated.icon} ${updated.title} · ${what}`, occurred_at: when });
  if (item.status !== updated.status) emitStatus(ctx, updated, updated.status);
  return updated;
}

function ref(item) {
  return { item_id: item.id, type: item.type, title: item.title, source: item.source, external_id: item.external_id };
}

function emitStatus(ctx, item, status) {
  const verb = { active: 'Started', done: 'Finished', dropped: 'Dropped' }[status];
  ctx.events.emit(STATUS_EVENT[status], ref(item), { title: `${item.icon} ${verb} ${item.title}` });
}

// --- collections -----------------------------------------------------------

export function listCollections(ctx) {
  return ctx.db
    .prepare('SELECT c.*, COUNT(ci.item_id) AS item_count FROM collections c LEFT JOIN collection_items ci ON ci.collection_id = c.id GROUP BY c.id ORDER BY c.name')
    .all();
}

export function createCollection(ctx, { name, description } = {}) {
  const n = String(name ?? '').trim();
  if (!n || n.length > 60) throw new HttpError(400, 'name is required (max 60 chars)');
  try {
    const res = ctx.db
      .prepare('INSERT INTO collections (name, description, created_at) VALUES (?, ?, ?)')
      .run(n, description ? String(description).slice(0, 500) : null, new Date().toISOString());
    return ctx.db.prepare('SELECT * FROM collections WHERE id = ?').get(Number(res.lastInsertRowid));
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw new HttpError(409, 'collection already exists');
    throw err;
  }
}

export function deleteCollection(ctx, id) {
  const res = ctx.db.prepare('DELETE FROM collections WHERE id = ?').run(id);
  if (!res.changes) throw notFound('collection');
}

export function setCollectionMembership(ctx, collectionId, itemId, member) {
  if (!ctx.db.prepare('SELECT 1 FROM collections WHERE id = ?').get(collectionId)) throw notFound('collection');
  getRow(ctx, itemId);
  if (member) ctx.db.prepare('INSERT OR IGNORE INTO collection_items (collection_id, item_id) VALUES (?, ?)').run(collectionId, itemId);
  else ctx.db.prepare('DELETE FROM collection_items WHERE collection_id = ? AND item_id = ?').run(collectionId, itemId);
}
