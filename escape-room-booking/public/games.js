'use strict';
/*
 * Game master: one phone or tablet per room. Pick your room, press Start when the players take off their
 * blindfolds, and Stop when the team opens the exit. The server times every game; this page only shows the clock,
 * so closing or reloading it never changes a result.
 */

const ROOM_KEY = 'escape-room:gm-room';
const G = { data: null, sig: '', receivedAt: 0, roomId: null, slotId: null, pinned: false, busy: false, wake: null, deleteArmed: null, settling: 0, editing: null };

bind();
boot();
setInterval(() => { if (G.data && document.visibilityState === 'visible' && !G.busy) refresh(); }, 3000);
setInterval(tick, 250);

/* ------------------------------------------------------------------ data */

async function boot() {
  try {
    setData(await api('/api/staff/games'));
    showApp();
  } catch (err) {
    showLogin(err.status === 401 ? '' : err.message);
  }
}

async function refresh() {
  try {
    setData(await api('/api/staff/games'));
  } catch (err) {
    if (err.status === 401) showLogin('Your session ended. Sign in again.');
  }
}

const slotById = (id) => G.data.slots.find((s) => s.id === id);
const roomById = (id) => G.data.rooms.find((r) => r.id === id);
const cellOf = (slot) => slot.rooms[G.roomId];
const isLive = (g) => !!g && (g.status === 'running' || g.status === 'paused');

function setData(d, force = false) {
  G.data = d;
  G.receivedAt = Date.now();
  const saved = storageGet(ROOM_KEY);
  if (!G.roomId || !roomById(G.roomId)) G.roomId = saved && d.rooms.some((r) => r.id === saved) ? saved : d.rooms[0].id;
  if (!G.pinned || !slotById(G.slotId)) G.slotId = autoSlotId();
  // Skip redrawing when nothing changed but the clock, so a tap never lands on a button being replaced.
  const sig = JSON.stringify([d.now, d.rooms, d.slots.map((s) => [s.id, Object.entries(s.rooms).map(([id, c]) => [id, c.released, c.teams, c.game && { ...c.game, playedMs: null }])]), G.roomId, G.slotId, G.pinned, G.busy]);
  if (force || sig !== G.sig) {
    G.sig = sig;
    render();
  }
  tick();
}

/** The game this room should show: the one running, else the current time slot, else the next one with players. */
function autoSlotId() {
  const d = G.data;
  const live = d.slots.find((s) => isLive(cellOf(s).game));
  if (live) return live.id;
  if (d.now.currentSlotId) return d.now.currentSlotId;
  const next = d.slots.find((s) => !cellOf(s).game && cellOf(s).teams.length);
  return (next || d.slots[0]).id;
}

/* ------------------------------------------------------------- formatting */

function clock(ms, round = 'floor') {
  const total = Math.max(0, Math[round](ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Play time of a running or paused game right now, from the server's figure and the time since it arrived. */
function playedNow(g) {
  if (!isLive(g)) return 0;
  return g.status === 'paused' ? g.playedMs : g.playedMs + (Date.now() - G.receivedAt);
}

const STATUS = {
  running: ['Running', 'is-live'],
  paused: ['Paused', 'is-paused'],
  escaped: ['Escaped', 'is-done'],
  timeout: ['Time ran out', 'is-out'],
  gaveup: ['Gave up', 'is-out'],
  ready: ['Ready to start', 'is-ready'],
  open: ['Check-in open', 'is-open'],
  noshow: ['Nobody checked in', 'is-out'],
  empty: ['No bookings', 'is-empty'],
};

function statusKey(cell) {
  const g = cell.game;
  if (g) return g.status === 'out' ? g.outReason || 'gaveup' : g.status;
  if (!cell.teams.length) return 'empty';
  if (!cell.released) return 'open';
  return inCount(cell.teams) ? 'ready' : 'noshow';
}

function statusPill(cell) {
  const [label, cls] = STATUS[statusKey(cell)];
  return h('span', { class: `gm-pill ${cls}`, text: label });
}

const inCount = (teams) => teams.reduce((n, t) => n + t.in, 0);
const ofCount = (teams) => teams.reduce((n, t) => n + t.of, 0);

/* ---------------------------------------------------------------- screens */

function showLogin(message) {
  keepAwake(false);
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  $('#loginError').textContent = message || '';
  $('#loginError').hidden = !message;
}

function showApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  render();
}

function bind() {
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#password');
    if (!pw.value) { pw.reportValidity(); return; }
    try {
      await api('/api/staff/login', { method: 'POST', body: { password: pw.value } });
      pw.value = '';
      setData(await api('/api/staff/games'), true);
      showApp();
    } catch (err) { showLogin(err.message); }
  });
  $('#nowBtn').addEventListener('click', () => { G.pinned = false; G.slotId = autoSlotId(); render(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && G.data) refresh(); });
  bindEdit();
}

