'use strict';
/* Organizer dashboard. */

const A = { data: null, tab: 'registrations', filter: { q: '', status: 'all', slot: 'all' }, openId: null, knownIds: new Set() };
const detail = $('#detail');
const TABS = ['registrations', 'slots', 'settings'];

bind();
boot();
setInterval(poll, 15000);

async function boot() {
  try {
    await load();
    showApp();
  } catch (err) {
    showLogin(err.status === 401 ? '' : err.message);
  }
}

async function load() {
  setData(await api('/api/admin/data'));
  fillSettings();
}

function setData(data) {
  A.data = data;
  A.knownIds = new Set(data.registrations.map((r) => r.id));
  renderAll();
}

async function poll() {
  if (!A.data || $('#appView').hidden || document.visibilityState !== 'visible') return;
  if (A.tab !== 'registrations' || detail.open) return;
  try {
    const data = await api('/api/admin/data');
    const fresh = data.registrations.filter((r) => !A.knownIds.has(r.id));
    setData(data);
    if (fresh.length) toast(fresh.length === 1 ? `New registration: ${fresh[0].groupName}` : `${fresh.length} new registrations`);
  } catch (err) {
    if (err.status === 401) showLogin('Your session ended. Sign in again.');
  }
}

function showLogin(message) {
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  const e = $('#loginError');
  e.textContent = message || '';
  e.hidden = !message;
  $('#password').focus();
}

function showApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  const fromHash = location.hash.slice(1);
  setTab(TABS.includes(fromHash) ? fromHash : 'registrations');
}

/* ------------------------------------------------------------------ bind */

function bind() {
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#password');
    if (!pw.value) { pw.reportValidity(); return; }
    const btn = $('#loginBtn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: pw.value } });
      pw.value = '';
      await load();
      showApp();
    } catch (err) {
      showLogin(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch { /* signed out anyway */ }
    A.data = null;
    showLogin('');
  });

  for (const t of $$('.tab')) t.addEventListener('click', () => setTab(t.dataset.tab));
  $('#setupGo').addEventListener('click', () => setTab('settings'));

  $('#search').addEventListener('input', (e) => { A.filter.q = e.target.value; renderTable(); });
  $('#statusFilter').addEventListener('change', (e) => { A.filter.status = e.target.value; renderTable(); });
  $('#slotFilter').addEventListener('change', (e) => { A.filter.slot = e.target.value; renderBoard(); renderTable(); });

  $('#genForm').addEventListener('submit', onGenerate);
  $('#settingsForm').addEventListener('submit', onSaveSettings);
  $('#passwordForm').addEventListener('submit', onChangePassword);

  detail.addEventListener('click', (e) => { if (e.target === detail) detail.close(); });
  detail.addEventListener('close', () => { A.openId = null; });
}

