# 128bit Tracker

The 128bit family's record-keeper. Log anything in seconds, build streaks,
and see your whole life — workouts, money, music, all of it — on one
timeline. 128bitlife plays the game; Tracker keeps the score.
Part of the 128bit family.

> Product direction is Daniel's call. The landing page (`index.html`) is
> live, and v0.1 of the app now lives in `src/` + `public/`.

## Connected: everything → one timeline

[`timeline.html`](timeline.html) is a working, web-first timeline. It signs in to the user's
own Supabase project and shows, newest first and grouped by day, with filters per source:

| Source | How it gets here |
|---|---|
| **128bitPlay** | Books, movies, episodes, comic chapters, posted to the family feed when signed in. |
| **128bitfit** | Workouts (strength and cardio), opt-in under its Settings → 128bit family. |
| **Google Health** | Daily Health Connect totals (steps, sleep, resting HR, active kcal, distance; never weight), opt-in through 128bitfit. Health Connect has no web API, so the phone sends them. |
| **Trakt** | Read directly, reusing 128bitPlay's Trakt sign-in. |
| **Hardcover** | Books marked Read, reusing 128bitPlay's token (or paste one). |
| **Log anything** | Two taps: type it (plus an amount) or tap a recent chip. Posts `habit.completed`. |
| **Any app** | Zapier, IFTTT, Tasker, iOS Shortcuts, scripts: a personal key and one HTTP POST. |

Duplicates (a Play episode that Trakt also scrobbled, a book Hardcover also has) show once,
tagged "also on Trakt".

- Feed SQL: [`supabase/family.sql`](supabase/family.sql). 128bitPlay's setup SQL includes it;
  projects set up earlier just run it again.
- Schema and API: [`docs/EVENTS.md`](docs/EVENTS.md), types in [`src/events.ts`](src/events.ts).

Open `timeline.html` from GitHub Pages (or any static host) and sign in with your
**128bit family account**: Continue with Google, Continue with Apple, or email and password,
the same account as 128bitPlay and 128bitfit. The family Supabase project is built in;
"Use my own Supabase project" points it elsewhere. Google and Apple need the page's address in
Supabase → Authentication → URL Configuration → Redirect URLs.

## Android app (APK)

The phone app lives in [`mobile/`](mobile/README.md). It is the same Tracker
running fully offline on the device, and it syncs with a Tracker server so
128bitplay and the other 128bit apps can reach it, and so your data is backed up.

**Download:** grab the latest `.apk` from
[Releases](https://github.com/Hootywhooo86/128bittracker/releases). Bumping
`"version"` in `mobile/package.json` publishes a new release automatically.

## Run the server

To put it online for 128bitplay and phone sync, see
[docs/SERVER.md](docs/SERVER.md) (Docker, Railway, Fly.io, VPS or home).

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

## What's in v0.4

- **128bit family account**: sign in with the same account as 128bitPlay and
  128bitfit. Books, movies, episodes and comics from Play and workouts from Fit
  flow into the Library and habits, and Tracker shares streaks, trophies and
  finished things back to the family feed.
- **Golden trophies**: 100% a game → golden controller, finish a movie →
  golden VHS, finish a show season → golden TV, finish an anime series →
  golden idol. Trophy shelf on Stats.
- **Game platforms**: Steam (official API), Xbox (OpenXBL), PlayStation
  (unofficial, opt-in) and RetroAchievements bring in play time, achievements
  and 100%s.
- **Media accounts** (all free): AniList, MyAnimeList, Trakt, Hardcover,
  Letterboxd, Goodreads and Last.fm keep your lists in step.
- **Auto-tracking**: Plex, Jellyfin and Emby webhooks (or any JSON) log what
  you finish. Anime is detected, so it earns the golden idol.
- **Your library in the cloud, per account**: sign in with your 128bit account
  (email, Google or Apple) and your library, lists and trophies are on every
  device. Everyone gets their own; nothing is shared unless you make a list or
  your profile public.
- **Lists**: ordered lists of anything, shown as rows in 128bitPlay. Plus Up
  Next, Watchlist and a Coming Up calendar, all readable by the other 128bit
  apps (`docs/TRACKER-RPC.md`).
- **128bit Connect**: one-tap Connect for AniList, Trakt and MyAnimeList. Your
  changes go back to them. No API keys for anyone: 128bit lends its own for
  TMDB, Steam, IGDB, Last.fm and RetroAchievements (`docs/SUPABASE-SETUP.md`).
- **Title search**: covers, years, creators and lengths from Open Library,
  AniList, TVmaze, iTunes, the Steam store, plus TMDB and IGDB with keys.
- **Imports**: Goodreads, StoryGraph, Letterboxd, MyAnimeList.
- **Coming up**: next episodes and game release dates on the Timeline.

## Earlier (v0.1–v0.3)

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
    play.js            # 128bitPlay game.* and media events → Library
    family.js          # any event → trackers that `listen` for it
    family-account.js  # 128bit family sign-in + family feed sync (Supabase)
    connectors/        # Steam, Xbox, PlayStation, RetroAchievements, AniList, MAL,
                       # Trakt, Hardcover, Letterboxd, Goodreads, Last.fm
    scrobble.js        # Plex / Jellyfin / Emby / generic webhooks
    metadata.js        # title search (Open Library, AniList, TVmaze, …)
    imports.js         # Goodreads, StoryGraph, Letterboxd, MyAnimeList
    calendar.js        # coming up: next episodes, game releases
  domain/trophies.js   # golden trophy rules
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

Done: reminders, backups, family account, trophies, Steam/Xbox/PlayStation,
search, imports, calendar, media accounts, Plex/Jellyfin/Emby auto-tracking,
cloud library per account, lists in 128bitPlay, Google/Apple sign-in,
128bit Connect with two-way sync.

Next up:
1. **Friends**: follow people's public profiles, see their activity.
2. **Year in review** card you can share.
3. **Body & health trackers**: weight and measurements with charts (or pull
   from 128bitfit), sleep from phone health APIs.
4. **Native SQLite on the phone** (swap `mobile/src/adapter.js`) once
   histories get large.
5. **Play Store listing.**

Later:
- Correlations ("you sleep better on workout days"), a Pro candidate
- Spotify via 128bitmusic
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
