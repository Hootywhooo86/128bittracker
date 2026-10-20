/*
 * Clerk sign-in, next to the 128bit family (Supabase) sign-in, not replacing it.
 *
 * Put <div data-clerk-account></div> where the button should go and set the key in
 * <meta name="clerk-publishable-key" content="pk_…"> (it is public). Signed out it
 * shows SIGN IN, which opens Clerk's sign-in: email, or Google if the person would
 * rather — Google is never required. Signed in it shows Clerk's account button.
 * No key: nothing is shown and the page works as before. If Clerk can't load
 * (offline, blocked), the slot says so in one line.
 */
(function () {
  const slots = document.querySelectorAll('[data-clerk-account]');
  const key = (document.querySelector('meta[name="clerk-publishable-key"]') || {}).content || '';
  if (!slots.length || !key.startsWith('pk_')) return;

  const load = (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.crossOrigin = 'anonymous';
      if (src.includes('clerk-js')) s.dataset.clerkPublishableKey = key;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Clerk didn’t load'));
      document.head.appendChild(s);
    });

  const say = (text) =>
    slots.forEach((el) => {
      el.textContent = text;
      el.className = (el.className + ' clerk-msg').trim();
    });

  let fapi;
  try {
    // The Frontend API host is base64 in the key, ending in "$".
    fapi = atob(key.split('_')[2]).slice(0, -1);
  } catch {
    return say('Clerk key looks wrong.');
  }

  (async () => {
    try {
      await load(`https://${fapi}/npm/@clerk/ui@1/dist/ui.browser.js`);
      await load(`https://${fapi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`);
      const clerk = window.Clerk;
      await clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });

      const render = () =>
        slots.forEach((el) => {
          if (el.__clerkUser) clerk.unmountUserButton(el.__clerkUser);
          el.textContent = '';
          el.__clerkUser = null;
          if (clerk.isSignedIn) {
            const box = document.createElement('div');
            el.appendChild(box);
            clerk.mountUserButton(box);
            el.__clerkUser = box;
          } else {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'clerk-signin';
            b.textContent = 'SIGN IN';
            b.title = 'Sign in with email or Google';
            b.onclick = () => clerk.openSignIn();
            el.appendChild(b);
          }
        });

      let signedIn = clerk.isSignedIn;
      render();
      clerk.addListener(() => {
        if (clerk.isSignedIn !== signedIn) {
          signedIn = clerk.isSignedIn;
          render();
        }
      });
    } catch (e) {
      say(navigator.onLine ? 'Clerk sign-in didn’t load. Try again later.' : 'Clerk sign-in needs a connection.');
    }
  })();
})();
