'use strict';
/* Staff dashboard: day board, payment review, bookings, standby, emails, settings. */

const TABS = ['board', 'payments', 'bookings', 'standby', 'emails', 'settings'];
const A = { tab: 'board', reviewIdx: 0, filter: { q: '', pay: 'all', slot: 'all' }, drawer: null, mailId: null, settingsDirty: false };
const drawer = $('#drawer');

STAFF.onData = renderAll;
STAFF.onSignedOut = showLogin;
bind();
boot();
setInterval(poll, 15000);

async function boot() {
  try {
    setStaffData(await api('/api/staff/data'));
    fillSettings();
    showApp();
  } catch (err) {
    showLogin(err.status === 401 ? '' : err.message);
  }
}

async function poll() {
  if (!STAFF.data || $('#appView').hidden || document.visibilityState !== 'visible') return;
  if (A.tab === 'settings' || A.tab === 'emails') return;
  // don't redraw under someone mid-task: an open panel, or a field being typed in
  if (drawer.open || isEditing()) return;
  const before = new Set(STAFF.data.bookings.map((b) => b.id));
  try {
    const d = await staffCall('/api/staff/data');
    const fresh = d.bookings.filter((b) => !before.has(b.id));
    setStaffData(d);
    if (fresh.length) toast(fresh.length === 1 ? `New booking: ${fresh[0].label}` : `${fresh.length} new bookings`);
  } catch { /* offline for a moment */ }
}

function isEditing() {
  const el = document.activeElement;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'search') return true;
  const reject = $('#reviewPanel input');
  return !!(reject && reject.value);
}

function showLogin(message) {
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  $('#loginError').textContent = message || '';
  $('#loginError').hidden = !message;
  if (drawer.open) drawer.close();
  $('#password').focus();
}

function showApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  const h0 = location.hash.slice(1);
  setTab(TABS.includes(h0) ? h0 : 'board');
}

function setTab(name) {
  A.tab = name;
  for (const t of $$('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const n of TABS) $(`#tab-${n}`).hidden = n !== name;
  if (name === 'settings') fillSettings();
  history.replaceState(null, '', name === 'board' ? location.pathname : `#${name}`);
}

/* ------------------------------------------------------------------ bind */

function bind() {
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#password');
    if (!pw.value) { pw.reportValidity(); return; }
    $('#loginBtn').disabled = true;
    try {
      await api('/api/staff/login', { method: 'POST', body: { password: pw.value } });
      pw.value = '';
      setStaffData(await api('/api/staff/data'));
      fillSettings();
      showApp();
    } catch (err) {
      showLogin(err.message);
    } finally {
      $('#loginBtn').disabled = false;
    }
  });
  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('/api/staff/logout', { method: 'POST', body: {} }); } catch { /* signed out anyway */ }
    showLogin('');
  });
  for (const t of $$('.tab')) t.addEventListener('click', () => setTab(t.dataset.tab));
  $('#search').addEventListener('input', (e) => { A.filter.q = e.target.value; renderBookings(); });
  $('#payFilter').addEventListener('change', (e) => { A.filter.pay = e.target.value; renderBookings(); });
  $('#slotFilter').addEventListener('change', (e) => { A.filter.slot = e.target.value; renderBookings(); });
  $('#syncBtn').addEventListener('click', syncNow);
  $('#syncNow').addEventListener('click', syncNow);
  $('#testGoogle').addEventListener('click', testGoogle);
  $('#walkinForm').addEventListener('submit', addWalkin);
  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#settingsForm').addEventListener('input', () => { A.settingsDirty = true; });
  $('#passwordForm').addEventListener('submit', changePassword);
  $('#testMailForm').addEventListener('submit', sendTest);
  $('#copyScript').addEventListener('click', async () => toast((await copyText($('#scriptBox').textContent)) ? 'Script copied. Paste it into Apps Script.' : 'Select the script and copy it.'));
  drawer.addEventListener('click', (e) => { if (e.target === drawer) drawer.close(); });
  drawer.addEventListener('close', () => { A.drawer = null; });
}

/* ---------------------------------------------------------------- render */

function renderAll() {
  const d = STAFF.data;
  $('#eventTitle').textContent = d.settings.eventName;
  document.title = `${d.settings.eventName} · Staff`;
  const pending = d.bookings.filter((b) => b.payment === 'pending').length;
  $('#payBadge').hidden = !pending;
  $('#payBadge').textContent = String(pending);
  const waiting = d.walkins.filter((w) => w.status === 'waiting' || w.status === 'alerted').length;
  $('#standbyBadge').hidden = !waiting;
  $('#standbyBadge').textContent = String(waiting);
  renderBanners();
  renderLinks();
  renderBoard();
  renderReview();
  renderSlotFilter();
  renderBookings();
  renderStandby();
  renderEmails();
  renderSheetStatus();
  renderStorage();
  if (A.drawer) renderDrawer();
}

function renderBanners() {
  const d = STAFF.data;
  const out = [];
  if (!d.settings.configured) {
    out.push(h('div', { class: 'setup-banner' },
      h('p', null, h('strong', { text: 'Finish setup before sharing the booking link. ' }), 'The date, price, venue and payment details are still examples.'),
      h('button', { class: 'btn btn-primary btn-small', type: 'button', text: 'Open settings', onclick: () => setTab('settings') })));
  }
  if (d.passwordFileExists) out.push(h('div', { class: 'setup-banner' }, h('p', null, h('strong', { text: 'Change the starting staff password. ' }), "It's saved in a plain text file in the app folder. Set your own in Settings and the file is deleted.")));
  if (!d.mailReady) {
    out.push(h('div', { class: 'setup-banner banner-info' },
      h('p', null, h('strong', { text: 'Emails are not being sent yet. ' }), 'They are saved in the Emails tab so you can preview them. Connect Google (Sheet + Gmail) in Settings to send them.'),
      h('button', { class: 'btn btn-small', type: 'button', text: 'Connect Google', onclick: () => { setTab('settings'); $('#googlePanel').scrollIntoView({ behavior: 'smooth' }); } })));
  }
  const st = d.storage;
  if (st.mode !== 'google' && st.onCloudHost) {
    out.push(h('div', { class: 'setup-banner' },
      h('p', null, h('strong', { text: 'Bookings on this host are temporary. ' }), 'Its disk is wiped on every restart. Connect Google and move the data to Google Drive before sharing the link.'),
      h('button', { class: 'btn btn-primary btn-small', type: 'button', text: 'Fix it', onclick: () => { setTab('settings'); $('#googlePanel').scrollIntoView({ behavior: 'smooth' }); } })));
  }
  if (st.mode === 'google' && st.lastError) out.push(h('div', { class: 'setup-banner' }, h('p', null, h('strong', { text: 'Not saved to Google Drive yet. ' }), `${st.lastError} The app keeps retrying; don't close it until this clears.`)));
  if (st.warning) out.push(h('div', { class: 'setup-banner' }, h('p', null, h('strong', { text: 'Two copies running? ' }), st.warning)));
  const queued = d.emails.filter((e) => e.status === 'queued').length;
  if (queued) out.push(h('div', { class: 'setup-banner banner-info' }, h('p', null, h('strong', { text: `${plural(queued, 'email')} waiting to send. ` }), 'They are retried automatically every few minutes (after an hour if the daily Gmail limit was reached).')));
  if (d.sheetStatus && !d.sheetStatus.ok) out.push(h('div', { class: 'setup-banner banner-info' }, h('p', null, h('strong', { text: 'Google Sheet sync failed. ' }), d.sheetStatus.error)));
  $('#banners').replaceChildren(...out);
}

