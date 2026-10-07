// In-app update notice. Checks GitHub Releases for a newer signed APK and
// opens its download in the browser; Android then installs it as an update
// (same signing key), keeping all data.
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { isNewer } from './version.js';

export const REPO = 'Hootywhooo86/128bittracker';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`; // never returns pre-releases
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export function createUpdates({ fetchImpl = (...a) => fetch(...a) } = {}) {
  async function check() {
    const { version: current } = await App.getInfo();
    const res = await fetchImpl(LATEST, { headers: { accept: 'application/vnd.github+json' } });
    if (res.status === 404) return { current, latest: null, available: false };
    if (!res.ok) throw new Error(`couldn't reach GitHub (HTTP ${res.status})`);
    const rel = await res.json();
    const apk = (rel.assets ?? []).find((a) => a.name.endsWith('.apk'));
    const latest = String(rel.tag_name ?? '').replace(/^v/, '');
    return {
      current,
      latest,
      available: !!apk && isNewer(latest, current),
      url: apk?.browser_download_url ?? rel.html_url,
      page: rel.html_url,
      name: rel.name ?? `v${latest}`,
    };
  }

  /** Only ever opens this repo's GitHub pages/downloads. */
  async function open(url) {
    if (!String(url).startsWith(`https://github.com/${REPO}/`)) throw new Error('not a 128bit Tracker download');
    await Browser.open({ url });
  }

  /** Check on launch/resume, at most every few hours; tell the UI if newer. */
  function startAuto(onAvailable) {
    const tick = async () => {
      let last = 0;
      try { last = Number(localStorage.getItem('updates.lastCheck') || 0); } catch {}
      if (Date.now() - last < CHECK_EVERY_MS) return;
      try {
        const info = await check();
        try { localStorage.setItem('updates.lastCheck', String(Date.now())); } catch {}
        if (info.available) onAvailable(info);
      } catch (err) {
        console.warn('update check:', err.message);
      }
    };
    setTimeout(tick, 3000);
    App.addListener('resume', tick);
  }

  return { check, open, startAuto };
}
