'use strict';
/*
 * TV leaderboard (/leaderboard): each room's top 6 by escape time, with medals for 1st to 3rd, plus the game in
 * each room right now. One public page left open on the TV. It asks the app for new results every 5 seconds and
 * lights up a team that just made the board. The server does the ranking (whole seconds; an earlier game wins a tie).
 */

const T = { data: null, sig: '', receivedAt: 0, seen: null, failures: 0, idleTimer: null };
const PLACES = ['1st', '2nd', '3rd'];

load();
setInterval(load, 5000);
setInterval(tickLive, 500);
bindScreen();

async function load() {
  try {
    const d = await api('/api/leaderboard');
    T.failures = 0;
    $('#status').hidden = true;
    const ids = new Set(d.rooms.flatMap((r) => r.top.map((e) => e.id)));
    const fresh = T.seen ? new Set([...ids].filter((id) => !T.seen.has(id))) : new Set();
    T.seen = ids;
    T.data = d;
    T.receivedAt = Date.now();
    // only redraw when a result or the game in a room changed, so the screen never flickers
    const sig = JSON.stringify(d.rooms.map((r) => [r.name, r.top, r.live && [r.live.label, r.live.paused]]));
    if (sig !== T.sig || fresh.size) {
      T.sig = sig;
      render(fresh);
    }
    tickLive();
  } catch {
    if (++T.failures >= 2) $('#status').hidden = false; // one missed refresh is normal on Wi-Fi
  }
}

function mmss(totalSec) {
  const s = Math.max(0, totalSec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function render(fresh) {
  const d = T.data;
  $('#rooms').replaceChildren(...d.rooms.map((r, i) => roomColumn(r, i, fresh, d)));
}

function roomColumn(r, i, fresh, d) {
  const tone = roomStory(r, i).tone;
  const rows = Array.from({ length: d.tvTop }, (_, k) => (r.top[k] ? entryRow(r.top[k], fresh.has(r.top[k].id), d.maxClues) : emptyRow(k + 1)));
  return h('section', { class: `tv-room tone-${tone}`, 'aria-label': `${r.name} top ${d.tvTop}` },
    h('header', { class: 'tv-room-head' },
      h('h2', { class: 'tv-room-name', text: r.name }),
      h('span', { class: 'tv-level', text: levelName(r.difficulty) })),
    h('div', { class: 'tv-cols', 'aria-hidden': 'true' }, h('span'), h('span', { text: 'Team' }), h('span', { text: 'Time · clues' })),
    h('ol', { class: 'tv-list', style: `--rows: ${d.tvTop}` }, rows),
    liveStrip(r));
}

/** 1st to 3rd get a medal on a ribbon in the room's colour; 4th and below a plain number. */
function badge(rank) {
  if (rank > 3) return h('span', { class: 'tv-badge' }, h('span', { class: 'tv-rank', text: rank }));
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text != null) n.textContent = text;
    return n;
  };
  const svg = el('svg', { class: `tv-medal medal-${rank}`, viewBox: '0 0 40 50', 'aria-hidden': 'true' });
  svg.append(
    el('path', { class: 'strap-a', d: 'M7 0h10l8 23H15z' }),
    el('path', { class: 'strap-b', d: 'M33 0H23l-8 23h10z' }),
    el('circle', { class: 'disc', cx: 20, cy: 33.5, r: 14.5 }),
    el('circle', { class: 'disc-ring', cx: 20, cy: 33.5, r: 10.5 }),
    el('text', { class: 'disc-num', x: 20, y: 39.5, 'text-anchor': 'middle' }, String(rank)));
  return h('span', { class: 'tv-badge', role: 'img', 'aria-label': `${PLACES[rank - 1]} place` }, svg);
}

function entryRow(e, isNew, maxClues) {
  return h('li', { class: `tv-row rank-${e.rank}${isNew ? ' is-new' : ''}` },
    badge(e.rank),
    h('span', { class: 'tv-team', text: e.label }), // shared rooms: every team name, joined with &
    h('div', { class: 'tv-result' },
      h('span', { class: 'tv-time', text: mmss(e.escapeSec) }),
      h('span', { class: 'tv-clues', role: 'img', 'aria-label': `${e.clues} of ${maxClues} clues used` },
        Array.from({ length: maxClues }, (_, k) => h('span', { class: `tv-dot${k < e.clues ? ' is-used' : ''}` })))));
}

function emptyRow(rank) {
  return h('li', { class: `tv-row is-empty rank-${rank}` },
    badge(rank),
    h('span', { class: 'tv-team', text: rank === 1 ? 'Be the first to escape' : 'Open spot' }),
    h('div', { class: 'tv-result' }));
}

function liveStrip(r) {
  if (!r.live) return h('footer', { class: 'tv-live is-idle' }, h('span', { class: 'kicker', text: 'No game running right now' }));
  return h('footer', { class: `tv-live${r.live.paused ? ' is-paused' : ''}` },
    h('div', { class: 'tv-live-who' },
      h('span', { class: 'kicker', text: r.live.paused ? 'In the room now · paused' : 'In the room now' }),
      h('span', { class: 'tv-live-team', text: r.live.label })),
    h('span', { class: 'tv-live-left', dataset: { room: r.id } }));
}

/** The countdown of each running game, ticking between refreshes. */
function tickLive() {
  if (!T.data) return;
  for (const r of T.data.rooms) {
    const el = r.live && document.querySelector(`.tv-live-left[data-room="${r.id}"]`);
    if (!el) continue;
    const left = r.live.paused ? r.live.leftMs : r.live.leftMs - (Date.now() - T.receivedAt);
    el.textContent = `${mmss(Math.ceil(Math.max(0, left) / 1000))} left`;
  }
}

/** Full screen on request, and the mouse pointer and button hide after a few still seconds. */
function bindScreen() {
  const btn = $('#fullBtn');
  if (!document.documentElement.requestFullscreen) btn.hidden = true;
  btn.addEventListener('click', () => { document.documentElement.requestFullscreen().catch(() => {}); });
  document.addEventListener('fullscreenchange', () => { btn.hidden = !!document.fullscreenElement; });
  const wake = () => {
    document.body.classList.remove('is-idle');
    clearTimeout(T.idleTimer);
    T.idleTimer = setTimeout(() => document.body.classList.add('is-idle'), 3000);
  };
  document.addEventListener('mousemove', wake);
  document.addEventListener('keydown', wake);
  wake();
}
