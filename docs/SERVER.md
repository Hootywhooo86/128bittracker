# Hosting the Tracker server

The phone app works on its own. The server is optional, but it's what lets
**128bitplay** (and the other 128bit apps) reach your Tracker, and it holds
your **backups**. It's one small Node process with one SQLite file, so any
host that runs a Docker container with a persistent disk works.

## What it needs

| | |
|---|---|
| Runtime | the `Dockerfile` in the repo root (Node 22, no other dependencies) |
| Disk | a persistent volume mounted at **`/data`** (the database lives there) |
| Port | `8128` (HTTP; let the host add HTTPS in front) |
| Env | `TRACKER_PASSWORD` (to log into the web UI), `TRACKER_SECRET` (any long random string; keeps logins across restarts) |
| Optional | `TRACKER_CORS_ORIGINS` only if a browser page calls the API directly |

Always use **HTTPS** on the internet. API keys are passwords.

## Pick a host

**Rule of thumb: put it wherever 128bitplay runs.** Same provider, same region.

### Option A: Railway (easiest, no terminal)
1. railway.com → New Project → Deploy from GitHub repo → `128bittracker`.
   It finds the `Dockerfile` on its own.
2. Service → Volumes → add a volume mounted at `/data`.
3. Variables → add `TRACKER_PASSWORD` and `TRACKER_SECRET`.
4. Settings → Networking → Generate Domain. That's your server URL (HTTPS).

### Option B: Fly.io (cheap, terminal)
```bash
fly launch --no-deploy            # pick a name + region, keep the Dockerfile
fly volumes create tracker_data --size 1
# in fly.toml add:  [mounts] source = "tracker_data"  destination = "/data"
fly secrets set TRACKER_PASSWORD=... TRACKER_SECRET=...
fly deploy                        # → https://<name>.fly.dev
```

### Option C: your own VPS (Hetzner, DigitalOcean, …)
```bash
docker run -d --name tracker --restart unless-stopped \
  -p 127.0.0.1:8128:8128 -v tracker-data:/data \
  -e TRACKER_PASSWORD=... -e TRACKER_SECRET=... \
  128bittracker             # after: docker build -t 128bittracker .
```
Put Caddy in front for automatic HTTPS (`tracker.yourdomain.com { reverse_proxy 127.0.0.1:8128 }`).

### Option D: a computer at home (free)
Run it on an always-on PC or Raspberry Pi (`npm start` or Docker), then
expose it with **Cloudflare Tunnel** or **Tailscale Funnel** for an HTTPS URL
without opening router ports. Fine for personal use; it's offline whenever
that machine is.

## After it's up

1. Open the server URL → log in with `TRACKER_PASSWORD`.
2. **Connect → API keys**:
   - `128bitplay` with *read + send events*. Give this to 128bitplay (as a
     server-side secret) along with the server URL. Event format: [API.md](API.md).
   - `phone` with *phone sync*. Paste it into the app's **Sync** tab.
3. Optional: **Connect → Webhooks**: add 128bitplay's webhook URL to get
   `streak.milestone`, `habit.completed`, etc. back.

## Backups of the server itself

Phones back up to the server. Back up the server's `/data/tracker.db` too
(your host's volume snapshots, or a nightly copy). It's a single file.
