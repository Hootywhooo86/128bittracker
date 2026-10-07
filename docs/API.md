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

## Writing (scope `write`)

| Method | Path | Body |
|---|---|---|
| POST | `/trackers` | `{ preset }` or `{ name, kind: check\|count\|duration\|scale, target, unit, icon, color, listens }` |
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
| POST | `/sync/outbox` | array of the phone's own events (`source: "128bittracker"`). Stored and sent to webhooks, idempotent by `id` |
