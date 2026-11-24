'use strict';
/* Helpers shared by the registration page and the organizer dashboard. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Build an element. Strings become text nodes, so user data is never parsed as HTML. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    const err = new Error("Can't reach the server. Check your connection and that the app is still running.");
    err.status = 0;
    throw err;
  }
  let data = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status}).`);
    err.status = res.status;
    err.code = data && data.code;
    throw err;
  }
  return data;
}

/* ------------------------------------------------------------ formatting */

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function dateLong(iso) {
  return parseDate(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
function dateShort(iso) {
  return parseDate(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function monthShort(iso) {
  return parseDate(iso).toLocaleDateString('en-US', { month: 'short' });
}
function time12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return { t: `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`, ap: h < 12 ? 'AM' : 'PM' };
}
function timeLabel(hhmm) {
  const x = time12(hhmm);
  return `${x.t} ${x.ap}`;
}
function slotRange(start, end) {
  const a = time12(start);
  const b = time12(end);
  return a.ap === b.ap ? `${a.t} – ${b.t} ${b.ap}` : `${a.t} ${a.ap} – ${b.t} ${b.ap}`;
}
function money(currency, n) {
  return `${currency}${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + 's'}`;
}
function fileSize(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const STATUS_LABEL = { pending: 'Pending approval', approved: 'Approved', rejected: 'Not approved' };
function statusPill(status) {
  return h('span', { class: `pill pill-${status}`, text: STATUS_LABEL[status] || status });
}

/** Render organizer-written text: blank lines split blocks, "- " lines become a list,
 *  and a short line right before a list becomes a heading. Text only, never HTML. */
function renderRichText(container, text) {
  container.replaceChildren();
  const blocks = String(text || '').split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
  for (const lines of blocks) {
    const isItem = (l) => /^[-•*]\s+/.test(l);
    let rest = lines;
    if (!isItem(lines[0]) && lines.length > 1 && lines.slice(1).every(isItem)) {
      container.append(h('h3', { text: lines[0] }));
      rest = lines.slice(1);
    }
    if (rest.every(isItem)) {
      container.append(h('ul', null, rest.map((l) => h('li', { text: l.replace(/^[-•*]\s+/, '') }))));
    } else {
      const p = h('p');
      rest.forEach((l, i) => { if (i) p.append(h('br')); p.append(l); });
      container.append(p);
    }
  }
}

/* ---------------------------------------------------------------- misc */

let toastTimer;
function toast(message, kind) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('is-bad', kind === 'bad');
  // As a popover the toast joins the top layer, so it shows above an open dialog.
  if (typeof el.showPopover === 'function') {
    try {
      if (el.matches(':popover-open')) el.hidePopover();
      el.showPopover();
    } catch { /* not a popover in this browser */ }
  }
  requestAnimationFrame(() => el.classList.add('is-on'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-on');
    setTimeout(() => {
      if (!el.classList.contains('is-on') && typeof el.hidePopover === 'function') {
        try { el.hidePopover(); } catch { /* already hidden */ }
      }
    }, 250);
  }, 3400);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { class: 'sr-only', readonly: true });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