/** The links staff share: the booking page for players, the scanner for the door. */
function renderLinks() {
  const d = STAFF.data;
  const base = d.publicBase;
  const local = /\/\/(localhost|127\.0\.0\.1)/.test(base);
  const row = (label, url) => h('div', { class: 'share-row' },
    h('span', { class: 'share-label', text: label }),
    h('code', { text: url }),
    h('button', {
      type: 'button', class: 'btn btn-small', text: 'Copy',
      onclick: async (e) => { const ok = await copyText(url); e.target.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(() => { e.target.textContent = 'Copy'; }, 1800); },
    }));
  $('#linksPanel').replaceChildren(
    h('div', { class: 'panel-head' }, h('h2', { text: 'Links' }),
      h('span', { class: 'small faint', text: local ? 'Only this computer can open these. Start the app with start-online.bat to get a public link.' : 'Share the booking link with players. Staff open the scanner on their phones.' })),
    row('Booking page', base),
    row('Door scanner', `${base}/staff/scan`),
    row('Staff dashboard', `${base}/staff`));
}

async function testGoogle() {
  const btn = $('#testGoogle');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  try {
    const r = await staffCall('/api/staff/google/test', { method: 'POST', body: {} });
    setStaffData(r.data);
    renderGoogleStatus();
    toast(r.status.ok ? `Connected as ${r.status.account}` : r.status.error, r.status.ok ? null : 'bad');
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test connection';
  }
}

function renderGoogleStatus() {
  const d = STAFF.data;
  const g = d.googleStatus;
  const box = $('#googleStatus');
  if (!d.settings.sheet.url && !d.connectorFromEnv) { box.replaceChildren(h('span', { class: 'pill pill-waiting', text: 'Not connected' })); return; }
  if (!g) { box.replaceChildren(h('span', { class: 'pill pill-waiting', text: 'Link saved, not tested yet' })); return; }
  if (!g.ok) { box.replaceChildren(h('span', { class: 'pill pill-failed', text: 'Connection failed' }), h('span', { class: 'faint', text: g.error })); return; }
  const left = d.mailQuota && typeof d.mailQuota.remaining === 'number' ? d.mailQuota.remaining : g.remaining;
  box.replaceChildren(h('span', { class: 'pill pill-sent', text: 'Connected' }),
    h('span', { class: 'faint', text: `${g.account} · sheet "${g.sheet}"${left != null ? ` · ${left} emails left today` : ''}` }));
}

/* ------------------------------------------------------------ day board */

function cellNumbers(st) {
  return { players: st.players, cap: st.capacity, inN: st.checkedIn };
}

