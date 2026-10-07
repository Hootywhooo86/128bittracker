// 128bit Tracker app — vanilla JS. On the web it talks to the server's
// /api/v1; in the Android app the same API runs on-device (see transport.js).
import { request, platform } from './transport.js';

const APP_COLORS = {
  '128bittracker': '#2dd4bf', '128bitplay': '#ff5d8f', '128bitfit': '#fb923c', '128bitgold': '#facc15',
  '128bitmusic': '#a78bfa', '128bitfantasy': '#4ade80', '128bittrip': '#38bdf8', '128bitlife': '#ff9f1c',
};
const STATUS_LABEL = { planned: 'PLANNED', active: 'IN PROGRESS', on_hold: 'ON HOLD', done: 'DONE', dropped: 'DROPPED' };

let META = null;
const state = { libType: '', libStatus: '', libQuery: '', tlSource: '', tlAll: false };

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');

async function api(method, path, body) {
  const { status, data } = await request(method, path, body);
  if (status === 401 && path !== '/session') { showLogin(); throw new Error('login required'); }
  if (status >= 400) throw new Error(data?.error || `HTTP ${status}`);
  return data;
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

// ---------- TODAY ----------
async function renderToday() {
  const trackers = await api('GET', '/trackers');
  const done = trackers.filter((t) => t.today.done).length;
  view.innerHTML = `
    <h1 class="view-title"><span class="t">TODAY</span> <span class="muted" style="font-size:.6em">${esc(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }))}</span></h1>
    <p class="view-sub">${trackers.length ? `${done}/${trackers.length} done. Two taps and it's on the record.` : 'Nothing tracked yet. Start with one habit.'}</p>
    <div class="row" style="margin-bottom:18px"><button class="btn" id="new-tracker">+ NEW TRACKER</button></div>
    ${trackers.length ? `<div class="cards">${trackers.map(trackerCard).join('')}</div>` : `<div class="empty"><span class="px">NO TRACKERS YET</span>Pick a preset — water, sleep, reading, mood — or make your own.</div>`}`;
  $('#new-tracker').addEventListener('click', newTrackerModal);
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
  const q = new URLSearchParams();
  if (state.libType) q.set('type', state.libType);
  if (state.libStatus) q.set('status', state.libStatus);
  if (state.libQuery) q.set('q', state.libQuery);
  const items = await api('GET', '/items?' + q);
  const types = Object.entries(META.item_types);
  view.innerHTML = `
    <h1 class="view-title"><span class="o">LIBRARY</span></h1>
    <p class="view-sub">Everything you play, watch, read and listen to. 128bitplay games show up here on their own.</p>
    <div class="row" style="margin-bottom:16px">
      <button class="btn" id="add-item">+ ADD</button>
      <input class="input" id="lib-q" type="search" placeholder="Search title or creator" aria-label="Search library" value="${esc(state.libQuery)}" style="flex:1;min-width:180px">
    </div>
    <div class="chips" role="group" aria-label="Type">
      <button class="chip" data-type="" aria-pressed="${!state.libType}">All</button>
      ${types.map(([k, v]) => `<button class="chip" data-type="${k}" aria-pressed="${state.libType === k}">${v.icon} ${k}</button>`).join('')}
    </div>
    <div class="chips" role="group" aria-label="Status">
      <button class="chip" data-status="" aria-pressed="${!state.libStatus}">Any status</button>
      ${META.statuses.map((s) => `<button class="chip" data-status="${s}" aria-pressed="${state.libStatus === s}">${STATUS_LABEL[s].toLowerCase()}</button>`).join('')}
    </div>
    ${items.length ? `<div class="lib">${items.map(tile).join('')}</div>` : `<div class="empty"><span class="px">NOTHING HERE YET</span>Add a game, show or book — or connect 128bitplay from the Connect tab.</div>`}`;
  $('#add-item').addEventListener('click', () => itemModal());
  let t;
  $('#lib-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(guard(async () => { state.libQuery = e.target.value; await renderLibrary(); $('#lib-q').focus(); $('#lib-q').setSelectionRange(9999, 9999); }), 250); });
  view.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => { state.libType = b.dataset.type; guard(renderLibrary)(); }));
  view.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => { state.libStatus = b.dataset.status; guard(renderLibrary)(); }));
  view.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', guard(async () => itemDetail(await api('GET', `/items/${b.dataset.item}`)))));
}

function tile(i) {
  const pct = i.progress_total ? Math.min(100, Math.round((i.progress / i.progress_total) * 100)) : null;
  return `<button class="tile" data-item="${i.id}">
    <div class="cover">${i.cover_url ? `<img src="${esc(i.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span aria-hidden="true">${esc(i.icon)}</span>`}
      <span class="status ${i.status}">${STATUS_LABEL[i.status]}</span>${i.source !== 'manual' ? `<span class="src">${esc(i.source.replace('128bit', ''))}</span>` : ''}</div>
    <div class="tile-body"><div class="tile-title">${esc(i.title)}</div>
      <div class="tile-sub">${esc(i.icon)} ${esc(i.type)}${i.creator ? ' · ' + esc(i.creator) : ''}${i.year ? ' · ' + i.year : ''}</div>
      ${pct != null ? `<div class="mini-bar" title="${pct}%"><span style="width:${pct}%"></span></div>` : ''}
      ${i.rating ? `<div class="stars"><span style="font-family:var(--sans)">★</span> ${i.rating}/10</div>` : ''}</div>
  </button>`;
}

function itemModal(item = {}) {
  const editing = !!item.id;
  const types = Object.keys(META.item_types);
  modal(editing ? `EDIT ${item.title}` : 'ADD TO LIBRARY', `<form>
    <div class="field"><label for="if-title">TITLE</label><input class="input" id="if-title" name="title" required maxlength="200" value="${esc(item.title ?? '')}"></div>
    <div class="grid2">
      <div class="field"><label for="if-type">TYPE</label><select class="input" id="if-type" name="type">${types.map((t) => `<option ${(item.type ?? state.libType ?? 'game') === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label for="if-status">STATUS</label><select class="input" id="if-status" name="status">${META.statuses.map((s) => `<option value="${s}" ${(item.status ?? 'planned') === s ? 'selected' : ''}>${STATUS_LABEL[s].toLowerCase()}</option>`).join('')}</select></div>
      <div class="field"><label for="if-creator">CREATOR</label><input class="input" id="if-creator" name="creator" maxlength="120" value="${esc(item.creator ?? '')}" placeholder="Author, studio, artist"></div>
      <div class="field"><label for="if-year">YEAR</label><input class="input" id="if-year" name="year" type="number" min="0" value="${esc(item.year ?? '')}"></div>
      <div class="field"><label for="if-total">TOTAL (PAGES / EPISODES)</label><input class="input" id="if-total" name="progress_total" type="number" min="0" step="any" value="${esc(item.progress_total ?? '')}"></div>
      <div class="field"><label for="if-cover">COVER IMAGE URL</label><input class="input" id="if-cover" name="cover_url" type="url" value="${esc(item.cover_url ?? '')}" placeholder="https://…"></div>
    </div>
    <button class="btn teal">${editing ? 'SAVE' : 'ADD'}</button></form>`, (m, close) => {
    m.querySelector('form').addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      const body = { ...f, year: f.year || null, progress_total: f.progress_total || null, cover_url: f.cover_url || null, creator: f.creator || null };
      const saved = editing ? await api('PATCH', `/items/${item.id}`, body) : await api('POST', '/items', body);
      close(); toast(editing ? 'SAVED' : 'ADDED'); await renderLibrary();
      if (editing) itemDetail(await api('GET', `/items/${saved.id}`));
    }));
  });
}

