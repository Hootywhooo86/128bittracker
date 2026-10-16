// 128bit Tracker app — vanilla JS. On the web it talks to the server's
// /api/v1; in the Android app the same API runs on-device (see transport.js).
import { request, platform } from './transport.js';
import { trophySvg, TROPHY_KINDS } from './trophy-art.js';
import { sittingWhere, fixSittingTitle } from './sitting.js';

const APP_COLORS = {
  '128bittracker': '#2dd4bf', '128bitplay': '#ff5d8f', '128bitfit': '#fb923c', '128bitgold': '#facc15',
  '128bitmusic': '#a78bfa', '128bitfantasy': '#4ade80', '128bittrip': '#38bdf8', '128bitlife': '#ff9f1c',
};
const STATUS_LABEL = { planned: 'PLANNED', active: 'IN PROGRESS', on_hold: 'ON HOLD', done: 'DONE', dropped: 'DROPPED' };

let META = null;
const state = { libType: '', libStatus: '', libQuery: '', libList: null, tlSource: '', tlAll: false, tlLog: false };

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');

async function api(method, path, body) {
  const { status, data } = await request(method, path, body);
  if (status === 401 && path !== '/session') { showLogin(); throw new Error('login required'); }
  if (status >= 400) throw Object.assign(new Error(data?.error || `HTTP ${status}`), { data, status });
  if (data?.new_trophy) setTimeout(() => celebrate(data.new_trophy), 350);
  return data;
}

// ---------- trophies ----------
const TROPHY_NAMES = { controller: 'GOLDEN CONTROLLER', vhs: 'GOLDEN VHS', tv: 'GOLDEN TV', anime: 'GOLDEN IDOL', cd: 'GOLDEN CD' };
const TROPHY_FOR = { controller: '100% a game', vhs: 'Finish a movie', tv: 'Finish a show season', anime: 'Finish an anime series', cd: 'Finish an audiobook' };

function celebrate(t) {
  const root = document.createElement('div');
  root.className = 'celebrate';
  root.setAttribute('role', 'status');
  root.innerHTML = `<div class="celebrate-card"><div class="celebrate-art">${trophySvg(t.kind, 144)}</div>
    <div class="px celebrate-name">${TROPHY_NAMES[t.kind] ?? 'TROPHY'} EARNED</div><div class="celebrate-title">${esc(t.title)}</div>
    <button class="btn teal">NICE!</button></div>`;
  document.body.append(root);
  const close = () => root.remove();
  root.addEventListener('click', close);
  setTimeout(close, 6000);
}

let toastTimer;
function toast(msg, err = false) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2600);
}

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { if (e.message !== 'login required') toast(e.message, true); }
};

function modal(title, html, onMount) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <button class="icon-btn close" data-close aria-label="Close">✕</button><h3>${esc(title)}</h3>${html}</div></div>`;
  const bg = root.firstElementChild;
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  onMount?.(bg.firstElementChild, close);
  bg.querySelector('input,select,textarea')?.focus();
  return close;
}

function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) out[k] = v;
  return out;
}

const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`);
const todayStr = () => new Date().toLocaleDateString('en-CA');

// ---------- routing ----------
const VIEWS = { today: renderToday, library: renderLibrary, timeline: renderTimeline, stats: renderStats, connect: renderConnect };

function go(name, push = true) {
  if (!VIEWS[name]) name = 'today';
  if (push) history.pushState({}, '', name === 'today' ? '/' : '/' + name);
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-current', t.dataset.view === name ? 'page' : 'false'));
  $('#tabs').classList.remove('hidden');
  guard(VIEWS[name])();
}
$('#tabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) go(t.dataset.view); });
window.addEventListener('popstate', () => go(location.pathname.slice(1), false));
const current = () => location.pathname.slice(1) || 'today';
const refresh = () => go(current(), false);
// The Android app pulls in other apps' events in the background.
window.addEventListener('tracker:synced', refresh);
window.addEventListener('tracker:update', (e) => showUpdate(e.detail));

// ---------- update notice (Android) ----------
function showUpdate(info, { force = false } = {}) {
  let dismissed = null;
  try { dismissed = localStorage.getItem('updates.dismissed'); } catch {}
  if (!info?.available || (!force && dismissed === info.latest)) return;
  const el = $('#update-banner');
  el.innerHTML = `<div class="update" role="status"><span class="px"><span style="font-family:var(--sans)">🆕</span> ${esc(info.name || 'v' + info.latest)} IS OUT</span>
    <button class="btn teal small" id="up-go">UPDATE</button><button class="btn ghost small" id="up-later">LATER</button></div>`;
  $('#up-go').addEventListener('click', guard(async () => {
    await api('POST', '/app/open-update', { url: info.url });
    toast('DOWNLOADING — OPEN IT TO INSTALL');
  }));
  $('#up-later').addEventListener('click', () => {
    try { localStorage.setItem('updates.dismissed', info.latest); } catch {}
    el.innerHTML = '';
  });
}

// ---------- login ----------
function showLogin() {
  $('#tabs').classList.add('hidden');
  view.innerHTML = `<form class="login" id="login">
    <span class="px">PRESS START</span>
    <div class="field"><input class="input" type="password" name="password" placeholder="Password" aria-label="Password" autocomplete="current-password" required></div>
    <button class="btn teal" style="width:100%">LOG IN</button></form>`;
  $('#login').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('POST', '/session', formData(e.target));
    await boot();
  }));
}

// ---------- HOME ----------
// ---------- watching / reading (Today) ----------
// Posters: the item's own, else the IMDb poster 128bitPlay uses.
const coverSrc = (i) => i.cover_url || (i.meta?.imdb_id ? `https://images.metahub.space/poster/medium/${i.meta.imdb_id}/img` : null);
const coverHtml = (i) => (coverSrc(i) ? `<img src="${esc(coverSrc(i))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span aria-hidden="true">${esc(i.icon ?? '📦')}</span>`);
const showKey = (i) => i.meta?.imdb_id ?? i.meta?.kitsu_id ?? i.title.toLowerCase().replace(/[:\s-]*(season|s)\s*\d+$/i, '').trim();

/** Opens the title in 128bitPlay (bit128://open, handled by Play's app/open.tsx). */
function playLink(i, ep) {
  const m = i.meta ?? {};
  const p = new URLSearchParams({ title: i.title });
  const id = m.imdb_id ?? (m.kitsu_id ? `kitsu:${m.kitsu_id}` : null);
  if (id) p.set('id', id);
  if (i.cover_url) p.set('poster', i.cover_url);
  if (i.type === 'movie') p.set('kind', 'movie');
  else if (i.type === 'show' || i.type === 'anime') {
    p.set('kind', ep ? 'episode' : 'show');
    if (ep) { p.set('season', ep.season ?? 1); p.set('episode', ep.number); }
  } else if (i.type === 'book') p.set('kind', 'book');
  else p.set('kind', 'comic');
  if (m.play_id) p.set('key', m.play_id);
  return `bit128://open?${p}`;
}
const playBtn = (i, ep, label = '▶ PLAY') => `<a class="btn teal small" href="${esc(playLink(i, ep))}">${label}</a>`;

function mediaCard(i, sub, actions = '', pct = null) {
  return `<div class="up-card">
    <button class="up-cover" data-item="${i.id}" aria-label="${esc(i.title)}">${coverHtml(i)}</button>
    <div class="up-body"><b>${esc(i.title)}</b><span class="muted">${sub}</span>
      ${pct != null ? `<div class="mini-bar" style="width:100%;margin:2px 0"><span style="width:${pct}%"></span></div>` : ''}
      <div class="up-actions">${actions}</div></div></div>`;
}

// One colour per kind, everywhere: calendar dots, Continue, the timeline. Changed in
// settings (🎨 COLOURS) and kept on this device.
// Books are brown; audiobooks (books with format audiobook, Play's listening) orange.
const DEFAULT_COLORS = { show: '#facc15', anime: '#f472b6', movie: '#a855f7', audiobook: '#f97316', book: '#a0522d', comic: '#ef4444', game: '#2dd4bf', accent: '#2dd4bf', heading: '#ff9f1c', background: '#0b0b16' };
const COLOR_LABEL = { show: 'TV shows', anime: 'Anime', movie: 'Movies', audiobook: 'Audiobooks', book: 'Books', comic: 'Comics', game: 'Games', accent: 'Buttons & highlights', heading: 'Headings & main buttons', background: 'Background' };
const KIND_COLOR = { ...DEFAULT_COLORS };
try { Object.assign(KIND_COLOR, JSON.parse(localStorage.getItem('tracker.colors') || '{}')); } catch { /* no storage */ }
const shade = (hex, f) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * f).toString(16).padStart(2, '0')).join('');
function applyColors() {
  const r = document.documentElement.style;
  r.setProperty('--teal', KIND_COLOR.accent); r.setProperty('--teal-d', shade(KIND_COLOR.accent, 0.45));
  r.setProperty('--orange', KIND_COLOR.heading); r.setProperty('--orange-d', shade(KIND_COLOR.heading, 0.55));
  r.setProperty('--bg', KIND_COLOR.background);
}
applyColors();
function saveColors(patch) {
  Object.assign(KIND_COLOR, patch);
  const changed = Object.fromEntries(Object.entries(KIND_COLOR).filter(([k, v]) => DEFAULT_COLORS[k] !== v));
  try { localStorage.setItem('tracker.colors', JSON.stringify(changed)); } catch { /* no storage */ }
  applyColors();
}

/** Settings → 🎨 COLOURS: a picker per kind plus the app's own colours. */
function renderColors(el) {
  el.innerHTML = `<div class="colors">${Object.keys(DEFAULT_COLORS).map((k) => `<label class="color-row"><input type="color" data-color="${k}" value="${esc(KIND_COLOR[k])}"><span>${esc(COLOR_LABEL[k])}</span></label>`).join('')}</div>
    <div class="row" style="margin-top:10px"><button class="btn ghost small" id="colors-reset">RESET TO DEFAULT</button></div>`;
  el.querySelectorAll('[data-color]').forEach((i) => i.addEventListener('input', () => saveColors({ [i.dataset.color]: i.value })));
  el.querySelector('#colors-reset').addEventListener('click', () => { saveColors({ ...DEFAULT_COLORS }); renderColors(el); toast('COLOURS RESET'); });
}
const KIND_NAME = { show: 'TV', anime: 'Anime', movie: 'Movies', audiobook: 'Audiobooks', book: 'Books', comic: 'Comics', game: 'Games' };
// A calendar entry's colour key: audiobooks apart from books.
const kindOf = (e) => (e.type === 'book' && e.format === 'audiobook' ? 'audiobook' : e.type ?? (e.kind === 'episode' ? 'show' : 'game'));
// A library item's colour key, or null for kinds without a colour (comics, podcasts…).
const itemKind = (i) => (i.type === 'book' && i.meta?.format === 'audiobook' ? 'audiobook' : ['show', 'anime', 'movie', 'book', 'game'].includes(i.type) ? i.type : null);

// Continue: movies, TV shows, anime, then audiobooks & books. TV / anime show
// the episode you're partway through, else the next one that's out.
async function renderContinue(el, cal = null) {
  const [active, upnext] = await Promise.all([api('GET', '/items?status=active&limit=500'), api('GET', '/upnext?limit=100').catch(() => [])]);
  if (!el.isConnected) return;
  const today = todayStr();
  const recent = (a, b) => String(b.meta?.now?.at ?? b.updated_at).localeCompare(String(a.meta?.now?.at ?? a.updated_at));
  const byShow = new Map();
  for (const u of upnext) {
    const k = showKey(u);
    const prev = byShow.get(k);
    if (!prev || (u.meta?.season ?? 1) > (prev.meta?.season ?? 1) || ((u.meta?.season ?? 1) === (prev.meta?.season ?? 1) && recent(prev, u) < 0)) byShow.set(k, u);
  }
  const midway = (u) => u.meta?.now?.episode === u.next.number && u.meta.now.pct > 0 && u.meta.now.pct < 95;
  const notOut = (u) => (cal ?? []).some((c) => c.kind === 'episode' && (c.item_id === u.id || c.title.toLowerCase() === u.title.toLowerCase())
    && c.date > today && c.number != null && c.number <= u.next.number && (c.season == null || c.season === u.next.season));
  const epCard = (u) => {
    const ep = `S${esc(u.next.season)} E${esc(u.next.number)}${u.progress_total ? ` of ${esc(u.progress_total)}` : ''}`;
    return midway(u)
      ? mediaCard(u, `${ep} · ${Math.round(u.meta.now.pct)}% in`, playBtn(u, u.next, '▶ RESUME'), Math.round(u.meta.now.pct))
      : mediaCard(u, `Next: ${ep}`, `${playBtn(u, u.next)}<button class="btn small ghost" data-watched="${u.id}" data-next="${u.next.number}">✓ WATCHED</button>`);
  };
  const shows = [...byShow.values()].filter((u) => !notOut(u)).sort((a, b) => Number(midway(b)) - Number(midway(a)) || recent(a, b));
  const groups = [
    ['movie', '🎬 MOVIES', active.filter((i) => i.type === 'movie' && (progressOf(i).pct ?? 0) < 100).sort(recent).map((i) => {
      const { pct, label } = progressOf(i);
      return mediaCard(i, esc(label || 'Watching'), playBtn(i, null, '▶ RESUME'), pct);
    })],
    ['show', '📺 TV SHOWS', shows.filter((u) => u.type === 'show').map(epCard)],
    ['anime', '🌸 ANIME', shows.filter((u) => u.type === 'anime').map(epCard)],
    // Listening now (orange), then reading (brown).
    ['audiobook', '🎧 AUDIOBOOKS', active.filter((i) => i.type === 'book' && i.meta?.format === 'audiobook').sort(recent).map((i) => {
      const { pct, label } = progressOf(i);
      return mediaCard(i, `🎧 ${esc(label || 'Listening')}${i.creator ? ` · ${esc(i.creator)}` : ''}`, playBtn(i, null, '▶ LISTEN'), pct);
    })],
    ['book', '📖 BOOKS', active.filter((i) => i.type === 'book' && i.meta?.format !== 'audiobook').sort(recent).map((i) => {
      const { pct, label } = progressOf(i);
      return mediaCard(i, `📖 ${esc(label || 'Reading')}${i.creator ? ` · ${esc(i.creator)}` : ''}`, playBtn(i, null, '▶ READ'), pct);
    })],
  ];
  const body = groups.filter(([, , cards]) => cards.length)
    .map(([k, title, cards]) => `<h3 class="sub kind" style="--c:${KIND_COLOR[k]}">${title}</h3><div class="upnext kinded" style="--c:${KIND_COLOR[k]}">${cards.join('')}</div>`).join('');
  el.innerHTML = `<h2 class="sec">▶ CONTINUE</h2>${body || '<p class="muted">Start something in 128bitPlay and it shows up here.</p>'}`;
  el.querySelectorAll('[data-watched]').forEach((b) => b.addEventListener('click', guard(async () => {
    b.disabled = true;
    await api('POST', `/items/${b.dataset.watched}/sessions`, { progress: Number(b.dataset.next) });
    toast('✓ WATCHED');
    await renderContinue(el, cal);
  })));
  el.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', guard(async () => itemDetail(await api('GET', `/items/${b.dataset.item}`)))));
}

