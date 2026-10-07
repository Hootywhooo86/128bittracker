# 128bit Tracker

The 128bit family's record-keeper. Log anything in seconds, build streaks,
and see your whole life — workouts, money, music, all of it — on one
timeline. 128bitlife plays the game; Tracker keeps the score.
Part of the 128bit family.

> Product direction is Daniel's call. The landing page (`index.html`) is
> live, and v0.1 of the app now lives in `src/` + `public/`.

## Android app (APK)

The phone app lives in [`mobile/`](mobile/README.md). It is the same Tracker
running fully offline on the device, and it syncs with a Tracker server so
128bitplay and the other 128bit apps can reach it, and so your data is backed up.

**Download:** grab the latest `.apk` from
[Releases](https://github.com/Hootywhooo86/128bittracker/releases). Bumping
`"version"` in `mobile/package.json` publishes a new release automatically.

## Run the server

Needs Node 22.5+ and nothing else: no `npm install`, no database server.

```bash
npm start          # http://127.0.0.1:8128
npm test
```

| Env var | Default | |
|---|---|---|
| `PORT` / `HOST` | `8128` / `127.0.0.1` | |
| `TRACKER_DB` | `data/tracker.db` | one SQLite file, gitignored |
| `TRACKER_PASSWORD` | unset | unset = UI works from this machine only. Set it to log in from your phone / network |
| `TRACKER_SECRET` | random | signs login cookies; set it so logins survive restarts |
| `TRACKER_CORS_ORIGINS` | none | comma-separated origins allowed to call the API from a browser |

## What's in v0.1

- **Today**: habit trackers (done / count / duration / 1–5 scale), presets,
  two-tap logging, undo, a 30-day pixel strip, forgiving streaks with freezes
  and "never miss twice" nudges.
- **Library**: track anything you play, watch, read or listen to (games,
  movies, shows, books, anime, manga, comics, podcasts, music, courses).
  Status, progress, sessions and time spent, 1–10 ratings, reviews,
  collections.
- **Timeline**: one feed for every 128bit app's events.
- **Stats**: completion rates, streaks, finished this year, time logged,
  year in pixels.
- **Connect**: scoped API keys, signed outbound webhooks, JSON export.
- **128bitplay integration**: games, sessions, completions and achievements
  sync into the Library on their own. See [`docs/API.md`](docs/API.md).

## Architecture

```
src/
  server.js            # node:http server, static UI + /api/v1
  db/                  # schema + migrations (shared), node:sqlite (server)
  domain/
    trackers.js        # habit CRUD, presets, logging, freezes
    streaks.js         # streak engine (pure, unit-tested)
    library.js         # items, sessions, collections
    events.js          # 128bit envelope + timeline
    stats.js           # overview + year in pixels
    apikeys.js         # hashed, scoped API keys
    webhooks.js        # webhook CRUD + signed delivery (server only)
  integrations/
    index.js           # POST /events: idempotent, atomic per event
    play.js            # 128bitplay game.* → Library
    family.js          # any event → trackers that `listen` for it
  api/                 # router, auth; core-routes.js is shared with the phone
public/                # the pixel app UI (vanilla JS), shared by web + Android
mobile/                # Android app (Capacitor + sql.js), see mobile/README.md
docs/API.md            # API reference for 128bitplay & siblings
test/                  # node:test
```

Rules:
- **Two taps to log.** If logging takes longer, the design failed.
- **Tracker records; Life rewards.** No quests, no XP logic here. Emit
  events and let 128bitlife (or 128bitplay) do the game layer.
- **Streaks are forgiving by design.** Freezes, rest days, and recovery.
  The engine should encourage, not punish.
- **Local-first.** Tracker data is personal; sync is opt-in, never required.
- Never store raw credentials in the repo.

## Roadmap (proposed — Daniel decides)

Done since v0.1: daily reminders on Android, automatic server backups with
one-tap restore, JSON import.

Next up:
1. **Metadata search**: look up a title and fill in cover, year and creator
   automatically (IGDB for games, TMDB for film/TV, Open Library for books,
   AniList for anime/manga, iTunes for podcasts).
2. **Imports**: Goodreads / StoryGraph CSV, Letterboxd, Trakt, MyAnimeList,
   Steam playtime, so nobody starts from zero.
3. **Upcoming calendar**: next episodes of shows you're watching, release
   dates for planned games.
4. **Body & health trackers**: weight and measurements with charts (or pull
   from 128bitfit), sleep from phone health APIs.
5. **Native SQLite on the phone** (swap `mobile/src/adapter.js`) once
   histories get large.
6. **Play Store listing.**

Later:
- Correlations ("you sleep better on workout days"), a Pro candidate
- Year-in-review card you can share (pixel art, obviously)
- Shared lists / friends' activity (opt-in), household trackers
- Media-server integrations (Jellyfin/Plex/Kodi scrobbling), Spotify via 128bitmusic
- Pixel themes & badge packs (cosmetic IAP)

## Start-here brief for Claude

```
We're building 128bit Tracker — the 128bit family's record-keeper:
universal habit logging + a timeline of the shared 128bit event feed.
Read this README first.

Build order:
1. src/trackers/ — custom tracker CRUD + presets (water, sleep, mood,
   meds). Two-tap logging is the whole UX bet — nail this first.
2. src/streaks/ — streak engine: chains, freezes, "never miss twice"
   nudges. Forgiving by design.
3. src/events.ts — shared 128bit event schema; emit habit.completed,
   streak.milestone. (Check sibling repos for the schema stub.)
4. src/timeline/feed/ — subscribe to sibling-app events, render one
   unified timeline (day/week/month).
5. UI: pick the stack (Expo to match the 128bit family, or web-first —
   ask Daniel). Tabs: Today, Streaks, Timeline, Stats.
6. src/stats/ — completion rates, trends, gentle correlations.

Constraints: two taps to log. Tracker records, Life rewards — no quest
or XP logic here. Local-first, sync opt-in. Small commits. Never commit
credentials.
```

## 128bit tie-in

Tracker is the family's memory: `habit.completed` and `streak.milestone`
events flow into the shared feed so 128bitlife can issue quests ("keep
the streak alive") and XP. It also *reads* the feed — every sibling app's
events land on Tracker's timeline. Don't silo the data.

## Monetization (family default)

128bit Pro bundle covers Tracker. Core logging and streaks are free;
advanced stats (correlations, year-in-pixels exports) can sit behind Pro
later. Cosmetic IAPs (themes, badges) like the rest of the family.
