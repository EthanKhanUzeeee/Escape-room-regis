'use strict';
/* Public booking page: ticket type → room + time grid → two-step form. */

const SAVED_KEY = 'escape-room:booking';
const S = { ev: null, type: null, size: { group: 1, private: 2 }, pick: null, step: 1, submitting: false };
const bookDialog = $('#bookDialog');
const findDialog = $('#findDialog');
let receipt;

init();

function init() {
  receipt = attachReceiptPicker($('#drop'), showFormError);
  bind();
  refresh(true);
  setInterval(() => { if (document.visibilityState === 'visible' && !bookDialog.open) refresh(false); }, 20000);
}

async function refresh(first) {
  try {
    S.ev = await api('/api/event');
    render();
  } catch (err) {
    if (first) {
      $('#eventName').textContent = 'Booking is unavailable right now';
      $('#tagline').textContent = err.message;
      $('#regBody').hidden = true;
    }
  }
}

const cap = () => S.ev.settings.roomCapacity;
const price = () => S.ev.settings.pricePerPlayer;
const cur = () => S.ev.settings.currency;
const roomById = (id) => S.ev.rooms.find((r) => r.id === id);
const slotById = (id) => S.ev.slots.find((s) => s.id === id);
function size(type = S.type) {
  if (type === 'team') return cap();
  return S.size[type] || 1;
}
const spotsPaid = (type, n) => (type === 'group' ? n : cap());

/* ---------------------------------------------------------------- render */

function render() {
  const s = S.ev.settings;
  document.title = `${s.eventName} · Book`;
  $('#brandName').textContent = s.hostName;
  $('#heroKicker').textContent = s.hostName;
  $('#eventName').textContent = s.eventName;
  $('#coverTitle').textContent = s.eventName;
  $('#tagline').textContent = s.tagline;
  $('#tagline').hidden = !s.tagline;
  $('#hostName').textContent = s.hostName;
  $('#hostInitial').textContent = (s.hostName.trim()[0] || '?').toUpperCase();
  $('#contactInfo').textContent = s.contactInfo || 'No contact details yet.';
  $('#footHost').textContent = `${s.eventName} · ${s.hostName}`;

  const art = $('#coverArt');
  if (s.poster) {
    if (!art.querySelector('img') || art.querySelector('img').getAttribute('src') !== s.poster) art.replaceChildren(h('img', { class: 'cover-img', src: s.poster, alt: `${s.eventName} poster` }));
  } else {
    art.replaceChildren();
  }
  $('#cover').classList.toggle('has-poster', !!s.poster);
  // no cover block at all until a poster is uploaded in Settings
  $('#coverWrap').hidden = !s.poster;
  $('#main').classList.toggle('no-cover', !s.poster);
  $('#hero').classList.toggle('has-poster', !!s.poster); // the poster takes the doors' place

  $('#bookedCount').textContent = String(S.ev.playersBooked);
  $('#bookedLabel').textContent = S.ev.playersBooked === 1 ? 'player booked' : 'players booked';
  $('#bookedMeter').style.width = `${Math.min(100, (S.ev.playersBooked / Math.max(1, S.ev.totalSpots)) * 100)}%`;
  $('#spotsSummary').textContent = `${S.ev.totalSpots - S.ev.playersBooked} of ${S.ev.totalSpots} spots open · ${S.ev.slots.length} times × ${S.ev.rooms.length} rooms`;

  for (const id of ['#venue', '#venue2']) $(id).textContent = s.venue;
  for (const id of ['#venueAddress', '#venueAddress2']) { $(id).textContent = s.venueAddress; $(id).hidden = !s.venueAddress; }
  const map = $('#mapLink');
  map.hidden = !/^https:\/\//i.test(s.mapUrl || '');
  if (!map.hidden) map.href = s.mapUrl;

  renderDate();
  renderRichText($('#description'), s.description);
  renderRooms();
  $('#regBody').hidden = !s.registrationOpen;
  $('#regClosed').hidden = s.registrationOpen;
  renderTypes();
  renderGrid();
  renderSaved();
}

function renderDate() {
  const s = S.ev.settings;
  const slots = S.ev.slots;
  const hours = slots.length ? `${timeLabel(slots[0].start)} – ${timeLabel(slots[slots.length - 1].end)}` : '';
  if (s.eventDate) {
    $('#calMonth').textContent = monthShort(s.eventDate);
    $('#calDay').textContent = String(parseDate(s.eventDate).getDate());
    $('#dateMain').textContent = dateLong(s.eventDate);
  } else {
    $('#calMonth').textContent = 'TBA';
    $('#calDay').textContent = '–';
    $('#dateMain').textContent = 'Date to be announced';
  }
  $('#dateSub').textContent = slots.length ? `${hours} · ${plural(slots.length, 'time slot')}, ${slots.length ? minutesBetween(slots[0]) : ''}` : '';
}