// Upcoming: a month calendar, a dot per kind on each day; tap a day for what's on.
const cal = { month: null, day: null };
function renderCalendar(el, entries) {
  const today = todayStr();
  const byDay = new Map();
  for (const e of entries) if (e.date) (byDay.get(e.date) ?? byDay.set(e.date, []).get(e.date)).push(e);
  const firstOut = [...byDay.keys()].sort().find((d) => d >= today);
  cal.month ??= (byDay.has(today) || !firstOut ? today : firstOut).slice(0, 7);
  cal.day ??= byDay.has(today) ? today : firstOut ?? today;
  const [y, m] = cal.month.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const iso = (d) => `${cal.month}-${String(d).padStart(2, '0')}`;
  const cells = [...Array(start.getDay()).fill('<span></span>')];
  for (let d = 1; d <= days; d++) {
    const list = byDay.get(iso(d)) ?? [];
    const kinds = [...new Set(list.map(kindOf))].slice(0, 4);
    cells.push(`<button class="cal-day${iso(d) === today ? ' today' : ''}${iso(d) === cal.day ? ' sel' : ''}${list.length ? ' has' : ''}" data-day="${iso(d)}" aria-label="${iso(d)}${list.length ? `, ${list.length} coming` : ''}">
      <span>${d}</span><span class="dots">${kinds.map((k) => `<i style="background:${KIND_COLOR[k] ?? '#9a97b8'}"></i>`).join('')}</span></button>`);
  }
  const picked = byDay.get(cal.day) ?? [];
  const label = new Date(cal.day + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const row = (e) => {
    const k = kindOf(e);
    const note = k === 'movie' ? 'In cinemas: start looking for streams' : k === 'audiobook' ? 'Audiobook out' : k === 'book' ? 'Out' : e.detail;
    return `<div class="cal-entry" style="--c:${KIND_COLOR[k] ?? '#9a97b8'}">
      <div class="up-cover">${coverHtml({ cover_url: e.cover_url, icon: k === 'movie' ? '🎬' : k === 'anime' ? '🌸' : k === 'audiobook' ? '🎧' : k === 'book' ? '📖' : '📺', meta: {} })}</div>
      <div><b>${esc(e.title)}</b><div class="muted">${esc(KIND_NAME[k] ?? k)} · ${esc(k === 'movie' || k === 'book' || k === 'audiobook' ? note : e.detail ?? '')}</div></div></div>`;
  };
  const tba = entries.filter((e) => !e.date);
  el.innerHTML = `<h2 class="sec">📅 UPCOMING</h2>
    <div class="cal">
      <div class="cal-head"><button class="btn ghost small" data-month="-1" aria-label="Previous month">‹</button>
        <b>${esc(start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }).toUpperCase())}</b>
        <button class="btn ghost small" data-month="1" aria-label="Next month">›</button></div>
      <div class="cal-grid">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<span class="cal-wd">${d}</span>`).join('')}${cells.join('')}</div>
      <div class="cal-legend">${['show', 'anime', 'movie', 'audiobook', 'book'].map((k) => `<span><i style="background:${KIND_COLOR[k]}"></i>${KIND_NAME[k]}</span>`).join('')}</div>
    </div>
    <h3 class="sub">${esc(label.toUpperCase())}</h3>
    ${picked.length ? `<div class="cal-list">${picked.map(row).join('')}</div>` : '<p class="muted">Nothing coming that day.</p>'}
    ${tba.length ? `<h3 class="sub">DATE TBA</h3><div class="cal-list">${tba.map(row).join('')}</div>` : ''}`;
  el.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => { cal.day = b.dataset.day; renderCalendar(el, entries); }));
  el.querySelectorAll('[data-month]').forEach((b) => b.addEventListener('click', () => {
    const d = new Date(y, m - 1 + Number(b.dataset.month), 1);
    cal.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    renderCalendar(el, entries);
  }));
}

const habitsOpen = () => { try { return localStorage.getItem('tracker.habits') === '1'; } catch { return false; } };

async function renderToday() {
  const trackers = await api('GET', '/trackers');
  const done = trackers.filter((t) => t.today.done).length;
  view.innerHTML = `
    <h1 class="view-title"><span class="t">HOME</span> <span class="muted" style="font-size:.6em">${esc(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }))}</span></h1>
    <div id="continue"></div>
    <div id="upcoming"></div>
    <details class="habits" id="habits"${habitsOpen() ? ' open' : ''}><summary class="sec">✓ HABITS <span class="muted">${trackers.length ? `${done}/${trackers.length} done today` : ''}</span></summary>
      <div class="row" style="margin-bottom:18px"><button class="btn" id="new-tracker">+ NEW TRACKER</button></div>
      ${trackers.length ? `<div class="cards">${trackers.map(trackerCard).join('')}</div>` : `<div class="empty"><span class="px">NO TRACKERS YET</span>Pick a preset — water, sleep, reading, mood — or make your own.</div>`}
    </details>`;
  $('#new-tracker').addEventListener('click', newTrackerModal);
  $('#habits').addEventListener('toggle', (e) => { try { localStorage.setItem('tracker.habits', e.target.open ? '1' : '0'); } catch { /* no storage */ } });
  const cont = $('#continue');
  const up = $('#upcoming');
  renderContinue(cont).catch(() => {});
  // Air dates may need a lookup: they fill in when ready.
  api('GET', '/calendar').then((entries) => {
    if (up.isConnected) renderCalendar(up, entries);
    if (cont.isConnected) renderContinue(cont, entries).catch(() => {});
  }).catch(() => {});
  view.querySelectorAll('[data-log]').forEach((b) => b.addEventListener('click', guard(async () => {
    const id = b.dataset.log;
    const value = b.dataset.value === undefined ? undefined : Number(b.dataset.value);
    const res = await api('POST', `/trackers/${id}/log`, value === undefined ? {} : { value });
    if (res.milestone) toast(`🔥 ${res.milestone}-DAY STREAK!`);
    else if (res.tracker.today.done && !b.closest('.card').classList.contains('done')) toast(`✓ ${res.tracker.name.toUpperCase()} DONE`);
    await renderToday();
    $(`[data-card="${id}"]`)?.classList.add('pop');
  })));
  view.querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', guard(async () => {
    await api('POST', `/trackers/${b.dataset.undo}/undo`, {});
    toast('UNDONE');
    await renderToday();
  })));
  view.querySelectorAll('[data-freeze]').forEach((b) => b.addEventListener('click', guard(async () => {
    await api('POST', `/trackers/${b.dataset.freeze}/freeze`, {});
    toast('🧊 STREAK FROZEN');
    await renderToday();
  })));
  view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editTrackerModal(trackers.find((t) => t.id == b.dataset.edit))));
}

function trackerCard(t) {
  const c = `--c:${t.color}`;
  const { total, done } = t.today;
  const s = t.streak;
  let meter = '';
  if (t.kind === 'count' || t.kind === 'duration') {
    const segs = 10;
    const on = Math.min(segs, Math.floor((total / t.target) * segs));
    meter = `<div class="bar" style="${c}" aria-hidden="true">${Array.from({ length: segs }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div>
      <div class="bar-label"><span><b>${esc(fmtNum(total))}</b> / ${esc(fmtNum(t.target))} ${esc(t.unit ?? '')}</span><span>${Math.min(100, Math.round((total / t.target) * 100))}%</span></div>`;
  }
  let btns;
  if (t.kind === 'check') {
    btns = done ? `<button class="btn teal" disabled>✓ DONE</button>` : `<button class="btn teal" data-log="${t.id}">✓ DONE</button>`;
  } else if (t.kind === 'count') {
    const big = t.target >= 1000 ? [500, 1000] : t.target >= 20 ? [1, 5] : [1];
    btns = big.map((v) => `<button class="btn teal" data-log="${t.id}" data-value="${v}">+${v}</button>`).join('');
  } else if (t.kind === 'duration') {
    const steps = t.target >= 240 ? [30, 60, 120] : [5, 15, 30];
    btns = steps.map((v) => `<button class="btn teal small" data-log="${t.id}" data-value="${v}">+${v}${esc(t.unit === 'min' ? 'm' : '')}</button>`).join('');
  } else {
    btns = Array.from({ length: Math.min(t.target, 10) }, (_, i) => `<button class="btn ${t.today.total && Math.round(t.today.total) === i + 1 ? 'teal' : 'ghost'} small" data-log="${t.id}" data-value="${i + 1}" aria-label="${i + 1} of ${t.target}">${i + 1}</button>`).join('');
  }
  const nudge = s.neverMissTwice && !done
    ? `<div class="nudge">Missed yesterday — never miss twice. ${s.current === 0 && t.history.at(-2) && !t.history.at(-2).frozen ? `<button class="icon-btn" style="color:var(--ice)" data-freeze="${t.id}">🧊 freeze it</button>` : ''}</div>`
    : s.atRisk ? `<div class="nudge ice">Keep the ${s.current}-day run alive today.</div>` : '';
  const last = t.history.length - 1;
  return `<article class="card ${done ? 'done' : ''}" data-card="${t.id}" style="${c}">
    <div class="card-head">
      <div class="card-ico" aria-hidden="true">${esc(t.icon)}</div>
      <div style="min-width:0"><div class="card-title">${esc(t.name)}</div>
        <div class="card-meta">${t.completion_30d}% · 30 days${t.remind_at ? ` · 🔔 ${esc(t.remind_at)}` : ''}${t.listens.length ? ` · auto: ${esc(t.listens.join(', '))}` : ''}</div></div>
      <div class="streak ${s.current ? '' : 'cold'}" title="Best: ${s.best}">🔥${s.current}</div>
    </div>
    ${meter}
    <div class="strip30" style="${c}" aria-label="Last 30 days">${t.history.map((h, i) => `<i class="${h.done ? 'on' : h.frozen ? 'fz' : ''} ${i === last ? 'today' : ''}" title="${h.day}${h.total ? ' · ' + fmtNum(h.total) : ''}"></i>`).join('')}</div>
    ${nudge}
    <div class="log-btns">${btns}</div>
    <div class="row" style="justify-content:flex-end;margin-top:8px;gap:4px">
      ${total ? `<button class="icon-btn" data-undo="${t.id}" title="Undo last log">↶ undo</button>` : ''}
      <button class="icon-btn" data-edit="${t.id}" title="Edit">✎ edit</button>
    </div>
  </article>`;
}
const fmtNum = (n) => (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1));

function newTrackerModal() {
  const presets = Object.entries(META.presets);
  modal('NEW TRACKER', `
    <div class="preset-grid">${presets.map(([k, p]) => `<button class="preset" data-preset="${k}"><span>${esc(p.icon)}</span>${esc(p.name)}</button>`).join('')}</div>
    <h2 class="sec" style="margin-top:0">OR MAKE YOUR OWN</h2>
    ${trackerForm({})}`, (m, close) => {
    m.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', guard(async () => {
      await api('POST', '/trackers', { preset: b.dataset.preset });
      close(); toast('TRACKER ADDED'); renderToday();
    })));
    m.querySelector('form').addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      await api('POST', '/trackers', trackerPayload(formData(e.target)));
      close(); toast('TRACKER ADDED'); renderToday();
    }));
  });
}

function editTrackerModal(t) {
  modal(`EDIT ${t.name}`, trackerForm(t) + `<div class="row" style="margin-top:8px"><button class="btn ghost small" data-archive>ARCHIVE</button><button class="btn pink small" data-delete>DELETE</button></div>`, (m, close) => {
    m.querySelector('form').addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      const { kind, ...rest } = trackerPayload(formData(e.target));
      await api('PATCH', `/trackers/${t.id}`, rest);
      close(); renderToday();
    }));
    m.querySelector('[data-archive]').addEventListener('click', guard(async () => {
      await api('PATCH', `/trackers/${t.id}`, { archived: true }); close(); toast('ARCHIVED'); renderToday();
    }));
    m.querySelector('[data-delete]').addEventListener('click', guard(async () => {
      if (!confirm(`Delete "${t.name}" and all its logs?`)) return;
      await api('DELETE', `/trackers/${t.id}`); close(); toast('DELETED'); renderToday();
    }));
  });
}

function trackerForm(t) {
  const editing = !!t.id;
  return `<form>
    <div class="grid2">
      <div class="field"><label for="tf-name">NAME</label><input class="input" id="tf-name" name="name" required maxlength="60" value="${esc(t.name ?? '')}" placeholder="Stretch"></div>
      <div class="field"><label for="tf-icon">ICON</label><input class="input" id="tf-icon" name="icon" maxlength="8" value="${esc(t.icon ?? '⭐')}"></div>
      <div class="field"><label for="tf-kind">TYPE</label><select class="input" id="tf-kind" name="kind" ${editing ? 'disabled' : ''}>
        ${[['check', 'Done / not done'], ['count', 'Count (glasses, reps)'], ['duration', 'Duration (minutes)'], ['scale', 'Scale (1–5 mood)']]
          .map(([k, l]) => `<option value="${k}" ${t.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label for="tf-target">DAILY TARGET</label><input class="input" id="tf-target" name="target" type="number" min="1" step="any" value="${esc(t.target ?? 1)}"></div>
      <div class="field"><label for="tf-unit">UNIT</label><input class="input" id="tf-unit" name="unit" maxlength="20" value="${esc(t.unit ?? '')}" placeholder="min, glasses…"></div>
      <div class="field"><label for="tf-color">COLOR</label><input class="input" id="tf-color" name="color" type="color" value="${esc(t.color ?? '#2dd4bf')}" style="height:48px;padding:4px"></div>
    </div>
    <div class="field"><label for="tf-remind">DAILY REMINDER (OPTIONAL)</label><input class="input" id="tf-remind" name="remind_at" type="time" value="${esc(t.remind_at ?? '')}">
      ${platform === 'web' ? '<span class="muted" style="font-size:12px">Reminders ring on the Android app.</span>' : ''}</div>
    <div class="field"><label for="tf-listens">AUTO-LOG FROM 128BIT EVENTS (OPTIONAL)</label><input class="input" id="tf-listens" name="listens" value="${esc((t.listens ?? []).join(', '))}" placeholder="workout.logged, game.session"></div>
    <button class="btn teal">${editing ? 'SAVE' : 'CREATE'}</button>
  </form>`;
}
function trackerPayload(f) {
  return { name: f.name, icon: f.icon, kind: f.kind, target: Number(f.target) || 1, unit: f.unit || null, color: f.color, listens: f.listens ?? '', remind_at: f.remind_at || null };
}

// ---------- LIBRARY ----------
async function renderLibrary() {
  if (state.libList) return renderList(state.libList);
  const q = new URLSearchParams();
  if (state.libType) q.set('type', state.libType);
  if (state.libStatus) q.set('status', state.libStatus);
  if (state.libQuery) q.set('q', state.libQuery);
  const [items, lists] = await Promise.all([api('GET', '/items?' + q), api('GET', '/collections')]);
  // Audiobooks get their own chip (books with format audiobook), right after books.
  const types = Object.entries(META.item_types).flatMap(([k, v]) => (k === 'book' ? [[k, v], ['audiobook', { icon: '🎧' }]] : [[k, v]]));
  view.innerHTML = `
    <h1 class="view-title"><span class="o">LIBRARY</span></h1>
    <p class="view-sub">Everything you play, watch, read and listen to. 128bitplay games show up here on their own.</p>
    <div class="row" style="margin-bottom:16px">
      <button class="btn" id="add-item">+ ADD</button>
      <button class="btn ghost" id="import-lib">⬆ IMPORT</button>
      <input class="input" id="lib-q" type="search" placeholder="Search title or creator" aria-label="Search library" value="${esc(state.libQuery)}" style="flex:1;min-width:180px">
    </div>
    <div class="chips lists-strip" role="group" aria-label="Lists">
      ${lists.map((l) => `<button class="chip list-chip" data-list="${l.id}">📋 ${esc(l.name)} <span class="muted">${l.item_count}</span>${l.show_in_play ? ' <span title="Shows in 128bitPlay">▶</span>' : ''}</button>`).join('')}
      <button class="chip" id="new-list">+ NEW LIST</button>
    </div>
    <div class="chips" role="group" aria-label="Type">
      <button class="chip" data-type="" aria-pressed="${!state.libType}">All</button>
      ${types.map(([k, v]) => `<button class="chip" data-type="${k}" aria-pressed="${state.libType === k}">${v.icon} ${k}</button>`).join('')}
    </div>
    <div class="chips" role="group" aria-label="Status">
      <button class="chip" data-status="" aria-pressed="${!state.libStatus}">Everything</button>
      ${STATUS_ORDER.map((s) => `<button class="chip" data-status="${s}" aria-pressed="${state.libStatus === s}">${STATUS_LABEL[s].toLowerCase()}</button>`).join('')}
    </div>
    ${items.length ? libSections(items) : `<div class="empty"><span class="px">NOTHING HERE YET</span>Add a game, show or book — or connect 128bitplay from the Connect tab.</div>`}`;
  $('#add-item').addEventListener('click', () => itemModal());
  $('#import-lib').addEventListener('click', importModal);
  $('#new-list').addEventListener('click', () => listModal());
  view.querySelectorAll('[data-list]').forEach((b) => b.addEventListener('click', () => { state.libList = Number(b.dataset.list); guard(renderLibrary)(); }));
  let t;
  $('#lib-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(guard(async () => { state.libQuery = e.target.value; await renderLibrary(); $('#lib-q').focus(); $('#lib-q').setSelectionRange(9999, 9999); }), 250); });
  view.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => { state.libType = b.dataset.type; guard(renderLibrary)(); }));
  view.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => { state.libStatus = b.dataset.status; guard(renderLibrary)(); }));
  view.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', guard(async () => itemDetail(await api('GET', `/items/${b.dataset.item}`)))));
}