function renderBoard() {
  const d = STAFF.data;
  const live = d.bookings.filter((b) => b.payment !== 'rejected');
  const totalSpots = d.slots.length * d.rooms.length * d.settings.roomCapacity;
  const players = live.reduce((n, b) => n + b.players.length, 0) + d.walkins.filter((w) => w.status === 'placed').reduce((n, w) => n + w.size, 0);
  const inN = d.slots.reduce((n, s) => n + d.rooms.reduce((m, r) => m + s.rooms[r.id].checkedIn, 0), 0);
  const review = d.bookings.filter((b) => b.payment === 'pending');
  const waiting = d.walkins.filter((w) => w.status === 'waiting' || w.status === 'alerted');
  const paid = d.bookings.filter((b) => b.payment === 'approved').reduce((n, b) => n + b.amount, 0);
  const tiles = [
    { label: 'Players booked', value: players, sub: `of ${totalSpots} spots` },
    { label: 'Checked in', value: inN, sub: `of ${players} booked` },
    { label: 'Payments to review', value: review.length, sub: review.length ? 'Open the Payments tab' : 'All caught up', alert: review.length > 0, tab: 'payments' },
    { label: 'Standby waiting', value: waiting.length, sub: waiting.length ? 'Walk-ins hoping for a spot' : 'Nobody waiting', tab: 'standby' },
    { label: 'Payments confirmed', value: staffMoney(paid), sub: `${d.bookings.filter((b) => b.payment === 'approved').length} bookings` },
  ];
  $('#stats').replaceChildren(...tiles.map((t) => h(t.tab ? 'button' : 'div', {
    class: `stat${t.alert ? ' is-alert' : ''}`, type: t.tab ? 'button' : null, onclick: t.tab ? () => setTab(t.tab) : null,
  }, h('p', { class: 'stat-label', text: t.label }), h('p', { class: 'stat-value', text: String(t.value) }), h('p', { class: 'stat-sub', text: t.sub }))));

  $('#capLabel').textContent = String(d.settings.roomCapacity);
  const dateText = d.settings.eventDate ? dateLong(d.settings.eventDate) : 'Date not set';
  $('#boardTitle').textContent = `Day board · ${dateText}`;

  const nowSlot = d.now.currentSlotId ? slotOf(d.now.currentSlotId) : null;
  const panel = $('#nowPanel');
  panel.hidden = !nowSlot;
  if (nowSlot) {
    panel.replaceChildren(
      h('div', { class: 'panel-head' }, h('h2', { text: `Now · ${slotRange(nowSlot.start, nowSlot.end)}` }), h('span', { class: 'small faint', text: d.now.minutes >= toMinutes(nowSlot.start) ? 'Check-in closed: missing spots are open to standby' : `Check-in closes at ${timeLabel(nowSlot.start)}` })),
      h('div', { class: 'now-rooms' }, d.rooms.map((r) => {
        const st = nowSlot.rooms[r.id];
        return h('button', { type: 'button', class: 'now-room', onclick: () => openRoom(nowSlot.id, r.id) },
          h('div', { class: 'room-name' }, h('strong', { text: r.name }), locks(r.difficulty)),
          h('span', { class: 'big', text: `${st.checkedIn}/${st.players}` }),
          h('span', { class: 'small muted', text: `checked in · ${st.players} of ${st.capacity} booked${st.hasPrivate ? ' · private' : ''}` }),
          st.toReview ? h('span', { class: 'small strong', text: `${st.toReview} payment${st.toReview === 1 ? '' : 's'} to review` }) : null,
          st.released && st.doorFree ? h('span', { class: 'small strong', text: `${st.doorFree} open for standby` }) : null);
      })));
  }

  const head = h('div', { class: 'board-row board-head' }, h('div', { text: 'Time' }), d.rooms.map((r) => h('div', null, h('span', { text: r.name }), locks(r.difficulty))));
  const rows = d.slots.map((s) => {
    const isNow = s.id === d.now.currentSlotId;
    const past = d.now.phase === 'after' || (d.now.phase === 'day' && d.now.minutes > toMinutes(s.end));
    return h('div', { class: `board-row${isNow ? ' is-now' : ''}${past ? ' is-past' : ''}` },
      h('div', { class: 'board-time' }, h('strong', { text: timeLabel(s.start) }), h('small', { text: isNow ? 'now' : `to ${timeLabel(s.end)}` })),
      d.rooms.map((r) => {
        const st = s.rooms[r.id];
        const c = cellNumbers(st);
        const inBar = h('span', { class: 'in' });
        const bkBar = h('span', { class: 'bk' });
        inBar.style.width = `${(c.inN / c.cap) * 100}%`;
        bkBar.style.width = `${(Math.max(0, (st.hasPrivate ? c.cap : c.players) - c.inN) / c.cap) * 100}%`;
        const sub = [];
        if (c.inN) sub.push(h('span', { class: 'is-in', text: `✓${c.inN} in` }));
        if (st.toReview) sub.push(h('span', { class: 'is-review', text: `${st.toReview} to review` }));
        if (st.hasPrivate) sub.push(h('span', { text: 'private' }));
        if (st.released && st.doorFree) sub.push(h('span', { class: 'is-open', text: `${st.doorFree} open` }));
        if (!sub.length) sub.push(h('span', { text: c.players ? 'booked' : 'empty' }));
        return h('button', { type: 'button', class: 'bcell', 'aria-label': `${r.name} at ${timeLabel(s.start)}: ${c.players} of ${c.cap} booked, ${c.inN} checked in`, onclick: () => openRoom(s.id, r.id) },
          h('span', { class: 'bnum' }, String(c.players), h('small', { text: `/${c.cap}` })),
          h('span', { class: 'bsub' }, sub),
          h('span', { class: 'bbar' }, inBar, bkBar));
      }));
  });
  $('#board').replaceChildren(head, ...rows);
}

function toMinutes(hhmm) {
  const [a, b] = hhmm.split(':').map(Number);
  return a * 60 + b;
}

/* --------------------------------------------------------------- drawer */

function openRoom(slotId, roomId) {
  A.drawer = { kind: 'room', slotId, roomId };
  renderDrawer();
  if (!drawer.open) drawer.showModal();
}

function openBooking(id) {
  A.drawer = { kind: 'booking', id };
  renderDrawer();
  if (!drawer.open) drawer.showModal();
}

function renderDrawer() {
  if (A.drawer.kind === 'room') renderRoomDrawer();
  else renderBookingDrawer();
}

