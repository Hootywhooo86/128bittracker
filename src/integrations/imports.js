// Bring your history with you. Detects the file by its contents:
//
//   Goodreads      library export CSV        → books (shelf, rating, pages, date read, review)
//   StoryGraph     export CSV                → books
//   Letterboxd     watched / diary / ratings → movies (finished, rating)
//   MyAnimeList    anime or manga XML export → anime / manga (status, progress, score)
//
// Re-importing the same file is safe: rows are keyed by the service's own id.
import { HttpError } from '../api/errors.js';
import { createItem, findByExternal, updateItem } from '../domain/library.js';
import { tx } from '../db/tx.js';

export function importFile(ctx, { text, filename = '' } = {}) {
  const body = String(text ?? '').replace(/^﻿/, '');
  if (!body.trim()) throw new HttpError(400, 'the file is empty');
  const parsed = detect(body, filename);
  if (!parsed) throw new HttpError(400, 'not a Goodreads, StoryGraph, Letterboxd or MyAnimeList export');

  const result = { format: parsed.format, added: 0, updated: 0, skipped: 0, trophies: 0 };
  tx(ctx.db, () => {
    for (const row of parsed.rows) {
      if (!row.title) { result.skipped++; continue; }
      const existing = row.external_id ? findByExternal(ctx, parsed.source, row.external_id) : null;
      const fields = {
        type: row.type,
        title: row.title.slice(0, 200),
        creator: row.creator || null,
        year: row.year || null,
        status: row.status,
        rating: row.rating || null,
        progress: row.progress ?? 0,
        progress_total: row.progress_total || null,
        review: row.review || null,
        meta: row.meta ?? {},
      };
      let item;
      if (existing) {
        const { type, ...patch } = fields;
        item = updateItem(ctx, existing.id, patch);
        result.updated++;
      } else {
        item = createItem(ctx, fields, { source: parsed.source, externalId: row.external_id ?? null, quiet: true });
        result.added++;
      }
      if (row.finished_at && item.status === 'done') {
        ctx.db.prepare('UPDATE items SET finished_at = ? WHERE id = ?').run(row.finished_at, item.id);
      }
      if (item.new_trophy) result.trophies++;
    }
  });
  return result;
}

function detect(text, filename) {
  if (/<myanimelist>/i.test(text)) return mal(text);
  const rows = parseCsv(text);
  if (!rows.length) return null;
  const h = rows[0].map((c) => c.trim().toLowerCase());
  const has = (...cols) => cols.every((c) => h.includes(c));
  const records = rows.slice(1).filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? '').trim()])));
  if (has('book id', 'title', 'exclusive shelf')) return goodreads(records);
  if (has('title', 'read status') && (h.includes('authors') || h.includes('isbn/uid'))) return storygraph(records);
  if (has('name', 'year', 'letterboxd uri')) return letterboxd(records, filename);
  return null;
}

/** RFC 4180-ish CSV: quotes, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const tenPoint = (fiveStar) => { const n = num(fiveStar); return n && n > 0 ? Math.min(10, Math.max(1, Math.round(n * 2))) : null; };
const isoDate = (d) => {
  if (!d) return null;
  const m = String(d).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m || m[1] === '0000') return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toISOString();
};

function goodreads(records) {
  const status = { read: 'done', 'currently-reading': 'active', 'to-read': 'planned' };
  return {
    format: 'Goodreads',
    source: 'goodreads',
    rows: records.map((r) => {
      const pages = num(r['number of pages']);
      const st = status[r['exclusive shelf']] ?? 'planned';
      return {
        type: 'book',
        external_id: r['book id'],
        title: r.title,
        creator: r.author,
        year: num(r['original publication year']) ?? num(r['year published']),
        status: st,
        rating: tenPoint(r['my rating']),
        progress_total: pages,
        progress: st === 'done' && pages ? pages : 0,
        review: r['my review']?.replace(/<br\s*\/?>/gi, '\n') || null,
        finished_at: isoDate(r['date read']),
      };
    }),
  };
}

function storygraph(records) {
  const status = { read: 'done', 'currently-reading': 'active', 'to-read': 'planned', 'did-not-finish': 'dropped', paused: 'on_hold' };
  return {
    format: 'StoryGraph',
    source: 'storygraph',
    rows: records.map((r) => ({
      type: 'book',
      external_id: r['isbn/uid'] || `${r.title}|${r.authors}`,
      title: r.title,
      creator: r.authors?.split(',')[0]?.trim(),
      status: status[r['read status']] ?? 'planned',
      rating: tenPoint(r['star rating']),
      review: r.review || null,
      finished_at: isoDate(r['last date read'] || r['dates read']),
    })),
  };
}

function letterboxd(records, filename) {
  // watchlist.csv is "want to watch"; watched/diary/ratings are finished films.
  const watchlist = /watchlist/i.test(filename);
  return {
    format: 'Letterboxd',
    source: 'letterboxd',
    rows: records.map((r) => ({
      type: 'movie',
      external_id: r['letterboxd uri'],
      title: r.name,
      year: num(r.year),
      status: watchlist ? 'planned' : 'done',
      rating: tenPoint(r.rating),
      review: r.review || null,
      finished_at: isoDate(r['watched date'] || r.date),
    })),
  };
}

function mal(xml) {
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`));
    return m ? m[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'") : '';
  };
  const status = { completed: 'done', watching: 'active', reading: 'active', 'plan to watch': 'planned', 'plan to read': 'planned', dropped: 'dropped', 'on-hold': 'on_hold' };
  const rows = [];
  for (const [, kind, block] of xml.matchAll(/<(anime|manga)>([\s\S]*?)<\/\1>/g)) {
    const anime = kind === 'anime';
    const total = num(tag(block, anime ? 'series_episodes' : 'manga_chapters'));
    const done = num(tag(block, anime ? 'my_watched_episodes' : 'my_read_chapters'));
    const score = num(tag(block, 'my_score'));
    rows.push({
      type: kind,
      external_id: `${kind}:${tag(block, anime ? 'series_animedb_id' : 'manga_mangadb_id')}`,
      title: tag(block, anime ? 'series_title' : 'manga_title'),
      status: status[tag(block, 'my_status').toLowerCase()] ?? 'planned',
      rating: score && score > 0 ? Math.min(10, score) : null,
      progress: done ?? 0,
      progress_total: total || null,
      finished_at: isoDate(tag(block, 'my_finish_date')),
    });
  }
  return { format: 'MyAnimeList', source: 'myanimelist', rows };
}