// In progress first, then what's next, then the rest; each its own section.
const STATUS_ORDER = ['active', 'planned', 'on_hold', 'done', 'dropped'];
const STATUS_HEAD = { active: '▶ IN PROGRESS', planned: '☰ PLANNED', on_hold: '⏸ ON HOLD', done: '✓ DONE', dropped: '✕ DROPPED' };
function libSections(items) {
  const by = Object.fromEntries(STATUS_ORDER.map((s) => [s, []]));
  for (const i of items) (by[i.status] ?? by.planned).push(i);
  // In progress: most recently touched first.
  by.active.sort((a, b) => String(b.meta?.now?.at ?? b.updated_at).localeCompare(String(a.meta?.now?.at ?? a.updated_at)));
  return STATUS_ORDER.filter((s) => by[s].length).map((s) => `<details class="lib-sec" ${s === 'dropped' ? '' : 'open'}>
      <summary class="sec">${STATUS_HEAD[s]} <span class="muted">${by[s].length}</span></summary>
      <div class="lib">${by[s].map(tile).join('')}</div></details>`).join('');
}

// ---------- lists ----------
const LIST_KINDS = { mixed: 'Anything', movie: 'Movies', show: 'TV shows', anime: 'Anime', book: 'Books', game: 'Games', music: 'Music', podcast: 'Podcasts', comic: 'Comics', manga: 'Manga' };