function drawerShell(eyebrow, title, extraHead, body, foot) {
  $('#drawerInner').replaceChildren(
    h('header', { class: 'drawer-head' },
      h('div', null, h('p', { class: 'eyebrow', text: eyebrow }), h('h2', { text: title }), extraHead || null),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', text: '×', onclick: () => drawer.close() })),
    h('div', { class: 'drawer-body' }, body),
    foot ? h('footer', { class: 'drawer-foot' }, foot) : null);
}

function renderRoomDrawer() {
  const d = STAFF.data;
  const { slotId, roomId } = A.drawer;
  const slot = slotOf(slotId);
  const room = roomOf(roomId);
  if (!slot || !room) { drawer.close(); return; }
  const st = slot.rooms[roomId];
  const books = d.bookings.filter((b) => b.slotId === slotId && b.roomId === roomId && b.payment !== 'rejected');
  const walks = d.walkins.filter((w) => w.status === 'placed' && w.placed && w.placed.slotId === slotId && w.placed.roomId === roomId);
  const manual = !!(d.releases && d.releases[`${slotId}:${roomId}`]);

  const body = [];
  body.push(h('p', { class: 'muted', text: `${st.players} of ${st.capacity} booked · ${st.checkedIn} checked in${st.hasPrivate ? ' · private room' : ''}` }));
  if (!st.released) {
    body.push(h('div', { class: 'contact-row' },
      h('span', { class: 'small muted', text: `Check-in closes at ${timeLabel(slot.start)}.` }),
      h('button', { type: 'button', class: 'btn btn-small', text: 'Close check-in now', onclick: () => setRelease(slotId, roomId, true) })));
  } else {
    body.push(h('div', { class: 'contact-row' },
      h('span', { class: 'small strong', text: st.doorFree ? `Check-in closed. ${plural(st.doorFree, 'spot')} open for standby.` : 'Check-in closed. No spots open.' }),
      manual ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Reopen check-in', onclick: () => setRelease(slotId, roomId, false) }) : null));
  }
  const waiting = d.walkins.filter((w) => (w.status === 'waiting' || w.status === 'alerted') && w.size <= st.doorFree);
  if (st.doorFree && waiting.length) {
    const sel = h('select', { 'aria-label': 'Walk-in to place' }, waiting.map((w) => h('option', { value: w.id, text: `${w.name}${w.size > 1 ? ` (party of ${w.size})` : ''}` })));
    body.push(h('div', { class: 'contact-row' }, sel,
      h('button', { type: 'button', class: 'btn btn-small btn-primary', text: 'Give spot to walk-in', onclick: () => walkinAction(sel.value, 'place', { slotId, roomId }) })));
  }
  if (!books.length && !walks.length) body.push(h('p', { class: 'empty', text: 'Nobody has booked this room yet.' }));
  const roster = h('div', { class: 'roster' }, books.map((b) => {
    const card = checkinCard(b, { showWhen: false });
    card.querySelector('header').append(h('button', { type: 'button', class: 'link-btn small', text: 'Details', onclick: () => openBooking(b.id) }));
    return card;
  }));
  for (const w of walks) {
    roster.append(h('section', { class: 'roster-item' },
      h('header', null, h('div', null, h('strong', { text: w.name }), h('span', { class: 'small faint', text: ` · walk-in · ${plural(w.size, 'player')}` })), h('span', { class: 'pill pill-placed', text: 'Placed' })),
      h('div', { class: 'contact-row' }, callText(w.phone, ''), h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Undo', onclick: () => walkinAction(w.id, 'unplace') }))));
  }
  body.push(roster);
  drawerShell(slotRange(slot.start, slot.end), room.name, locks(room.difficulty), body, null);
}

function renderBookingDrawer() {
  const b = bookingOf(A.drawer.id);
  if (!b) { drawer.close(); return; }
  const d = STAFF.data;
  const url = `/staff/receipt/${b.id}`;
  const receipt = b.receiptType === 'application/pdf'
    ? h('a', { class: 'receipt-pdf', href: url, target: '_blank', rel: 'noopener' }, h('span', { class: 'pdf-badge', text: 'PDF' }), h('strong', { text: 'Open receipt PDF' }))
    : h('a', { class: 'receipt-big', href: url, target: '_blank', rel: 'noopener', title: 'Open full size' }, h('img', { src: url, alt: `Receipt from ${b.label}` }));
  const rows = [
    ['Booking code', b.code], ['Type', TYPE_INFO[b.type].label], ['Room and time', whenLabel(b.slotId, b.roomId)],
    ['Amount', `${staffMoney(b.amount)} (${b.spots} spots)`], ['Reference no.', b.referenceNo], ['Email', b.email], ['Mobile', b.phone],
    ['Booked', new Date(b.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })],
  ];
  if (b.rejectReason) rows.push(['Reject reason', b.rejectReason]);

  const slotSel = h('select', { 'aria-label': 'Time' }, d.slots.map((s) => h('option', { value: s.id, text: slotRange(s.start, s.end) })));
  slotSel.value = b.slotId;
  const roomSel = h('select', { 'aria-label': 'Room' }, d.rooms.map((r) => h('option', { value: r.id, text: r.name })));
  roomSel.value = b.roomId;

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
      setStaffData(await staffCall(`/api/staff/bookings/${b.id}`, { method: 'DELETE' }));
      drawer.close();
      toast(`Deleted ${b.label}`);
    } catch (err) { toast(err.message, 'bad'); }
  });

  const foot = [];
  if (b.payment !== 'approved') foot.push(h('button', { type: 'button', class: 'btn btn-small btn-primary', text: 'Approve payment', onclick: () => payment(b, 'approved') }));
  if (b.payment !== 'rejected') foot.push(h('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Reject payment', onclick: () => { setTab('payments'); A.reviewIdx = reviewQueue().findIndex((x) => x.id === b.id); renderReview(); drawer.close(); } }));
  foot.push(h('button', {
    type: 'button', class: 'btn btn-small', text: b.payment === 'approved' ? 'Resend ticket email' : 'Resend email',
    onclick: async () => { try { setStaffData((await staffCall(`/api/staff/bookings/${b.id}/resend`, { method: 'POST', body: {} })).data); toast(`Email sent to ${b.email}`); } catch (err) { toast(err.message, 'bad'); } },
  }));
  foot.push(h('a', { class: 'btn btn-small btn-ghost', href: `/t/${b.token}`, target: '_blank', rel: 'noopener', text: 'Ticket page' }));
  foot.push(h('span', { class: 'spacer' }), del);

  drawerShell(b.code, b.label, h('p', { class: 'small' }, payPill(b.payment)), [
    receipt,
    h('dl', { class: 'summary' }, rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
    checkinCard(b, { showWhen: false }),
    h('div', { class: 'field' }, h('span', { class: 'label', text: 'Move to another room or time' }),
      h('div', { class: 'contact-row' }, slotSel, roomSel, h('button', {
        type: 'button', class: 'btn btn-small', text: 'Move',
        onclick: async () => {
          try {
            setStaffData(await staffCall(`/api/staff/bookings/${b.id}/move`, { method: 'POST', body: { slotId: slotSel.value, roomId: roomSel.value } }));
            toast(`Moved to ${whenLabel(slotSel.value, roomSel.value)}`);
          } catch (err) { toast(err.message, 'bad'); }
        },
      }))),
  ], foot);
}

async function setRelease(slotId, roomId, released) {
  try {
    setStaffData(await staffCall('/api/staff/release', { method: 'POST', body: { slotId, roomId, released } }));
    toast(released ? 'Check-in closed. Missing spots are open for standby.' : 'Check-in reopened');
  } catch (err) { toast(err.message, 'bad'); }
}

async function payment(b, status, reason) {
  try {
    setStaffData(await staffCall(`/api/staff/bookings/${b.id}/payment`, { method: 'POST', body: { status, reason } }));
    toast(status === 'approved' ? `Approved. Ticket emailed to ${b.email}.` : status === 'rejected' ? `Rejected. ${b.leaderName} was emailed.` : 'Moved back to review');
    return true;
  } catch (err) {
    toast(err.message, 'bad');
    return false;
  }
}

/* -------------------------------------------------------- payment review */

function reviewQueue() {
  return STAFF.data.bookings.filter((b) => b.payment === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function renderReview() {
  const q = reviewQueue();
  const panel = $('#reviewPanel');
  if (!q.length) {
    panel.replaceChildren(h('div', { class: 'panel-head' }, h('h2', { text: 'Payments to review' })), h('p', { class: 'empty', text: 'All caught up. New bookings show up here.' }));
    return;
  }
  A.reviewIdx = Math.max(0, Math.min(A.reviewIdx, q.length - 1));
  const b = q[A.reviewIdx];
  const url = `/staff/receipt/${b.id}`;
  const img = b.receiptType === 'application/pdf'
    ? h('a', { class: 'receipt-pdf', href: url, target: '_blank', rel: 'noopener' }, h('span', { class: 'pdf-badge', text: 'PDF' }), h('strong', { text: 'Open receipt PDF' }))
    : h('a', { class: 'review-img', href: url, target: '_blank', rel: 'noopener', title: 'Open full size' }, h('img', { src: url, alt: `Receipt from ${b.label}` }));
  const reason = h('input', { type: 'text', maxlength: '300', placeholder: 'Reason, e.g. "Amount is ₱300, expected ₱450"', 'aria-label': 'Reason for rejecting' });
  const rejectRow = h('div', { class: 'contact-row', hidden: true }, reason,
    h('button', { type: 'button', class: 'btn btn-danger', text: 'Reject and email them', onclick: async () => { if (await payment(b, 'rejected', reason.value)) renderReview(); } }));
  const price = STAFF.data.settings.pricePerPlayer;
  panel.replaceChildren(
    h('div', { class: 'panel-head' }, h('h2', { text: `Payments to review · ${q.length} left` }), h('span', { class: 'small faint', text: `${A.reviewIdx + 1} of ${q.length}, oldest first` })),
    h('div', { class: 'review' }, img,
      h('div', { class: 'review-info' },
        h('div', null, h('p', { class: 'eyebrow mono', text: b.code }), h('h3', { text: b.label })),
        h('p', { class: 'muted', text: `${TYPE_INFO[b.type].label} · ${plural(b.players.length, 'player')} · ${whenLabel(b.slotId, b.roomId)}` }),
        h('div', { class: 'expect' }, h('span', { class: 'eyebrow', text: 'Expected' }), h('strong', { text: staffMoney(b.amount) }), h('span', { class: 'small muted', text: `${staffMoney(price)} × ${b.spots} spots` })),
        h('dl', { class: 'summary' },
          h('dt', { text: 'Reference no.' }), h('dd', { class: 'mono', text: b.referenceNo }),
          h('dt', { text: 'Leader' }), h('dd', { text: `${b.leaderName} · ${b.phone}` }),
          h('dt', { text: 'Submitted' }), h('dd', { text: new Date(b.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) })),
        h('div', { class: 'contact-row' },
          h('button', { type: 'button', class: 'btn btn-primary', text: 'Approve and send ticket', onclick: async () => { if (await payment(b, 'approved')) renderReview(); } }),
          h('button', { type: 'button', class: 'btn btn-danger', text: 'Reject', onclick: () => { rejectRow.hidden = false; reason.focus(); } })),
        rejectRow,
        h('div', { class: 'review-nav' },
          h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: '← Previous', disabled: A.reviewIdx === 0, onclick: () => { A.reviewIdx--; renderReview(); } }),
          h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Details', onclick: () => openBooking(b.id) }),
          h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Skip →', disabled: A.reviewIdx >= q.length - 1, onclick: () => { A.reviewIdx++; renderReview(); } })))));
}

/* -------------------------------------------------------------- bookings */

function renderSlotFilter() {
  const sel = $('#slotFilter');
  sel.replaceChildren(h('option', { value: 'all', text: 'All times' }), ...STAFF.data.slots.map((s) => h('option', { value: s.id, text: slotRange(s.start, s.end) })));
  if (A.filter.slot !== 'all' && !slotOf(A.filter.slot)) A.filter.slot = 'all';
  sel.value = A.filter.slot;
}

function renderBookings() {
  const d = STAFF.data;
  const q = A.filter.q.trim().toLowerCase();
  const order = Object.fromEntries(d.slots.map((s, i) => [s.id, i]));
  const rows = d.bookings
    .filter((b) => A.filter.pay === 'all' || b.payment === A.filter.pay)
    .filter((b) => A.filter.slot === 'all' || b.slotId === A.filter.slot)
    .filter((b) => !q || [b.label, b.teamName, b.code, b.referenceNo, b.email, b.phone, ...b.players.map((p) => p.name)].join(' ').toLowerCase().includes(q))
    .sort((a, b) => (order[a.slotId] ?? 99) - (order[b.slotId] ?? 99) || a.roomId.localeCompare(b.roomId) || a.createdAt.localeCompare(b.createdAt));
  $('#bookingRows').replaceChildren(...rows.map((b) => {
    const slot = slotOf(b.slotId);
    const room = roomOf(b.roomId);
    const inN = b.players.filter((p) => p.inAt).length;
    const tr = h('tr', { tabindex: '0', onclick: () => openBooking(b.id), onkeydown: (e) => { if (e.key === 'Enter') openBooking(b.id); } },
      h('td', null, h('div', { class: 'cell-main', text: b.label }), h('div', { class: 'cell-sub mono', text: b.code })),
      h('td', { text: room ? room.name : '—' }),
      h('td', { text: slot ? slotRange(slot.start, slot.end) : '—' }),
      h('td', { text: TYPE_INFO[b.type].label }),
      h('td', { class: 'num', text: String(b.players.length) }),
      h('td', { text: inN ? `${inN} of ${b.players.length}` : '—' }),
      h('td', null, payPill(b.payment)),
      h('td', null, h('div', { class: 'cell-main', text: b.leaderName }), h('div', { class: 'cell-sub', text: b.phone })));
    return tr;
  }));
  $('#bookingEmpty').hidden = rows.length > 0;
  $('#bookingEmpty').textContent = d.bookings.length ? 'No bookings match these filters.' : 'No bookings yet. Share the booking page to get your first team.';
  $('#resultCount').textContent = d.bookings.length ? `${rows.length} of ${d.bookings.length}` : '';
}

async function syncNow() {
  try {
    const r = await staffCall('/api/staff/sheet/sync', { method: 'POST', body: {} });
    setStaffData(r.data);
    toast(r.status.ok ? `Google Sheet updated (${plural(r.status.rows, 'row')})` : r.status.error, r.status.ok ? null : 'bad');
  } catch (err) { toast(err.message, 'bad'); }
}

/* ---------------------------------------------------------------- standby */

function renderStandby() {
  const d = STAFF.data;
  const spots = openSpotsNow();
  $('#openSpots').replaceChildren(...(spots.length
    ? spots.map((o) => h('button', { type: 'button', class: 'open-spot', onclick: () => openRoom(o.slot.id, o.room.id), text: `${timeLabel(o.slot.start)} · ${o.room.name} · ${o.free} open${o.released ? '' : ' (unbooked)'}` }))
    : [h('p', { class: 'small muted', text: d.now.phase === 'day' ? 'No open spots right now.' : 'Spots open up here on the event day, when check-in closes for each room.' })]));
  $('#wSize').max = String(d.settings.roomCapacity);
  if (!$('#wPaid').value) $('#wPaid').placeholder = String(d.settings.pricePerPlayer);

  const over = d.now.phase === 'after';
  const list = [...d.walkins].sort((a, b) => {
    const rank = { waiting: 0, alerted: 0, placed: 1, refunded: 2 };
    return rank[a.status] - rank[b.status] || a.createdAt.localeCompare(b.createdAt);
  });
  if (!list.length) {
    $('#walkinList').replaceChildren(h('p', { class: 'empty', text: 'Nobody on standby yet.' }));
    return;
  }
  let pos = 0;
  $('#walkinList').replaceChildren(...list.map((w) => {
    const active = w.status === 'waiting' || w.status === 'alerted';
    if (active) pos++;
    const pill = w.status === 'placed' ? h('span', { class: 'pill pill-placed', text: `Placed · ${whenLabel(w.placed.slotId, w.placed.roomId)}` })
      : w.status === 'refunded' ? h('span', { class: 'pill pill-refunded', text: 'Refunded' })
        : over ? h('span', { class: 'pill pill-due', text: 'Refund due' })
          : w.status === 'alerted' ? h('span', { class: 'pill pill-alerted', text: `Alerted ${inTime(w.alertedAt)}` })
            : h('span', { class: 'pill pill-waiting', text: `Waiting · #${pos}` });
    const actions = [];
    if (active) {
      const fits = spots.filter((o) => o.free >= w.size);
      const sel = h('select', { 'aria-label': `Open spot for ${w.name}` }, fits.length
        ? fits.map((o) => h('option', { value: `${o.slot.id}|${o.room.id}`, text: `${timeLabel(o.slot.start)} · ${o.room.name} (${o.free} open)` }))
        : [h('option', { value: '', text: 'No open spot fits yet' })]);
      sel.disabled = !fits.length;
      const pick = () => { const [slotId, roomId] = sel.value.split('|'); return { slotId, roomId }; };
      actions.push(sel,
        h('button', { type: 'button', class: 'btn btn-small', disabled: !fits.length, text: w.email ? 'Alert by email' : 'Mark alerted', onclick: () => walkinAction(w.id, 'alert', pick()) }),
        h('button', { type: 'button', class: 'btn btn-small btn-primary', disabled: !fits.length, text: 'Give spot', onclick: () => walkinAction(w.id, 'place', pick()) }));
      const first = fits[0];
      actions.push(callText(w.phone, first ? standbyMessage(first.slot, first.room) : ''));
      actions.push(armedButton('Mark refunded', 'Confirm refund', () => walkinAction(w.id, 'refund')));
    } else if (w.status === 'placed') {
      actions.push(h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Undo placement', onclick: () => walkinAction(w.id, 'unplace') }));
    }
    actions.push(armedButton('Remove', 'Confirm remove', async () => {
      try { setStaffData(await staffCall(`/api/staff/walkins/${w.id}`, { method: 'DELETE' })); } catch (err) { toast(err.message, 'bad'); }
    }));
    return h('article', { class: 'wl' },
      h('header', null,
        h('div', null, h('strong', { text: w.name }), h('span', { class: 'small faint', text: ` · ${plural(w.size, 'player')} · paid ${staffMoney(w.amountPaid)} ${w.method}${w.email ? ` · ${w.email}` : ''}` })),
        pill),
      h('div', { class: 'wl-actions' }, actions));
  }));
}

function armedButton(label, confirmLabel, action) {
  const btn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: label });
  let armed = null;
  btn.addEventListener('click', () => {
    if (!armed) {
      btn.textContent = confirmLabel;
      btn.classList.add('btn-danger', 'is-armed');
      armed = setTimeout(() => { armed = null; btn.textContent = label; btn.classList.remove('btn-danger', 'is-armed'); }, 3500);
      return;
    }
    clearTimeout(armed);
    action();
  });
  return btn;
}

async function walkinAction(id, action, body) {
  try {
    setStaffData(await staffCall(`/api/staff/walkins/${id}/${action}`, { method: 'POST', body: body || {} }));
    const w = STAFF.data.walkins.find((x) => x.id === id);
    const msg = { place: `${w.name} got a spot`, alert: w && w.email ? `Alert emailed to ${w.name}` : `${w.name} marked as alerted`, unplace: 'Placement undone', refund: 'Marked as refunded' }[action];
    toast(msg);
  } catch (err) { toast(err.message, 'bad'); }
}

async function addWalkin(e) {
  e.preventDefault();
  for (const el of $$('input', e.target)) if (!el.checkValidity()) { el.reportValidity(); return; }
  try {
    setStaffData(await staffCall('/api/staff/walkins', {
      method: 'POST',
      body: { name: $('#wName').value, phone: $('#wPhone').value, email: $('#wEmail').value, size: Number($('#wSize').value), amountPaid: Number($('#wPaid').value), method: $('#wMethod').value },
    }));
    toast(`${$('#wName').value} added to standby`);
    e.target.reset();
  } catch (err) { toast(err.message, 'bad'); }
}

/* ----------------------------------------------------------------- emails */

function renderEmails() {
  const d = STAFF.data;
  const sender = d.mailMode === 'smtp' ? d.settings.mail.user : d.googleStatus && d.googleStatus.account ? d.googleStatus.account : 'the Google account that runs your connector';
  const left = d.mailQuota && typeof d.mailQuota.remaining === 'number' ? ` About ${d.mailQuota.remaining} more can go out today.` : '';
  $('#mailStatus').replaceChildren(d.mailReady
    ? h('p', { class: 'small muted', text: `Emails are sent from ${sender}.${left}` })
    : h('div', { class: 'setup-banner banner-info' }, h('p', null, h('strong', { text: 'Preview mode. ' }), 'Emails are saved here instead of being sent until you connect Google (Sheet + Gmail) in Settings.')));
  const KIND = { received: 'Booking received', ticket: 'QR ticket', rejected: 'Payment rejected', 'leader-alert': 'Players missing', 'walkin-alert': 'Standby alert', test: 'Test' };
  renderMailActions();
  if (!d.emails.length) {
    $('#mailList').replaceChildren(h('p', { class: 'empty', text: 'No emails yet.' }));
    return;
  }
  $('#mailList').replaceChildren(...d.emails.map((m) => h('button', {
    type: 'button', class: `mail-item${A.mailId === m.id ? ' is-active' : ''}`,
    onclick: () => showEmail(m.id),
  },
  h('span', { class: 'top' }, h('span', { text: `${KIND[m.kind] || m.kind} · ${new Date(m.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` }),
    h('span', { class: `pill pill-${m.status}`, text: MAIL_STATUS[m.status] || m.status })),
  h('strong', { text: m.subject }),
  h('span', { class: 'small muted', text: m.status === 'failed' ? `To ${m.to} · ${m.error}` : `To ${m.to}` }))));
}

const MAIL_STATUS = { saved: 'Saved only', queued: 'Waiting to send', sent: 'Sent', failed: 'Failed' };

/** Status and a "Send now" button for the email being previewed. */
function renderMailActions() {
  const box = $('#mailActions');
  const m = STAFF.data.emails.find((e) => e.id === A.mailId);
  box.hidden = !m;
  if (!m) return;
  const parts = [h('span', { class: `pill pill-${m.status}`, text: MAIL_STATUS[m.status] || m.status })];
  if (m.error && m.status !== 'sent') parts.push(h('span', { class: 'small faint', text: m.error }));
  if (m.status !== 'sent' && STAFF.data.mailReady) {
    parts.push(h('button', {
      type: 'button', class: 'btn btn-small btn-primary', text: 'Send now',
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          const r = await staffCall(`/api/staff/emails/${m.id}/send`, { method: 'POST', body: {} });
          setStaffData(r.data);
          toast(r.email.status === 'sent' ? `Sent to ${r.email.to}` : `Not sent yet: ${r.email.error}`, r.email.status === 'sent' ? null : 'bad');
        } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
      },
    }));
  }
  box.replaceChildren(...parts);
}

/** Load the saved email into the sandboxed preview (no scripts run in it). */
async function showEmail(id) {
  A.mailId = id;
  renderEmails();
  $('#mailOpen').href = `/api/staff/emails/${id}`;
  $('#mailOpen').hidden = false;
  try {
    const res = await fetch(`/api/staff/emails/${id}`, { credentials: 'same-origin' });
    $('#mailFrame').srcdoc = res.ok ? await res.text() : '<p style="font-family:sans-serif;padding:16px">This email is no longer saved.</p>';
  } catch {
    $('#mailFrame').srcdoc = '<p style="font-family:sans-serif;padding:16px">Couldn\'t load the email. Check that the app is still running.</p>';
  }
}

/* --------------------------------------------------------------- settings */

const FIELDS = {
  sEventName: 'eventName', sHostName: 'hostName', sEventDate: 'eventDate', sTimezone: 'timezone', sTagline: 'tagline', sDescription: 'description',
  sContact: 'contactInfo', sVenue: 'venue', sVenueAddress: 'venueAddress', sMapUrl: 'mapUrl', sCap: 'roomCapacity', sArrive: 'arriveBefore',
  sAlert: 'alertBefore', sCurrency: 'currency', sPrice: 'pricePerPlayer', sPayment: 'paymentInstructions', sPublicUrl: 'publicUrl',
};

function fillSettings() {
  const d = STAFF.data;
  if (!d) return;
  const s = d.settings;
  for (const [id, key] of Object.entries(FIELDS)) $(`#${id}`).value = s[key] == null ? '' : String(s[key]);
  $('#sFirst').value = s.schedule.firstStart;
  $('#sLast').value = s.schedule.lastStart;
  $('#sLength').value = String(s.schedule.length);
  $('#sEvery').value = String(s.schedule.every);
  $('#sOpen').checked = !!s.registrationOpen;
  $('#sMailUser').value = s.mail.user;
  $('#sMailPass').value = '';
  $('#sMailPass').placeholder = s.mail.passSet ? 'Saved. Type a new one to replace it.' : '';
  $('#sMailName').value = s.mail.fromName;
  $('#sMailHost').value = s.mail.host;
  $('#sMailPort').value = String(s.mail.port);
  $('#sSheetUrl').value = s.sheet.url;
  $('#priceHint').textContent = `A full team or private room pays ${money(s.currency, s.pricePerPlayer * s.roomCapacity)}.`;
  const local = /localhost|127\.0\.0\.1/.test(d.publicBase);
  $('#publicUrlHint').textContent = d.publicFromEnv
    ? `Set automatically by start-online: ${d.publicBase}. Ticket links and QR codes use it.`
    : local
      ? 'Ticket links in emails point to localhost, which only works on this computer. Start the app with start-online.bat, or put its public address here.'
      : 'Used for ticket links and QR codes in emails.';
  $('#roomEdits').replaceChildren(...d.rooms.map((r) => h('div', { class: 'room-edit', 'data-room': r.id },
    h('div', { class: 'field' }, h('label', { for: `rn-${r.id}`, text: 'Room name' }), h('input', { id: `rn-${r.id}`, 'data-k': 'name', maxlength: '60', required: true, value: r.name })),
    h('div', { class: 'field' }, h('label', { for: `rd-${r.id}`, text: 'Difficulty' }),
      (() => { const sel = h('select', { id: `rd-${r.id}`, 'data-k': 'difficulty' }, [1, 2, 3].map((n) => h('option', { value: n, text: `${n} of 3 padlocks` }))); sel.value = String(r.difficulty); return sel; })()),
    h('div', { class: 'field full' }, h('label', { for: `rt-${r.id}`, text: 'Short description' }),
      (() => { const ta = h('textarea', { id: `rt-${r.id}`, 'data-k': 'teaser', rows: '2', maxlength: '400', placeholder: 'One or two lines about the story. Leave empty to show "Story coming soon."' }); ta.value = r.teaser; return ta; })()))));
  renderImageSlots();
  fetch('/api/staff/google/script', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.text() : ''))
    .then((t) => { $('#scriptBox').textContent = t; })
    .catch(() => {});
  renderSheetStatus();
  renderGoogleStatus();
  renderStorage();
  A.settingsDirty = false;
}

/** Where the data lives, and how to run the app on another laptop or a cloud host. */
function renderStorage() {
  const d = STAFF.data;
  const st = d.storage;
  const panel = $('#storagePanel');
  const parts = [h('div', { class: 'panel-head' }, h('h2', { text: 'Where your data is stored' }),
    h('span', { class: `pill ${st.mode === 'google' ? 'pill-sent' : st.onCloudHost ? 'pill-failed' : 'pill-waiting'}`, text: st.mode === 'google' ? 'Google Drive' : st.onCloudHost ? 'Temporary' : 'This computer only' }))];
  if (st.mode === 'google') {
    parts.push(h('p', { class: 'small muted', text: `Bookings, receipts and pictures are in the "Escape Room App Data" folder of ${d.googleStatus && d.googleStatus.account ? d.googleStatus.account : 'the Google account that runs the connector'}. A copy of the data file is kept every hour in its Backups folder.` }));
    parts.push(h('p', { class: 'small', text: st.lastError ? `Not saved yet: ${st.lastError}. Retrying every 10 seconds.` : st.lastSavedAt ? `Last saved ${new Date(st.lastSavedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })}.` : 'Saved.' }));
    if (st.onCloudHost && !d.connectorFromEnv) {
      parts.push(h('p', { class: 'small strong', text: 'One more step on this host: add the two lines below as environment variables (Render › your service › Environment), or after a restart the app won\'t find its data.' }));
    }
  } else if (st.onCloudHost) {
    parts.push(h('p', { class: 'small strong', text: 'This host wipes its disk on every restart, so bookings made now will be lost. Connect Google above, then move the data to Google Drive.' }));
  } else {
    parts.push(h('p', { class: 'small muted', text: 'Right now everything is saved on this computer only. Move it to the event\'s Google Drive so any laptop, or a free cloud host, can run the app with the same data.' }));
  }
  if (st.mode !== 'google') {
    const ready = !!(d.settings.sheet.url || d.connectorFromEnv);
    parts.push(h('div', { class: 'contact-row' },
      h('button', {
        type: 'button', class: 'btn btn-primary', disabled: !ready, text: 'Move data to Google Drive',
        onclick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = 'Moving…';
          try {
            setStaffData(await staffCall('/api/staff/storage/google', { method: 'POST', body: {} }));
            renderStorage();
            toast('Data is now stored in Google Drive.');
          } catch (err) {
            toast(err.message, 'bad');
            e.target.disabled = false;
            e.target.textContent = 'Move data to Google Drive';
          }
        },
      }),
      ready ? null : h('span', { class: 'small faint', text: 'Connect Google first.' })));
  }
  if (st.config) {
    const lines = `GOOGLE_SCRIPT_URL=${st.config.GOOGLE_SCRIPT_URL}\nGOOGLE_SECRET=${st.config.GOOGLE_SECRET}`;
    parts.push(h('div', { class: 'stack-sm' },
      h('p', { class: 'small strong', text: st.mode === 'google' ? 'Run the app on another laptop, or on a cloud host' : 'For later: running the app elsewhere' }),
      h('p', { class: 'small muted', text: 'Another laptop: save these two lines in a file named config.env inside its escape-room-booking folder, then start the app there. Cloud host: add them as environment variables. Keep them private: they unlock the bookings. Run only one copy at a time.' }),
      h('pre', { class: 'code-block', text: lines }),
      h('div', null, h('button', { type: 'button', class: 'btn btn-small', text: 'Copy these lines', onclick: async () => toast((await copyText(lines)) ? 'Copied' : 'Select the lines and copy them') }))));
  }
  panel.replaceChildren(...parts);
}

function renderImageSlots() {
  const d = STAFF.data;
  const slots = [{ target: 'poster', label: 'Event poster (cover)', src: d.settings.poster ? `/media/${d.settings.poster}` : null, ph: null }]
    .concat(d.rooms.map((r) => ({ target: r.id, label: r.name, src: r.image, ph: r })));
  $('#imageSlots').replaceChildren(...slots.map((sl) => {
    const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'sr-only' });
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        const blob = await shrinkImage(f, 1600);
        setStaffData(await staffCall('/api/staff/images', { method: 'POST', body: { target: sl.target, image: { name: f.name, data: await blobToBase64(blob) } } }));
        renderImageSlots();
        toast('Picture updated');
      } catch (err) { toast(err.message, 'bad'); }
    });
    const preview = sl.src ? h('img', { src: sl.src, alt: '' }) : roomPlaceholder();
    return h('div', { class: 'img-slot' }, preview,
      h('div', { class: 'stack-sm' }, h('strong', { text: sl.label }),
        h('div', { class: 'contact-row' },
          h('label', { class: 'btn btn-small' }, input, sl.src ? 'Replace' : 'Upload'),
          sl.src ? h('button', {
            type: 'button', class: 'btn btn-small btn-ghost', text: 'Remove',
            onclick: async () => { try { setStaffData(await staffCall('/api/staff/images', { method: 'POST', body: { target: sl.target, remove: true } })); renderImageSlots(); } catch (err) { toast(err.message, 'bad'); } },
          }) : null)));
  }));
}

