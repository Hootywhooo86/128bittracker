// Goodreads: your shelves through their public RSS feeds. No key needed
// (Goodreads closed its API). Your profile must be public.
import { rssItems, tag } from './rss.js';

const SHELVES = { read: 'done', 'currently-reading': 'active', 'to-read': 'planned' };
const MAX_PAGES = 20;

export const goodreads = {
  label: 'Goodreads',
  group: 'media',
  icon: '📕',
  official: true,
  help: 'Your Goodreads profile link (goodreads.com/user/show/12345-name) or the number in it. Reads your Read, Currently Reading and Want to Read shelves. The profile must be public.',
  fields: [{ key: 'profile', label: 'Goodreads profile URL or user id', required: true }],

  async sync(config, { fetch, upsertMedia }) {
    const id = String(config.profile).match(/(\d+)/)?.[1];
    if (!id) throw new Error('use the profile link or the number in it, e.g. 12345');
    for (const [shelf, status] of Object.entries(SHELVES)) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await fetch(`https://www.goodreads.com/review/list_rss/${id}?${new URLSearchParams({ shelf, page: String(page) })}`, {
          headers: { 'User-Agent': '128bitTracker', Accept: 'application/rss+xml' },
        });
        if (res.status === 404) throw new Error(`no Goodreads user ${id}`);
        if (res.status === 403) throw new Error('that Goodreads profile is private');
        if (!res.ok) throw new Error(`Goodreads answered HTTP ${res.status}`);
        const items = rssItems(await res.text());
        if (!items.length) break;
        for (const item of items) {
          const bookId = tag(item, 'book_id');
          const title = tag(item, 'title');
          if (!bookId || !title) continue;
          const stars = Number(tag(item, 'user_rating'));
          const readAt = tag(item, 'user_read_at');
          const pages = Number(tag(item, 'num_pages')) || null;
          upsertMedia({
            id: `book:${bookId}`,
            type: 'book',
            title,
            creator: tag(item, 'author_name'),
            year: Number(tag(item, 'book_published')) || null,
            cover_url: tag(item, 'book_large_image_url') ?? tag(item, 'book_image_url'),
            status,
            progress: status === 'done' ? pages : undefined,
            progress_total: pages,
            rating: stars > 0 ? stars * 2 : null,
            finished_at: readAt && !Number.isNaN(Date.parse(readAt)) ? new Date(readAt).toISOString() : null,
            meta: { goodreads_id: Number(bookId) },
          });
        }
      }
    }
  },
};
