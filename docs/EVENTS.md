# 128bit family events

Every 128bit app posts what happens to the user's **family feed**; Tracker's timeline
([`timeline.html`](../timeline.html)) reads it, adds Trakt and Hardcover, and shows one
timeline. Types live in [`src/events.ts`](../src/events.ts). 128bitPlay (`docs/FAMILY_EVENTS.md`)
and 128bitfit (`docs/family-feed.md`) describe what they send; change them together.

## Where the feed lives

In the user's own Supabase project: the same one 128bitPlay's **Settings → Account** and
128bitfit's **Settings → 128bit family** sign in to. The SQL is
[`supabase/family.sql`](../supabase/family.sql) (128bitPlay's setup SQL includes the same block).
It's safe to run again; it only adds what's missing. The tables can't be read directly; everything
goes through these functions:

| Function | Who | What |
|---|---|---|
| `log_events(events jsonb)` | signed in | Add up to 500 events. Same `id` again replaces the event; no `id` makes a new one. |
| `get_events(before_ms bigint, max_rows int)` | signed in | Newest first (max 1000). Pass the oldest `at` you have as `before_ms` for the next page. |
| `delete_event(event_id text)` | signed in | Remove one. |
| `create_family_key(key_label text)` | signed in | A personal key for outside apps. Returned once; only its hash is stored. |
| `list_family_keys()` / `delete_family_key(key_id text)` | signed in | See and revoke keys. |
| `log_events_with_key(ingest_key text, events jsonb)` | anyone with a key | Same as `log_events`, for apps without a sign-in. |

Each account only sees its own events. A TV paired to 128bitPlay posts to its owner's feed.

## Event

```json
{ "id": "fit-health-2026-10-07", "app": "fit", "type": "health.day", "at": 1791427200000,
  "data": { "date": "2026-10-07", "steps": 8432, "sleepMinutes": 432, "restingHeartRate": 58,
            "activeCalories": null, "km": null } }
```

| Field | Meaning |
|---|---|
| `id` | Unique per account. Optional when posting: left out, the feed makes one. |
| `app` | `play`, `fit`, `tracker`, `gold`, `music`, `fantasy`, `trip`, `life`, or anything (`custom` by default). |
| `type` | `noun.verb`, past tense. Required. |
| `at` | When it happened, ms since 1970. Optional; default now. |
| `data` | Small, display-ready fields. `null` means "not measured", never 0. |

## Types

| App | `type` | `data` | Status |
|---|---|---|---|
| play | `book.finished` | `title`, `author` | live |
| play | `movie.watched` | `title` | live |
| play | `episode.watched` | `show`, `episode` (`S2 E3 · Name`) | live |
| play | `chapter.read` | `comic` | live |
| fit | `workout.logged` | `kind: strength`, `name`, `minutes`, `exercises`, `sets` | live, opt-in |
| fit | `workout.logged` | `kind: cardio`, `name`, `minutes`, `km` | live, opt-in |
| fit | `health.day` | `date`, `steps`, `sleepMinutes`, `restingHeartRate`, `activeCalories`, `km` (Health Connect) | live, opt-in |
| tracker | `habit.completed` | `tracker`, `value`, `unit` | live (Log anything) |
| tracker | `streak.milestone` / `streak.frozen` | `tracker`, `days` | planned |
| gold | `budget.updated` | `name` | planned |
| music | `track.played` | `title`, `artist` | planned |
| fantasy | `matchup.won` | `league`, `score` | planned |
| trip | `booking.made` | `place` | planned |

The timeline shows unknown types too (using `data.title`, `name`, `tracker` or `text` if there),
so anything can start posting before Tracker learns its icon.

## Read directly, not through the feed

- **Trakt**: the last 100 plays from `/sync/history`, using the Trakt sign-in 128bitPlay keeps in
  the same account (read only, never refreshed here, so 128bitPlay's stays valid). If 128bitPlay
  uses built-in Trakt keys, paste a Client ID once.
- **Hardcover**: books marked Read, with 128bitPlay's token or one pasted into the page.
- A Trakt or Hardcover item that matches a feed event within 3 days (same title, or same show and
  episode) is folded into it ("also on Trakt") instead of shown twice.

## Outside apps

The timeline's **Connections → Any app** makes a key. Then, from Zapier, IFTTT,
Tasker, iOS Shortcuts, Home Assistant, a cron job:

```
POST https://<project>.supabase.co/rest/v1/rpc/log_events_with_key
apikey: <anon key>
Content-Type: application/json

{"ingest_key": "128bit_…", "events": [{"type": "habit.completed", "data": {"tracker": "Water", "value": 1, "unit": "glass"}}]}
```

Google Health / Health Connect has no web API, so phone health data comes through 128bitfit.