function setTab(name) {
  A.tab = name;
  for (const t of $$('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const n of TABS) $(`#tab-${n}`).hidden = n !== name;
  if (name === 'settings') fillSettings();
  history.replaceState(null, '', name === 'registrations' ? location.pathname : `#${name}`);
  window.scrollTo({ top: 0 });
}

/* ---------------------------------------------------------------- render */

const slotById = (id) => A.data.slots.find((s) => s.id === id);
const sum = (list, f) => list.reduce((n, x) => n + (Number(f(x)) || 0), 0);
const cur = () => A.data.settings.currency;

function renderAll() {
  const s = A.data.settings;
  $('#adminEventName').textContent = s.eventName;
  document.title = `${s.eventName} · Organizer`;
  $('#setupBanner').hidden = !!s.configured;
  $('#passwordBanner').hidden = !A.data.passwordFileExists;
  const pending = A.data.registrations.filter((r) => r.status === 'pending').length;
  $('#pendingBadge').hidden = !pending;
  $('#pendingBadge').textContent = String(pending);
  renderShare();
  renderStats();
  renderBoard();
  renderSlotFilter();
  renderTable();
  renderSlotList();
  if (!$('#genDate').value) $('#genDate').value = defaultGenDate();
}

function renderShare() {
  const isLocal = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  const rows = [[isLocal ? 'This computer' : 'Registration link', location.origin]];
  for (const u of A.data.networkUrls) if (u !== location.origin) rows.push(['Same Wi-Fi', u]);
  const hint = isLocal && rows.length === 1
    ? 'Only this computer can open the page right now. See the README to put it online.'
    : isLocal
      ? 'Phones and laptops on the same Wi-Fi can register with the Same Wi-Fi link. To take registrations from anywhere, put the app online (see the README).'
      : 'Anyone with this link can register.';
  $('#shareRows').replaceChildren(
    ...rows.map(([label, url]) => h('div', { class: 'share-row' },
      h('span', { class: 'share-label', text: label }),
      h('code', { text: url }),
      h('button', {
        type: 'button', class: 'btn btn-small', text: 'Copy',
        onclick: async (e) => { const ok = await copyText(url); e.target.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(() => { e.target.textContent = 'Copy'; }, 1800); },
      }))),
    h('p', { class: 'hint', text: hint }),
  );
}

function renderStats() {
  const regs = A.data.registrations;
  const pending = regs.filter((r) => r.status === 'pending');
  const approved = regs.filter((r) => r.status === 'approved');
  const rejected = regs.filter((r) => r.status === 'rejected');
  const slots = A.data.slots;
  const tiles = [
    { label: 'Waiting for review', value: pending.length, sub: pending.length ? `${money(cur(), sum(pending, (r) => r.amount))} to check` : 'All caught up', alert: pending.length > 0 },
    { label: 'Approved groups', value: approved.length, sub: plural(sum(approved, (r) => r.players), 'player') },
    { label: 'Payments confirmed', value: money(cur(), sum(approved, (r) => r.amount)), sub: `from ${plural(approved.length, 'group')}` },
    { label: 'Spots left', value: sum(slots, (s) => s.left), sub: `of ${sum(slots, (s) => s.capacity)} across ${plural(slots.length, 'slot')}` },
    { label: 'Not approved', value: rejected.length, sub: rejected.length ? 'Their spots were released' : 'None' },
  ];
  $('#stats').replaceChildren(...tiles.map((t) => h('div', { class: `stat${t.alert ? ' is-alert' : ''}` },
    h('p', { class: 'stat-label', text: t.label }),
    h('p', { class: 'stat-value', text: String(t.value) }),
    h('p', { class: 'stat-sub', text: t.sub }))));
}

function groupByDate(slots) {
  const map = new Map();
  for (const s of slots) {
    if (!map.has(s.date)) map.set(s.date, []);
    map.get(s.date).push(s);
  }
  return map;
}

function renderBoard() {
  const box = $('#slotBoard');
  if (!A.data.slots.length) {
    box.replaceChildren(h('p', { class: 'muted', text: 'No time slots yet. Add them under Time slots.' }));
    return;
  }
  const regs = A.data.registrations;
  const days = [];
  for (const [date, slots] of groupByDate(A.data.slots)) {
    days.push(h('div', { class: 'board-day' },
      h('h3', { text: dateLong(date) }),
      h('div', { class: 'slot-board' }, slots.map((s) => {
        const ap = regs.filter((r) => r.slotId === s.id && r.status === 'approved').length;
        const pe = regs.filter((r) => r.slotId === s.id && r.status === 'pending').length;
        const a = h('span', { class: 'a' });
        const p = h('span', { class: 'p' });
        a.style.width = `${Math.min(100, (ap / s.capacity) * 100)}%`;
        p.style.width = `${Math.min(100, (pe / s.capacity) * 100)}%`;
        const active = A.filter.slot === s.id;
        return h('button', {
          type: 'button', class: `board-cell${active ? ' is-active' : ''}`, 'aria-pressed': String(active),
          onclick: () => { A.filter.slot = active ? 'all' : s.id; $('#slotFilter').value = A.filter.slot; renderBoard(); renderTable(); },
        },
        h('span', { class: 't', text: slotRange(s.start, s.end) }),
        h('span', { class: 'n', text: s.left ? `${s.taken}/${s.capacity} · ${s.left} open` : `${s.taken}/${s.capacity} · full` }),
        h('span', { class: 'bar' }, a, p));
      }))));
  }
  box.replaceChildren(...days);
}

function renderSlotFilter() {
  const sel = $('#slotFilter');
  if (A.filter.slot !== 'all' && !slotById(A.filter.slot)) A.filter.slot = 'all';
  sel.replaceChildren(h('option', { value: 'all', text: 'All time slots' }),
    ...A.data.slots.map((s) => h('option', { value: s.id, text: `${dateShort(s.date)}, ${slotRange(s.start, s.end)}` })));
  sel.value = A.filter.slot;
}

function filtered() {
  const q = A.filter.q.trim().toLowerCase();
  const order = { pending: 0, approved: 1, rejected: 2 };
  return A.data.registrations
    .filter((r) => A.filter.status === 'all' || r.status === A.filter.status)
    .filter((r) => A.filter.slot === 'all' || r.slotId === A.filter.slot)
    .filter((r) => !q || [r.groupName, r.leaderName, r.code, r.referenceNo, r.email, r.phone, r.school, ...r.members].join(' ').toLowerCase().includes(q))
    .sort((a, b) => order[a.status] - order[b.status] || b.createdAt.localeCompare(a.createdAt));
}

function renderTable() {
  const rows = filtered();
  $('#regRows').replaceChildren(...rows.map(rowEl));
  const total = A.data.registrations.length;
  const empty = $('#regEmpty');
  empty.hidden = rows.length > 0;
  empty.textContent = total ? 'No registrations match these filters.' : 'No registrations yet. Share the registration link to get your first group.';
  $('#resultCount').textContent = total ? `${rows.length} of ${total}` : '';
}

function rowEl(r) {
  const slot = slotById(r.slotId);
  const tr = h('tr', {
    tabindex: '0',
    onclick: (e) => { if (!e.target.closest('button, a')) openDetail(r.id); },
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === tr) openDetail(r.id); },
  },
  h('td', null, h('div', { class: 'cell-main', text: r.groupName }), h('div', { class: 'cell-sub mono', text: r.code })),
  h('td', null,
    h('div', { class: 'cell-main', text: slot ? slotRange(slot.start, slot.end) : 'Slot removed' }),
    h('div', { class: 'cell-sub', text: slot ? dateShort(slot.date) : 'Pick a new slot' })),
  h('td', null, h('div', { class: 'cell-main', text: r.leaderName }), h('div', { class: 'cell-sub', text: r.phone })),
  h('td', { class: 'num', text: String(r.players) }),
  h('td', null, h('div', { class: 'cell-main mono', text: money(cur(), r.amount) }), h('div', { class: 'cell-sub mono', text: `Ref ${r.referenceNo}` })),
  h('td', null, receiptThumb(r)),
  h('td', null, statusPill(r.status)),
  h('td', null, rowActions(r)));
  return tr;
}