function minutesBetween(slot) {
  const [a, b] = [slot.start, slot.end].map((t) => { const [h1, m1] = t.split(':').map(Number); return h1 * 60 + m1; });
  return `${b - a} minutes each`;
}

function renderRooms() {
  const s = S.ev.settings;
  const first = S.ev.slots[0];
  const mins = first ? (([a, b]) => b - a)([first.start, first.end].map((t) => { const [h1, m1] = t.split(':').map(Number); return h1 * 60 + m1; })) : 0;
  $('#roomCards').replaceChildren(...S.ev.rooms.map((r, i) => {
    const st = roomStory(r, i);
    return h('article', { class: `room-card tone-${st.tone}`, id: `room-${r.id}` },
      h('div', { class: 'room-art' }, roomArt(r, st.tone), h('span', { class: 'room-level', text: levelName(r.difficulty) })),
      h('div', { class: 'room-body' },
        st.genre ? h('p', { class: 'room-genre', text: st.genre }) : null,
        h('div', { class: 'room-name' }, h('h3', { text: r.name }), locks(r.difficulty)),
        h('p', { class: 'room-hook', text: st.hook }),
        st.line ? h('p', { class: 'room-line', text: st.line }) : null,
        h('ul', { class: 'room-meta' }, h('li', { text: `Up to ${s.roomCapacity} players` }), mins ? h('li', { text: `${mins} minutes` }) : null),
        st.notes.length ? h('div', { class: 'room-notes' }, h('span', { class: 'room-notes-label', text: 'Heads-up' }), h('span', { text: st.notes.join(' · ') })) : null,
        h('button', { type: 'button', class: 'btn room-cta', text: 'See open times', onclick: () => showRoomTimes(r.id) })));
  }));
  $('#doors').replaceChildren(...S.ev.rooms.map((r, i) => {
    const st = roomStory(r, i);
    return h('a', { class: `door tone-${st.tone}`, href: `#room-${r.id}`, 'aria-label': `${r.name}, ${levelName(r.difficulty)}` },
      h('span', { class: 'door-frame', 'aria-hidden': 'true' }, h('span', { class: 'door-knob' })),
      h('span', { class: 'door-floor', 'aria-hidden': 'true' }),
      h('span', { class: 'door-name', text: r.name }),
      h('span', { class: 'door-level', text: levelName(r.difficulty) }));
  }));
}

/** From a room card: jump to the time grid and light up that room's column for a moment. */
function showRoomTimes(roomId) {
  S.focus = roomId;
  renderGrid();
  $('#picker').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  if (!S.type) toast("Choose how you're joining, then pick a time.");
  clearTimeout(S.focusTimer);
  S.focusTimer = setTimeout(() => { S.focus = null; renderGrid(); }, 3200);
}

function renderTypes() {
  const c = cap();
  for (const el of $$('[data-cap]')) el.textContent = String(c);
  for (const el of $$('[data-capm1]')) el.textContent = String(c - 1);
  for (const card of $$('.ticket-type')) {
    const type = card.dataset.type;
    const selected = S.type === type;
    card.classList.toggle('is-selected', selected);
    $('.tt-main', card).setAttribute('aria-checked', String(selected));
    const priceEl = $('[data-price]', card);
    if (type === 'group') priceEl.replaceChildren(h('strong', { text: money(cur(), price()) }), h('small', { text: 'per player' }));
    else priceEl.replaceChildren(h('strong', { text: money(cur(), price() * c) }), h('small', { text: `${c} spots` }));
    const counter = $('.tt-count', card);
    if (counter) {
      counter.hidden = !selected;
      $('[data-size]', card).textContent = String(size(type));
    }
  }
  const hint = $('#pickerHint');
  if (!S.type) hint.textContent = "Choose how you're joining first.";
  else if (S.type === 'group') hint.textContent = `Showing rooms with space for ${plural(size(), 'player')}. You'll share the room with other players.`;
  else hint.textContent = `${TYPE_INFO[S.type].label} needs an empty room. Rooms other players already booked are greyed out.`;
}

