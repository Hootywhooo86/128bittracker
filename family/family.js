/*
 * 128bit family: one account for every 128bit app, and the shared event feed.
 *
 * Drop-in for any 128bit web page. No dependencies, no build step:
 *
 *   <script src="family/family.js" defer></script>
 *   <div data-128bit-family></div>          <!-- optional: the sign-in chip goes here -->
 *
 *   Bit128Family.logEvent('track.played', { title: 'Song', artist: 'Band' }, { app: 'music' });
 *
 * Canonical copy: 128bittracker/family/family.js. Other 128bit repos carry a copy; change
 * this one and copy it over. Feed schema: 128bittracker/docs/EVENTS.md.
 *
 * Every 128bit page on the same site (hootywhooo86.github.io/…) shares one sign-in: the
 * session lives under one localStorage key there.
 *
 * Google / Apple need this page's address in Supabase → Authentication → URL Configuration →
 * Redirect URLs, and the provider switched on.
 */
(function () {
  'use strict';

  // The 128bit family project. Its publishable key is meant to be public; the tables are only
  // reachable through the family SQL's functions.
  var PROJECT = { url: 'https://wvflpwtaszpstmjpkrhu.supabase.co', key: 'sb_publishable_dO8uP74cTV1tbuqESgxysw_323C7lWh' };
  var SESSION = '128bit.family.session';
  var OUTBOX = '128bit.family.outbox';
  var PKCE = '128bit.family.pkce';
  var TIMELINE = 'https://hootywhooo86.github.io/128bittracker/timeline.html';

  var listeners = [];
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  };
  function changed() { listeners.forEach(function (fn) { try { fn(api.email()); } catch (e) { /* listener's problem */ } }); }

  function session() {
    var s = store.get(SESSION);
    return s && s.refresh && s.url === PROJECT.url ? s : null;
  }
  function save(s) { store.set(SESSION, s); changed(); }

  async function auth(path, body) {
    var r;
    try {
      r = await fetch(PROJECT.url + '/auth/v1/' + path, {
        method: 'POST', headers: { apikey: PROJECT.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
    } catch (e) { throw new Error('Couldn’t reach the 128bit family account. Check the connection.'); }
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error_description || j.msg || j.message || 'The account service answered ' + r.status);
    return j;
  }

  function toSession(j, email) {
    if (!j.access_token || !j.refresh_token) throw new Error('Sign-in failed.');
    return {
      url: PROJECT.url, key: PROJECT.key, access: j.access_token, refresh: j.refresh_token,
      expires: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
      email: (j.user && j.user.email) || email || ''
    };
  }

  async function token() {
    var s = session();
    if (!s) return null;
    if (s.expires - 60 > Date.now() / 1000) return s.access;
    try {
      var fresh = toSession(await auth('token?grant_type=refresh_token', { refresh_token: s.refresh }), s.email);
      save(fresh);
      return fresh.access;
    } catch (e) {
      if (/invalid|not found|revoked|expired/i.test(e.message)) save(null);
      throw e;
    }
  }

  async function rpc(fn, args) {
    var t = await token();
    if (!t) throw new Error('Sign in to your 128bit family account first.');
    var r = await fetch(PROJECT.url + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { apikey: PROJECT.key, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {})
    });
    var txt = await r.text();
    var body = null;
    try { body = txt ? JSON.parse(txt) : null; } catch (e) { /* not JSON */ }
    if (!r.ok) throw new Error((body && body.message) || 'The account service answered ' + r.status);
    return body;
  }

  // ---------- Google / Apple (redirect, S256 PKCE) ----------

  function b64url(bytes) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function here() { return location.origin + location.pathname; }

  async function signInWith(provider) {
    var verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    var challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    try { sessionStorage.setItem(PKCE, verifier); } catch (e) { /* private mode */ }
    location.href = PROJECT.url + '/auth/v1/authorize?provider=' + provider +
      '&redirect_to=' + encodeURIComponent(here()) + '&code_challenge=' + challenge + '&code_challenge_method=s256';
  }

  // Back from Google / Apple with ?code=… (or ?error_description=…).
  async function finishRedirect() {
    var q = new URLSearchParams(location.search);
    var code = q.get('code');
    var error = q.get('error_description');
    if (!code && !error) return null;
    var verifier = null;
    try { verifier = sessionStorage.getItem(PKCE); sessionStorage.removeItem(PKCE); } catch (e) { /* none */ }
    // Only a sign-in this page started: leave other ?code= uses alone.
    if (!verifier) return null;
    q.delete('code'); q.delete('error'); q.delete('error_description');
    history.replaceState(null, '', here() + (q.toString() ? '?' + q : '') + location.hash);
    if (error) throw new Error(error);
    save(toSession(await auth('token?grant_type=pkce', { auth_code: code, code_verifier: verifier })));
    flush();
    return api.email();
  }

  // ---------- Outbox ----------

  var timer = null;
  var sending = null;

  function logEvent(type, data, opts) {
    opts = opts || {};
    if (!session()) return false;   // nothing is collected while signed out
    var at = opts.at || Date.now();
    var q = store.get(OUTBOX) || [];
    q.push({
      id: opts.id || (opts.app || 'web') + '-' + at.toString(36) + '-' + Math.random().toString(36).slice(2, 10),
      app: opts.app || 'custom', type: type, at: at, data: data || {}
    });
    store.set(OUTBOX, q.slice(-500));
    clearTimeout(timer);
    timer = setTimeout(flush, 2000);
    return true;
  }

  function flush() {
    if (sending) return sending;
    sending = (async function () {
      var q = store.get(OUTBOX) || [];
      if (!q.length || !session()) return;
      var batch = q.slice(0, 100);
      await rpc('log_events', { events: batch });
      var sent = {};
      batch.forEach(function (e) { sent[e.id] = 1; });
      var rest = (store.get(OUTBOX) || []).filter(function (e) { return !sent[e.id]; });
      store.set(OUTBOX, rest);
      if (rest.length) setTimeout(flush, 0);
    })().catch(function () { /* offline: stays in the outbox */ }).finally(function () { sending = null; });
    return sending;
  }

  // ---------- Public API ----------

  var api = {
    project: PROJECT,
    timeline: TIMELINE,
    email: function () { var s = session(); return s ? s.email || 'you' : null; },
    onChange: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
    signInEmail: async function (email, password) {
      save(toSession(await auth('token?grant_type=password', { email: email.trim(), password: password }), email.trim()));
      flush();
    },
    /** False when the email has to be confirmed first. */
    signUpEmail: async function (email, password) {
      var j = await auth('signup', { email: email.trim(), password: password });
      if (!j.access_token) return false;
      save(toSession(j, email.trim()));
      return true;
    },
    signInWith: signInWith,
    finishRedirect: finishRedirect,
    signOut: function () {
      var s = session();
      if (s) token().then(function (t) {
        return fetch(PROJECT.url + '/auth/v1/logout', { method: 'POST', headers: { apikey: PROJECT.key, Authorization: 'Bearer ' + t } });
      }).catch(function () {});
      store.set(OUTBOX, null);
      save(null);
    },
    /** Deletes the account and everything every 128bit app stored in it. */
    deleteAccount: async function () { await rpc('delete_my_account'); store.set(OUTBOX, null); save(null); },
    logEvent: logEvent,
    flush: flush,
    rpc: rpc,
    getEvents: function (beforeMs, max) { return rpc('get_events', { before_ms: beforeMs || null, max_rows: max || 200 }); }
  };
  window.Bit128Family = api;

  // ---------- The sign-in chip ----------

  var CSS = ':host{all:initial;font-family:Inter,system-ui,sans-serif;color:#f4f1ff}' +
    '.chip{font:inherit;font-size:13px;font-weight:600;background:#141428;color:#f4f1ff;border:2px solid #26264a;padding:8px 12px;cursor:pointer}' +
    '.chip b{color:#2dd4bf;font-weight:800}' +
    '.panel{position:absolute;right:0;margin-top:8px;width:min(320px,calc(100vw - 32px));background:#141428;border:3px solid #26264a;' +
    'box-shadow:6px 6px 0 #08081a;padding:16px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;text-align:left}' +
    '.h{font-family:"Press Start 2P",monospace;font-size:9px;letter-spacing:1px;color:#2dd4bf}' +
    'p{margin:0;font-size:13px;line-height:1.5;color:#9a97b8}' +
    'button.b{font:inherit;font-weight:800;font-size:14px;padding:11px;border:2px solid #ff9f1c;background:#ff9f1c;color:#201100;cursor:pointer}' +
    'button.g{font:inherit;font-size:13px;font-weight:700;padding:9px;border:2px solid #26264a;background:transparent;color:#f4f1ff;cursor:pointer}' +
    'input{font:inherit;font-size:15px;padding:10px;background:#0b0b16;border:2px solid #2dd4bf;color:#f4f1ff;outline:none;min-width:0}' +
    '.row{display:flex;gap:8px}.row>*{flex:1}.err{color:#ff5d8f}.ok{color:#2dd4bf}a{color:#ff9f1c}' +
    '.wrap{position:relative;display:inline-block}';

  function mount(host) {
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var wrap = document.createElement('div');
    wrap.className = 'wrap';
    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    root.appendChild(wrap);
    var open = false;
    var note = null;

    function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    function btn(cls, text, fn) { var b = el('button', cls, text); b.type = 'button'; b.onclick = fn; return b; }
    async function run(fn) {
      note = null;
      try { var t = await fn(); if (t) note = { text: t }; } catch (e) { note = { text: e.message, bad: true }; }
      draw();
    }

    function draw() {
      wrap.textContent = '';
      var who = api.email();
      var chip = el('button', 'chip');
      chip.type = 'button';
      chip.appendChild(el('b', null, '128bit '));
      chip.appendChild(document.createTextNode(who ? who : 'Sign in'));
      chip.onclick = function () { open = !open; draw(); };
      wrap.appendChild(chip);
      if (!open) return;
      var p = el('div', 'panel');
      p.appendChild(el('div', 'h', '128BIT FAMILY ACCOUNT'));
      if (who) {
        p.appendChild(el('p', null, 'Signed in as ' + who + '. The same account works in every 128bit app.'));
        var link = el('a', null, 'Your timeline →');
        link.href = TIMELINE;
        p.appendChild(link);
        var r = el('div', 'row');
        r.appendChild(btn('g', 'Sign out', function () { api.signOut(); open = false; draw(); }));
        r.appendChild(btn('g', 'Delete account', function () {
          if (confirm('Delete your 128bit family account? Everything every 128bit app sent to it is deleted for good.')) {
            run(async function () { await api.deleteAccount(); return 'Account deleted.'; });
          }
        }));
        p.appendChild(r);
      } else {
        p.appendChild(el('p', null, 'One sign-in for 128bitPlay, 128bitfit, Tracker and every 128bit app.'));
        p.appendChild(btn('b', 'Continue with Google', function () { run(function () { return signInWith('google'); }); }));
        p.appendChild(btn('g', 'Continue with Apple', function () { run(function () { return signInWith('apple'); }); }));
        var mail = el('input'); mail.type = 'email'; mail.placeholder = 'Email'; mail.autocomplete = 'username';
        var pass = el('input'); pass.type = 'password'; pass.placeholder = 'Password'; pass.autocomplete = 'current-password';
        p.appendChild(mail);
        p.appendChild(pass);
        var r2 = el('div', 'row');
        r2.appendChild(btn('g', 'Sign in', function () { run(async function () { await api.signInEmail(mail.value, pass.value); open = false; }); }));
        r2.appendChild(btn('g', 'Create account', function () {
          run(async function () {
            if (pass.value.length < 6) throw new Error('Pick a password of at least 6 characters.');
            return (await api.signUpEmail(mail.value, pass.value)) ? null : 'Check your email for the confirmation link, then sign in.';
          });
        }));
        p.appendChild(r2);
      }
      if (note) p.appendChild(el('p', note.bad ? 'err' : 'ok', note.text));
      wrap.appendChild(p);
    }

    api.onChange(draw);
    draw();
  }

  function start() {
    var hosts = document.querySelectorAll('[data-128bit-family]');
    for (var i = 0; i < hosts.length; i++) mount(hosts[i]);
    finishRedirect().catch(function (e) { alert(e.message); });
    flush();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
