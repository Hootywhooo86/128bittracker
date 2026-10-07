# 128bit Tracker

The 128bit family's record-keeper. Log anything in seconds, build streaks,
and see your whole life — workouts, money, music, all of it — on one
timeline. 128bitlife plays the game; Tracker keeps the score.
Part of the 128bit family.

> Product direction is Daniel's call — this README is a starter brief so
> Carlos (Claude Code) has something concrete to react to. The landing page
> is live, and so is the first slice of the family timeline (below); the
> rest of the app is unstarted.

## Connected: 128bitPlay → timeline

[`timeline.html`](timeline.html) is a working, web-first family timeline. It
signs in to the user's own Supabase project (the one 128bitPlay's
**Settings → Account** uses) and lists every event in the family feed,
newest first, grouped by day, with **Load older**.

- **128bitPlay** posts `book.finished`, `movie.watched`, `episode.watched`
  and `chapter.read` as you finish things (queued on the phone, sent when
  signed in).
- The feed is the `family_events` table plus two RPCs, `log_events` and
  `get_events`, created by 128bitPlay's setup SQL. Projects set up earlier:
  run that SQL again; it only adds what's missing.
- Schema: [`docs/EVENTS.md`](docs/EVENTS.md) and
  [`src/events.ts`](src/events.ts). Tracker's own `habit.completed` /
  `streak.*` and the sibling apps' types are listed there as planned; the
  timeline already shows unknown types, so siblings can start posting
  whenever.

Open `timeline.html` from GitHub Pages (or any static host) or locally,
then enter the project URL, anon key, email and password.

## Concept (starter — Daniel decides)

A universal tracker with two jobs:

1. **Log anything.** Habits, water, sleep, moods, meds — two-tap logging,
   custom trackers, reminders. Streaks with streak-freezes (consistency >
   perfection), completion rates, trends.
2. **The family timeline.** Subscribes to the shared 128bit event feed and
   renders every event from every sibling app on one timeline:
   `workout.logged` (fit), `budget.updated` (gold), `track.played` (music),
   `matchup.won` (fantasy), `booking.made` (trip). Tracker doesn't issue
   quests — that's 128bitlife's job. Tracker keeps the record.

## Architecture — log fast, aggregate honestly

```
src/
  trackers/
    custom/      # User-defined trackers: name, type (count/duration/
                 # check/binary, scale), target, reminder schedule.
    presets/     # Water, sleep, reading, mood, meds — one-tap enable.
  streaks/       # Streak engine: chains, freezes, recovery rules,
                 # "never miss twice" nudges. No shame spirals.
  timeline/
    feed/        # Subscribes to the shared 128bit event schema.
    views/       # Day / week / month / "year in pixels" aggregations.
  stats/         # Completion rates, best streaks, correlations
                 # ("you sleep better on workout days").
  events.ts      # 128bit shared event schema — emit habit.completed,
                 # streak.milestone, streak.frozen, etc.
                 # 128bitlife subscribes for quests + XP.
```

Rules:
- **Two taps to log.** If logging takes longer, the design failed.
- **Tracker records; Life rewards.** No quests, no XP logic here — emit
  events and let 128bitlife do the game layer.
- **Streaks are forgiving by design.** Freezes, rest days, and recovery —
  the engine should encourage, not punish.
- **Local-first.** Tracker data is personal; sync is opt-in, never required.
- Never store raw credentials in the repo.

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