function render() {
  if (!G.data || $('#appView').hidden) return;
  const d = G.data;
  const cur = d.now.currentSlotId ? slotById(d.now.currentSlotId) : null;
  $('#nowLabel').textContent = cur ? `· now ${slotRange(cur.start, cur.end)}`
    : { before: '· before the event day', after: '· the event is over', undated: '· no event date set yet' }[d.now.phase] || '';

  $('#roomTabs').replaceChildren(...d.rooms.map((r) => {
    const live = d.slots.some((s) => isLive(s.rooms[r.id].game));
    return h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(r.id === G.roomId),
      onclick: () => { G.roomId = r.id; storageSet(ROOM_KEY, r.id); G.pinned = false; G.slotId = autoSlotId(); render(); },
    }, h('span', { text: r.name }), live ? h('span', { class: 'gm-live-dot', title: 'A game is running', 'aria-label': 'running' }) : null);
  }));

  renderCard();
  renderSlots();
  $('#nowBtn').hidden = !G.pinned || G.slotId === autoSlotId();
  keepAwake(isLive(cellOf(slotById(G.slotId)).game));
}

function renderCard() {
  const d = G.data;
  const slot = slotById(G.slotId);
  const room = roomById(G.roomId);
  const cell = cellOf(slot);
  const g = cell.game;
  const parts = [
    h('header', { class: 'gm-card-head' },
      h('div', null, h('span', { class: 'eyebrow', text: room.name }), h('h1', { class: 'gm-slot', text: slotRange(slot.start, slot.end) })),
      statusPill(cell)),
  ];

  // who is playing
  if (g) {
    parts.push(h('div', { class: 'gm-teams' }, h('p', { class: 'gm-team-name', text: g.label }), h('p', { class: 'small muted', text: plural(g.players, 'player') })));
  } else if (cell.teams.length) {
    parts.push(h('ul', { class: 'gm-team-list' }, cell.teams.map((t) => h('li', null,
      h('span', { class: 'gm-team-name', text: t.label }),
      h('span', { class: `small ${t.in === t.of ? 'gm-ok' : t.in ? 'muted' : 'gm-warn'}`, text: t.type === 'walkin' ? `walk-in · ${plural(t.of, 'player')}` : `${t.in} of ${t.of} checked in` })))));
  } else {
    parts.push(h('p', { class: 'muted', text: 'Nobody is booked into this room for this time.' }));
  }

  parts.push(timerBlock(cell));
  parts.push(controls(cell, slot));
  if (g) parts.push(cluesBlock(g, d.maxClues));
  $('#gameCard').replaceChildren(...parts);
}