async function renderList(id) {
  let list;
  try { list = await api('GET', `/collections/${id}`); } catch { state.libList = null; return renderLibrary(); }
  view.innerHTML = `
    <div class="row" style="margin-bottom:10px"><button class="btn ghost small" id="list-back">← LIBRARY</button></div>
    <h1 class="view-title"><span class="o">${esc(list.name.toUpperCase())}</span></h1>
    <p class="view-sub">${esc(LIST_KINDS[list.kind] ?? list.kind)} · ${list.item_count} ${list.item_count === 1 ? 'item' : 'items'}${list.show_in_play ? ' · ▶ shows in 128bitPlay' : ''}${list.is_public ? ' · 🌐 public' : ''}${list.description ? `<br>${esc(list.description)}` : ''}</p>
    <div class="row" style="margin-bottom:16px"><button class="btn" id="list-search">+ SEARCH &amp; ADD</button><button class="btn ghost" id="list-add">FROM LIBRARY</button><button class="btn ghost" id="list-edit">SETTINGS</button></div>
    ${list.is_public && list.share_id ? `<p class="muted" style="font-size:13px;margin-bottom:12px">Share code: <code>${esc(list.share_id)}</code></p>` : ''}
    ${list.items.length ? `<div class="list-items">${list.items.map((i, n) => `<div class="list-row">
        <div class="li-cover">${i.cover_url ? `<img src="${esc(i.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span aria-hidden="true">${esc(i.icon)}</span>`}</div>
        <div class="grow"><b>${esc(i.title)}</b><div class="muted" style="font-size:12px">${esc(i.type)}${i.year ? ' · ' + i.year : ''} · ${STATUS_LABEL[i.status].toLowerCase()}</div></div>
        <button class="icon-btn" data-move="${n}" data-dir="-1" aria-label="Move up" ${n === 0 ? 'disabled' : ''}>▲</button>
        <button class="icon-btn" data-move="${n}" data-dir="1" aria-label="Move down" ${n === list.items.length - 1 ? 'disabled' : ''}>▼</button>
        <button class="icon-btn" data-drop="${i.id}" aria-label="Remove from list">✕</button></div>`).join('')}</div>`
      : `<div class="empty"><span class="px">EMPTY LIST</span>Add things from your library.${list.show_in_play ? ' It shows up as a row in 128bitPlay.' : ''}</div>`}`;
  $('#list-back').addEventListener('click', () => { state.libList = null; guard(renderLibrary)(); });
  $('#list-edit').addEventListener('click', () => listModal(list));
  $('#list-add').addEventListener('click', guard(() => addToListModal(list)));
  // Anything from the catalogs (TMDB, AniList, Open Library, IGDB…) straight onto this list.
  $('#list-search').addEventListener('click', () => itemModal(list.kind !== 'mixed' && META.item_types[list.kind] ? { type: list.kind } : {}, { list }));
  view.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', guard(async () => {
    const ids = list.items.map((i) => i.id);
    const from = Number(b.dataset.move);
    const to = from + Number(b.dataset.dir);
    [ids[from], ids[to]] = [ids[to], ids[from]];
    await api('POST', `/collections/${id}/order`, { item_ids: ids });
    await renderList(id);
  })));
  view.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', guard(async () => {
    await api('DELETE', `/collections/${id}/items/${b.dataset.drop}`);
    await renderList(id);
  })));
}

function listModal(list = null) {
  modal(list ? 'LIST SETTINGS' : 'NEW LIST', `<form>
    <div class="field"><label for="lf-name">NAME</label><input class="input" id="lf-name" name="name" required maxlength="60" value="${esc(list?.name ?? '')}" placeholder="Friday horror night"></div>
    <div class="field"><label for="lf-kind">WHAT'S ON IT</label><select class="input" id="lf-kind" name="kind">${Object.entries(LIST_KINDS).map(([k, v]) => `<option value="${k}" ${(list?.kind ?? 'mixed') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label for="lf-desc">DESCRIPTION</label><input class="input" id="lf-desc" name="description" maxlength="500" value="${esc(list?.description ?? '')}"></div>
    <label class="row" style="font-size:14px;margin-bottom:10px;gap:8px"><input type="checkbox" name="show_in_play" ${list ? (list.show_in_play ? 'checked' : '') : 'checked'}> Show in 128bitPlay (a row on its Movies / TV / Anime screens)</label>
    <label class="row" style="font-size:14px;margin-bottom:16px;gap:8px"><input type="checkbox" name="is_public" ${list?.is_public ? 'checked' : ''}> Public: anyone with the share code can see it</label>
    <div class="row"><button class="btn teal">${list ? 'SAVE' : 'CREATE'}</button>${list ? '<span class="spacer"></span><button type="button" class="btn pink small" id="lf-del">DELETE LIST</button>' : ''}</div></form>`, (m, close) => {
    const form = m.querySelector('form');
    form.addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      const f = formData(form);
      const body = { name: f.name, kind: f.kind, description: f.description || null, show_in_play: form.elements.show_in_play.checked, is_public: form.elements.is_public.checked };
      const saved = list ? await api('PATCH', `/collections/${list.id}`, body) : await api('POST', '/collections', body);
      close(); toast(list ? 'SAVED' : 'LIST CREATED');
      state.libList = saved.id; await renderLibrary();
    }));
    m.querySelector('#lf-del')?.addEventListener('click', guard(async () => {
      if (!confirm(`Delete the list "${list.name}"? The items stay in your library.`)) return;
      await api('DELETE', `/collections/${list.id}`);
      close(); state.libList = null; await renderLibrary();
    }));
  });
}

async function addToListModal(list) {
  const kindType = list.kind !== 'mixed' ? list.kind : '';
  const items = await api('GET', `/items?${new URLSearchParams({ ...(kindType ? { type: kindType } : {}), limit: '500' })}`);
  const have = new Set(list.items.map((i) => i.id));
  modal(`ADD TO ${list.name}`, `<input class="input" id="al-q" type="search" placeholder="Filter" aria-label="Filter" style="margin-bottom:10px">
    <div class="al-list">${items.map((i) => `<label class="list-row al-row" data-t="${esc(i.title.toLowerCase())}"><input type="checkbox" value="${i.id}" ${have.has(i.id) ? 'checked' : ''}>
      <div class="grow"><b>${esc(i.title)}</b><div class="muted" style="font-size:12px">${esc(i.icon)} ${esc(i.type)}${i.meta?.season ? ' · S' + esc(i.meta.season) : ''}${i.year ? ' · ' + i.year : ''}</div></div></label>`).join('') || '<p class="muted">Nothing in your library of that kind yet.</p>'}</div>
    <div class="row" style="margin-top:12px"><button class="btn teal" id="al-save">DONE</button></div>`, (m, close) => {
    m.querySelector('#al-q').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      m.querySelectorAll('.al-row').forEach((r) => { r.hidden = !r.dataset.t.includes(q); });
    });
    m.querySelector('#al-save').addEventListener('click', guard(async () => {
      for (const box of m.querySelectorAll('input[type=checkbox]')) {
        const itemId = Number(box.value);
        if (box.checked && !have.has(itemId)) await api('PUT', `/collections/${list.id}/items/${itemId}`);
        if (!box.checked && have.has(itemId)) await api('DELETE', `/collections/${list.id}/items/${itemId}`);
      }
      close(); await renderList(list.id);
    }));
  });
}

// How far through, and where you are right now: meta.pct / meta.now come from
// 128bitPlay (or the % field); episodes and pages count up from progress.
const EPISODIC = new Set(['show', 'anime', 'podcast']);
function progressOf(i) {
  const m = i.meta ?? {};
  const now = m.now && typeof m.now === 'object' ? m.now : null;
  const unit = META.item_types[i.type]?.unit ?? '';
  const counted = i.progress_total ? (i.progress + (now?.episode === i.progress + 1 ? (now.pct ?? 0) / 100 : 0)) / i.progress_total * 100 : null;
  let pct = i.status === 'done' ? 100 : EPISODIC.has(i.type) && counted != null ? counted : m.pct != null && Number.isFinite(Number(m.pct)) ? Number(m.pct) : counted;
  pct = pct == null ? null : Math.max(0, Math.min(100, Math.round(pct)));
  const parts = [];
  if (pct != null && i.status !== 'done') parts.push(`${pct}%`);
  if (i.progress_total && unit && unit !== '%') parts.push(`${fmtNum(i.progress)}/${i.progress_total} ${unit}`);
  if (i.status !== 'done' && now) {
    if (now.episode) { if (now.episode > i.progress) parts.push(`E${now.episode} · ${Math.round(now.pct ?? 0)}% in`); }
    else if (now.chapter) parts.push(`Ch. ${now.chapter}${now.page ? ` · p. ${now.page}${now.pages ? '/' + now.pages : ''}` : ''}`);
    else if (now.duration_s > 0 && now.position_s != null) parts.push(`${fmtMin(Math.max(0, now.duration_s - now.position_s) / 60)} left`);
  }
  return { pct, label: parts.join(' · ') };
}

function tile(i) {
  const { pct, label } = progressOf(i);
  const k = itemKind(i);
  return `<button class="tile${k ? ' kinded' : ''}" data-item="${i.id}"${k ? ` style="--k:${KIND_COLOR[k]}"` : ''}>
    <div class="cover">${coverHtml(i)}
      <span class="status ${i.status}">${STATUS_LABEL[i.status]}</span>${i.trophy_kind ? `<span class="trophy-badge" title="${TROPHY_NAMES[i.trophy_kind]}">${trophySvg(i.trophy_kind, 30)}</span>` : ''}${i.source !== 'manual' ? `<span class="src">${esc(i.source.replace('128bit', ''))}</span>` : ''}</div>
    <div class="tile-body"><div class="tile-title">${esc(i.title)}</div>
      <div class="tile-sub">${k === 'audiobook' ? '🎧 audiobook' : `${esc(i.icon)} ${esc(i.type)}`}${i.meta?.season ? ' · S' + esc(i.meta.season) : ''}${i.creator ? ' · ' + esc(i.creator) : ''}${i.year ? ' · ' + i.year : ''}</div>
      ${pct != null ? `<div class="mini-bar" title="${pct}%"><span style="width:${pct}%"></span></div>` : ''}
      ${label && i.status !== 'done' ? `<div class="tile-prog">${esc(label)}</div>` : ''}
      ${i.rating ? `<div class="stars"><span style="font-family:var(--sans)">★</span> ${i.rating}/10</div>` : ''}</div>
  </button>`;
}

/** Add (or edit) a library item. opts.list: opened from a list, so it goes on that list too. */
function itemModal(item = {}, opts = {}) {
  const editing = !!item.id;
  // Audiobooks are books (meta.format 'audiobook') with their own search: Audible first.
  const types = Object.keys(META.item_types).flatMap((t) => (t === 'book' ? ['book', 'audiobook'] : [t]));
  const curType = item.type === 'book' && (item.meta?.format === 'audiobook' || (!editing && /audio/i.test(opts.list?.name ?? ''))) ? 'audiobook' : item.type;
  let picked = {};
  const onLists = new Set(opts.list ? [opts.list.id] : []);
  modal(editing ? `EDIT ${item.title}` : opts.list ? `ADD TO ${opts.list.name}` : 'ADD TO LIBRARY', `${editing ? '' : `<div class="search-box">
      <div class="row"><input class="input" id="sr-q" type="search" placeholder="Search to fill in cover & details" aria-label="Search titles" style="flex:1;min-width:0">
        <button type="button" class="btn small" id="sr-go">SEARCH</button></div>
      <div id="sr-results" class="sr-results"></div><div id="sr-seasons"></div></div>`}<form>
    <div class="field"><label for="if-title">TITLE</label><input class="input" id="if-title" name="title" required maxlength="200" value="${esc(item.title ?? '')}"></div>
    <div class="grid2">
      <div class="field"><label for="if-type">TYPE</label><select class="input" id="if-type" name="type">${types.map((t) => `<option ${(curType ?? state.libType ?? 'game') === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label for="if-status">STATUS</label><select class="input" id="if-status" name="status">${META.statuses.map((s) => `<option value="${s}" ${(item.status ?? 'planned') === s ? 'selected' : ''}>${STATUS_LABEL[s].toLowerCase()}</option>`).join('')}</select></div>
      <div class="field"><label for="if-creator">CREATOR</label><input class="input" id="if-creator" name="creator" maxlength="120" value="${esc(item.creator ?? '')}" placeholder="Author, studio, artist"></div>
      <div class="field"><label for="if-year">YEAR</label><input class="input" id="if-year" name="year" type="number" min="0" value="${esc(item.year ?? '')}"></div>
      <div class="field"><label for="if-total">TOTAL (PAGES / EPISODES)</label><input class="input" id="if-total" name="progress_total" type="number" min="0" step="any" value="${esc(item.progress_total ?? '')}"></div>
      <div class="field"><label for="if-release">RELEASE DATE (SHOWS ON THE CALENDAR)</label><input class="input" id="if-release" name="release_date" type="date" value="${esc(item.meta?.release_date ?? '')}"></div>
      <div class="field"><label for="if-cover">COVER IMAGE URL</label><input class="input" id="if-cover" name="cover_url" type="url" value="${esc(item.cover_url ?? '')}" placeholder="https://…"></div>
      <div class="field"><label for="if-season">SEASON (SHOWS)</label><input class="input" id="if-season" name="season" type="number" min="0" value="${esc(item.meta?.season ?? '')}" placeholder="1"></div>
    </div>
    ${editing ? '' : '<div class="field"><label>ADD TO LISTS</label><div class="chips" id="if-lists"><span class="muted" style="font-size:13px">…</span></div></div>'}
    <button class="btn teal">${editing ? 'SAVE' : 'ADD'}</button></form>`, (m, close) => {
    const form = m.querySelector('form');
    if (!editing) {
      guard(async () => {
        const lists = await api('GET', '/collections');
        const box = m.querySelector('#if-lists');
        box.innerHTML = lists.length
          ? lists.map((l) => `<button type="button" class="chip" data-pick-list="${l.id}" aria-pressed="${onLists.has(l.id)}">📋 ${esc(l.name)}</button>`).join('')
          : '<span class="muted" style="font-size:13px">No lists yet: Library → + NEW LIST.</span>';
        box.querySelectorAll('[data-pick-list]').forEach((b) => b.addEventListener('click', () => {
          const id = Number(b.dataset.pickList);
          if (onLists.has(id)) onLists.delete(id); else onLists.add(id);
          b.setAttribute('aria-pressed', String(onLists.has(id)));
        }));
      })();
    }
    const set = (name, v) => { if (v != null && v !== '') form.elements[name].value = v; };
    const runSearch = guard(async () => {
      const q = m.querySelector('#sr-q').value.trim();
      const type = form.elements.type.value;
      if (q.length < 2) return;
      const box = m.querySelector('#sr-results');
      box.innerHTML = '<p class="muted" style="font-size:13px">Searching…</p>';
      m.querySelector('#sr-seasons').innerHTML = '';
      const results = await api('GET', `/search?${new URLSearchParams({ type, q })}`);
      box.innerHTML = results.length ? results.map((r, i) => `<button type="button" class="sr-item" data-i="${i}">
          ${r.cover_url ? `<img src="${esc(r.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="sr-noimg">?</span>'}
          <span><b>${esc(r.title)}</b><br><span class="muted">${[r.year, r.creator, r.meta?.narrator ? '🎙 ' + r.meta.narrator : null, r.meta?.runtime_min ? fmtMin(r.meta.runtime_min) : null, r.meta?.series ? `${r.meta.series}${r.meta.series_position ? ' #' + r.meta.series_position : ''}` : null, r.progress_total ? r.progress_total + ' ' + (META.item_types[type]?.unit ?? '') : null].filter(Boolean).map(esc).join(' · ')}</span></span></button>`).join('')
        : `<p class="muted" style="font-size:13px">No matches${type === 'movie' ? ' (movie search works best with a TMDB key — Connect tab)' : ''}.</p>`;
      box.querySelectorAll('.sr-item').forEach((b) => b.addEventListener('click', guard(async () => {
        const r = results[Number(b.dataset.i)];
        picked = { ...(r.meta ?? {}), provider: r.provider, provider_id: r.provider_id };
        set('title', r.title); set('creator', r.creator); set('year', r.year); set('cover_url', r.cover_url); set('progress_total', r.progress_total);
        set('release_date', r.meta?.release_date);
        box.querySelectorAll('.sr-item').forEach((x) => x.classList.toggle('on', x === b));
        if (type === 'show' && (r.provider === 'tvmaze' || r.provider === 'tmdb')) {
          const seasons = await api('GET', `/search/seasons?${new URLSearchParams({ provider: r.provider, id: r.provider_id })}`);
          m.querySelector('#sr-seasons').innerHTML = seasons.length ? `<p class="muted" style="font-size:12px;margin:8px 0 6px">Track which season?</p><div class="chips">${seasons.map((x, i) => `<button type="button" class="chip" data-s="${i}">S${x.number}${x.episodes ? ' · ' + x.episodes + ' ep' : ''}</button>`).join('')}</div>` : '';
          m.querySelectorAll('[data-s]').forEach((c) => c.addEventListener('click', () => {
            const x = seasons[Number(c.dataset.s)];
            set('season', x.number); set('progress_total', x.episodes); set('year', x.year); set('cover_url', x.cover_url);
            m.querySelectorAll('[data-s]').forEach((y) => y.setAttribute('aria-pressed', String(y === c)));
          }));
        }
      })));
    });
    m.querySelector('#sr-go')?.addEventListener('click', runSearch);
    m.querySelector('#sr-q')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
    m.querySelector('form').addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      const { season, ...f } = formData(e.target);
      const { release_date: releaseDate, ...rest } = f;
      // "audiobook" saves as a book with format audiobook (narrator, length, ASIN from Audible).
      const audio = f.type === 'audiobook';
      const format = audio ? 'audiobook' : picked.format === 'audiobook' || item.meta?.format === 'audiobook' ? null : undefined;
      const body = { ...rest, type: audio ? 'book' : f.type, year: f.year || null, progress_total: f.progress_total || null, cover_url: f.cover_url || null, creator: f.creator || null,
        meta: { ...picked, season: season ? Number(season) : null, release_date: releaseDate || null, ...(format !== undefined ? { format } : {}) } };
      const saved = editing ? await api('PATCH', `/items/${item.id}`, body) : await api('POST', '/items', body);
      if (!editing) for (const listId of onLists) await api('PUT', `/collections/${listId}/items/${saved.id}`);
      close(); toast(editing ? 'SAVED' : onLists.size ? `ADDED · ON ${onLists.size} ${onLists.size === 1 ? 'LIST' : 'LISTS'}` : 'ADDED');
      await renderLibrary();
      if (editing) itemDetail(await api('GET', `/items/${saved.id}`));
    }));
  });
}

function itemDetail(i) {
  const unit = META.item_types[i.type]?.unit ?? '';
  modal(`${i.icon} ${i.title}`, `
    <p class="muted" style="font-size:13px;margin:-8px 0 16px">${esc(i.type)}${i.meta?.season ? ' · Season ' + esc(i.meta.season) : ''}${i.creator ? ' · ' + esc(i.creator) : ''}${i.year ? ' · ' + i.year : ''}${i.source !== 'manual' ? ' · synced from ' + esc(i.source) : ''}</p>
    ${i.trophy ? `<div class="trophy-row">${trophySvg(i.trophy.kind, 56)}<div><div class="px" style="font-size:9px;color:#ffc72c;line-height:1.7">${TROPHY_NAMES[i.trophy.kind]}</div><div class="muted" style="font-size:12px">Earned ${new Date(i.trophy.earned_at).toLocaleDateString()}</div></div></div>` : ''}
    ${i.type === 'game' ? `<div class="row" style="margin-bottom:14px">${i.meta?.playtime_minutes ? `<span class="muted" style="font-size:13px">⏱ ${fmtMin(i.meta.playtime_minutes)} on ${esc(i.meta.platform ?? i.source)}</span>` : ''}${i.meta?.achievements ? `<span class="muted" style="font-size:13px">🏅 ${i.meta.achievements.unlocked}/${i.meta.achievements.total} achievements</span>` : ''}
      ${i.trophy ? '' : `<button class="btn ghost small" data-perfect="${i.meta?.perfect ? '0' : '1'}">${i.meta?.perfect ? 'UNMARK 100%' : '★ MARK 100%'}</button>`}</div>` : ''}
    <div class="chips" role="group" aria-label="Status">${META.statuses.map((s) => `<button class="chip" data-set-status="${s}" aria-pressed="${i.status === s}">${STATUS_LABEL[s].toLowerCase()}</button>`).join('')}</div>
    <div class="field"><label>LISTS</label><div class="chips" id="item-lists"><span class="muted" style="font-size:13px">…</span></div></div>
    <div class="field"><label>RATING</label><div class="rating">${Array.from({ length: 10 }, (_, n) => `<button data-rate="${n + 1}" class="${i.rating && n < i.rating ? 'on' : ''}" aria-label="Rate ${n + 1}">${n + 1}</button>`).join('')}</div></div>
    ${(() => { const { pct, label } = progressOf(i); return pct != null || label ? `<div class="where"><div class="mini-bar"><span style="width:${pct ?? 0}%"></span></div><span class="muted">${esc(i.status === 'done' ? 'Finished' : label || pct + '%')}</span></div>` : ''; })()}
    <h2 class="sec">LOG A SESSION</h2>
    <form data-session class="grid2">
      <div class="field"><label for="s-min">MINUTES</label><input class="input" id="s-min" name="minutes" type="number" min="0" max="1440" placeholder="45"></div>
      <div class="field"><label for="s-prog">PROGRESS ${unit ? '(' + esc(unit) + ')' : ''}</label><input class="input" id="s-prog" name="progress" type="number" min="0" step="any" placeholder="${esc(i.progress ?? 0)}${i.progress_total ? ' / ' + i.progress_total : ''}"></div>
      ${i.type === 'game' || EPISODIC.has(i.type) ? '' : `<div class="field"><label for="s-pct">% THROUGH</label><input class="input" id="s-pct" name="pct" type="number" min="0" max="100" step="1" placeholder="${esc(progressOf(i).pct ?? 0)}"></div>`}
      <div class="field" style="grid-column:1/-1"><button class="btn teal">+ LOG SESSION</button></div>
    </form>
    <p class="muted" style="font-size:13px">Total time: <b style="color:var(--ink)">${fmtMin(i.minutes_total)}</b> · Progress: <b style="color:var(--ink)">${fmtNum(i.progress)}${i.progress_total ? ' / ' + i.progress_total : ''}</b></p>
    ${i.sessions.length ? `<div class="sessions">${i.sessions.map((s) => `<div>${new Date(s.at).toLocaleDateString()} — ${s.minutes ? fmtMin(s.minutes) : ''}${s.progress != null ? ` → ${fmtNum(s.progress)}` : ''}${s.source !== 'manual' ? ` <span class="pill">${esc(s.source)}</span>` : ''}</div>`).join('')}</div>` : ''}
    <h2 class="sec">REVIEW</h2>
    <form data-review><div class="field"><textarea class="input" name="review" maxlength="5000" placeholder="What did you think?" aria-label="Review">${esc(i.review ?? '')}</textarea></div>
      <div class="row"><button class="btn small">SAVE REVIEW</button><span class="spacer"></span><button type="button" class="btn ghost small" data-edit-item>EDIT</button><button type="button" class="btn pink small" data-del-item>DELETE</button></div></form>`,
  (m, close) => {
    const reopen = async (patch) => { await api('PATCH', `/items/${i.id}`, patch); close(); renderLibrary(); itemDetail(await api('GET', `/items/${i.id}`)); };
    m.querySelectorAll('[data-set-status]').forEach((b) => b.addEventListener('click', guard(() => reopen({ status: b.dataset.setStatus }))));
    m.querySelectorAll('[data-rate]').forEach((b) => b.addEventListener('click', guard(() => reopen({ rating: Number(b.dataset.rate) }))));
    m.querySelector('[data-perfect]')?.addEventListener('click', guard(() => reopen({ meta: { perfect: m.querySelector('[data-perfect]').dataset.perfect === '1' ? true : null } })));
    m.querySelector('[data-session]').addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      if (f.pct != null && f.pct !== '') await api('PATCH', `/items/${i.id}`, { meta: { pct: Math.max(0, Math.min(100, Number(f.pct))), now: null } });
      if (f.minutes || (f.progress ?? '') !== '' || !f.pct) await api('POST', `/items/${i.id}/sessions`, { minutes: f.minutes ? Number(f.minutes) : 0, progress: f.progress === '' ? null : Number(f.progress) });
      toast('SESSION LOGGED'); close(); renderLibrary(); itemDetail(await api('GET', `/items/${i.id}`));
    }));
    m.querySelector('[data-review]').addEventListener('submit', guard(async (e) => { e.preventDefault(); await api('PATCH', `/items/${i.id}`, { review: formData(e.target).review }); toast('SAVED'); }));
    m.querySelector('[data-edit-item]').addEventListener('click', () => { close(); itemModal(i); });
    guard(async () => {
      const lists = await api('GET', '/collections');
      const mine = new Set((i.collections ?? []).map((c) => c.id));
      const box = m.querySelector('#item-lists');
      box.innerHTML = lists.length
        ? lists.map((l) => `<button type="button" class="chip" data-in-list="${l.id}" aria-pressed="${mine.has(l.id)}">📋 ${esc(l.name)}</button>`).join('')
        : '<span class="muted" style="font-size:13px">No lists yet: make one in the Library.</span>';
      box.querySelectorAll('[data-in-list]').forEach((b) => b.addEventListener('click', guard(async () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        await api(on ? 'PUT' : 'DELETE', `/collections/${b.dataset.inList}/items/${i.id}`);
        b.setAttribute('aria-pressed', String(on));
      })));
    })();
    m.querySelector('[data-del-item]').addEventListener('click', guard(async () => {
      if (!confirm(`Delete "${i.title}"?`)) return;
      await api('DELETE', `/items/${i.id}`); close(); toast('DELETED'); renderLibrary();
    }));
  });
}

// ---------- TIMELINE ----------
async function renderTimeline() {
  const q = new URLSearchParams({ limit: '200' });
  if (state.tlSource) q.set('source', state.tlSource);
  const all = await api('GET', '/events?' + q);
  // Highlights hide per-tap logs and Tracker's mirror of events another app already sent.
  const covered = finishedSittings(all);
  const shown = state.tlAll ? all : all.filter((e) => e.type !== 'habit.logged' && !(e.source === '128bittracker' && e.type.startsWith('item.') && e.data.source && e.data.source !== 'manual') && !covered.has(e.id));
  // Watch log: only what you watched, listened to and read.
  const events = state.tlLog ? shown.filter((e) => WATCH_LOG.has(e.type) || e.type.endsWith('.session')) : shown;
  const groups = new Map();
  for (const e of events) {
    const d = new Date(e.occurred_at).toLocaleDateString('en-CA');
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(e);
  }
  const sources = Object.keys(APP_COLORS);
  view.innerHTML = `
    <h1 class="view-title"><span class="t">TIMELINE</span></h1>
    <p class="view-sub">Every event from every 128bit app, on one record.</p>
    <div id="coming-up"></div>
    <div class="chips" role="group" aria-label="Source">
      <button class="chip" data-src="" aria-pressed="${!state.tlSource}">All apps</button>
      ${sources.map((s) => `<button class="chip" data-src="${s}" aria-pressed="${state.tlSource === s}" style="--c:${APP_COLORS[s]}">${s.replace('128bit', '')}</button>`).join('')}
      <span class="spacer"></span>
      <button class="chip" id="tl-log" aria-pressed="${state.tlLog}">▶ watch log</button>
      <button class="chip" id="tl-all" aria-pressed="${state.tlAll}">show every log</button>
    </div>
    ${events.length ? [...groups].map(([day, evs]) => `<div class="tl-day">${day === todayStr() ? 'TODAY' : esc(new Date(day + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase())}</div>
      <div class="tl">${evs.map(tlItem).join('')}</div>`).join('') : `<div class="empty"><span class="px">QUIET SO FAR</span>Log a habit or connect a 128bit app and events show up here.</div>`}`;
  view.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', () => { state.tlSource = b.dataset.src; guard(renderTimeline)(); }));
  $('#tl-all').addEventListener('click', () => { state.tlAll = !state.tlAll; guard(renderTimeline)(); });
  $('#tl-log').addEventListener('click', () => { state.tlLog = !state.tlLog; guard(renderTimeline)(); });
  renderComingUp($('#coming-up'));
}

async function renderComingUp(el, refresh = false) {
  let list;
  try { list = await api('GET', `/calendar${refresh ? '?refresh=1' : ''}`); } catch { return; }
  if (!el.isConnected) return;
  if (!list.length) { el.innerHTML = ''; return; }
  const day = (d) => {
    if (!d) return 'TBA';
    const dt = new Date(d + 'T12:00');
    const diff = Math.round((dt - new Date(todayStr() + 'T12:00')) / 86400000);
    return diff === 0 ? 'TODAY' : diff === 1 ? 'TMRW' : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
  };
  el.innerHTML = `<h2 class="sec" style="margin-top:0">COMING UP <button class="icon-btn" id="cu-refresh" title="Refresh">⟳</button></h2>
    <div class="coming">${list.slice(0, 12).map((e) => `<button class="coming-item" data-item="${e.item_id}">
      <span class="coming-date px">${esc(day(e.date))}</span>
      ${e.cover_url ? `<img src="${esc(e.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="coming-ico">${e.kind === 'release' ? '🎮' : '📺'}</span>`}
      <span class="coming-text"><b>${esc(e.title)}</b><br><span class="muted">${esc(e.detail)}</span></span></button>`).join('')}</div>`;
  el.querySelector('#cu-refresh').addEventListener('click', () => renderComingUp(el, true));
  el.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', guard(async () => itemDetail(await api('GET', `/items/${b.dataset.item}`)))));
}

// A finished watch/listen sitting already says "✓ finished": its separate
// movie.watched / episode.watched / book.finished (and that day's chapter.read) are hidden.
function finishedSittings(all) {
  const k = (...p) => p.map((x) => String(x ?? '').toLowerCase()).join('|');
  const day = (e) => new Date(e.occurred_at).toLocaleDateString('en-CA');
  const keyOf = (e) => {
    const d = e.data ?? {};
    if (e.type === 'episode.watched' || (e.type === 'watch.session' && d.kind !== 'movie')) return k('ep', d.imdb ?? d.kitsu ?? d.show, d.season, d.number ?? d.episode);
    if (e.type === 'movie.watched' || e.type === 'watch.session') return k('mv', d.imdb ?? d.title);
    if (e.type === 'book.finished' || e.type === 'listen.session') return k('bk', d.title);
    if (e.type === 'chapter.read' || e.type === 'read.session') return k('ch', d.comic, day(e));
    return null;
  };
  const done = new Set(all.filter((e) => (e.type.endsWith('.session') && e.data?.finished) || e.type === 'read.session').map(keyOf));
  return new Set(all.filter((e) => !e.type.endsWith('.session') && done.has(keyOf(e))).map((e) => e.id));
}

const WATCH_LOG = new Set(['movie.watched', 'episode.watched', 'book.finished', 'chapter.read']);
// What a watch / listen / read entry is, for its colour.
function mediaKind(e) {
  const d = e.data ?? {};
  if (e.type === 'watch.session' || e.type === 'episode.watched' || e.type === 'movie.watched') {
    if (d.kind === 'movie' || e.type === 'movie.watched') return 'movie';
    return d.anime || d.kitsu ? 'anime' : 'show';
  }
  // Play's books are audiobooks; a book.finished from elsewhere (Goodreads…) is a book.
  if (e.type === 'listen.session') return 'audiobook';
  if (e.type === 'book.finished') return e.source === '128bitplay' || d.format === 'audiobook' ? 'audiobook' : 'book';
  return null;
}
// "🕒 7:40–8:10 PM · ⏱ 42:10 → 1:12:30": when, and where in it you started and stopped.
function sittingLine(e) {
  if (!e.type.endsWith('.session')) return '';
  const d = e.data ?? {};
  const t = (x) => x.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const end = new Date(e.occurred_at);
  const clock = d.started_at ? `${t(new Date(d.started_at))}–${t(end)}` : t(end);
  // Every position that came with it (chapter and time), even if only one end did.
  const where = sittingWhere(d);
  return `<div class="tl-sit">🕒 ${esc(clock)}${where ? ` · ⏱ ${esc(where)}${d.finished ? '' : ' · stopped here'}` : ''}</div>`;
}

function tlItem(e) {
  const k = mediaKind(e);
  const c = (k && KIND_COLOR[k]) || APP_COLORS[e.source] || '#9a97b8';
  const d = e.data ?? {};
  // Sittings: minutes from the start/stop positions when Play's ticks came up short.
  const title = e.type.endsWith('.session') && e.title ? fixSittingTitle(e.title, d, e.occurred_at) : e.title ?? describe(e);
  const from = Number(d.from_pct ?? d.to_pct), to = d.finished ? 100 : Number(d.to_pct);
  const bar = e.type.endsWith('.session') && Number.isFinite(to) ? `<div class="tl-bar" title="${Number.isFinite(from) ? from : 0}% → ${to}%"><span style="left:${Math.min(from || 0, to)}%;width:${Math.max(1, to - Math.min(from || 0, to))}%"></span></div>` : '';
  // Trophies show their golden pixel art (VHS, TV, idol, controller, CD).
  const art = e.type === 'trophy.earned' && TROPHY_NAMES[d.kind] ? `<span class="tl-trophy">${trophySvg(d.kind, 28)}</span>` : '';
  return `<div class="tl-item" style="--c:${c}"><div class="tl-title">${art}${esc(title)}</div>${bar}${sittingLine(e)}
    <div class="tl-meta"><span class="app-tag" style="--c:${c}">${esc(e.source.replace('128bit', '').toUpperCase() || e.source)}</span>
      <span>${esc(e.type)}</span><span>${new Date(e.occurred_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div></div>`;
}

function describe(e) {
  const d = e.data ?? {};
  const game = d.game?.title;
  switch (e.type) {
    case 'game.started': return `🎮 Started ${game}`;
    case 'game.session': return `🎮 Played ${game}${d.minutes ? ' · ' + fmtMin(d.minutes) : ''}`;
    case 'game.completed': return `🏁 Beat ${game}`;
    case 'achievement.unlocked': return `🏆 ${d.achievement?.name ?? 'Achievement'} — ${game ?? ''}`;
    case 'score.posted': return `🕹️ ${game}: ${d.score}`;
    case 'workout.logged': return `💪 Workout${d.minutes ? ' · ' + fmtMin(d.minutes) : ''}`;
    case 'track.played': return `🎵 ${d.title ?? 'Track played'}`;
    case 'budget.updated': return `💰 Budget updated`;
    case 'matchup.won': return `🏈 Matchup won`;
    case 'booking.made': return `✈️ Booking made`;
    default: return `${e.type}${game ? ' · ' + game : ''}`;
  }
}

// ---------- STATS ----------
async function renderStats() {
  const year = new Date().getFullYear();
  const [s, pixels, tro] = await Promise.all([api('GET', '/stats'), api('GET', `/stats/year/${year}`), api('GET', '/trophies')]);
  const lib = Object.entries(s.library).sort((a, b) => b[1].total - a[1].total);
  // A day's cell: the colour of what you mostly watched / listened to / read that day
  // (TV yellow, anime pink…), brighter the more you did; habits and other apps in teal.
  const score = (d) => d.logs + d.events + d.minutes / 15;
  const max = Math.max(1, ...pixels.days.map(score));
  const lvl = (n) => (n === 0 ? 0 : n / max > 0.6 ? 4 : n / max > 0.3 ? 3 : n / max > 0.1 ? 2 : 1);
  const cell = (d) => {
    const l = lvl(score(d));
    if (!l) return `<i data-day="${d.day}"></i>`;
    if (d.top) return `<i data-day="${d.day}" style="background:${KIND_COLOR[d.top]};opacity:${[0, 0.45, 0.65, 0.85, 1][l]}"></i>`;
    return `<i data-day="${d.day}" class="l${l}"></i>`;
  };
  const byDay = new Map(pixels.days.map((d) => [d.day, d]));
  const dayLine = (d) => {
    const kinds = Object.entries(d.kinds ?? {}).sort((a, b) => b[1].minutes - a[1].minutes);
    const what = kinds.map(([k, v]) => `<span style="color:${KIND_COLOR[k] ?? 'inherit'}">${esc(KIND_NAME[k] ?? k)} ${v.minutes ? fmtMin(v.minutes) : `×${v.n}`}</span>`);
    if (d.logs) what.push(`${d.logs} habit log${d.logs === 1 ? '' : 's'}`);
    const other = d.events - kinds.reduce((a, [, v]) => a + v.n, 0);
    if (other > 0) what.push(`${other} other event${other === 1 ? '' : 's'}`);
    return `<b>${esc(new Date(d.day + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))}</b> · ${what.length ? what.join(' · ') : 'nothing logged'}`;
  };
  const pad = (new Date(year, 0, 1).getDay() + 6) % 7; // weeks start Monday
  const minutes = lib.reduce((a, [, v]) => a + (v.minutes ?? 0), 0);
  const timeSplit = lib.filter(([, v]) => v.minutes).sort((a, b) => b[1].minutes - a[1].minutes).slice(0, 3).map(([t, v]) => `${KIND_NAME[t] ?? t} ${fmtMin(v.minutes)}`).join(' · ');
  view.innerHTML = `
    <h1 class="view-title"><span class="o">STATS</span></h1>
    <p class="view-sub">Numbers, not guilt.</p>
    <h2 class="sec" style="margin-top:6px">TROPHY SHELF</h2>
    <div class="shelf">${TROPHY_KINDS.map((k) => `<div class="shelf-slot ${tro.counts[k] ? 'won' : ''}">${trophySvg(k, 64, { locked: !tro.counts[k] })}
      <div class="px shelf-n">×${tro.counts[k]}</div><div class="shelf-for">${TROPHY_FOR[k]}</div></div>`).join('')}</div>
    ${tro.trophies.length ? `<div class="shelf-list">${tro.trophies.slice(0, 24).map((t) => `<div class="shelf-item" title="${esc(TROPHY_NAMES[t.kind])} · ${new Date(t.earned_at).toLocaleDateString()}">${trophySvg(t.kind, 36)}<span>${esc(t.title)}</span></div>`).join('')}</div>` : '<p class="muted" style="font-size:13px;margin:10px 0 0">Finish a movie, a show season, an anime or an audiobook, or 100% a game, to earn your first golden trophy.</p>'}
    <h2 class="sec">THE NUMBERS</h2>
    <div class="kpis">
      ${kpi('DONE TODAY', `${s.habits.done_today}/${s.habits.count}`, 'habits')}
      ${kpi('BEST LIVE STREAK', `🔥${s.habits.best_current_streak}`, `all-time best ${s.habits.best_ever_streak}`)}
      ${kpi('30-DAY RATE', `${s.habits.avg_completion_30d}%`, 'average completion')}
      ${kpi(`FINISHED IN ${year}`, s.finished_this_year, 'games, books, shows…')}
      ${kpi('TIME LOGGED', fmtMin(minutes), timeSplit || 'watching, listening, reading, playing')}
      ${kpi('AVG RATING', s.average_rating ?? '—', 'out of 10')}
    </div>
    <h2 class="sec">${year} IN PIXELS</h2>
    <div class="pixels" role="img" aria-label="Activity per day in ${year}">${'<i style="visibility:hidden"></i>'.repeat(pad)}${pixels.days.map(cell).join('')}</div>
    <div class="legend">${['show', 'anime', 'movie', 'audiobook', 'book', 'comic'].map((k) => `<span><i style="background:${KIND_COLOR[k]}"></i>${KIND_NAME[k]}</span>`).join('')}<span><i style="background:var(--teal)"></i>Other</span></div>
    <p class="px-day muted" id="px-day">${dayLine(byDay.get(todayStr()) ?? pixels.days.at(-1))}</p>
    <h2 class="sec">LIBRARY</h2>
    ${lib.length ? `<div class="table-wrap"><table class="lib-stats"><thead><tr><th>TYPE</th><th class="n">TOTAL</th><th class="n">ACTIVE</th><th class="n">DONE</th><th class="n">TIME</th></tr></thead><tbody>
      ${lib.map(([t, v]) => `<tr><td>${esc(t === 'audiobook' ? '🎧' : META.item_types[t]?.icon ?? '📦')} ${esc(t)}</td><td class="n">${v.total}</td><td class="n">${v.active ?? 0}</td><td class="n">${v.done ?? 0}</td><td class="n">${v.minutes ? fmtMin(v.minutes) : '—'}</td></tr>`).join('')}
    </tbody></table></div>` : `<p class="muted">Library is empty.</p>`}`;
  // Tap a day to see what it was.
  view.querySelectorAll('.pixels [data-day]').forEach((c) => c.addEventListener('click', () => {
    view.querySelectorAll('.pixels .sel').forEach((x) => x.classList.remove('sel'));
    c.classList.add('sel');
    $('#px-day').innerHTML = dayLine(byDay.get(c.dataset.day));
  }));
}
const kpi = (k, v, s) => `<div class="kpi"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`;

// One account: the catalogs come built in. Other trackers are only for moving in.
const ONE_ACCOUNT = `<p class="muted" style="font-size:13px;line-height:1.7;margin:4px 0 6px">One account for everything. Movies, TV, anime, books, comics and games are built in: search, posters, seasons and new episodes all work, with nothing to connect.</p>
  <p class="muted" style="font-size:11px;line-height:1.6;margin:0 0 6px">Data from TMDB, TVmaze, AniList, Open Library and IGDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>`;
const MOVING_IN = `<details class="advanced"><summary class="sec">MOVING FROM ANOTHER TRACKER?</summary>
    <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:10px">Bring your history from Trakt, AniList, MyAnimeList, Letterboxd, Goodreads, Hardcover or Last.fm. Optional: you don't need any of these to use Tracker. (Files work too: Library → Import.)</p>
    <div id="media-accounts"></div></details>`;

// ---------- CONNECT ----------
async function renderConnect() {
  if (platform !== 'web') return renderSync();
  const [keys, hooks] = await Promise.all([api('GET', '/keys'), api('GET', '/webhooks')]);
  const origin = location.origin;
  view.innerHTML = `
    <h1 class="view-title"><span class="t">CONNECT</span></h1>
    <p class="view-sub">Plug 128bitplay and the rest of the family in. Full reference in <code>docs/API.md</code>.</p>

    <h2 class="sec">YOUR 128BIT ACCOUNT</h2>
    <div id="family"></div>
    ${ONE_ACCOUNT}

    <h2 class="sec">GAME PLATFORMS (OPTIONAL)</h2>
    <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:10px">Pull in play time and 100% achievements: just your profile name, no keys.</p>
    <div id="platforms"></div>

    ${MOVING_IN}

    <h2 class="sec">AUTO-TRACK: PLEX, JELLYFIN, EMBY</h2>
    ${scrobbleHelp(origin)}

    <details class="advanced"><summary class="sec">ADVANCED: YOUR OWN API KEYS</summary>
    <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:10px">Not needed with a 128bit account. Only for running Tracker without one.</p>
    <div id="services"></div></details>

    <h2 class="sec">API KEYS</h2>
    <form id="key-form" class="row" style="margin-bottom:8px">
      <input class="input" name="name" required maxlength="60" placeholder="128bitplay" aria-label="Key name" style="flex:1;min-width:160px">
      <select class="input" name="preset" aria-label="Permissions" style="width:auto">
        <option value="read,ingest">read + send events</option>
        <option value="ingest">send events only</option>
        <option value="read">read only</option>
        <option value="sync">phone sync (Android app)</option>
        <option value="read,write,ingest">full (no admin)</option>
      </select>
      <button class="btn">+ CREATE KEY</button>
    </form>
    <div id="new-key"></div>
    ${keys.length ? keys.map((k) => `<div class="list-row"><div class="grow"><b>${esc(k.name)}</b> <span class="muted">${esc(k.prefix)}…</span><br>
      ${k.scopes.map((s) => `<span class="pill">${esc(s)}</span>`).join('')}${k.revoked ? '<span class="pill off">REVOKED</span>' : ''}
      <div class="muted" style="font-size:12px;margin-top:4px">${k.last_used_at ? 'last used ' + new Date(k.last_used_at).toLocaleString() : 'never used'}</div></div>
      ${k.revoked ? '' : `<button class="btn pink small" data-revoke="${k.id}">REVOKE</button>`}</div>`).join('') : '<p class="muted">No keys yet.</p>'}

    <h2 class="sec">128BITPLAY QUICKSTART</h2>
    <div class="code">curl -X POST ${esc(origin)}/api/v1/events \\
  -H "Authorization: Bearer $TRACKER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "id": "play-evt-0001",
    "type": "game.session",
    "source": "128bitplay",
    "data": {
      "game": { "id": "g-42", "title": "Pixel Quest", "platform": "web" },
      "minutes": 35
    }
  }'</div>
    <p class="muted" style="font-size:13px;margin-top:8px;line-height:1.6">The game lands in your Library, the session adds play time, and any tracker listening to <code>game.session</code> gets logged.</p>

    <h2 class="sec">WEBHOOKS: TRACKER TO YOUR APPS</h2>
    <form id="hook-form" class="row" style="margin-bottom:8px">
      <input class="input" name="url" type="url" required placeholder="https://128bitplay.example/hooks/tracker" aria-label="Webhook URL" style="flex:2;min-width:200px">
      <input class="input" name="event_types" value="*" aria-label="Event types" placeholder="habit.completed, streak.*" style="flex:1;min-width:140px">
      <button class="btn">+ ADD</button>
    </form>
    <div id="new-hook"></div>
    ${hooks.length ? hooks.map((h) => `<div class="list-row"><div class="grow"><b style="overflow-wrap:anywhere">${esc(h.url)}</b><br>
      ${h.event_types.map((s) => `<span class="pill">${esc(s)}</span>`).join('')}${h.active ? '' : '<span class="pill off">PAUSED</span>'}
      <div class="muted" style="font-size:12px;margin-top:4px">${h.last_status ? 'last: HTTP ' + h.last_status : h.last_error ? 'last error: ' + esc(h.last_error) : 'no deliveries yet'}</div></div>
      <button class="btn ghost small" data-toggle-hook="${h.id}" data-active="${h.active}">${h.active ? 'PAUSE' : 'RESUME'}</button>
      <button class="btn pink small" data-del-hook="${h.id}">DELETE</button></div>`).join('') : '<p class="muted">No webhooks yet.</p>'}

    <h2 class="sec">YOUR DATA</h2>
    <p class="muted" style="margin-bottom:12px">Local-first: it all lives in one SQLite file on your machine.</p>
    <div class="row"><a class="btn ghost" href="#" id="export">⬇ EXPORT JSON</a>${importButton()}</div>
    <h2 class="sec">🎨 COLOURS</h2>
    <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:10px">Pick a colour for each kind (calendar, Continue, timeline) and for the app itself. Saved on this device.</p>
    <div id="colors"></div>
`;
  bindImport(renderConnect);
  renderColors($('#colors'));
  await renderFamily($('#family'));
  await renderPlatforms($('#platforms'), 'games');
  await renderPlatforms($('#media-accounts'), 'media');
  await renderServices($('#services'));

  $('#key-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    const k = await api('POST', '/keys', { name: f.name, scopes: f.preset.split(',') });
    await renderConnect();
    $('#new-key').innerHTML = `<p class="muted" style="font-size:13px">Copy this now — it won't be shown again:</p><div class="secret">${esc(k.key)}</div>`;
  }));
  $('#hook-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const h = await api('POST', '/webhooks', formData(e.target));
    await renderConnect();
    $('#new-hook').innerHTML = `<p class="muted" style="font-size:13px">Signing secret (verify <code>X-128bit-Signature</code>) — shown once:</p><div class="secret">${esc(h.secret)}</div>`;
  }));
  view.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', guard(async () => {
    if (!confirm('Revoke this key? Apps using it stop working.')) return;
    await api('DELETE', `/keys/${b.dataset.revoke}`); renderConnect();
  })));
  view.querySelectorAll('[data-toggle-hook]').forEach((b) => b.addEventListener('click', guard(async () => {
    await api('PATCH', `/webhooks/${b.dataset.toggleHook}`, { active: b.dataset.active !== 'true' }); renderConnect();
  })));
  view.querySelectorAll('[data-del-hook]').forEach((b) => b.addEventListener('click', guard(async () => {
    if (!confirm('Delete this webhook?')) return;
    await api('DELETE', `/webhooks/${b.dataset.delHook}`); renderConnect();
  })));
  $('#export').addEventListener('click', guard(async (e) => {
    e.preventDefault();
    const data = await api('GET', '/export');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `128bittracker-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }));
}

async function renderServices(el) {
  const list = await api('GET', '/services');
  el.innerHTML = list.map((c) => `<details class="platform"><summary><span class="platform-name">${esc(c.label)}</span>
      <span class="muted platform-state">${c.configured ? '✓ key saved' : 'optional'}</span></summary>
    <form data-svc="${c.name}"><p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:12px">${esc(c.help)}</p>
      ${c.fields.map((f) => `<div class="field"><label for="sv-${c.name}-${f.key}">${esc(f.label.toUpperCase())}</label>
        <input class="input" id="sv-${c.name}-${f.key}" name="${f.key}" ${f.secret ? 'type="password" autocomplete="off"' : ''} value="${f.secret ? '' : esc(f.value ?? '')}" placeholder="${f.secret && f.set ? 'saved — paste to replace' : ''}"></div>`).join('')}
      <button class="btn teal small">SAVE</button></form></details>`).join('');
  el.querySelectorAll('form[data-svc]').forEach((form) => form.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('PUT', `/services/${form.dataset.svc}`, formData(form));
    toast('SAVED');
    await renderServices(el);
  })));
}

// ---------- imports ----------
function importModal() {
  modal('IMPORT YOUR HISTORY', `<p class="muted" style="font-size:14px;line-height:1.7;margin-bottom:14px">Bring your lists from:</p>
    <ul class="import-list">
      <li><b>Goodreads</b>: My Books → Import and export → Export library</li>
      <li><b>StoryGraph</b>: Manage account → Export StoryGraph library</li>
      <li><b>Letterboxd</b>: Settings → Data → Export your data (use watched.csv, diary.csv, ratings.csv or watchlist.csv)</li>
      <li><b>MyAnimeList</b>: Profile → Export lists (anime or manga, unzip the .xml)</li>
      <li><b>Steam / Xbox / PlayStation</b>: connect them on the ${platform === 'web' ? 'Connect' : 'Sync'} tab</li>
    </ul>
    <label class="btn teal" style="cursor:pointer;margin-top:8px">CHOOSE FILE<input type="file" accept=".csv,.xml,text/csv,text/xml,application/xml" id="imp-file" hidden></label>
    <p class="muted" id="imp-status" style="font-size:13px;margin-top:12px">Re-importing the same file updates instead of duplicating.</p>`, (m, close) => {
    m.querySelector('#imp-file').addEventListener('change', guard(async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      m.querySelector('#imp-status').textContent = `Importing ${file.name}…`;
      const r = await api('POST', '/imports', { text: await file.text(), filename: file.name });
      close();
      toast(`${r.format}: ${r.added} ADDED · ${r.updated} UPDATED${r.trophies ? ` · ${r.trophies} TROPHIES` : ''}`);
      await renderLibrary();
    }));
  });
}

// ---------- 128bit family account ----------
async function renderFamily(el) {
  const f = await api('GET', '/family');
  if (!f.signed_in) {
    el.innerHTML = `<form class="family" id="fam-form">
      <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:12px">One account for 128bitPlay, 128bitfit, Gold and Tracker. Sign in with the same email you use in 128bitPlay (Settings → Account) to pull in what you read, watch and lift, and share your streaks and trophies back.</p>
      <div class="field"><label for="fam-email">EMAIL</label><input class="input" id="fam-email" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="fam-pass">PASSWORD</label><input class="input" id="fam-pass" name="password" type="password" autocomplete="current-password" required minlength="6"></div>
      <div class="row"><button class="btn teal">SIGN IN</button><button type="button" class="btn ghost" id="fam-signup">CREATE ACCOUNT</button></div>
      <div class="row" style="margin-top:10px"><button type="button" class="btn ghost" data-provider="google">CONTINUE WITH GOOGLE</button><button type="button" class="btn ghost" data-provider="apple">CONTINUE WITH APPLE</button></div>
      <p class="muted" style="font-size:12px;margin-top:10px;line-height:1.6">New here? Create an account and you get your own library and lists, on every device and in 128bitPlay.</p>
    </form>`;
    const form = $('#fam-form');
    const signedIn = async () => {
      toast('SIGNED IN · SYNCING');
      await renderFamily(el);
      const r = await api('POST', '/family/sync', {});
      await renderFamily(el);
      if (r?.pulled) refresh();
    };
    form.addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/family/signin', formData(form));
      } catch (err) {
        if (await otherAccount(err)) return;
        throw err;
      }
      await signedIn();
    }));
    $('#fam-signup').addEventListener('click', guard(async () => {
      if (!form.reportValidity()) return;
      let r;
      try { r = await api('POST', '/family/signup', formData(form)); } catch (err) { if (await otherAccount(err)) return; throw err; }
      if (r.confirm_email) toast('CHECK YOUR EMAIL, THEN SIGN IN');
      else await signedIn();
    }));
    el.querySelectorAll('[data-provider]').forEach((b) => b.addEventListener('click', guard(async () => {
      const redirect = platform === 'web' ? `${location.origin}/connect` : 'app.bit128.tracker://auth';
      const { url } = await api('POST', '/family/oauth/start', { provider: b.dataset.provider, redirect });
      if (platform === 'web') location.href = url;
      else await api('POST', '/app/open-url', { url });
    })));
    return;
  }

  el.innerHTML = `<div class="family">
    <p style="margin-bottom:10px">✓ Signed in as <b>${esc(f.email)}</b>${f.project ? ` <span class="pill">${esc(f.project)}</span>` : ''}</p>
    <p class="muted" style="font-size:13px;margin-bottom:12px">Last sync: ${f.last_sync_at ? new Date(f.last_sync_at).toLocaleString() : 'never'} · ${f.pulled_total} in · ${f.pushed_total} out</p>
    ${f.last_error ? `<p class="nudge">Last error: ${esc(f.last_error)}</p>` : ''}
    <p class="muted" style="font-size:13px;margin-bottom:12px;line-height:1.6">${f.cloud?.enabled
      ? `☁ Cloud library on: your library and lists are on every device you sign in to, and 128bitPlay shows your lists.${f.cloud.last_sync_at ? ` Synced ${new Date(f.cloud.last_sync_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}`
      : `☁ Cloud library: ${esc(f.cloud?.last_error ?? 'turns on with the next sync')}`}</p>
    <details class="platform"><summary><span class="platform-name">👤 Public profile</span><span class="muted platform-state">${f.cloud?.profile?.is_public ? '@' + esc(f.cloud.profile.handle) : 'private'}</span></summary>
      <form id="prof-form"><p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:12px">Private unless you turn it on. Public shows your trophy shelf and public lists, nothing else.</p>
        <div class="field"><label for="pf-handle">HANDLE</label><input class="input" id="pf-handle" name="handle" pattern="[a-z0-9_]{3,24}" placeholder="pixelfan" value="${esc(f.cloud?.profile?.handle ?? '')}"></div>
        <div class="field"><label for="pf-name">DISPLAY NAME</label><input class="input" id="pf-name" name="display_name" maxlength="60" value="${esc(f.cloud?.profile?.display_name ?? '')}"></div>
        <label class="row" style="font-size:14px;margin-bottom:12px;gap:8px"><input type="checkbox" name="is_public" ${f.cloud?.profile?.is_public ? 'checked' : ''}> Public profile</label>
        <button class="btn teal small">SAVE</button></form></details>
    <div class="row"><button class="btn teal small" id="fam-sync">⟳ SYNC NOW</button><button class="btn ghost small" id="fam-out">SIGN OUT</button></div></div>`;
  $('#prof-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const form = e.target;
    await api('POST', '/family/profile', { handle: form.elements.handle.value || null, display_name: form.elements.display_name.value || null, is_public: form.elements.is_public.checked });
    toast('PROFILE SAVED');
    await renderFamily(el);
  }));

  $('#fam-sync').addEventListener('click', guard(async () => {
    $('#fam-sync').disabled = true;
    const r = await api('POST', '/family/sync', {});
    toast(r.error ? `SYNC FAILED: ${r.error}` : `FAMILY · ${r.pulled} IN · ${r.pushed} OUT`, !!r.error);
    if (r.new_trophies?.length) celebrate(r.new_trophies[0]);
    await renderFamily(el);
  }));
  $('#fam-out').addEventListener('click', guard(async () => {
    if (!confirm('Sign out of the 128bit family account? Your data stays here.')) return;
    await api('POST', '/family/signout', {});
    await renderFamily(el);
  }));
}

/**
 * Someone else signing in on a Tracker that holds another account's library.
 * The phone opens a separate library for them; the server can't.
 */
async function otherAccount(err) {
  if (err.data?.code !== 'other_account') return false;
  if (platform === 'web') {
    toast('THIS TRACKER HOLDS ANOTHER ACCOUNT', true);
    alert('This Tracker server already holds another 128bit account\'s library. Each account gets its own library: use the Android app or your own Tracker server.');
    return true;
  }
  const who = err.data.account?.email ?? 'that account';
  if (!confirm(`Switch to ${who}'s own library on this phone? The library here stays for when its owner signs back in.`)) return true;
  await api('POST', '/device/switch-account', { account: err.data.account });
  return true;
}

/** Back from Google / Apple on the web (?code=…). */
async function finishWebOAuth() {
  if (platform !== 'web') return;
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  const error = q.get('error_description');
  const connected = q.get('connected');
  if (connected && (q.get('ok') || q.get('error'))) {
    history.replaceState(null, '', location.pathname);
    if (q.get('ok')) {
      await api('GET', '/connect').catch(() => {});
      toast(`✓ CONNECTED${q.get('account') ? ' AS ' + q.get('account').toUpperCase() : ''} · SYNCING`);
      api('POST', `/connectors/${connected}/sync`, {}).then(refresh).catch(() => {});
    } else toast(`CONNECT FAILED: ${q.get('error')}`.toUpperCase(), true);
    return;
  }
  if (!code && !error) return;
  history.replaceState(null, '', location.pathname);
  if (error) return toast(error.toUpperCase(), true);
  try {
    await api('POST', '/family/oauth/finish', { code });
    toast('SIGNED IN');
    api('POST', '/family/sync', {}).then(refresh).catch(() => {});
  } catch (err) {
    if (!(await otherAccount(err))) toast(err.message.toUpperCase(), true);
  }
}

// ---------- game platforms + media accounts ----------
const PLATFORM_ICON = { steam: '🎮', xbox: '🟢', psn: '🔷' };

function syncSummary(r, group) {
  return group === 'media'
    ? `${r.items} on your lists · ${r.added} new`
    : `${r.games} games · ${r.perfect} at 100%${r.minutes ? ` · +${fmtMin(r.minutes)}` : ''}`;
}

async function renderPlatforms(el, group = 'games') {
  const list = (await api('GET', '/connectors')).filter((c) => (c.group ?? 'games') === group);
  el.innerHTML = list.map((c) => `<details class="platform">
    <summary><span class="platform-name">${c.icon ?? PLATFORM_ICON[c.name] ?? '🎮'} ${esc(c.label)}</span>
      ${c.official ? '' : '<span class="pill">UNOFFICIAL</span>'}
      <span class="muted platform-state">${c.connected ? '✓ connected' : c.last_error ? '⚠ error' : c.last_sync_at ? `synced ${new Date(c.last_sync_at).toLocaleDateString()}` : c.configured ? 'ready' : 'not connected'}</span></summary>
    <form data-conn="${c.name}">
      <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:12px">${esc(c.help)}</p>
      ${c.oauth ? (c.connected
        ? `<p style="margin-bottom:12px">✓ Connected to ${esc(c.label)}. Changes here go back to it. <button type="button" class="btn ghost small" data-oauth-off="${c.oauth}">UNLINK</button></p>`
        : c.hub ? `<div class="row" style="margin-bottom:12px"><button type="button" class="btn teal" data-oauth="${c.oauth}">CONNECT ${esc(c.label.toUpperCase())}</button></div><p class="muted" style="font-size:12px;margin-bottom:10px">Or by username:</p>`
        : `<p class="muted" style="font-size:12px;margin-bottom:10px">Sign in to your 128bit account (above) for one-tap Connect.</p>`) : ''}
      ${c.warning ? `<p class="nudge" style="line-height:1.6">⚠ ${esc(c.warning)}</p>` : ''}
      ${c.fields.filter((f) => !(f.hub && f.optional && !f.set) || c.showKeys).map((f) => `<div class="field"><label for="cf-${c.name}-${f.key}">${esc(f.label.toUpperCase())}${f.optional ? ' <span class="muted">(OPTIONAL)</span>' : ''}</label>
        <input class="input" id="cf-${c.name}-${f.key}" name="${f.key}" ${f.secret ? 'type="password" autocomplete="off"' : ''}
          value="${f.secret ? '' : esc(f.value ?? '')}" placeholder="${f.secret && f.set ? 'saved — paste to replace' : f.optional && f.oauth ? 'not needed: connected' : ''}"></div>`).join('')}
      ${c.fields.some((f) => f.hub && f.optional && !f.set) ? '<p class="muted" style="font-size:12px;margin-bottom:10px">✓ No key needed: 128bit Connect lends its own.</p>' : ''}
      ${c.warning ? `<label class="row" style="font-size:13px;margin-bottom:12px;gap:8px"><input type="checkbox" name="accept_risk" ${c.fields && c.configured ? '' : ''}> I understand the risk</label>` : ''}
      ${c.last_result ? `<p class="muted" style="font-size:12px;margin-bottom:10px">Last sync: ${syncSummary({ items: c.last_result.games, ...c.last_result }, group)}</p>` : ''}
      ${c.last_error ? `<p class="nudge">Last error: ${esc(c.last_error)}</p>` : ''}
      <div class="row"><button class="btn teal small">SAVE</button>
        <button type="button" class="btn small" data-conn-sync ${c.configured ? '' : 'disabled'}>⟳ SYNC NOW</button>
        ${c.configured ? '<button type="button" class="btn ghost small" data-conn-remove>DISCONNECT</button>' : ''}</div>
    </form></details>`).join('');

  el.querySelectorAll('[data-oauth]').forEach((b) => b.addEventListener('click', guard(async () => {
    const return_to = platform === 'web' ? `${location.origin}/connect?connected=${b.dataset.oauth}` : 'app.bit128.tracker://connect';
    const { url } = await api('POST', '/connect/start', { service: b.dataset.oauth, return_to });
    if (platform === 'web') location.href = url;
    else await api('POST', '/app/open-url', { url });
  })));
  el.querySelectorAll('[data-oauth-off]').forEach((b) => b.addEventListener('click', guard(async () => {
    if (!confirm('Unlink? Tracker stops sending changes there. Everything already synced stays.')) return;
    await api('POST', '/connect/disconnect', { service: b.dataset.oauthOff });
    await renderPlatforms(el, group);
  })));
  el.querySelectorAll('form[data-conn]').forEach((form) => {
    const name = form.dataset.conn;
    form.addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      const body = formData(form);
      if (form.querySelector('[name=accept_risk]')) body.accept_risk = form.querySelector('[name=accept_risk]').checked;
      await api('PUT', `/connectors/${name}`, body);
      toast('SAVED');
      await renderPlatforms(el, group);
      el.querySelector(`form[data-conn="${name}"]`)?.closest('details')?.setAttribute('open', '');
    }));
    form.querySelector('[data-conn-sync]').addEventListener('click', guard(async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'SYNCING…';
      try {
        const r = await api('POST', `/connectors/${name}/sync`, {});
        toast(syncSummary(r, group).toUpperCase());
        if (r.new_trophies?.length) celebrate(r.new_trophies.length === 1 ? r.new_trophies[0] : { ...r.new_trophies[0], title: `${r.new_trophies[0].title} + ${r.new_trophies.length - 1} more` });
      } finally {
        await renderPlatforms(el, group);
      }
    }));
    form.querySelector('[data-conn-remove]')?.addEventListener('click', guard(async () => {
      if (!confirm('Disconnect? Everything it synced stays in your library.')) return;
      await api('DELETE', `/connectors/${name}`);
      await renderPlatforms(el, group);
    }));
  });
}

