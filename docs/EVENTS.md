# 128bit family events

Every 128bit app posts what happens to the user's **family feed**; Tracker reads it and shows one
timeline. Types live in [`src/events.ts`](../src/events.ts). 128bitPlay keeps the same schema in
its `docs/FAMILY_EVENTS.md`; change both together.

## Where the feed lives

In the user's own Supabase project: the same one 128bitPlay's **Settings → Account** uses. The
`family_events` table and its two functions come from 128bitPlay's setup SQL (`SETUP_SQL` in
`app/src/lib/account.ts`, or **Settings → Account → Copy setup SQL**). The table can't be read
directly; everything goes through:

- `log_events(events jsonb)`: insert a batch. An `id` already there is ignored.
- `get_events(before_ms bigint default null, max_rows int default 200)`: newest first (max 1000).
  Pass the oldest `at` you have as `before_ms` for the next page.

Both need a signed-in user (`Authorization: Bearer <access token>`), and each account only sees
its own events. A TV paired to 128bitPlay writes to its owner's feed.

## Event

```json
{ "id": "lq3k9z1-4f8a2c1b", "app": "play", "type": "book.finished", "at": 1791427200000,
  "data": { "title": "Project Hail Mary", "author": "Andy Weir" } }
```

| Field | Meaning |
|---|---|
| `id` | Unique per event per account. |
| `app` | `play`, `tracker`, `fit`, `gold`, `music`, `fantasy`, `trip`, `life` |
| `type` | `noun.verb`, past tense. |
| `at` | When it happened, ms since 1970. |
| `data` | Small, display-ready fields for that type. |

## Types

| App | `type` | `data` | Status |
|---|---|---|---|
| play | `book.finished` | `title`, `author` | live |
| play | `movie.watched` | `title` | live |
| play | `episode.watched` | `show`, `episode` | live |
| play | `chapter.read` | `comic` | live |
| tracker | `habit.completed` | `tracker`, `value`, `unit` | planned |
| tracker | `streak.milestone` | `tracker`, `days` | planned |
| tracker | `streak.frozen` | `tracker` | planned |
| fit | `workout.logged` | `name`, `minutes` | planned |
| gold | `budget.updated` | `name` | planned |
| music | `track.played` | `title`, `artist` | planned |
| fantasy | `matchup.won` | `league`, `score` | planned |
| trip | `booking.made` | `place` | planned |

The timeline shows unknown types too (as `type` plus the data), so a sibling app can start
posting before Tracker learns its icon.