function timerBlock(cell) {
  const g = cell.game;
  const minutes = G.data.gameMinutes;
  if (!g) {
    return h('div', { class: 'gm-timer is-idle' }, h('span', { class: 'gm-clock', text: clock(minutes * 60000) }),
      h('span', { class: 'gm-clock-sub', text: 'The countdown starts when you press Start' }));
  }
  if (isLive(g)) {
    return h('div', { class: 'gm-timer', id: 'timer' }, h('span', { class: 'gm-clock', id: 'clockBig' }), h('span', { class: 'gm-clock-sub', id: 'clockSub' }));
  }
  if (g.status === 'escaped') {
    const top = G.data.tvTop;
    const rankText = g.rank <= top ? `#${g.rank} in this room · on the TV leaderboard` : `#${g.rank} in this room · not in the top ${top}`;
    return h('div', { class: 'gm-timer is-escaped' }, h('span', { class: 'gm-clock-label', text: 'Escape time' }), h('span', { class: 'gm-clock', text: clock(g.escapeMs) }),
      h('span', { class: 'gm-clock-sub', text: `${rankText}${g.editedAt ? ' · edited' : ''}` }));
  }
  return h('div', { class: 'gm-timer is-out' }, h('span', { class: 'gm-clock-label', text: g.outReason === 'timeout' ? 'Time ran out' : 'Gave up' }), h('span', { class: 'gm-clock', text: '--:--' }),
    h('span', { class: 'gm-clock-sub', text: `No escape time, so the team isn't ranked${g.editedAt ? ' · edited' : ''}` }));
}

function actionButton(label, cls, onclick, { disabled = false } = {}) {
  return h('button', { type: 'button', class: `btn ${cls}`, disabled: G.busy || disabled, onclick, text: label });
}

function controls(cell, slot) {
  const g = cell.game;
  if (!g) {
    const none = !inCount(cell.teams);
    return h('div', { class: 'gm-controls' },
      actionButton('Start · blindfolds off', 'btn-primary gm-big', () => startGame(slot, cell), { disabled: none }),
      h('p', { class: 'small muted', text: none ? (cell.teams.length ? 'Start unlocks once a player checks in at the door.' : 'There is no one to start a game for.') : `Press Start when the players take off their blindfolds. The countdown starts at ${clock(G.data.gameMinutes * 60000)}.` }),
      !cell.released && cell.teams.length ? h('p', { class: 'small gm-warn', text: `Check-in is still open (it closes at ${timeLabel(slot.start)}). Starting closes it.` }) : null);
  }
  const url = (a) => `/api/staff/games/${g.id}/${a}`;
  if (g.status === 'running') {
    return h('div', { class: 'gm-controls' },
      actionButton('Stop · team opened the exit', 'btn-primary gm-big gm-stop', () => act(url('stop'), {}, (d) => escapedToast(d, g.id))),
      h('div', { class: 'gm-row' },
        actionButton('Pause', '', () => act(url('pause'), {}, 'Paused. The countdown is frozen.')),
        actionButton('Gave up', 'btn-danger', () => giveUp(g))));
  }
  if (g.status === 'paused') {
    return h('div', { class: 'gm-controls' },
      actionButton('Resume', 'btn-primary gm-big', () => act(url('resume'), {}, 'Resumed.')),
      h('div', { class: 'gm-row' },
        actionButton('Stop · team opened the exit', 'gm-stop', () => act(url('stop'), {}, (d) => escapedToast(d, g.id))),
        actionButton('Gave up', 'btn-danger', () => giveUp(g))));
  }
  return h('div', { class: 'gm-controls' },
    h('div', { class: 'gm-row' },
      g.canUndo ? actionButton(g.status === 'escaped' ? 'Undo stop' : 'Undo gave up', '', () => act(url('undo'), {}, 'Undone. The countdown carries on.')) : null,
      actionButton('Edit result', '', () => openEdit(g, slot))),
    g.canUndo ? h('p', { class: 'small faint', text: 'Tapped by mistake? Undo puts the game back on the clock, counting the time since Start.' }) : null);
}

