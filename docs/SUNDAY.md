# Sunday list

Requests saved for Sunday's session. Items marked ✅ were built early (Tracker v0.13.0, Oct 16).

**Start: Sunday Oct 18, 10:30 AM Edmonton time (America/Edmonton, MDT = UTC−6).**

1. **128bitPlay on Android TV: can't reach the Sign in button with the remote.**
   Settings → Account on the TV: focus goes Email → Password → skips "Sign in" and
   "Create account" → jumps to the SQL setup section. The buttons need to be
   focusable (D-pad) on TV. Workaround today: "Sign in with your phone" (QR / code
   on the TV, phone → Settings → Account → Sign in a TV).

2. **⭐ TOP PRIORITY: Listening / watching sessions must add up to the real time.**
   Example (Oct 14): "🎧 Masquerade · 7 min · 3%", 3:10–4:05 PM, while the player sat at
   59:41. Time is counted from the app's ticks, which stop when the screen is off or the
   app is in the background, so long listens undercount; the start/stop positions weren't
   on the line either.
   - Count a sitting by where you started and stopped in the book/video (position
     difference, per chapter), not by ticks; keep ticks only as a fallback.
   - Write a checkpoint about once an hour during long sittings, so nothing is lost if the
     app is closed, and the total listened time in Play's stats matches the sessions.
   - Check audiobooks across chapters and with the screen off.
   - **Full review of audiobook listening sessions (asked again Oct 15):** go through the
     whole path end to end and test it on the phone, not just in code:
     - Play `lib/player.tsx` (listening ticks, pause, chapter change, book finished),
       `lib/sessions.ts` (start / end, 10-minute idle split, under-a-minute drop),
       `lib/family.ts` (queue + send), then Tracker's timeline line.
     - Screen off / app in background / phone locked; switching books; seeking; speed
       above 1×; sleep timer; streaming from TorBox vs downloaded.
     - Positions on the line ("Ch 1 59:41 → …") must always show; the Oct 14 Masquerade
       line had none.
     - One sitting = one line (no splits every few minutes, no lost sittings), and the
       session minutes for a day add up to Play's "time listened" stat.

   ✅ **DONE Oct 16 (Tracker side only).** The timeline line always shows every position that
   came with a sitting (`Ch 1 4:41 → Ch 1 59:41`, or just one end), and a sitting's minutes
   come from the position difference when Play's tick count is smaller (same chapter, or no
   chapters; capped at the clock time between start and stop; across chapters the ticks
   stand). Old lines are corrected on display too. Code: `public/sitting.js` (shared by the
   timeline and `family-account.js` titles), test `test/sitting.test.js`.
   **Left (Play repo):** counting by position per chapter in `lib/player.tsx` / `lib/sessions.ts`,
   hourly checkpoints, always sending `from_*` / `to_*`, and the on-phone review above.

