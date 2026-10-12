# Setting up the 128bit family Supabase project for Tracker

Project: **128bit play** (`wvflpwtaszpstmjpkrhu`), at
https://supabase.com/dashboard/project/wvflpwtaszpstmjpkrhu

## Already done (installed from the build session)

- ✅ `supabase/family.sql`: the family feed, keys and account deletion.
- ✅ `supabase/tracker.sql`: the cloud library, lists, trophies, calendar and
  profiles; the functions 128bitPlay reads; and the trigger that files
  Play's watches into the library.
- ✅ Edge Function **`connect`** (128bit Connect), deployed with *Verify JWT
  off*. It checks the 128bit sign-in itself, and `/callback` is opened by
  browsers.

To reinstall from scratch:
1. SQL Editor → New query → paste `supabase/family.sql`, Run.
2. Then the same with `supabase/tracker.sql`. Both are safe to run again.
3. For the function: `npx supabase functions deploy connect --project-ref wvflpwtaszpstmjpkrhu --no-verify-jwt`.

## 1. Sign-in redirect links (2 min)

**Authentication → URL Configuration → Redirect URLs → Add URL**, one at a time:

```
app.bit128.tracker://auth
bit128://auth-callback
```

The first is Tracker's Google/Apple sign-in. The second is 128bitPlay's; skip it
if it's already there. If you run a Tracker server on the web, also add
`https://<your tracker address>/connect`.

## 2. Google and Apple sign-in (skip if 128bitPlay already has them on)

**Authentication → Sign In / Providers**:

- **Google**: switch it on. You need a Client ID and Secret from Google Cloud Console:
  1. APIs & Services → Credentials → Create credentials → OAuth client ID → *Web application*.
  2. Under *Authorized redirect URIs* add `https://wvflpwtaszpstmjpkrhu.supabase.co/auth/v1/callback`.
  3. Paste the Client ID and Secret into Supabase and Save.
- **Apple**: needs an Apple Developer account. Follow the steps on the Supabase
  Apple page. Use the same callback URL as above.
- **Email**: keep it on so people can sign up with email and a password.

While you're there: **Authentication → Sign In / Providers → Email →
"Prevent use of leaked passwords"** → on. Supabase's security advisor flags it.

## 3. Register 128bit with each service (once, ~2 min each)

Each service gives you a key or an ID+secret. They go into **Edge Functions →
Secrets** (step 4), never into the app or a chat.

The callback URL for AniList, Trakt and MyAnimeList is:

```
https://wvflpwtaszpstmjpkrhu.supabase.co/functions/v1/connect/callback
```

| Service | Where | What to fill in | Secrets it gives you |
|---|---|---|---|
| **AniList** | anilist.co → Settings → Developer → *Create New Client* | Name `128bit Tracker`, Redirect URL = the callback above | `ANILIST_CLIENT_ID`, `ANILIST_CLIENT_SECRET` |
| **Trakt** | trakt.tv/oauth/applications → *New Application* | Name `128bit Tracker`, Redirect URI = the callback above, tick `/scrobble` | `TRAKT_CLIENT_ID`, `TRAKT_CLIENT_SECRET` |
| **MyAnimeList** | myanimelist.net/apiconfig → *Create ID* | App Type **web**, Name `128bit Tracker`, Redirect URL = the callback above, Homepage `https://github.com/Hootywhooo86/128bittracker` | `MAL_CLIENT_ID`, `MAL_CLIENT_SECRET` |
| **TMDB** | themoviedb.org → Settings → API (you have this) | — | `TMDB_TOKEN` (the long *API Read Access Token*) |
| **Steam** | steamcommunity.com/dev/apikey | Domain: `128bit` | `STEAM_API_KEY` |
| **IGDB (Twitch)** | dev.twitch.tv/console/apps → *Register Your Application* | Name `128bit Tracker`, OAuth Redirect `http://localhost`, Category *Application Integration*, Client type *Confidential*, then *New Secret* | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` |
| **Last.fm** | last.fm/api/account/create | Application name `128bit Tracker` | `LASTFM_API_KEY` |
| **RetroAchievements** | retroachievements.org → Settings → Keys | — | `RA_API_KEY` |

Every one is optional. Without a secret, that service's Connect button or
no-key lookup says "isn't set up yet", and people can still type their own
key in the app.

## 4. Put the secrets in

**Edge Functions → Secrets** (sidebar: *Edge Functions*, then the *Secrets*
tab) → *Add new secret*. Name exactly as below, paste the value, Save:

```
ANILIST_CLIENT_ID
ANILIST_CLIENT_SECRET
TRAKT_CLIENT_ID
TRAKT_CLIENT_SECRET
MAL_CLIENT_ID
MAL_CLIENT_SECRET
TMDB_TOKEN
STEAM_API_KEY
TWITCH_CLIENT_ID
TWITCH_CLIENT_SECRET
LASTFM_API_KEY
RA_API_KEY
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase
automatically. Don't add them. New secrets are live within a minute; nothing
needs redeploying.

## 5. 128bitPlay

1. Merge the 128bit-MTAB pull request "128bit Tracker as a source". It sits on
   the family-account branch, so merge that first.
2. Build Play as usual.
3. Sign in to Play and Tracker with the **same** 128bit account.
4. In Tracker: Library → **+ NEW LIST** → keep *Show in 128bitPlay* on → add movies or shows.
5. Open Play → Movies (or Shows / Anime). The list is a row: "<name> · Tracker".
   Up next and Watchlist rows come from Tracker too.
6. Play → Settings → Tracking → *Tracker rows* turns them off. Trakt keeps
   working alongside until you unlink it.

## 6. Check that everyone gets their own

1. Make a second account (Tracker → Sync/Connect → CREATE ACCOUNT, another email).
2. Sign in to Play with it: no lists of yours, only an empty-state hint.
3. On a phone signed in as you, signing in as the second account asks to
   *switch to their own library*. Yours stays on the phone, untouched.
4. Your lists stay private until you tick *Public* on a list. The profile is
   private until you switch it on (Sync → 128bit family account → Public profile).

The same checks run automatically against a real Postgres copy:
`bash supabase/test/run.sh`.
