# 128bit Tracker for Android

The Android app is the same Tracker: the same screens (`../public`) and the same
logic (`../src/domain`, `../src/integrations`), running **on the phone**. It
works fully offline. The database is SQLite compiled to WebAssembly (sql.js)
and is stored on the device.

```
mobile/
  src/main.js        # entry: Android back button, save on background, auto-sync
  src/transport.js   # runs the /api/v1 routes in-process, instead of over HTTP
  src/engine.js      # sql.js + IndexedDB persistence
  src/adapter.js     # makes sql.js look like node:sqlite, so the domain code is shared
  src/sync.js        # phone ⇄ Tracker server sync
  scripts/           # build-www.mjs (bundle), make-icons.py (pixel icon + splash)
  android/           # Capacitor Android project (committed)
  test/              # runs the shared core on sql.js + sync against a real server
```

## Get the APK

Download it from [Releases](https://github.com/Hootywhooo86/128bittracker/releases).
To ship a new release, bump `"version"` in `mobile/package.json` and push.
The **Release APK** workflow tests, builds and publishes `v<version>`.

### Signing (do this once)

Android only installs an update over an existing app if both are signed with
the **same key**. Until the four secrets below exist, releases are built with
a throwaway key and marked *pre-release*, so you must uninstall before
updating (export your data first, or rely on server backup).

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 128bittracker-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | `tracker` |
| `ANDROID_KEY_PASSWORD` | key password |

Keep the `.jks` file and its passwords somewhere safe, like a password
manager. If you lose them you can't update the app on anyone's phone, and the
Play Store needs the same key forever. Never commit them.

## Build the APK yourself

Needs Node 22, JDK 21 and the Android SDK (`ANDROID_HOME`, platform 35).

```bash
cd mobile
npm ci
npm test                 # device + sync tests
npm run apk              # → android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run apk` bundles `www/` with esbuild, runs `cap sync`, then runs Gradle.
Every push also builds the APK on GitHub Actions (**Actions → Android APK →
artifacts**).

**Installing:** copy the `.apk` to the phone and open it. Android will ask you
to allow installs from that source. Local builds are debug-signed, which is
fine for testing. Signed releases come from CI (see *Signing* above).

## Reminders

Give any habit a **daily reminder** time (edit the habit). The app schedules
local notifications for the next 7 days. It skips today once the habit is
done, and re-plans whenever you open the app or log something. Android asks
for notification permission the first time.

## Backups

With a server linked, every sync that changed something also uploads a full
snapshot. The server keeps the last 10 per phone. **Sync → Restore from
server** rebuilds a new or reset phone from the newest one. **Export / Import
JSON** works without a server.

## Connecting to 128bitplay (sync)

The phone can't receive webhooks, so the Tracker **server** (`npm start` in
the repo root, on a machine that 128bitplay can reach) acts as the hub:

```
128bitplay ──POST /events──▶ Tracker server ◀──sync──▶ phone
                              │
                              └──webhooks──▶ 128bitplay (streaks, completions)
```

1. On the server: **Connect → API keys**. Create a `128bitplay` key
   (*read + send events*) for 128bitplay, and a *phone sync* key for your phone.
2. On the phone: **Sync** tab. Enter the server URL and paste the phone key.

The phone syncs at launch, whenever it comes back to the foreground, every 5
minutes while open, and when you tap **Sync now**:
- **Pull**: events 128bitplay and the other apps sent to the server are applied
  on the phone. Games land in the Library, play time goes to the Play time habit, etc.
- **Push**: the phone's own events (`habit.completed`, `streak.milestone`,
  `item.completed`, …) go to the server, which forwards them to webhooks.
  Linking only pushes what happens from then on.

Plain `http://` is allowed so a server on your home network works. Use
`https://` for anything on the internet: the sync key is a password.