3. **Steps every 3 hours.** Read Health Connect (and take Fit's count) every 3 hours, also
   when Tracker isn't open: a background job (Android WorkManager / background task) plus
   the Health Connect background-read permission. Today it only reads while Tracker is
   open (on open, every 30 min, or READ NOW).

   ✅ **DONE Oct 16 (as far as it can go without native code).** Tracker reads Health
   Connect on every open and resume, every 30 min while on screen, and every 3 hours while
   the app is still running in the background (`mobile/src/main.js`, `healthCheck`). Each
   read covers the last 7 days and Health Connect keeps the history, so steps taken while
   Tracker was closed are never lost: they arrive on the next open, on the right day (the
   day buckets are the phone's local days; checked in the plugin's source).
   **Not done:** reading while Tracker is fully closed. That needs a native Android
   WorkManager job plus Health Connect's background-read permission
   (`READ_HEALTH_DATA_IN_BACKGROUND`), and the job can't write into the WebView's sql.js
   database, so it would have to queue the numbers for the app or post them to the cloud
   itself. Fit's count still arrives through the family feed whenever Tracker syncs.

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

   ✅ **Keys added on Oct 14** (`GOOGLE_BOOKS_KEY`, `HARDCOVER_TOKEN`). Sunday: check both
   respond through the Edge Function before building on them.

   ✅ **DONE Oct 16 (Audible + Google Books).** Book search = Open Library, then Google Books
   (deduped by title + author); Google Books goes through 128bit Connect when signed in and
   is skipped quietly if it answers 429 (shared quota, not signed in). Audible catalog
   search (no key) gives narrator, length, ASIN, series + number, release / pre-order date.
   Code: `src/integrations/metadata.js`; tests in `test/imports.test.js`.
   **Left:** Hardcover in search (series order / "next in series", upcoming releases), and
   checking Google Books through the Edge Function on the phone while signed in.

   **API keys** (free; they go in Supabase → project
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

   ✅ **DONE Oct 16.** Add / Search has an **audiobook** type (Audible first, then Google Books /
   Open Library); it saves a `book` with `meta.format: 'audiobook'`, narrator, `runtime_min`,
   ASIN, series and release date. Adding from a list named "…audio…" starts on audiobook.
   API: `GET /api/v1/search?type=audiobook&q=…`.

6. **Audiobooks get their own colour and trophy.**
   - Books stay **brown**. Audiobooks are **orange** (calendar dots, Continue group,
     timeline, library tiles, settings → Colours). Pick an orange that isn't the headings'
     orange (#ff9f1c), e.g. #f97316.
   - Finishing an audiobook earns a **golden CD with a book on the cover** (new trophy
     beside the golden VHS / TV / idol / controller), on the timeline and in Stats.

   ✅ **DONE Oct 16.** Audiobooks are #f97316 with their own picker in 🎨 Colours (books stay
   #a0522d): calendar dots + legend, Continue (🎧 Audiobooks, then 📖 Books), timeline
   (`listen.session` and Play's `book.finished`), and a coloured left edge on library tiles
   by kind. New trophy `cd`: the golden CD (pixel-art jewel case with an open book on the
   cover, the disc peeking out) for finishing a book with `format: audiobook`; Play's
   `book.finished` now marks the book as an audiobook. On the shelf in Stats and with its
   art on the timeline's trophy lines. Tests: `test/imports.test.js`, `test/family.test.js`.
   **Left:** Play's own audiobook items in the cloud library need `meta.format: 'audiobook'`
   to colour orange / earn the CD (worth checking from the Play side).

7. **Audiobooks: Tracker replaces Hardcover in 128bitPlay's Wanted flow.**
   You made an **Audiobooks** list in Tracker. That list becomes the source of what you
   want to listen to, instead of Hardcover's "Want to Read".
   - Today in Play: find a book → it goes to Hardcover (Want to Read) → Play's **Wanted**
     list (`lib/wanted.ts`, `importHardcoverWanted`) looks for it on AudiobookBay / your
     sources → one tap sends it to TorBox. Progress also syncs back to Hardcover
     (`lib/hardcover.ts`).
   - Sunday: Wanted reads (and adds to) the Tracker **Audiobooks** list: adding a book in
     Play or Tracker puts it on that list; Play finds a release and sends it to TorBox as
     now; listening progress and "finished" go to Tracker (already does) instead of
     Hardcover.
   - Everything audiobook-related lands on that list automatically (Play's history sync
     and "Add to Tracker" on audiobooks).
   - Hardcover becomes optional: keep it only as a one-time import of your current
     Want to Read into the Tracker list, then it can be switched off. (The server-side
     `HARDCOVER_TOKEN` still gives series / release data; that's data only, not your shelf.)
   - Goal: everything ours (Tracker), no outside account needed.

   **Added Oct 14 (details for 7):**
   - **Two-way:** adding a book to the Tracker **Audiobooks** list puts it in Play's
     **Wanted**; and every book in Play's Wanted *right now* moves onto the Tracker
     Audiobooks list (one-time move, then they stay in step).
   - **Hardcover is killed:** no Hardcover shelf, no Hardcover progress sync, no Hardcover
     button in the player. (Server-side Hardcover data for series / release dates can stay.)

8. **Ready-made lists for everyone.** The first time anyone opens Tracker (or signs in on
   a new account), it makes five lists: **Movies**, **Shows**, **Anime**, **Audiobooks**,
   **Comics**, each with the right kind and already placed on its tab in 128bitPlay
   (Audiobooks → Wanted, Comics → Comics). Never duplicated if they already exist (match
   by name + kind, e.g. your own "Amine" / "Audiobooks" lists).

   ✅ **DONE Oct 16.** Signed in: the first cloud sync of each account calls `starter_lists()`
   (once, remembered in kv `cloud.starter.<user>`) right after its push, and the pull brings
   the lists down. Not signed in: the five are made locally once on first run, skipping any
   you already have (same fuzzy name match as the SQL: movie|film, show|tv|series,
   anim|amine, audio|book, comic|manga|manhwa, else any list of that kind). Local starter
   lists still empty when you first sign in make way for the account's own, so no
   "Movies (2)". Code: `src/integrations/starter-lists.js`, `cloud.js`, `core-routes.js`;
   tests in `test/lists.test.js`.

9. **Play's Audiobooks tab only (not movies / shows): Library = books you have.**
   (Clarified Oct 15 with a screenshot of Audiobooks → Library / Downloads / Wanted.)
   - **Library**: the audiobooks you actually have (sent to TorBox or downloaded), each
     with its progress bar and %, keeping the All / Favorites / In progress / Finished
     filters. The **In progress** filter is the "main page in progress" with meters.
   - **Wanted** = the Tracker **Audiobooks** list (item 7): books you want but don't have.
   - When a Wanted book is grabbed (sent to TorBox), it **moves from Wanted to Library**,
     and in Tracker goes from planned to listening.
   - **Downloads** stays as is (copies saved on the phone for offline).

10. **Every 128bit app syncs everything when it opens.** Opening Play, Tracker or Fit runs
    a full sync in the background: pull and push the family feed and the cloud library /
    progress, so what you did in one app is in the others right away (Fit's steps and
    workouts in Tracker, Play's progress in Tracker, Tracker's lists in Play, …), and again
    when the app comes back to the foreground. Needs the same in 128bitFit's repo (not in
    this session yet).

11. **Everything on the phone's own time (Edmonton, America/Edmonton).**
    Days, "today", calendar dates and timeline times follow the phone's clock and time
    zone, never UTC. Found Oct 15: some code uses UTC dates
    (`new Date().toISOString().slice(0, 10)`), which after 6 PM Edmonton time (midnight
    UTC) already says *tomorrow*:
    - `src/integrations/calendar.js` (today, episode / anime / game / movie / book dates)
    - `src/integrations/scrobble.js` (day of a scrobble)
    - Supabase SQL using `current_date` / `now()::date` (e.g. `get_calendar`, the
      `tracker_apply_event` trigger): pass the phone's day / time zone instead.
    - Health Connect `health.day` events (stored as local 23:59, check the day boundary).
    - Check Play too (session times, Continue / Up next, stats days).
    Test with the phone set to Edmonton at 7 PM and at 11:30 PM.

    ✅ **DONE Oct 16 (Tracker).** `calendar.js` (today, AniList airing times, IGDB / Steam
    release days, TMDB / Google Books "still coming" checks) and `scrobble.js` use the
    device's local day (`toDay()`), never UTC. Checked: `health.js` (`health.day` stored as
    local 23:59 of the Health Connect day, whose buckets are local days), the web app's
    "today" / calendar / timeline grouping (all local). `test/timezone.test.js` runs with
    TZ=America/Edmonton at 7 PM and 11:30 PM.
    **Left:** Play (session times, Continue / Up next, stats days) and the Supabase trigger
    `tracker_apply_event`'s day (the calendar RPCs were done Oct 16).

12. **Play title page: show the whole backdrop image at the top.**
    (Screenshot Oct 15, *As a Reincarnated Aristocrat…*.) The backdrop starts halfway
    down, under an empty black header, and the poster + title sit on top of it, so most of
    the picture is hidden. Bring the image up to the top of the screen and let it show in
    full (taller banner behind the status bar / back button), with the poster, title and
    year below or along its bottom edge instead of covering it.
    Code: 128bit-MTAB `app/src/app/title.tsx` — `styles.hero` (height 240), `heroShade`,
    and `styles.body` (`marginTop: -80` pulls the info up over the image). Check phone and
    TV, movies and shows.

13. **Anime search finds too little (Play), so titles can't be found to add to lists.**
    (Screenshot Oct 15: Play → Anime → search "fate" shows only 4, all from the "Anime
    Kitsu" addon: Fate/Zero, Fate/Zero 2nd Season, Fate/stay night, Fate/Prototype.)
    Kitsu's own API returns 20+ for "fate" (Unlimited Blade Works, Heaven's Feel I–III,
    Apocrypha, Grand Order, Prisma☆Illya, Extra: Last Encore…). Play shows whatever the
    addon returns (`components/video-browse.tsx` → `fetchMetas` in `lib/addons.ts`), so
    the addon's search is the limit.
    - Search anime straight from Kitsu and/or AniList as well (no key), merged with the
      addon results, with "more" paging; same ids (`kitsu:…`) so title pages, streams and
      Add to Tracker / Lists keep working.
    - Same in Tracker's own Add → Anime search (AniList), so anything can go on the
      Anime list from either app.
    - Check that every search result's title page has **Add to Tracker / Lists**.

14. ✅ **DONE Oct 16 (Play PR #11, build after merge): Play's "Add to a Tracker list" said "No lists yet" when you have lists.** Sunday: just confirm on the phone.
    (Screenshot Oct 16, *Mushoku no Eiyuu*.) Cause: the Lists popup
    (`app/src/components/tracker-actions.tsx` → `getTrackerLists(kind)`) asks for
    `get_lists(kind, play_only: true)`, so it only shows lists of that exact kind with
    "Show in 128bitPlay" on. Since "Where your lists go" (Play PR #8) that switch no longer
    decides anything, so lists made in Tracker don't appear.
    - Show **all** your lists in the popup (`getAllTrackerLists`), the page's kind first,
      then the rest; "New list" stays at the bottom.
    - Small, one-file fix; can be done before Sunday if wanted.

## Later (not Sunday)

- **Music** in the 128bit family: November.
