# 128bit Tracker API (v1)

Base URL: `http://<host>:8128/api/v1`. JSON in, JSON out.

## Auth

Apps (128bitplay, 128bitfit, scripts) use API keys created in **Connect → API keys**
or with `POST /keys`:

```
Authorization: Bearer tb128_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

| Scope    | Allows                                                    |
|----------|-----------------------------------------------------------|
| `read`   | every `GET`: library, trackers, timeline, stats, export   |
| `write`  | create/update/delete trackers, logs, items, sessions      |
| `ingest` | `POST /events`, which is how sibling apps report activity |
| `sync`   | the Android app: `/sync/inbox` + `/sync/outbox` only      |
| `admin`  | manage API keys and webhooks                              |

Only a hash of each key is stored; the plaintext is shown once. Revoking a key
(`DELETE /keys/:id`) takes effect immediately.

**Recommended for 128bitplay:** a key named `128bitplay` with `read` + `ingest`,
called **server-to-server**. If a browser has to call the API directly, add its
origin to `TRACKER_CORS_ORIGINS`. The key is then visible to the browser, so give
it the fewest scopes it needs.

Errors look like `{ "error": "message" }`, with 400 (validation), 401 (no/invalid
key), 403 (missing scope), 404, 409 (conflict, e.g. freeze limit), 413, 415.

## Sending events (`POST /events`, scope `ingest`)

Every 128bit app speaks the same envelope:

```json
{
  "id": "play-evt-0001",
  "type": "game.session",
  "source": "128bitplay",
  "occurred_at": "2026-10-07T18:20:00Z",
  "title": "optional display text for the timeline",
  "data": { }
}
```

- `id`: your unique id. Resending the same id is a no-op (`"status":"duplicate"`),
  so retries are safe. Omit it and one is generated.
- `type`: `noun.verb`, lowercase.
- `source`: defaults to the API key's name (slugified). `128bittracker` is reserved.
- `occurred_at`: defaults to now.

Send one envelope (201 / 200 for duplicates) or an array of up to 500 (207, one
result per event). Each event is atomic: if its side effects fail it isn't stored,
so you can fix it and resend the same `id`.

```json
{ "id": "play-evt-0001", "status": "accepted", "effects": [{ "item_id": 5, "minutes": 35 }] }
```

### 128bitplay events

`game` is `{ id, title, cover_url?, platform?, developer?, year?, url? }`. The same
`game.id` always maps to one Library item.

| type                   | data                          | effect                                  |
|------------------------|-------------------------------|-----------------------------------------|
| `game.added`           | `{ game }`                    | Library item (planned)                  |
| `game.started`         | `{ game }`                    | item → in progress                      |
| `game.session`         | `{ game, minutes, progress? }`| play session + time; feeds Play time habit |
| `game.completed`       | `{ game }`                    | item → done                             |
| `game.dropped`         | `{ game }`                    | item → dropped                          |
| `game.rated`           | `{ game, rating }` (1–10)     | rating                                  |
| `achievement.unlocked` | `{ game, achievement:{name} }`| timeline                                |
| `score.posted`         | `{ game, score }`             | timeline                                |
| anything else          | any                           | timeline (+ item if `game` present)     |

Automation only moves status forward (planned → in progress → done). Manual edits
can still set any status.

### Other apps

Every event lands on the timeline. Habit trackers can also auto-log from events by
listing event types in `listens`. The **Workout** preset listens to `workout.logged`
and **Play time** listens to `game.session`. Logged value: `1` for check and scale
trackers, otherwise `data.minutes ?? data.value ?? 1`.

## Reading (scope `read`)

| Method | Path | Notes |
|---|---|---|
| GET | `/` | API info, types, presets. Works without auth |
| GET | `/trackers` | `?archived=true` includes archived. Each tracker includes today, streak, 30-day history |
| GET | `/trackers/:id` · `/trackers/:id/logs` | |
| GET | `/items` | `?type=game&status=active&q=zelda&collection=1&sort=updated\|title\|rating\|created&limit&offset` |
| GET | `/items/:id` | includes sessions, total minutes, collections |
| GET | `/lookup/:source/:externalId` | e.g. `/lookup/128bitplay/g-42`, to find the Tracker item for a 128bitplay game |
| GET | `/collections` | |
| GET | `/events` | `?type=game.*&source=128bitplay&before=ISO&after=ISO&limit=50` |
| GET | `/stats` | habit + library overview |
| GET | `/stats/year/:year` | year in pixels |
| GET | `/export` | everything, as JSON |
| POST | `/import` | *(scope `write`)* replace all data with an export. Settings and keys are kept |

## Writing (scope `write`)

| Method | Path | Body |
|---|---|---|
| POST | `/trackers` | `{ preset }` or `{ name, kind: check\|count\|duration\|scale, target, unit, icon, color, listens, remind_at: "HH:MM" }` |
| PATCH / DELETE | `/trackers/:id` | |
| POST | `/trackers/:id/log` | `{ value?, day?, note? }`. Empty body = one tap |
| POST | `/trackers/:id/undo` | removes the last log for `day` (default today) |
| POST | `/trackers/:id/freeze` | `{ day? }` (default yesterday). Max 4 per 30 days |
| POST | `/items` | `{ type, title, status, creator, year, cover_url, progress, progress_total, rating, review, meta }` |
| PATCH / DELETE | `/items/:id` | |
| POST | `/items/:id/sessions` | `{ minutes?, progress?, note? }` |
| POST / DELETE | `/collections`, `/collections/:id` | |
| PUT / DELETE | `/collections/:id/items/:itemId` | |

## Webhooks: Tracker → your app (scope `admin`)

`POST /webhooks { "url": "https://…", "event_types": ["habit.completed", "streak.*"] }`
returns a `secret` once. Tracker POSTs its own events (envelope above, `source:
"128bittracker"`) with these headers:

```
X-128bit-Event: streak.milestone
X-128bit-Timestamp: 1791400000
X-128bit-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
```

Verify the signature and reject stale timestamps. Events Tracker emits:
`habit.logged`, `habit.completed`, `streak.milestone` (3, 7, 14, 30, 50, 100, 200,
365, 500, 1000 days), `streak.frozen`, `item.added`, `item.started`,
`item.session`, `item.completed`, `item.dropped`, `item.rated`.

This is how 128bitplay (or 128bitlife) can reward streaks: subscribe to
`streak.milestone` and hand out XP, badges or unlocks.

`PATCH /webhooks/:id { active: false }` pauses a webhook. `DELETE` removes it.

## Device sync (scope `sync`)

The Android app uses these endpoints. Other apps don't need them.

| Method | Path | |
|---|---|---|
| GET | `/sync/inbox?cursor=0&limit=200` | events from other sources, in arrival order → `{ events, cursor, more }`. Pass `cursor` back next time |
| PUT | `/sync/backup` | upload a full export. The server keeps the latest 10 per key |
| GET | `/sync/backups` | list this device's backups (no data) |
| GET | `/sync/backups/latest` · `/sync/backups/:id` | the export, ready for `/import` |
| POST | `/sync/outbox` | array of the phone's own events (`source: "128bittracker"`). Stored and sent to webhooks, idempotent by `id` |

## Library helpers (scope `read` / `write`)

| Method | Path | |
|---|---|---|
| GET | `/search?type=book&q=dune` | title search; results carry `cover_url`, `year`, `creator`, `progress_total`, `meta` to pass when creating the item. `type=audiobook` searches Audible first (then Google Books / Open Library); save those as `type: book` with their `meta` (`format: audiobook`, `narrator`, `runtime_min`, `asin`, `series`) |
| GET | `/search/seasons?provider=tvmaze&id=44933` | a show's seasons with episode counts |
| POST | `/imports` | `{ text, filename }`: a Goodreads / StoryGraph / Letterboxd CSV or MyAnimeList XML → `{ format, added, updated, trophies }` |
| GET | `/calendar` | coming up: `[{ kind: episode\|release, date, title, detail, item_id }]` (`?refresh=1` skips the 6 h cache) |
| GET | `/trophies` | `{ trophies, counts, kinds }`. Items that earn one return `new_trophy`; a `trophy.earned` event is emitted |

## Game platforms and data services (scope `write`)

| Method | Path | |
|---|---|---|
| GET | `/connectors` | Steam / Xbox / PlayStation status (secrets are never returned) |
| PUT | `/connectors/:name` | save fields (`api_key`, `profile`, `npsso`, `accept_risk`) |
| POST | `/connectors/:name/sync` | `{ games, added, updated, minutes, perfect, new_trophies }` |
| DELETE | `/connectors/:name` | forget the credentials (games stay) |
| GET / PUT | `/services`, `/services/:name` | TMDB (`token`) and IGDB (`client_id`, `client_secret`) keys |

Connectors come in two groups (`group` in `GET /connectors`):

| Group | Connector | Needs | Brings in |
|---|---|---|---|
| games | `steam` | Web API key + public profile | games, play time, achievements |
| games | `xbox` | OpenXBL key | games, achievements |
| games | `psn` | NPSSO (unofficial, opt-in) | games, trophies, play time |
| games | `retroachievements` | username + Web API key | retro games; mastered → golden controller |
| media | `anilist` | username (public list) | anime + manga: status, progress, score |
| media | `mal` | MAL Client ID + username | anime + manga |
| media | `trakt` | Trakt Client ID + username (public profile) | movies, shows per season (anime genre → anime), ratings, watchlist |
| media | `hardcover` | API token | books: shelves, ratings, progress |
| media | `letterboxd` | username | latest ~50 diary entries (RSS) |
| media | `goodreads` | profile URL or id | Read / Currently Reading / Want to Read (RSS) |
| media | `lastfm` | API key + username | top 200 albums with play counts |

Sync results: `{ items, games, added, updated, minutes, perfect, new_trophies }`.
Re-syncing updates items in place (keyed by the service's id).

## Auto-tracking from media servers

`POST /scrobble/:service?key=tb128_…` with a key that has `ingest`. The key goes
in the URL because media servers can't set headers, so use a key that can only
send events.

| `:service` | Set up | Counts |
|---|---|---|
| `plex` | Settings → Webhooks (Plex Pass). Multipart is fine | `media.scrobble` |
| `jellyfin` | Webhook plugin → Generic destination | `PlaybackStop` with `PlayedToCompletion`, or marked played |
| `emby` | Settings → Webhooks | `playback.stop` when finished, `item.markplayed` |
| `generic` | any JSON (Kodi add-ons, Tautulli, Home Assistant, Tasker) | `{ "type": "movie", "title" }` or `{ "type": "episode", "show", "season", "episode" }` |

Each becomes a `movie.watched` or `episode.watched` event (`source` = the service).
The same thing on the same day counts once. Episodes are looked up on TVmaze for
the season's episode count and whether the show is anime, so finishing a season
earns the golden TV, or the golden idol for anime. Other payloads return
`{ "status": "ignored" }`.

## 128bit family account (scope `write`)

| Method | Path | |
|---|---|---|
| GET | `/family` | `{ signed_in, email, last_sync_at, pulled_total, pushed_total }` |
| POST | `/family/signin` · `/family/signup` | `{ email, password }` (optional `url`/`key` for your own Supabase project) |
| POST | `/family/sync` | push Tracker's shared events, pull the family feed → `{ pulled, pushed }` |
| POST | `/family/signout` | |

Tracker shares `habit.completed`, `streak.milestone`, `streak.frozen`, `trophy.earned`,
`item.completed`, `item.started` and `item.rated` to the feed as `app: "tracker"`. From
128bitPlay it understands `book.finished`, `movie.watched`, `episode.watched` and
`chapter.read` (from any source, not only Play). Anime episodes become anime items
and earn the golden idol. Everything else shows on the timeline.
