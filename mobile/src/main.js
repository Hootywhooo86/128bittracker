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

device().then(({ store, sync, reminders, updates }) => {
  updates.startAuto((info) => window.dispatchEvent(new CustomEvent('tracker:update', { detail: info })));
  // Never lose a tap: write the database out as soon as we go to the background.
  App.addListener('pause', () => store.flush());
  // Re-plan reminders on open/resume (today may be done, or a new day).
  reminders.refresh();
  App.addListener('resume', () => reminders.refresh());
  autoSyncPlatforms();
  App.addListener('resume', autoSyncPlatforms);
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