function cellState(sr) {
  if (sr.closed) return { cls: 'is-closed', text: 'Closed', ok: false, why: 'Booking for this time has closed.' };
  if (sr.free === 0) return { cls: 'is-full', text: 'Full', ok: false, why: 'This room is full.' };
  const label = `${sr.free} left`;
  if (!S.type) return { cls: 'is-idle', text: label, ok: false, idle: true, why: "Choose how you're joining first." };
  if (S.type === 'group') {
    return sr.free >= size() ? { cls: 'is-open', text: label, ok: true } : { cls: 'is-no', text: label, ok: false, why: `Not enough room for ${size()}.` };
  }
  return sr.free === cap() ? { cls: 'is-open', text: 'Empty', ok: true } : { cls: 'is-no', text: label, ok: false, why: 'Other players are already in this room.' };
}

function renderGrid() {
  const grid = $('#sched');
  const rooms = S.ev.rooms;
  const head = [h('div', { class: 'sched-corner', role: 'columnheader' }, h('span', { class: 'sr-only', text: 'Time' }))];
  const tone = (r, i) => `tone-${roomStory(r, i).tone}${S.focus === r.id ? ' is-focus' : ''}`;
  rooms.forEach((r, i) => head.push(h('div', { class: `sched-room ${tone(r, i)}`, role: 'columnheader' }, h('span', { text: r.name }), locks(r.difficulty))));
  const rows = S.ev.slots.map((slot) => h('div', { class: 'sched-row', role: 'row' },
    h('div', { class: 'sched-time', role: 'rowheader' }, h('strong', { text: timeLabel(slot.start) }), h('small', { text: `to ${timeLabel(slot.end)}` })),
    rooms.map((r, i) => {
      const st = cellState(slot.rooms[r.id]);
      const picked = S.pick && S.pick.slotId === slot.id && S.pick.roomId === r.id;
      return h('button', {
        type: 'button',
        role: 'gridcell',
        class: `cell ${st.cls} ${tone(r, i)}${picked ? ' is-picked' : ''}`,
        disabled: !st.ok && !st.idle,
        title: st.why || null,
        'aria-label': `${r.name}, ${slotRange(slot.start, slot.end)}: ${st.text}${st.why ? `. ${st.why}` : ''}`,
        onclick: () => onCell(slot.id, r.id, st),
      }, h('span', { text: st.text }));
    })));
  grid.replaceChildren(h('div', { class: 'sched-row sched-head', role: 'row' }, head), ...rows);
}

function onCell(slotId, roomId, st) {
  if (st.idle) {
    toast("Choose how you're joining first.");
    $('.ticket-type .tt-main').focus();
    return;
  }
  if (!st.ok) return;
  openBooking(slotId, roomId);
}

function renderSaved() {
  const saved = storageGet(SAVED_KEY);
  const foot = $('#regBody .reg-foot');
  if (saved && saved.token) {
    foot.replaceChildren('Your booking ', h('span', { class: 'mono', text: saved.code }), ' · ', h('a', { href: `/t/${saved.token}`, text: 'View it' }), ' · ',
      h('button', { class: 'link-btn', type: 'button', text: 'Find another', onclick: openFind }));
  }
}

/* ------------------------------------------------------------------ bind */

function bind() {
  for (const card of $$('.ticket-type')) {
    $('.tt-main', card).addEventListener('click', () => {
      S.type = card.dataset.type;
      S.pick = null;
      renderTypes();
      renderGrid();
    });
    for (const btn of $$('[data-step]', card)) {
      btn.addEventListener('click', () => {
        const type = card.dataset.type;
        const [min, max] = type === 'group' ? [1, cap() - 1] : [2, cap() - 1];
        S.size[type] = Math.min(max, Math.max(min, size(type) + Number(btn.dataset.step)));
        renderTypes();
        renderGrid();
      });
    }
  }
  for (const id of ['#findTop', '#findOpen', '#findClosed']) $(id).addEventListener('click', openFind);
  for (const btn of $$('[data-close]')) btn.addEventListener('click', () => btn.closest('dialog').close());
  for (const d of [bookDialog, findDialog]) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  bookDialog.addEventListener('close', () => {
    if (S.step === 3) resetBooking();
    S.pick = null;
    renderGrid();
  });

  for (const btn of $$('[data-fstep]')) btn.addEventListener('click', () => changeFormSize(Number(btn.dataset.fstep)));
  $('#leaderName').addEventListener('input', () => { const c = $('#leaderChip'); if (c) c.textContent = leaderChip(); });
  $('#shareContact').addEventListener('change', () => {
    $('#contactFields').hidden = !$('#shareContact').checked;
    $('#contactValue').required = $('#shareContact').checked;
  });
  $('#contactKind').addEventListener('change', () => {
    $('#contactValue').placeholder = { messenger: 'e.g. https://m.me/your.name', facebook: 'e.g. https://facebook.com/your.name', instagram: 'e.g. @yourname', phone: 'e.g. 0917 123 4567', other: 'Link or username' }[$('#contactKind').value];
  });
  $('#backBtn').addEventListener('click', () => setStep(1));
  $('#bookForm').addEventListener('submit', onSubmit);
  $('#copyCode').addEventListener('click', async () => {
    const ok = await copyText($('#successCode').textContent);
    $('#copyCode').textContent = ok ? 'Copied' : 'Select and copy';
  });
  $('#findForm').addEventListener('submit', onFind);
}

