// Android entry: boots the shared app UI plus native glue.
import { App } from '@capacitor/app';
import { device } from './transport.js';
import '../../public/app.js';

// Hardware back: close a dialog, else go back a tab, else leave the app.
App.addListener('backButton', ({ canGoBack }) => {
  const modal = document.getElementById('modal-root');
  if (modal?.firstChild) modal.innerHTML = '';
  else if (canGoBack && location.pathname !== '/') history.back();
  else App.exitApp();
});

// Back from Google / Apple sign-in: app.bit128.tracker://auth?code=…
App.addListener('appUrlOpen', async ({ url }) => {
  const u = new URL(url);
  const where = u.host || u.pathname.replace(/^\/+/, '').split('/')[0];
  if (where === 'connect') {
    // Back from AniList / Trakt / MAL (128bit Connect).
    const { Browser } = await import('@capacitor/browser');
    Browser.close().catch(() => {});
    const { request } = await import('./transport.js');
    const service = u.searchParams.get('service');
    if (!u.searchParams.get('ok')) return alert(`Couldn't connect: ${u.searchParams.get('error') ?? 'cancelled'}`);
    await request('GET', '/connect');
    if (service) await request('POST', `/connectors/${service}/sync`, {});
    window.dispatchEvent(new CustomEvent('tracker:synced'));
    return;
  }
  if (where !== 'auth') return;
  const { Browser } = await import('@capacitor/browser');
  Browser.close().catch(() => {});
  const { request } = await import('./transport.js');
  const code = u.searchParams.get('code');
  const error = u.searchParams.get('error_description');
  if (!code) {
    if (error) alert(error);
    return;
  }
  const { status, data } = await request('POST', '/family/oauth/finish', { code });
  if (status === 409 && data?.code === 'other_account') {
    const who = data.account?.email ?? 'that account';
    if (confirm(`Switch to ${who}'s own library on this phone? The library here stays for when its owner signs back in.`)) {
      await request('POST', '/device/switch-account', { account: data.account });
    }
    return;
  }
  if (status >= 400) return alert(data?.error ?? 'Sign-in failed');
  await request('POST', '/family/sync', {});
  window.dispatchEvent(new CustomEvent('tracker:synced'));
});

device().then(({ store, sync, reminders, updates }) => {
  updates.startAuto((info) => window.dispatchEvent(new CustomEvent('tracker:update', { detail: info })));
  // Never lose a tap: write the database out as soon as we go to the background.
  App.addListener('pause', () => store.flush());
  // Re-plan reminders on open/resume (today may be done, or a new day).
  reminders.refresh();
  App.addListener('resume', () => reminders.refresh());
  autoSyncPlatforms();
  familyTick();
  setInterval(familyTick, 5 * 60_000);
  App.addListener('resume', familyTick);
  App.addListener('resume', autoSyncPlatforms);
  healthTick();
  setInterval(healthTick, 30 * 60_000);
  App.addListener('resume', healthTick);
  sync.startAuto({
    onSynced: () => {
      reminders.refresh();
      window.dispatchEvent(new CustomEvent('tracker:synced'));
    },
  });
});

// Game platforms: refresh play time + achievements at most twice a day.
async function autoSyncPlatforms() {
  const { request } = await import('./transport.js');
  const { data: list } = await request('GET', '/connectors');
  for (const c of list ?? []) {
    if (!c.configured || c.last_error) continue;
    if (c.last_sync_at && Date.now() - Date.parse(c.last_sync_at) < 12 * 3600_000) continue;
    const { status, data } = await request('POST', `/connectors/${c.name}/sync`, {});
    if (status === 200 && (data.added || data.minutes || data.new_trophies?.length)) {
      window.dispatchEvent(new CustomEvent('tracker:synced'));
    }
  }
}

// 128bit family feed: pull what Play/Fit posted, share Tracker's wins.
async function familyTick() {
  const { request } = await import('./transport.js');
  const { data } = await request('POST', '/family/sync', {});
  if (data?.pulled) window.dispatchEvent(new CustomEvent('tracker:synced'));
}

// Health Connect: new workouts and today's steps, on open and every 30 minutes.
async function healthTick() {
  const { request } = await import('./transport.js');
  const { data } = await request('GET', '/health');
  if (!data?.enabled) return;
  try {
    const { status, data: res } = await request('POST', '/health/pull', {});
    if (status === 200 && (res.workouts_added || res.days)) window.dispatchEvent(new CustomEvent('tracker:synced'));
  } catch (err) {
    console.warn('health:', err.message);
  }
}