function renderSheetStatus() {
  const d = STAFF.data;
  const st = d.sheetStatus;
  const box = $('#sheetStatus');
  if (!d.settings.sheet.url) box.replaceChildren(h('span', { class: 'pill pill-waiting', text: 'Not connected' }));
  else if (!st) box.replaceChildren(h('span', { class: 'pill pill-waiting', text: 'Not synced yet' }));
  else box.replaceChildren(h('span', { class: `pill ${st.ok ? 'pill-sent' : 'pill-failed'}`, text: st.ok ? `Synced ${plural(st.rows, 'row')}` : 'Sync failed' }), h('span', { class: 'faint', text: new Date(st.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }));
}

async function saveSettings(e) {
  e.preventDefault();
  const err = $('#settingsError');
  err.hidden = true;
  for (const el of $$('input, select, textarea', e.target)) if (!el.checkValidity()) { el.reportValidity(); return; }
  const body = {};
  for (const [id, key] of Object.entries(FIELDS)) body[key] = $(`#${id}`).value;
  body.registrationOpen = $('#sOpen').checked;
  body.schedule = { firstStart: $('#sFirst').value, lastStart: $('#sLast').value, length: Number($('#sLength').value), every: Number($('#sEvery').value) };
  body.mail = { user: $('#sMailUser').value, pass: $('#sMailPass').value, fromName: $('#sMailName').value, host: $('#sMailHost').value, port: Number($('#sMailPort').value) };
  body.sheet = { url: $('#sSheetUrl').value };
  body.rooms = $$('.room-edit').map((el) => ({
    id: el.dataset.room, name: $('[data-k="name"]', el).value, difficulty: Number($('[data-k="difficulty"]', el).value), teaser: $('[data-k="teaser"]', el).value,
  }));
  $('#saveSettings').disabled = true;
  try {
    setStaffData(await staffCall('/api/staff/settings', { method: 'PUT', body }));
    fillSettings();
    toast('Settings saved. The booking page is updated.');
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    $('#saveSettings').disabled = false;
  }
}

async function sendTest(e) {
  e.preventDefault();
  try {
    setStaffData((await staffCall('/api/staff/test-email', { method: 'POST', body: { to: $('#testTo').value } })).data);
    toast('Test email sent. Check the inbox.');
  } catch (err) { toast(err.message, 'bad'); }
}

async function changePassword(e) {
  e.preventDefault();
  const err = $('#passwordError');
  err.hidden = true;
  for (const el of $$('input', e.target)) if (!el.checkValidity()) { el.reportValidity(); return; }
  try {
    await staffCall('/api/staff/password', { method: 'POST', body: { current: $('#pCurrent').value, next: $('#pNext').value } });
    e.target.reset();
    STAFF.data.passwordFileExists = false;
    renderAll();
    toast('Password changed. Tell the rest of the staff.');
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  }
}