/* ------------------------------------------------------------ the form */

function openBooking(slotId, roomId) {
  const slot = slotById(slotId);
  const room = roomById(roomId);
  S.pick = { slotId, roomId };
  renderGrid();
  $('#sumRoom').textContent = room.name;
  const date = S.ev.settings.eventDate ? `${dateShort(S.ev.settings.eventDate)}, ` : '';
  $('#sumTime').textContent = `${date}${slotRange(slot.start, slot.end)} · ${TYPE_INFO[S.type].label}`;

  const needsName = S.type !== 'group';
  $('#teamName').required = needsName;
  $('#teamOpt').hidden = needsName;
  $('#formStepper').hidden = S.type === 'team';
  $('#optin').hidden = S.type !== 'group';
  renderMemberInputs();
  setStep(1);
  bookDialog.showModal();
  $('#teamName').focus();
}

function formLimits() {
  if (S.type === 'team') return [cap(), cap()];
  const free = S.pick ? slotById(S.pick.slotId).rooms[S.pick.roomId].free : cap();
  if (S.type === 'group') return [1, Math.min(cap() - 1, free)];
  return [2, cap() - 1];
}

function changeFormSize(delta) {
  const [min, max] = formLimits();
  const next = size() + delta;
  if (next > max && S.type === 'group' && max < cap() - 1) {
    toast(`This room only has ${plural(max, 'open spot')}.`);
    return;
  }
  S.size[S.type] = Math.min(max, Math.max(min, next));
  renderTypes();
  renderMemberInputs();
}

const leaderChip = () => `Player 1: ${$('#leaderName').value.trim() || 'the group leader'}`;

function renderMemberInputs() {
  const box = $('#memberInputs');
  const previous = $$('input', box).map((i) => i.value);
  const n = size();
  box.replaceChildren(h('div', { class: 'leader-chip', id: 'leaderChip', text: leaderChip() }));
  for (let i = 2; i <= n; i++) {
    const input = h('input', { id: `player${i}`, required: true, maxlength: 80, autocomplete: 'off', placeholder: `Player ${i} full name`, 'aria-label': `Player ${i} full name` });
    input.value = previous[i - 2] || '';
    box.append(input);
  }
  $('#playerCount').textContent = String(n);
  $('#formSize').textContent = String(n);
  const [min, max] = formLimits();
  $('[data-fstep="-1"]').disabled = n <= min;
  $('[data-fstep="1"]').disabled = n >= max;
  const hint = $('#playersHint');
  if (S.type === 'team') hint.textContent = `A full team has exactly ${cap()} players.`;
  else if (S.type === 'private') hint.textContent = `You pay for all ${cap()} spots, so nobody else joins your room.`;
  else hint.textContent = `${cap() - n} spot${cap() - n === 1 ? '' : 's'} in your room may go to other players booking this time.`;
}

function setStep(n) {
  S.step = n;
  $('#step1').hidden = n !== 1;
  $('#step2').hidden = n !== 2;
  $('#step3').hidden = n !== 3;
  $('#slotSummary').hidden = n === 3;
  $('#backBtn').hidden = n !== 2;
  $('#viewBooking').hidden = n !== 3;
  const next = $('#nextBtn');
  next.disabled = false;
  next.textContent = n === 1 ? 'Continue to payment' : n === 2 ? 'Submit booking' : 'Done';
  $('#stepLabel').textContent = n === 1 ? 'Step 1 of 2 · Your team' : n === 2 ? 'Step 2 of 2 · Payment' : 'All set';
  $('#sheetTitle').textContent = n === 3 ? 'Booking received' : 'Your booking';
  showFormError('');
  if (n === 2) fillPayment();
  $('#bookForm .sheet-body').scrollTop = 0;
}