function receiptThumb(r) {
  const url = `/api/admin/receipt/${r.id}`;
  if (r.receiptType === 'application/pdf') return h('a', { class: 'thumb is-pdf', href: url, target: '_blank', rel: 'noopener', title: 'Open receipt PDF', text: 'PDF' });
  return h('a', { class: 'thumb', href: url, target: '_blank', rel: 'noopener', title: 'Open receipt' }, h('img', { src: url, alt: `Receipt from ${r.groupName}`, loading: 'lazy' }));
}

function rowActions(r) {
  const b = (label, cls, status) => h('button', { type: 'button', class: `btn btn-small ${cls}`, text: label, onclick: () => setStatus(r.id, status) });
  if (r.status === 'pending') return h('div', { class: 'row-actions' }, b('Approve', 'btn-ok', 'approved'), b('Reject', 'btn-danger', 'rejected'));
  if (r.status === 'approved') return h('div', { class: 'row-actions' }, b('Undo', 'btn-ghost', 'pending'));
  return h('div', { class: 'row-actions' }, b('Restore', 'btn-ghost', 'pending'));
}

const STATUS_DONE = { approved: 'Approved', rejected: 'Marked as not approved', pending: 'Moved back to pending' };

async function setStatus(id, status, extra = {}) {
  const r = A.data.registrations.find((x) => x.id === id);
  return patchRegistration(id, { status, ...extra }, `${STATUS_DONE[status]}: ${r ? r.groupName : 'group'}`);
}