function scrobbleHelp(origin) {
  const url = (s) => `${origin}/api/v1/scrobble/${s}?key=YOUR_KEY`;
  return `<p class="muted" style="font-size:13px;line-height:1.7;margin-bottom:10px">Finish a movie or episode on your media server and it lands here on its own: golden VHS tapes and TVs included, anime detected. Create a key under API keys below with <b>send events only</b>, put it in place of YOUR_KEY, and paste the link into your server. Your server has to be able to reach this Tracker.</p>
    <details class="platform"><summary><span class="platform-name">🟧 Plex</span><span class="muted platform-state">needs Plex Pass</span></summary>
      <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:8px">Plex Web → Settings → Webhooks → Add Webhook:</p><div class="code">${esc(url('plex'))}</div></details>
    <details class="platform"><summary><span class="platform-name">🟪 Jellyfin</span><span class="muted platform-state">free</span></summary>
      <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:8px">Dashboard → Plugins → Catalog → install <b>Webhook</b>, restart. Then Webhook → Add Generic Destination, tick <b>Playback Stop</b> and <b>User Data Saved</b>, and use:</p><div class="code">${esc(url('jellyfin'))}</div></details>
    <details class="platform"><summary><span class="platform-name">🟩 Emby</span><span class="muted platform-state">Emby Premiere</span></summary>
      <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:8px">Settings → Webhooks → Add Webhook, events <b>Playback Stop</b> and <b>Mark Played</b>:</p><div class="code">${esc(url('emby'))}</div></details>
    <details class="platform"><summary><span class="platform-name">📦 Kodi, Tautulli, scripts</span><span class="muted platform-state">any JSON</span></summary>
      <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:8px">POST JSON from a Kodi add-on, Tautulli, Home Assistant or Tasker:</p><div class="code">curl -X POST "${esc(url('generic'))}" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"episode","show":"Frieren","season":1,"episode":28}'</div></details>`;
}

