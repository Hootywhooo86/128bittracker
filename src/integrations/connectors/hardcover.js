// Hardcover: your shelves, ratings and reading progress (GraphQL API).
// Needs your personal API token from hardcover.app/account/api.
const API = 'https://api.hardcover.app/v1/graphql';
// Hardcover's shelf ids.
const STATUS = { 1: 'planned', 2: 'active', 3: 'done', 4: 'on_hold', 5: 'dropped' };

const FULL = `query {
  me { user_books(order_by: { updated_at: desc }) {
    status_id rating
    book { id title slug release_year pages image { url } contributions(limit: 1) { author { name } } }
    user_book_reads(order_by: { id: desc }, limit: 1) { progress_pages finished_at }
  } }
}`;
// Fallback if the API ever drops a field from FULL: shelves and ratings only.
const BASIC = `query {
  me { user_books { status_id rating book { id title release_year pages image { url } } } }
}`;

export const hardcover = {
  label: 'Hardcover',
  group: 'media',
  icon: '📗',
  official: true,
  help: 'Copy your API token from hardcover.app/account/api (Settings → Hardcover API). Imports your shelves, ratings and reading progress.',
  fields: [{ key: 'token', label: 'Hardcover API token', secret: true, required: true }],

  async sync(config, { fetch, upsertMedia }) {
    const token = String(config.token).trim().replace(/^bearer\s+/i, '');
    const run = async (query) => {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': '128bitTracker' },
        body: JSON.stringify({ query }),
      });
      if (res.status === 401 || res.status === 403) throw new Error('Hardcover rejected the token (they expire yearly: copy a fresh one)');
      if (!res.ok) throw new Error(`Hardcover answered HTTP ${res.status}`);
      return res.json();
    };
    let body = await run(FULL);
    if (body.errors) body = await run(BASIC);
    if (body.errors) throw new Error(body.errors[0]?.message ?? 'Hardcover query failed');
    const me = Array.isArray(body.data?.me) ? body.data.me[0] : body.data?.me;
    if (!me) throw new Error('Hardcover rejected the token');

    for (const ub of me.user_books ?? []) {
      const b = ub.book;
      if (!b?.id) continue;
      const read = ub.user_book_reads?.[0];
      const status = STATUS[ub.status_id] ?? 'planned';
      upsertMedia({
        id: `book:${b.id}`,
        type: 'book',
        title: b.title,
        creator: b.contributions?.[0]?.author?.name,
        year: b.release_year,
        cover_url: b.image?.url,
        status,
        progress: status === 'done' ? b.pages : read?.progress_pages,
        progress_total: b.pages,
        rating: ub.rating ? ub.rating * 2 : null, // Hardcover rates 0.5–5 stars
        finished_at: read?.finished_at ? new Date(read.finished_at).toISOString() : null,
        meta: { hardcover_id: b.id, url: b.slug ? `https://hardcover.app/books/${b.slug}` : null },
      });
    }
  },
};
