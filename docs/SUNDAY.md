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