function cluesBlock(g, max) {
  const url = `/api/staff/games/${g.id}/clue`;
  const dots = Array.from({ length: max }, (_, i) => h('span', { class: `gm-dot${i < g.clues ? ' is-used' : ''}`, 'aria-hidden': 'true' }));
  return h('div', { class: 'gm-clues' },
    h('div', null, h('strong', { text: 'Clues used' }), h('span', { class: 'small faint', text: ' · sub-feature, shown on the TV only' })),
    h('div', { class: 'gm-clue-row' },
      actionButton('−', 'gm-clue-btn', () => act(url, { delta: -1 }), { disabled: g.clues <= 0 }),
      h('span', { class: 'gm-dots', role: 'img', 'aria-label': `${g.clues} of ${max} clues used` }, dots),
      actionButton('+', 'gm-clue-btn', () => act(url, { delta: 1 }), { disabled: g.clues >= max })),
    g.clues >= max ? h('p', { class: 'small muted', text: `All ${max} clues used. A fourth clue isn't allowed.` }) : null);
}

function renderSlots() {
  const d = G.data;
  $('#dayTitle').textContent = `Today in ${roomById(G.roomId).name}`;
  $('#slotList').replaceChildren(...d.slots.map((s) => {
    const cell = cellOf(s);
    const g = cell.game;
    const who = g ? g.label : cell.teams.length ? cell.teams.map((t) => t.label).join(' & ') : 'No bookings';
    let right = '';
    if (g && g.status === 'escaped') right = `${clock(g.escapeMs)} · #${g.rank}`;
    else if (g) right = STATUS[statusKey(cell)][0];
    else if (cell.teams.length) right = cell.released ? (inCount(cell.teams) ? 'Ready' : 'Nobody in') : `${inCount(cell.teams)}/${ofCount(cell.teams)} in`;
    return h('li', null, h('button', {
      type: 'button', class: `gm-slot-row ${STATUS[statusKey(cell)][1]}`, 'aria-current': s.id === G.slotId ? 'true' : null,
      onclick: () => { G.slotId = s.id; G.pinned = s.id !== autoSlotId(); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); },
    }, h('span', { class: 'gm-slot-time mono', text: timeLabel(s.start) }), h('span', { class: 'gm-slot-who', text: who }), h('span', { class: 'gm-slot-state', text: right })));
  }));
}

/* --------------------------------------------------------------- the clock */

function tick() {
  if (!G.data || $('#appView').hidden) return;
  const g = cellOf(slotById(G.slotId)).game;
  const big = $('#clockBig');
  if (!isLive(g) || !big) { document.title = 'Game Master'; return; }
  const played = playedNow(g);
  const left = g.limitMs - played;
  big.textContent = clock(left, 'ceil');
  $('#clockSub').textContent = g.status === 'paused' ? `Paused · played ${clock(played)}` : `time left · played ${clock(played)}`;
  const timer = $('#timer');
  timer.classList.toggle('is-paused', g.status === 'paused');
  timer.classList.toggle('is-warn', g.status === 'running' && left <= 5 * 60000 && left > 60000);
  timer.classList.toggle('is-bad', g.status === 'running' && left <= 60000);
  document.title = `${clock(left, 'ceil')} · ${roomById(G.roomId).name}`;
  // At zero the server ends the game; ask for the result once a second until it arrives.
  if (g.status === 'running' && left <= 0 && Date.now() - G.settling > 1000) { G.settling = Date.now(); refresh(); }
}

async function keepAwake(on) {
  try {
    if (on && !G.wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      G.wake = await navigator.wakeLock.request('screen');
      G.wake.addEventListener('release', () => { G.wake = null; });
    } else if (!on && G.wake) {
      const w = G.wake;
      G.wake = null;
      await w.release();
    }
  } catch { G.wake = null; /* not allowed here, the screen may sleep */ }
}

/* ---------------------------------------------------------------- actions */

async function act(path, body, success, method = 'POST') {
  if (G.busy) return null;
  G.busy = true;
  render();
  try {
    const d = await api(path, { method, body });
    G.busy = false;
    setData(d, true);
    const msg = typeof success === 'function' ? success(d) : success;
    if (msg) toast(msg);
    if (navigator.vibrate) navigator.vibrate(40);
    return d;
  } catch (err) {
    G.busy = false;
    if (err.status === 401) showLogin('Your session ended. Sign in again.');
    else { toast(err.message, 'bad'); refresh(); }
    render();
    return null;
  }
}