// ---------- import ----------
function importButton() {
  return `<label class="btn ghost" style="cursor:pointer">⬆ IMPORT JSON<input type="file" accept="application/json,.json" id="import-file" hidden></label>`;
}
function bindImport(after) {
  $('#import-file')?.addEventListener('change', guard(async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const data = JSON.parse(await file.text());
    if (!confirm(`Replace everything here with this export${data.exported_at ? ' from ' + new Date(data.exported_at).toLocaleString() : ''}?`)) return;
    const r = await api('POST', '/import', data);
    toast(`RESTORED ${r.restored.trackers} TRACKERS · ${r.restored.items} ITEMS`);
    await after();
  }));
}

// Health Connect (Android): workouts, steps, calories and distance from any fitness app.
async function renderHealth(el) {
  const h = await api('GET', '/health');
  el.innerHTML = h.enabled
    ? `${Object.keys(h.today ?? {}).length ? `<p style="font-size:13px;margin-bottom:6px">Today: ${Object.entries(h.today).map(([src, n]) => `<b>${esc(src === 'healthconnect' ? 'Health Connect' : src.replace('128bit', '128bit '))}</b> ${Math.round(n).toLocaleString()} steps`).join(' · ')}</p>` : '<p style="font-size:13px;margin-bottom:6px">Today: no steps read yet. Tap READ NOW.</p>'}<p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:10px">✓ Connected. Workouts log your Workout tracker and steps fill your Steps tracker, from any app that writes to Health Connect (Samsung Health, Fitbit, Google Fit, Strava…). ${h.workouts} workouts so far · last read ${h.last_sync_at ? new Date(h.last_sync_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'never'}.</p>
      <div class="row"><button class="btn teal" id="hc-pull">⟳ READ NOW</button><button class="btn ghost" id="hc-settings">PERMISSIONS</button><button class="btn ghost" id="hc-off">TURN OFF</button></div>`
    : `<p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:10px">Bring in workouts, steps, calories and distance from any app that writes to Health Connect (Samsung Health, Fitbit, Google Fit, Strava…). Read-only: Tracker never changes your health data.</p>
      <div class="row"><button class="btn teal" id="hc-connect">♥ CONNECT HEALTH CONNECT</button></div>`;
  const again = () => renderHealth(el);
  $('#hc-connect', el)?.addEventListener('click', guard(async () => {
    $('#hc-connect', el).disabled = true;
    try {
      const r = await api('POST', '/health/connect', {});
      if (!r.ok) return toast(r.reason ?? 'NOT CONNECTED', true);
      // Steps and workouts need somewhere to land.
      const mine = await api('GET', '/trackers');
      if (!mine.some((t) => t.unit === 'steps')) await api('POST', '/trackers', { preset: 'steps' });
      if (!mine.some((t) => (t.listens ?? []).includes('workout.logged'))) await api('POST', '/trackers', { preset: 'workout' });
      toast(`HEALTH CONNECTED · ${r.workouts_added} WORKOUTS`);
    } finally {
      await again();
    }
  }));
  $('#hc-pull', el)?.addEventListener('click', guard(async () => {
    $('#hc-pull', el).disabled = true;
    const r = await api('POST', '/health/pull', {});
    toast(`READ · ${r.workouts_added} NEW WORKOUTS${r.today?.steps != null ? ` · ${Math.round(r.today.steps).toLocaleString()} STEPS TODAY` : ''}`);
    await again();
  }));
  $('#hc-settings', el)?.addEventListener('click', guard(() => api('POST', '/health/settings', {})));
  $('#hc-off', el)?.addEventListener('click', guard(async () => {
    await api('PUT', '/health', { enabled: false });
    await again();
  }));
}