async function patchRegistration(id, body, okMessage) {
  try {
    const res = await api(`/api/admin/registrations/${id}`, { method: 'PATCH', body });
    const i = A.data.registrations.findIndex((x) => x.id === id);
    if (i >= 0) A.data.registrations[i] = res.registration;
    A.data.slots = res.slots;
    renderAll();
    if (detail.open && A.openId === id) renderDetail();
    toast(okMessage);
    return true;
  } catch (err) {
    toast(err.message, 'bad');
    if (err.status === 401) showLogin('Your session ended. Sign in again.');
    return false;
  }
}

/* ---------------------------------------------------------------- detail */

function openDetail(id) {
  A.openId = id;
  renderDetail();
  if (!detail.open) detail.showModal();
}

function renderDetail() {
  const r = A.data.registrations.find((x) => x.id === A.openId);
  if (!r) { detail.close(); return; }
  const s = A.data.settings;
  const slot = slotById(r.slotId);
  const url = `/api/admin/receipt/${r.id}`;

  const receipt = r.receiptType === 'application/pdf'
    ? h('a', { class: 'receipt-pdf', href: url, target: '_blank', rel: 'noopener' },
      h('span', { class: 'pdf-badge', text: 'PDF' }),
      h('span', null, h('strong', { text: 'Open receipt PDF' }), h('br'), h('span', { class: 'small muted', text: r.receiptName || 'receipt.pdf' })))
    : h('a', { class: 'receipt-big', href: url, target: '_blank', rel: 'noopener', title: 'Open full size' },
      h('img', { src: url, alt: `Payment receipt from ${r.groupName}` }));

  const slotSelect = h('select', { id: 'moveSlot' }, A.data.slots.map((x) => h('option', {
    value: x.id,
    text: `${dateShort(x.date)}, ${slotRange(x.start, x.end)}${x.id === r.slotId ? ' (current)' : x.left ? ` · ${x.left} open` : ' · full'}`,
  })));
  if (!slot) slotSelect.prepend(h('option', { value: '', text: 'Slot was removed. Pick a new one.' }));
  slotSelect.value = slot ? r.slotId : '';

  const note = h('textarea', { id: 'adminNote', rows: '3', maxlength: '500', placeholder: 'e.g. Payment confirmed, see you at 9:45 for the briefing.' });
  note.value = r.adminNote || '';

  const edits = () => {
    const body = { adminNote: note.value };
    if (slotSelect.value && slotSelect.value !== r.slotId) body.slotId = slotSelect.value;
    return body;
  };

  const pairs = [
    ['Reference no.', r.referenceNo, 'mono'],
    ['Amount', money(s.currency, r.amount), 'mono'],
    ['Time slot', slot ? `${dateLong(slot.date)}, ${slotRange(slot.start, slot.end)}` : 'Slot removed'],
    ['Leader', r.leaderName],
    ['Email', r.email],
    ['Mobile', r.phone],
    ['School / org', r.school || '—'],
    ['Registered', new Date(r.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })],
  ];
  if (r.notes) pairs.push(['Their notes', r.notes]);

  const del = h('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Delete' });
  let armed = null;
  del.addEventListener('click', async () => {
    if (!armed) {
      del.textContent = 'Click again to delete for good';
      del.classList.add('is-armed');
      armed = setTimeout(() => { armed = null; del.textContent = 'Delete'; del.classList.remove('is-armed'); }, 4000);
      return;
    }
    clearTimeout(armed);
    try {
      await api(`/api/admin/registrations/${r.id}`, { method: 'DELETE' });
      detail.close();
      await load();
      toast(`Deleted ${r.groupName}`);
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  const statusButtons = [];
  if (r.status !== 'approved') statusButtons.push(h('button', { type: 'button', class: 'btn btn-small btn-primary', text: 'Approve', onclick: () => setStatus(r.id, 'approved', edits()) }));
  if (r.status !== 'rejected') statusButtons.push(h('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Reject', onclick: () => setStatus(r.id, 'rejected', edits()) }));
  if (r.status !== 'pending') statusButtons.push(h('button', { type: 'button', class: 'btn btn-small', text: 'Mark pending', onclick: () => setStatus(r.id, 'pending', edits()) }));

  $('#detailInner').replaceChildren(
    h('header', { class: 'drawer-head' },
      h('div', null,
        h('p', { class: 'eyebrow mono', text: r.code }),
        h('h2', { id: 'detailTitle', text: r.groupName }),
        h('p', { class: 'small' }, statusPill(r.status))),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', text: '×', onclick: () => detail.close() })),
    h('div', { class: 'drawer-body' },
      receipt,
      h('dl', { class: 'summary' }, pairs.flatMap(([k, v, cls]) => [h('dt', { text: k }), h('dd', { class: cls || null, text: v })])),
      h('div', null,
        h('p', { class: 'eyebrow', text: `${plural(r.players, 'player')}` }),
        h('ol', { class: 'members-list' }, [`${r.leaderName} (leader)`, ...r.members].map((n) => h('li', { text: n })))),
      h('div', { class: 'field' }, h('label', { for: 'moveSlot', text: 'Time slot' }), slotSelect),
      h('div', { class: 'field' },
        h('label', { for: 'adminNote', text: 'Note to the group' }),
        note,
        h('p', { class: 'hint', text: 'They see this when they check their status with their code.' })),
      h('div', { class: 'row-actions' },
        h('button', { type: 'button', class: 'btn btn-small', text: 'Save slot and note', onclick: () => patchRegistration(r.id, edits(), 'Saved') }),
        h('button', {
          type: 'button', class: 'btn btn-small btn-ghost', text: 'Copy message for the group',
          onclick: async (e) => { const ok = await copyText(groupMessage(r)); e.target.textContent = ok ? 'Copied' : 'Copy failed'; },
        }))),
    h('footer', { class: 'drawer-foot' }, ...statusButtons, h('span', { class: 'spacer' }), del),
  );
}

function groupMessage(r) {
  const s = A.data.settings;
  const slot = slotById(r.slotId);
  const when = slot ? `${dateLong(slot.date)}, ${slotRange(slot.start, slot.end)}` : 'a time slot we will confirm with you';
  if (r.status === 'approved') {
    return `Hi ${r.leaderName}! Your group "${r.groupName}" is confirmed for ${s.eventName} on ${when} at ${s.venue}. Please arrive 15 minutes early for the briefing. Registration code: ${r.code}.`;
  }
  if (r.status === 'rejected') {
    return `Hi ${r.leaderName}, we couldn't confirm the payment for "${r.groupName}" (${r.code}) for ${s.eventName}.${r.adminNote ? ` ${r.adminNote}` : ''} Reply to this message so we can sort it out.`;
  }
  return `Hi ${r.leaderName}! We received the registration for "${r.groupName}" (${r.code}) for ${s.eventName} on ${when}. We're checking your payment and will confirm soon.`;
}

/* ------------------------------------------------------------ time slots */

function defaultGenDate() {
  const dates = A.data.slots.map((s) => s.date).sort();
  const d = dates.length ? parseDate(dates[dates.length - 1]) : new Date();
  d.setDate(d.getDate() + (dates.length ? 1 : 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function onGenerate(e) {
  e.preventDefault();
  for (const el of $$('input', e.target)) if (!el.checkValidity()) { el.reportValidity(); return; }
  try {
    const res = await api('/api/admin/slots', {
      method: 'POST',
      body: { date: $('#genDate').value, from: $('#genFrom').value, to: $('#genTo').value, minutes: Number($('#genLen').value), capacity: Number($('#genCap').value) },
    });
    setData(res);
    $('#genDate').value = defaultGenDate();
    toast(res.added ? `Added ${plural(res.added, 'slot')}${res.skipped ? ` (${res.skipped} already existed)` : ''}` : 'Those slots already exist');
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function renderSlotList() {
  const box = $('#slotList');
  if (!A.data.slots.length) {
    box.replaceChildren(h('div', { class: 'panel' }, h('p', { class: 'muted', text: 'No time slots yet. Add your first day above.' })));
    return;
  }
  const days = [];
  for (const [date, slots] of groupByDate(A.data.slots)) {
    const booked = sum(slots, (s) => s.taken);
    days.push(h('section', { class: 'slot-day' },
      h('div', { class: 'slot-day-head' },
        h('strong', { text: dateLong(date) }),
        h('span', { class: 'small muted', text: `${plural(slots.length, 'slot')} · ${booked} booked` })),
      slots.map(slotLine)));
  }
  box.replaceChildren(...days);
}

function slotLine(s) {
  const cap = h('input', { type: 'number', min: '1', max: '100', 'aria-label': `Groups allowed at ${slotRange(s.start, s.end)}`, title: 'Groups per slot' });
  cap.value = String(s.capacity);
  cap.addEventListener('change', async () => {
    try {
      setData(await api(`/api/admin/slots/${s.id}`, { method: 'PATCH', body: { capacity: Number(cap.value) } }));
      toast(`${slotRange(s.start, s.end)} now takes ${plural(Number(cap.value), 'group')}`);
    } catch (err) {
      cap.value = String(s.capacity);
      toast(err.message, 'bad');
    }
  });

  const del = h('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Remove' });
  let armed = null;
  del.addEventListener('click', async () => {
    if (!armed) {
      del.textContent = 'Confirm';
      del.classList.add('is-armed');
      armed = setTimeout(() => { armed = null; del.textContent = 'Remove'; del.classList.remove('is-armed'); }, 3500);
      return;
    }
    clearTimeout(armed);
    try {
      setData(await api(`/api/admin/slots/${s.id}`, { method: 'DELETE' }));
      toast(`Removed ${slotRange(s.start, s.end)}`);
    } catch (err) {
      del.textContent = 'Remove';
      del.classList.remove('is-armed');
      armed = null;
      toast(err.message, 'bad');
    }
  });

  return h('div', { class: 'slot-line' },
    h('span', { class: 'strong', text: slotRange(s.start, s.end) }),
    h('span', { class: 'booked', text: `${s.taken}/${s.capacity} booked` }),
    h('label', { class: 'small muted' }, 'Groups ', cap),
    del);
}

/* -------------------------------------------------------------- settings */

const SETTING_FIELDS = {
  sEventName: 'eventName', sHostName: 'hostName', sTagline: 'tagline', sDescription: 'description', sContact: 'contactInfo',
  sVenue: 'venue', sVenueAddress: 'venueAddress', sMapUrl: 'mapUrl', sMin: 'minPlayers', sMax: 'maxPlayers',
  sCurrency: 'currency', sPrice: 'price', sPriceMode: 'priceMode', sPayment: 'paymentInstructions',
};

function fillSettings() {
  if (!A.data) return;
  const s = A.data.settings;
  for (const [id, key] of Object.entries(SETTING_FIELDS)) $(`#${id}`).value = s[key] == null ? '' : String(s[key]);
  $('#sOpen').checked = !!s.registrationOpen;
  $('#settingsError').hidden = true;
}

async function onSaveSettings(e) {
  e.preventDefault();
  const err = $('#settingsError');
  err.hidden = true;
  for (const el of $$('input, select, textarea', e.target)) {
    if (!el.checkValidity()) { el.reportValidity(); return; }
  }
  const body = {};
  for (const [id, key] of Object.entries(SETTING_FIELDS)) body[key] = $(`#${id}`).value;
  body.registrationOpen = $('#sOpen').checked;
  const btn = $('#saveSettings');
  btn.disabled = true;
  try {
    setData(await api('/api/admin/settings', { method: 'PUT', body }));
    fillSettings();
    toast('Settings saved. The registration page is updated.');
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

async function onChangePassword(e) {
  e.preventDefault();
  const err = $('#passwordError');
  err.hidden = true;
  for (const el of $$('input', e.target)) if (!el.checkValidity()) { el.reportValidity(); return; }
  try {
    await api('/api/admin/password', { method: 'POST', body: { current: $('#pCurrent').value, next: $('#pNext').value } });
    $('#pCurrent').value = '';
    $('#pNext').value = '';
    A.data.passwordFileExists = false;
    renderAll();
    toast('Password changed');
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  }
}
