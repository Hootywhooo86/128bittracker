# The databases behind 128bit Tracker

128bit Tracker is its own tracker. People make **one 128bit account**, and Tracker
looks up movies, TV, anime, books and games from the databases below, using
**your** keys, stored once in Supabase. Users never connect anything, and no
other tracker (Trakt etc.) is involved.

## Where the keys go (all of them)

1. Open https://supabase.com/dashboard/project/wvflpwtaszpstmjpkrhu
2. Left sidebar → **Edge Functions** → the **Secrets** tab.
3. **Add new secret**: *Name* exactly as written below, *Value* = the key. Save.
4. Live within a minute for every user. No app update needed.

A key saved inside the app (Sync → Advanced) only works on that one phone. Keys
in Supabase work for everyone.

---

## Must have

### 1. TMDB: movies and TV
Search, posters, backdrops, cast, seasons with episode counts, next episode dates.

1. Make an account at https://www.themoviedb.org/signup and confirm the email.
2. Avatar → **Settings** → **API** → **Create** / *Request an API Key* → **Developer**.
3. Accept the terms, then fill in the app form. For Application Name use `128bit Tracker`; for URL use the GitHub repo or your site; for summary write "Personal media tracker".
4. On the API page, copy the long **API Read Access Token** (starts with `eyJ…`).

| Secret name | Value |
|---|---|
| `TMDB_TOKEN` | the API Read Access Token |

Free for non-commercial use. If you ever charge money, TMDB needs a commercial
licence. The app must show TMDB's logo with "This product uses the TMDB API but
is not endorsed or certified by TMDB". Tracker shows this under your account on the Sync / Connect screen.

### 2. IGDB: games
Game search, covers, developers, release dates (Coming up shows them).

1. Sign in at https://dev.twitch.tv/console with a Twitch account. **Two-factor authentication must be on**: twitch.tv → Settings → Security.
2. **Applications** → **Register Your Application**:
   - Name: `128bit Tracker` (it must be unique on Twitch; add a word if it's taken)
   - OAuth Redirect URLs: `http://localhost`
   - Category: *Application Integration*
   - Client Type: **Confidential**
3. **Create** → **Manage** → copy the **Client ID**. Then **New Secret** → copy the secret (it's shown once).

| Secret name | Value |
|---|---|
| `TWITCH_CLIENT_ID` | Client ID |
| `TWITCH_CLIENT_SECRET` | Client Secret |

Free. Check Twitch's developer terms before charging money.

---

## Built in, no key needed

These already work for everyone, nothing to set up:

| Database | Gives Tracker |
|---|---|
| **TVmaze** | TV schedules, seasons, episode counts, anime detection. Credit "Data from TVmaze" (CC BY-SA). |
| **AniList** (catalog) | Anime and manga search, episode and chapter counts, next airing episode. |
| **Open Library** | Book search, covers, authors, page counts. |
| **Steam Store** | Game search and release dates when IGDB isn't set up. |
| **iTunes Search** | Podcasts and music albums. |

---

## Nice to have: users type only a profile name

| Secret name | What it adds | Where to get it |
|---|---|---|
| `STEAM_API_KEY` | Steam play time and 100% achievements (golden controller) from just the user's Steam profile | https://steamcommunity.com/dev/apikey. The Steam account needs at least $5 spent. Domain: anything, e.g. `128bit` |
| `RA_API_KEY` | Retro games (NES to PS2) and mastery trophies from a RetroAchievements username | Make an account at retroachievements.org → **Settings** → **Keys** → *Web API Key* |
| `LASTFM_API_KEY` | Music: top albums with play counts from a Last.fm username | https://www.last.fm/api/account/create. Name `128bit Tracker`; the callback can be left empty. Copy the **API key** (not the shared secret) |

---

## Not needed

`TRAKT_*`, `ANILIST_CLIENT_*` and `MAL_CLIENT_*` are only for importing someone's
old history from those services ("Moving from another tracker?"). Leave them out
and that one-time import simply says it isn't set up. Nothing else changes.

## Check it works

1. Open Tracker signed in with your 128bit account.
2. Library → **+ ADD** → type **movie** → search `Alien`: posters and years come from TMDB.
3. Type **game** → search `Zelda`: covers come from IGDB.
4. Add a show you're watching (pick its season). **Today → Up next** and
   **Timeline → Coming up** fill in on their own.