// ---------- SYNC (Android) ----------
async function renderSync() {
  const s = await api('GET', '/sync/settings');
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');
  view.innerHTML = `
    <h1 class="view-title"><span class="t">SYNC</span></h1>
    <p class="view-sub">Everything lives on this phone and works offline. Link a Tracker server to pull in 128bitplay and other 128bit apps, and send your streaks back out.</p>
    <h2 class="sec">YOUR 128BIT ACCOUNT</h2>
    <div id="family"></div>
    ${ONE_ACCOUNT}
    <h2 class="sec">HEALTH CONNECT</h2>
    <div id="health"></div>
    <h2 class="sec">GAME PLATFORMS (OPTIONAL)</h2>
    <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:10px">Pull in play time and 100% achievements: just your profile name, no keys.</p>
    <div id="platforms"></div>
    ${MOVING_IN}
    <details class="advanced"><summary class="sec">ADVANCED</summary>
    <h2 class="sec">YOUR OWN API KEYS</h2>
    <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:10px">Not needed with a 128bit account. Only for using Tracker without one.</p>
    <div id="services"></div>
    <h2 class="sec">TRACKER SERVER</h2>
    <form id="sync-form">
      <div class="field"><label for="sy-url">SERVER URL</label><input class="input" id="sy-url" name="server_url" type="url" inputmode="url" placeholder="https://tracker.example.com" value="${esc(s.server_url ?? '')}"></div>
      <div class="field"><label for="sy-key">SYNC KEY</label><input class="input" id="sy-key" name="api_key" autocomplete="off" placeholder="${s.has_key ? 'saved (tb128_…) — paste to replace' : 'tb128_…'}"></div>
      <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:14px">On the server: Connect → API keys → "phone sync". Paste the key here once.</p>
      <div class="row"><button class="btn teal">SAVE</button>${s.server_url ? '<button type="button" class="btn ghost" id="sy-unlink">UNLINK</button>' : ''}</div>
    </form>
    <h2 class="sec">STATUS</h2>
    <div class="kpis">
      ${kpi('LAST SYNC', s.last_sync_at ? new Date(s.last_sync_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—', when(s.last_sync_at))}
      ${kpi('PULLED', s.pulled_total ?? 0, 'events from other apps')}
      ${kpi('SENT', s.pushed_total ?? 0, 'events to the server')}
    </div>
    ${s.last_error ? `<p class="nudge" style="margin-top:12px">Last error: ${esc(s.last_error)}</p>` : ''}
    <div class="row" style="margin-top:16px"><button class="btn" id="sy-run" ${s.server_url && s.has_key ? '' : 'disabled'}>⟳ SYNC NOW</button></div>
    <h2 class="sec">BACKUP</h2>
    <p class="muted" style="margin-bottom:12px;line-height:1.6">${s.server_url ? `The server keeps your last 10 backups, made automatically whenever something changes. Last backup: <b style="color:var(--ink)">${when(s.last_backup_at)}</b>.` : 'Link a server to get automatic backups.'}</p>
    <div class="row" style="margin-bottom:12px">
      <button class="btn teal" id="sy-backup" ${s.server_url && s.has_key ? '' : 'disabled'}>⬆ BACK UP NOW</button>
      <button class="btn ghost" id="sy-restore" ${s.server_url && s.has_key ? '' : 'disabled'}>⬇ RESTORE FROM SERVER</button>
    </div>
    <h2 class="sec">APP</h2>
    <p class="muted" style="margin-bottom:12px">Updates come from GitHub Releases and install over this app, keeping your data.</p>
    <div class="row" style="margin-bottom:12px"><button class="btn ghost" id="up-check">⟳ CHECK FOR UPDATES</button><span class="muted" id="up-version"></span></div>
    </details>
    <h2 class="sec">🎨 COLOURS</h2>
    <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:10px">Pick a colour for each kind (calendar, Continue, timeline) and for the app itself. Saved on this device.</p>
    <div id="colors"></div>
    <h2 class="sec">FILES</h2>
    <div class="row"><button class="btn ghost" id="export">⬇ EXPORT JSON</button>${importButton()}</div>`;
  bindImport(renderSync);
  renderColors($('#colors'));
  await renderFamily($('#family'));
  await renderHealth($('#health'));
  await renderPlatforms($('#platforms'), 'games');
  await renderPlatforms($('#media-accounts'), 'media');
  await renderServices($('#services'));
  $('#up-check').addEventListener('click', guard(async () => {
    $('#up-check').disabled = true;
    try {
      const u = await api('GET', '/app/update');
      $('#up-version').textContent = `This is v${u.current}`;
      if (u.available) showUpdate(u, { force: true });
      else toast(u.latest ? `UP TO DATE · v${u.current}` : 'NO RELEASES YET');
    } finally {
      $('#up-check').disabled = false;
    }
  }));
  $('#sy-backup').addEventListener('click', guard(async () => {
    $('#sy-backup').disabled = true;
    await api('POST', '/sync/backup', {});
    toast('BACKED UP');
    await renderSync();
  }));
  $('#sy-restore').addEventListener('click', guard(async () => {
    if (!confirm('Replace everything on this phone with the latest server backup?')) return;
    const r = await api('POST', '/sync/restore', {});
    toast(`RESTORED ${r.restored.trackers} TRACKERS · ${r.restored.items} ITEMS`);
    await renderSync();
  }));
  $('#sync-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    await api('PUT', '/sync/settings', { server_url: f.server_url, ...(f.api_key ? { api_key: f.api_key.trim() } : {}) });
    toast('SAVED');
    await renderSync();
  }));
  $('#sy-unlink')?.addEventListener('click', guard(async () => {
    if (!confirm('Unlink this server? Your data stays on the phone.')) return;
    await api('PUT', '/sync/settings', { server_url: '', api_key: '' });
    await renderSync();
  }));
  $('#sy-run').addEventListener('click', guard(async () => {
    $('#sy-run').disabled = true;
    const r = await api('POST', '/sync/run', {});
    toast(r.error ? `SYNC FAILED: ${r.error}` : `SYNCED · ${r.pulled} IN · ${r.pushed} OUT${r.backed_up ? ' · BACKED UP' : ''}`, !!r.error);
    await renderSync();
  }));
  $('#export').addEventListener('click', guard(async () => {
    const data = await api('GET', '/export');
    await api('POST', '/share-file', { name: `128bittracker-${todayStr()}.json`, text: JSON.stringify(data, null, 2) });
  }));
}

// ---------- boot ----------
async function boot() {
  META = await api('GET', '');
  if (!META.authenticated && !META.password_required) {
    $('#tabs').classList.add('hidden');
    view.innerHTML = `<div class="login"><span class="px">LOCAL ONLY</span><p class="muted">Open Tracker from the machine it runs on, or set TRACKER_PASSWORD on the server to log in from elsewhere.</p></div>`;
    return;
  }
  if (!META.authenticated) return showLogin();
  await finishWebOAuth();
  go(current(), false);
  // Pull in what the other 128bit apps posted (the Android app does this in main.js).
  if (platform === 'web') {
    request('POST', '/family/sync', {}).then(({ data }) => { if (data?.pulled) refresh(); }).catch(() => {});
  }
}
guard(boot)();
