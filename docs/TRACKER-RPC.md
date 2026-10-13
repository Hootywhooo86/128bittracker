# 128bit Tracker for other apps (API v1)

128bitPlay and any other 128bit app read and write a person's Tracker library
through Supabase functions on the 128bit family project
(`supabase/tracker.sql`). No keys, no extra server: call them with the
person's 128bit sign-in, exactly like `log_events`.

```
POST https://wvflpwtaszpstmjpkrhu.supabase.co/rest/v1/rpc/<function>
apikey: <publishable key>
Authorization: Bearer <the signed-in person's access token>
Content-Type: application/json

{ ...arguments }
```

Every function acts for the signed-in account only (a TV paired in 128bitPlay
acts for its owner). There is no way to read someone else's library, apart
from lists and profiles their owners made public.

## Items

Every item comes back in this shape:

```json
{
  "id": "i-3f9c…", "type": "show", "title": "Severance", "creator": null, "year": 2022,
  "poster": "https://…", "backdrop": null, "status": "active", "progress": 3, "progress_total": 9,
  "rating": 9, "season": 1, "ids": { "imdb": "tt11280740", "tmdb": 95396, "tvmaze": 44933 },
  "started_at": "…", "finished_at": null, "updated_at": "…"
}
```

- `type`: one of `movie`, `show`, `anime`, `book`, `game`, `manga`, `comic`, `music`, `podcast`, `course` or `other`.
- `status`: one of `planned`, `active`, `on_hold`, `done` or `dropped`.
- Shows are tracked **per season**: one item per season, with `season` set and `progress` = episodes watched.
- `ids` is whatever is known. The keys are `imdb`, `tmdb`, `tvdb`, `tvmaze`, `anilist`, `mal`, `kitsu`, `igdb`, `steam` and `trakt`. Open titles by `ids.imdb`; fall back to `ids.tmdb`.

## Reading

| Function | Arguments | Returns |
|---|---|---|
| `get_lists` | `kind` (`movie` / `show` / `anime` / `book` / `game` / null for all), `play_only` (bool: only lists marked "Show in 128bitPlay") | `[{ id, name, description, kind, show_in_play, is_public, share_id, item_count }]`. `mixed` lists match every kind |
| `get_list_items` | `list_id`, `page` (1…), `per_page` (≤200) | items in the list's order, each with `position` |
| `get_watchlist` | `kind` (an item type or null), `max_rows` | planned items, newest first |
| `get_up_next` | `max_rows` | shows and anime in progress, newest first, each with `next: { season, number }` and `last_watched_at` |
| `get_calendar` | `days` (≤366) | `[{ date, kind: "episode" \| "release", title, detail, item }]`, from today |
| `get_history` | `before_ms`, `max_rows` | finished things from every 128bit app: `[{ id, app, type, at, data }]` |
| `get_item_progress` | `ids`, e.g. `{"imdb": "tt11280740"}` | that title's items (one per season for shows) |
| `find_item` | `item`: `{ type, title, ids? }` | the library item matched by any id, else by type + title (books and comics have no shared ids), or null |

## Writing

| Function | Arguments | Does |
|---|---|---|
| `create_list` | `name`, `kind`, `show_in_play` (default true) | `{ id }` |
| `add_to_list` | `list_id`, `item`: an existing `{ id }`, or `{ type, title, creator, year, poster, ids }` | matches the library by any id, else type + title (or adds the title as planned), appends it → `{ item_id }` |
| `remove_from_list` | `list_id`, `item_id` | |
| `set_watchlist` | `item` (as above), `wanted` (bool) | adds it as planned / removes it while it's still just planned → `{ item_id }` |
| `rate` | `item_id`, `rating` (1–10, null to clear) | |

**Watching something:** keep posting `movie.watched` / `episode.watched` to the
family feed (`log_events`). Tracker applies it to the library straight away,
even when the Tracker app is closed. Include as much as you know:

```json
{ "id": "…", "app": "play", "type": "episode.watched", "at": 1790000000000,
  "data": { "show": "Frieren", "episode": "S1 E3 · …", "season": 1, "number": 3,
            "season_episodes": 28, "imdb": "tt22248376", "anime": 1, "poster": "https://…" } }
```

- With `season_episodes`, the last episode finishes the season: a golden TV, or a golden idol with `anime`.
- `movie.watched` takes `{ title, imdb?, year?, poster? }`.

## Sharing (anyone, no sign-in)

| Function | Arguments | Returns |
|---|---|---|
| `get_public_list` | `share_id` | `{ name, description, kind, owner, items }`, only while its owner keeps it public |
| `get_public_profile` | `handle` | `{ handle, display_name, trophies, recent_trophies, lists }`, only while public |

The owner sets these with `set_profile(handle, display_name, is_public)` and the
list's Public switch in Tracker.

## Tracker's own sync

`tracker_push(payload)` and `tracker_pull(since)` are how the Tracker app keeps
every device in step (the newer `updated_at` wins). Other apps should use the
functions above instead.