function fillPayment() {
  const n = size();
  const spots = spotsPaid(S.type, n);
  $('#amountText').textContent = money(cur(), spots * price());
  $('#amountBreakdown').textContent = S.type === 'group'
    ? `${money(cur(), price())} × ${plural(n, 'player')}`
    : `${money(cur(), price())} × ${cap()} spots${S.type === 'private' ? ` (room for your ${n})` : ''}`;
  $('#payInstructions').textContent = S.ev.settings.paymentInstructions;
}

function validateStep(sel) {
  for (const el of $$('input, select, textarea', $(sel))) {
    if (el.type === 'file' || el.closest('[hidden]')) continue;
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'checkbox' && !el.value.trim()) el.value = '';
    if (!el.checkValidity()) {
      el.reportValidity();
      el.focus();
      return false;
    }
  }
  return true;
}

async function onSubmit(e) {
  e.preventDefault();
  if (S.step === 1) {
    if (validateStep('#step1')) setStep(2);
  } else if (S.step === 2) {
    if (!receipt.value) { showFormError('Upload your payment receipt before submitting.'); return; }
    if (validateStep('#step2')) await submitBooking();
  } else {
    bookDialog.close();
  }
}

async function submitBooking() {
  if (S.submitting) return;
  S.submitting = true;
  const btn = $('#nextBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  showFormError('');
  const payload = {
    type: S.type,
    slotId: S.pick.slotId,
    roomId: S.pick.roomId,
    teamName: $('#teamName').value,
    leaderName: $('#leaderName').value,
    email: $('#email').value,
    phone: $('#phone').value,
    players: $$('#memberInputs input').map((i) => i.value),
    contact: S.type === 'group' ? { share: $('#shareContact').checked, kind: $('#contactKind').value, value: $('#contactValue').value } : null,
    referenceNo: $('#referenceNo').value,
    receipt: { name: receipt.value.name, data: receipt.value.data },
  };
  try {
    const r = await api('/api/book', { method: 'POST', body: payload });
    storageSet(SAVED_KEY, { token: r.token, code: r.code });
    showSuccess(r, payload.email.trim());
    refresh(false);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Submit booking';
    if (err.code === 'no_room') {
      bookDialog.close();
      await refresh(false);
      toast(err.message, 'bad');
    } else if (err.code === 'name_taken') {
      setStep(1);
      showFormError(err.message);
      $('#teamName').focus();
    } else {
      showFormError(err.message);
    }
  } finally {
    S.submitting = false;
  }
}

function showSuccess(r, email) {
  const t = r.ticket;
  $('#successCode').textContent = r.code;
  $('#copyCode').textContent = 'Copy code';
  $('#successText').textContent = `We emailed ${email}. Your QR ticket arrives in a second email once your payment is approved.`;
  const rows = [
    ['Team', t.label],
    ['Room', t.room.name],
    ['Time', `${S.ev.settings.eventDate ? `${dateShort(S.ev.settings.eventDate)}, ` : ''}${slotRange(t.slot.start, t.slot.end)}`],
    ['Players', String(t.players.length)],
    ['Amount', money(cur(), t.amount)],
  ];
  $('#successSummary').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
  $('#viewBooking').href = `/t/${r.token}`;
  setStep(3);
}

function resetBooking() {
  $('#bookForm').reset();
  receipt.reset();
  $('#contactFields').hidden = true;
  S.pick = null;
  setStep(1);
  render();
}

function showFormError(msg) {
  const el = $('#formError');
  el.textContent = msg;
  el.hidden = !msg;
  if (msg) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ------------------------------------------------------------------ find */

function openFind() {
  $('#findError').hidden = true;
  findDialog.showModal();
  $('#findCode').focus();
}

async function onFind(e) {
  e.preventDefault();
  for (const el of [$('#findCode'), $('#findEmail')]) if (!el.checkValidity()) { el.reportValidity(); return; }
  const btn = $('#findSubmit');
  btn.disabled = true;
  try {
    const r = await api('/api/find', { method: 'POST', body: { code: $('#findCode').value, email: $('#findEmail').value } });
    location.href = `/t/${r.token}`;
  } catch (err) {
    $('#findError').textContent = err.message;
    $('#findError').hidden = false;
    btn.disabled = false;
  }
}