function itemDetail(i) {
  const unit = META.item_types[i.type]?.unit ?? '';
  modal(`${i.icon} ${i.title}`, `
    <p class="muted" style="font-size:13px;margin:-8px 0 16px">${esc(i.type)}${i.creator ? ' · ' + esc(i.creator) : ''}${i.year ? ' · ' + i.year : ''}${i.source !== 'manual' ? ' · synced from ' + esc(i.source) : ''}</p>
    <div class="chips" role="group" aria-label="Status">${META.statuses.map((s) => `<button class="chip" data-set-status="${s}" aria-pressed="${i.status === s}">${STATUS_LABEL[s].toLowerCase()}</button>`).join('')}</div>
    <div class="field"><label>RATING</label><div class="rating">${Array.from({ length: 10 }, (_, n) => `<button data-rate="${n + 1}" class="${i.rating && n < i.rating ? 'on' : ''}" aria-label="Rate ${n + 1}">${n + 1}</button>`).join('')}</div></div>
    <h2 class="sec">LOG A SESSION</h2>
    <form data-session class="grid2">
      <div class="field"><label for="s-min">MINUTES</label><input class="input" id="s-min" name="minutes" type="number" min="0" max="1440" placeholder="45"></div>
      <div class="field"><label for="s-prog">PROGRESS ${unit ? '(' + esc(unit) + ')' : ''}</label><input class="input" id="s-prog" name="progress" type="number" min="0" step="any" placeholder="${esc(i.progress ?? 0)}${i.progress_total ? ' / ' + i.progress_total : ''}"></div>
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
    m.querySelector('[data-session]').addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      await api('POST', `/items/${i.id}/sessions`, { minutes: f.minutes ? Number(f.minutes) : 0, progress: f.progress === '' ? null : Number(f.progress) });
      toast('SESSION LOGGED'); close(); renderLibrary(); itemDetail(await api('GET', `/items/${i.id}`));
    }));
    m.querySelector('[data-review]').addEventListener('submit', guard(async (e) => { e.preventDefault(); await api('PATCH', `/items/${i.id}`, { review: formData(e.target).review }); toast('SAVED'); }));
    m.querySelector('[data-edit-item]').addEventListener('click', () => { close(); itemModal(i); });
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
  const events = state.tlAll ? all : all.filter((e) => e.type !== 'habit.logged' && !(e.source === '128bittracker' && e.type.startsWith('item.') && e.data.source && e.data.source !== 'manual'));
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
    <div class="chips" role="group" aria-label="Source">
      <button class="chip" data-src="" aria-pressed="${!state.tlSource}">All apps</button>
      ${sources.map((s) => `<button class="chip" data-src="${s}" aria-pressed="${state.tlSource === s}" style="--c:${APP_COLORS[s]}">${s.replace('128bit', '')}</button>`).join('')}
      <span class="spacer"></span>
      <button class="chip" id="tl-all" aria-pressed="${state.tlAll}">show every log</button>
    </div>
    ${events.length ? [...groups].map(([day, evs]) => `<div class="tl-day">${day === todayStr() ? 'TODAY' : esc(new Date(day + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase())}</div>
      <div class="tl">${evs.map(tlItem).join('')}</div>`).join('') : `<div class="empty"><span class="px">QUIET SO FAR</span>Log a habit or connect a 128bit app and events show up here.</div>`}`;
  view.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', () => { state.tlSource = b.dataset.src; guard(renderTimeline)(); }));
  $('#tl-all').addEventListener('click', () => { state.tlAll = !state.tlAll; guard(renderTimeline)(); });
}

function tlItem(e) {
  const c = APP_COLORS[e.source] ?? '#9a97b8';
  const title = e.title ?? describe(e);
  return `<div class="tl-item" style="--c:${c}"><div class="tl-title">${esc(title)}</div>
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
  const [s, pixels] = await Promise.all([api('GET', '/stats'), api('GET', `/stats/year/${year}`)]);
  const lib = Object.entries(s.library).sort((a, b) => b[1].total - a[1].total);
  const max = Math.max(1, ...pixels.days.map((d) => d.logs + d.events));
  const lvl = (n) => (n === 0 ? '' : n / max > 0.75 ? 'l4' : n / max > 0.4 ? 'l3' : n / max > 0.15 ? 'l2' : 'l1');
  const pad = (new Date(year, 0, 1).getDay() + 6) % 7; // weeks start Monday
  const minutes = lib.reduce((a, [, v]) => a + (v.minutes ?? 0), 0);
  view.innerHTML = `
    <h1 class="view-title"><span class="o">STATS</span></h1>
    <p class="view-sub">Numbers, not guilt.</p>
    <div class="kpis">
      ${kpi('DONE TODAY', `${s.habits.done_today}/${s.habits.count}`, 'habits')}
      ${kpi('BEST LIVE STREAK', `🔥${s.habits.best_current_streak}`, `all-time best ${s.habits.best_ever_streak}`)}
      ${kpi('30-DAY RATE', `${s.habits.avg_completion_30d}%`, 'average completion')}
      ${kpi(`FINISHED IN ${year}`, s.finished_this_year, 'games, books, shows…')}
      ${kpi('TIME LOGGED', fmtMin(minutes), 'across the library')}
      ${kpi('AVG RATING', s.average_rating ?? '—', 'out of 10')}
    </div>
    <h2 class="sec">${year} IN PIXELS</h2>
    <div class="pixels-wrap"><div class="pixels" role="img" aria-label="Activity per day in ${year}">${'<i style="visibility:hidden"></i>'.repeat(pad)}${pixels.days.map((d) => `<i class="${lvl(d.logs + d.events)}" title="${d.day}: ${d.logs} logs, ${d.events} events"></i>`).join('')}</div></div>
    <div class="legend">less <i style="background:var(--panel-2)"></i><i style="background:#134e48"></i><i style="background:#1f8a7d"></i><i style="background:var(--teal)"></i><i style="background:var(--orange)"></i> more</div>
    <h2 class="sec">LIBRARY</h2>
    ${lib.length ? `<div class="table-wrap"><table class="lib-stats"><thead><tr><th>TYPE</th><th class="n">TOTAL</th><th class="n">ACTIVE</th><th class="n">DONE</th><th class="n">TIME</th></tr></thead><tbody>
      ${lib.map(([t, v]) => `<tr><td>${esc(META.item_types[t]?.icon ?? '📦')} ${esc(t)}</td><td class="n">${v.total}</td><td class="n">${v.active ?? 0}</td><td class="n">${v.done ?? 0}</td><td class="n">${v.minutes ? fmtMin(v.minutes) : '—'}</td></tr>`).join('')}
    </tbody></table></div>` : `<p class="muted">Library is empty.</p>`}`;
}
const kpi = (k, v, s) => `<div class="kpi"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`;

// ---------- CONNECT ----------
async function renderConnect() {
  if (platform !== 'web') return renderSync();
  const [keys, hooks] = await Promise.all([api('GET', '/keys'), api('GET', '/webhooks')]);
  const origin = location.origin;
  view.innerHTML = `
    <h1 class="view-title"><span class="t">CONNECT</span></h1>
    <p class="view-sub">Plug 128bitplay and the rest of the family in. Full reference in <code>docs/API.md</code>.</p>

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
    <div class="row"><a class="btn ghost" href="#" id="export">⬇ EXPORT JSON</a>${importButton()}</div>`;
  bindImport(renderConnect);

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

// ---------- SYNC (Android) ----------
async function renderSync() {
  const s = await api('GET', '/sync/settings');
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');
  view.innerHTML = `
    <h1 class="view-title"><span class="t">SYNC</span></h1>
    <p class="view-sub">Everything lives on this phone and works offline. Link a Tracker server to pull in 128bitplay and other 128bit apps, and send your streaks back out.</p>
    <h2 class="sec">SERVER</h2>
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
    <h2 class="sec">FILES</h2>
    <div class="row"><button class="btn ghost" id="export">⬇ EXPORT JSON</button>${importButton()}</div>`;
  bindImport(renderSync);
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
  go(current(), false);
}
guard(boot)();
