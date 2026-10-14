# Sunday list

Requests saved for Sunday's session (nothing here is built yet).

1. **128bitPlay on Android TV: can't reach the Sign in button with the remote.**
   Settings → Account on the TV: focus goes Email → Password → skips "Sign in" and
   "Create account" → jumps to the SQL setup section. The buttons need to be
   focusable (D-pad) on TV. Workaround today: "Sign in with your phone" (QR / code
   on the TV, phone → Settings → Account → Sign in a TV).

2. **Listening / watching sessions must add up to the real time.**
   Example (Oct 14): "🎧 Masquerade · 7 min · 3%", 3:10–4:05 PM, while the player sat at
   59:41. Time is counted from the app's ticks, which stop when the screen is off or the
   app is in the background, so long listens undercount; the start/stop positions weren't
   on the line either.
   - Count a sitting by where you started and stopped in the book/video (position
     difference, per chapter), not by ticks; keep ticks only as a fallback.
   - Write a checkpoint about once an hour during long sittings, so nothing is lost if the
     app is closed, and the total listened time in Play's stats matches the sessions.
   - Check audiobooks across chapters and with the screen off.

3. **Steps every 3 hours.** Read Health Connect (and take Fit's count) every 3 hours, also
   when Tracker isn't open: a background job (Android WorkManager / background task) plus
   the Health Connect background-read permission. Today it only reads while Tracker is
   open (on open, every 30 min, or READ NOW).

4. **All books and audiobooks: better databases.** Today Tracker's book search is Open
   Library only (thin on new, indie and audiobook-only titles like *Book of the Dead*).
   Add, in this order:
   - **Audible catalog** (`api.audible.com/1.0/catalog/products`): no key needed. Checked
     Oct 14: finds *Masquerade* by RinoZ (ASIN B0FFBMSL71) with series and pre-order dates.
   - **Google Books**: needs a key (the shared no-key quota is used up; this also feeds the
     audiobook / book release dates on the calendar).
   - **Hardcover**: needs a token. Series order ("next in series") and upcoming releases.
   - Route Google Books and Hardcover through the 128bit Connect Edge Function like TMDB,
     so users never connect anything.

   **API keys to get before Sunday** (free; put them in Supabase → project
   `wvflpwtaszpstmjpkrhu` → Edge Functions → **Secrets**, same as `TMDB_TOKEN`):

   | Secret name | Where to get it |
   |---|---|
   | `GOOGLE_BOOKS_KEY` | console.cloud.google.com → create a project → APIs & Services → Library → enable **Books API** → Credentials → **Create credentials → API key** (optionally restrict it to the Books API) |
   | `HARDCOVER_TOKEN` | hardcover.app → sign up → Settings → **API** → copy the token (starts with `Bearer …`; paste it without "Bearer ") |
   | *(Audible)* | nothing needed |

   Still waiting from before (optional, for games/music): `TWITCH_CLIENT_ID` +
   `TWITCH_CLIENT_SECRET` (IGDB), `STEAM_API_KEY`, `RA_API_KEY`, `LASTFM_API_KEY`
   (see docs/DATABASES.md).

5. **Search for audiobooks.** Tracker's search has no audiobook option. Add an
   **Audiobook** choice in Add / Search (Audible first, then Google Books / Open Library),
   saving the item as a book with `format: audiobook`, narrator, length and ASIN.

6. **Audiobooks get their own colour and trophy.**
   - Books stay **brown**. Audiobooks are **orange** (calendar dots, Continue group,
     timeline, library tiles, settings → Colours). Pick an orange that isn't the headings'
     orange (#ff9f1c), e.g. #f97316.
   - Finishing an audiobook earns a **golden CD with a book on the cover** (new trophy
     beside the golden VHS / TV / idol / controller), on the timeline and in Stats.