function startGame(slot, cell) {
  if (!cell.released) {
    const missing = cell.teams.filter((t) => t.in < t.of);
    const extra = missing.length ? `\n\nNot everyone is in: ${missing.map((t) => `${t.label} (${t.in} of ${t.of})`).join(', ')}.` : '';
    if (!confirm(`Check-in is still open for ${timeLabel(slot.start)}. Starting now closes it, and spots of players who haven't checked in go to the standby list.${extra}\n\nStart the game?`)) return;
  }
  act('/api/staff/games', { slotId: slot.id, roomId: G.roomId }, 'Game started. The countdown is running.');
}

function giveUp(g) {
  if (!confirm(`Mark ${g.label} as not escaped? They get no time and aren't ranked. You can undo this for 10 minutes.`)) return;
  act(`/api/staff/games/${g.id}/giveup`, {}, 'Marked as gave up.');
}

function findGameIn(d, id) {
  for (const s of d.slots) for (const c of Object.values(s.rooms)) if (c.game && c.game.id === id) return c.game;
  return null;
}

function escapedToast(d, id) {
  const g = findGameIn(d, id);
  if (!g || g.escapeMs == null) return 'Stopped.';
  return `Escaped in ${clock(g.escapeMs)} · #${g.rank} in this room`;
}

/* ------------------------------------------------------------ edit result */

function bindEdit() {
  const form = $('#editForm');
  form.addEventListener('change', () => { $('#escapeField').hidden = form.result.value !== 'escaped'; });
  $('#editCancel').addEventListener('click', () => $('#editDialog').close());
  $('#editDialog').addEventListener('close', disarmDelete);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const g = G.editing;
    const result = form.result.value;
    const escape = $('#escapeInput').value.trim();
    const err = $('#editError');
    if (!result) { err.textContent = 'Pick a result.'; err.hidden = false; return; }
    if (result === 'escaped' && !/^\d{1,3}:[0-5]\d$/.test(escape)) { err.textContent = 'Type the escape time as minutes:seconds, like 23:36.'; err.hidden = false; return; }
    $('#editSave').disabled = true;
    try {
      const d = await api(`/api/staff/games/${g.id}/edit`, { method: 'POST', body: result === 'escaped' ? { status: 'escaped', escape } : { status: 'out', outReason: result } });
      $('#editDialog').close();
      setData(d, true);
      toast('Result saved. The leaderboard is updated.');
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    } finally {
      $('#editSave').disabled = false;
    }
  });
  $('#deleteBtn').addEventListener('click', async () => {
    const btn = $('#deleteBtn');
    if (!G.deleteArmed) {
      btn.textContent = 'Tap again to delete';
      btn.classList.add('is-armed');
      G.deleteArmed = setTimeout(disarmDelete, 5000);
      return;
    }
    disarmDelete();
    btn.disabled = true;
    try {
      const d = await api(`/api/staff/games/${G.editing.id}`, { method: 'DELETE' });
      $('#editDialog').close();
      setData(d, true);
      toast('Result deleted. The room can be started again for this time.');
    } catch (e2) {
      $('#editError').textContent = e2.message;
      $('#editError').hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

function disarmDelete() {
  clearTimeout(G.deleteArmed);
  G.deleteArmed = null;
  const btn = $('#deleteBtn');
  btn.textContent = 'Delete result';
  btn.classList.remove('is-armed');
}

function openEdit(g, slot) {
  G.editing = g;
  const form = $('#editForm');
  form.result.value = g.status === 'escaped' ? 'escaped' : g.outReason || 'gaveup';
  $('#escapeInput').value = g.escapeMs != null ? clock(g.escapeMs) : '';
  $('#escapeField').hidden = form.result.value !== 'escaped';
  $('#editTeams').textContent = `${g.label} · ${slotRange(slot.start, slot.end)}`;
  $('#editError').hidden = true;
  $('#editDialog').showModal();
}
