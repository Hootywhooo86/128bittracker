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

device().then(({ store, sync, reminders }) => {
  // Never lose a tap: write the database out as soon as we go to the background.
  App.addListener('pause', () => store.flush());
  // Re-plan reminders on open/resume (today may be done, or a new day).
  reminders.refresh();
  App.addListener('resume', () => reminders.refresh());
  sync.startAuto({
    onSynced: () => {
      reminders.refresh();
      window.dispatchEvent(new CustomEvent('tracker:synced'));
    },
  });
});
