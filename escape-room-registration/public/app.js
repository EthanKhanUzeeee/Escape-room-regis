'use strict';
/* Public registration page. */

const SAVED_KEY = 'escape-room:last-registration';
const state = { event: null, date: null, slotId: null, step: 1, receipt: null, submitting: false };
const regDialog = $('#regDialog');
const statusDialog = $('#statusDialog');

buildCover();
bindPage();
refresh(true);
setInterval(() => { if (document.visibilityState === 'visible') refresh(false); }, 20000);

/* ------------------------------------------------------------------ data */

async function refresh(first) {
  try {
    const data = await api('/api/event');
    state.event = data;
    const dates = uniqueDates(data.slots);
    if (!state.date || !dates.includes(state.date)) state.date = firstOpenDate(data.slots) || dates[0] || null;
    const picked = data.slots.find((s) => s.id === state.slotId);
    if (state.slotId && (!picked || picked.left <= 0) && !regDialog.open) state.slotId = null;
    render();
  } catch (err) {
    if (first) {
      $('#eventName').textContent = 'Registration is unavailable';
      $('#tagline').textContent = err.message;
      $('#regBody').hidden = true;
    }
  }
}

const uniqueDates = (slots) => [...new Set(slots.map((s) => s.date))];
const firstOpenDate = (slots) => (slots.find((s) => s.left > 0) || {}).date;
const slotById = (id) => state.event.slots.find((s) => s.id === id);

/* ---------------------------------------------------------------- render */

function render() {
  const { settings: s, slots, groups } = state.event;
  document.title = `${s.eventName} · Register`;
  $('#brandName').textContent = s.hostName;
  $('#eventName').textContent = s.eventName;
  $('#coverTitle').textContent = s.eventName;
  $('#tagline').textContent = s.tagline;
  $('#tagline').hidden = !s.tagline;
  $('#hostName').textContent = s.hostName;
  $('#hostInitial').textContent = (s.hostName.trim()[0] || '?').toUpperCase();
  $('#contactInfo').textContent = s.contactInfo || 'No contact details yet.';
  $('#footHost').textContent = `${s.eventName} · ${s.hostName}`;
  $('#groupCount').textContent = groups;
  $('#groupCountLabel').textContent = groups === 1 ? 'group registered' : 'groups registered';

  for (const id of ['#venue', '#venue2']) $(id).textContent = s.venue;
  for (const id of ['#venueAddress', '#venueAddress2']) { $(id).textContent = s.venueAddress; $(id).hidden = !s.venueAddress; }
  const map = $('#mapLink');
  map.hidden = !/^https:\/\//i.test(s.mapUrl || '');
  if (!map.hidden) map.href = s.mapUrl;

  renderRichText($('#description'), s.description);
  renderDateFact(slots);
  renderFillStrip(slots);

  $('#priceText').textContent = s.price > 0 ? `${money(s.currency, s.price)} per ${s.priceMode}` : 'Free';
  $('#regBody').hidden = !s.registrationOpen;
  $('#regClosed').hidden = s.registrationOpen;

  renderDateTabs();
  renderSlots();
  renderSaved();
}

function renderDateFact(slots) {
  const dates = uniqueDates(slots);
  if (!dates.length) {
    $('#calMonth').textContent = 'TBA';
    $('#calDay').textContent = '–';
    $('#dateMain').textContent = 'Date to be announced';
    $('#dateSub').textContent = 'Time slots will appear here soon.';
    return;
  }
  const first = dates[0];
  const last = dates[dates.length - 1];
  $('#calMonth').textContent = monthShort(first);
  $('#calDay').textContent = String(parseDate(first).getDate());
  const starts = slots.map((s) => s.start).sort();
  const ends = slots.map((s) => s.end).sort();
  const hours = `${timeLabel(starts[0])} – ${timeLabel(ends[ends.length - 1])}`;
  if (dates.length === 1) {
    $('#dateMain').textContent = dateLong(first);
    $('#dateSub').textContent = `${hours} · ${plural(slots.length, 'time slot')}`;
  } else {
    $('#dateMain').textContent = `${dateShort(first)} to ${dateShort(last)}`;
    $('#dateSub').textContent = `${dates.length} days · ${hours}`;
  }
}

function renderFillStrip(slots) {
  const strip = $('#fillStrip');
  strip.replaceChildren(...slots.map((s) => h('i', {
    class: `fill-cell${s.left <= 0 ? ' is-full' : s.taken > 0 ? ' is-part' : ''}`,
    title: `${dateShort(s.date)}, ${slotRange(s.start, s.end)}: ${s.left <= 0 ? 'full' : `${s.left} open`}`,
  })));
  const open = slots.filter((s) => s.left > 0).length;
  $('#openSummary').textContent = slots.length ? `${open} of ${plural(slots.length, 'time slot')} still open` : '';
}

function renderDateTabs() {
  const dates = uniqueDates(state.event.slots);
  const tabs = $('#dateTabs');
  tabs.hidden = dates.length < 2;
  tabs.replaceChildren(...dates.map((d) => {
    const open = state.event.slots.filter((s) => s.date === d && s.left > 0).length;
    return h('button', {
      type: 'button', class: 'date-tab', role: 'tab', 'aria-selected': String(d === state.date),
      onclick: () => { state.date = d; renderDateTabs(); renderSlots(); },
    }, dateShort(d), h('small', { text: open ? `${open} open` : 'Full' }));
  }));
}

function renderSlots() {
  const box = $('#slots');
  const list = state.event.slots.filter((s) => s.date === state.date);
  if (!list.length) {
    box.replaceChildren(h('p', { class: 'empty-slots', text: 'No time slots yet. Check back soon.' }));
    return;
  }
  box.replaceChildren(...list.map((s) => {
    const full = s.left <= 0;
    const selected = s.id === state.slotId;
    let status = 'Available';
    if (full) status = 'Full';
    else if (s.capacity > 1) status = `${s.left} of ${s.capacity} spots left`;
    const low = !full && s.capacity > 1 && s.left === 1;
    return h('button', {
      type: 'button',
      class: `slot${selected ? ' is-selected' : ''}`,
      role: 'radio',
      'aria-checked': String(selected),
      'aria-label': `${slotRange(s.start, s.end)}, ${status}`,
      disabled: full,
      onclick: () => selectSlot(s.id),
    },
    h('span', { class: 'slot-time', text: slotRange(s.start, s.end) }),
    h('span', { class: `slot-status${low ? ' is-low' : ''}`, text: low ? 'Last spot' : status }),
    h('span', { class: 'slot-check', 'aria-hidden': 'true' }));
  }));
}

function selectSlot(id) {
  state.slotId = id;
  renderSlots();
}

function renderSaved() {
  const saved = storageGet(SAVED_KEY);
  $('#savedReg').hidden = !saved;
  if (saved) {
    $('#savedGroup').textContent = saved.groupName;
    $('#savedCode').textContent = saved.code;
  }
}

/* ------------------------------------------------------------ registration */

function bindPage() {
  $('#registerBtn').addEventListener('click', () => {
    if (!state.slotId) {
      toast('Pick a time slot first.');
      const first = $('#slots .slot:not(:disabled)');
      if (first) first.focus();
      return;
    }
    openRegistration();
  });
  for (const id of ['#statusOpen', '#statusOpenTop', '#statusOpenClosed', '#savedCheck']) $(id).addEventListener('click', openStatus);

  for (const btn of $$('[data-close]')) btn.addEventListener('click', () => btn.closest('dialog').close());
  for (const d of [regDialog, statusDialog]) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // click on the backdrop
  }
  regDialog.addEventListener('close', () => { if (state.step === 3) resetRegistration(); });

  $('#players').addEventListener('change', renderMemberInputs);
  $('#leaderName').addEventListener('input', () => { const c = $('#leaderChip'); if (c) c.textContent = leaderChipText(); });
  $('#backBtn').addEventListener('click', () => setStep(1));
  $('#regForm').addEventListener('submit', onRegSubmit);
  $('#copyCode').addEventListener('click', async () => {
    const ok = await copyText($('#successCode').textContent);
    $('#copyCode').textContent = ok ? 'Copied' : 'Select and copy';
  });

  const input = $('#receipt');
  input.addEventListener('change', () => { if (input.files[0]) takeReceipt(input.files[0]); input.value = ''; });
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    const f = e.dataTransfer.files[0];
    if (f) takeReceipt(f);
  });

  $('#statusForm').addEventListener('submit', onStatusSubmit);
}

function openRegistration() {
  const slot = slotById(state.slotId);
  const s = state.event.settings;
  $('#sumTime').textContent = slotRange(slot.start, slot.end);
  $('#sumDate').textContent = dateLong(slot.date);

  const sel = $('#players');
  const keep = Number(sel.value) || Math.min(Math.max(4, s.minPlayers), s.maxPlayers);
  sel.replaceChildren();
  for (let n = s.minPlayers; n <= s.maxPlayers; n++) sel.append(h('option', { value: n, text: plural(n, 'player') }));
  sel.value = String(Math.min(Math.max(keep, s.minPlayers), s.maxPlayers));
  $('#playersHint').textContent = `Groups of ${s.minPlayers} to ${s.maxPlayers} players.`;
  renderMemberInputs();

  setStep(1);
  regDialog.showModal();
  $('#groupName').focus();
}

const leaderChipText = () => `Player 1: ${$('#leaderName').value.trim() || 'the group leader'}`;

function renderMemberInputs() {
  const box = $('#memberInputs');
  const previous = $$('input', box).map((i) => i.value);
  const n = Number($('#players').value);
  box.replaceChildren(h('div', { class: 'leader-chip', id: 'leaderChip', text: leaderChipText() }));
  for (let i = 2; i <= n; i++) {
    const input = h('input', { id: `member${i}`, required: true, maxlength: 80, autocomplete: 'off', placeholder: `Player ${i} full name`, 'aria-label': `Player ${i} full name` });
    input.value = previous[i - 2] || '';
    box.append(input);
  }
}

function setStep(n) {
  state.step = n;
  $('#step1').hidden = n !== 1;
  $('#step2').hidden = n !== 2;
  $('#step3').hidden = n !== 3;
  $('#slotSummary').hidden = n === 3;
  $('#backBtn').hidden = n !== 2;
  $('#nextBtn').disabled = false;
  $('#nextBtn').textContent = n === 1 ? 'Continue to payment' : n === 2 ? 'Submit registration' : 'Done';
  $('#stepLabel').textContent = n === 1 ? 'Step 1 of 2 · Your group' : n === 2 ? 'Step 2 of 2 · Payment' : 'All set';
  $('#sheetTitle').textContent = n === 3 ? 'Registration received' : 'Register your group';
  showFormError('');
  if (n === 2) fillPayment();
  const body = $('#regForm .sheet-body');
  if (body) body.scrollTop = 0;
}

function fillPayment() {
  const s = state.event.settings;
  const players = Number($('#players').value);
  const amount = s.priceMode === 'player' ? s.price * players : s.price;
  $('#amountText').textContent = money(s.currency, amount);
  $('#amountBreakdown').textContent = s.priceMode === 'player'
    ? `${money(s.currency, s.price)} × ${plural(players, 'player')}`
    : `${money(s.currency, s.price)} per group`;
  $('#payInstructions').textContent = s.paymentInstructions;
}

function validateStep(stepSel) {
  for (const el of $$('input, select, textarea', $(stepSel))) {
    if (el.type === 'file') continue;
    // whitespace-only answers count as empty
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'checkbox' && !el.value.trim()) el.value = '';
    if (!el.checkValidity()) {
      el.reportValidity();
      el.focus();
      return false;
    }
  }
  return true;
}

async function onRegSubmit(e) {
  e.preventDefault();
  if (state.step === 1) {
    if (!validateStep('#step1')) return;
    setStep(2);
  } else if (state.step === 2) {
    if (!state.receipt) { showFormError('Upload your payment receipt before submitting.'); return; }
    if (!validateStep('#step2')) return;
    await submitRegistration();
  } else {
    regDialog.close();
  }
}

async function submitRegistration() {
  if (state.submitting) return;
  state.submitting = true;
  const btn = $('#nextBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  showFormError('');
  const payload = {
    slotId: state.slotId,
    groupName: $('#groupName').value,
    leaderName: $('#leaderName').value,
    school: $('#school').value,
    email: $('#email').value,
    phone: $('#phone').value,
    players: Number($('#players').value),
    members: $$('#memberInputs input').map((i) => i.value),
    referenceNo: $('#referenceNo').value,
    notes: $('#notes').value,
    receipt: { name: state.receipt.name, data: state.receipt.data },
  };
  try {
    const r = await api('/api/register', { method: 'POST', body: payload });
    storageSet(SAVED_KEY, { code: r.code, groupName: r.groupName, email: payload.email.trim().toLowerCase() });
    showSuccess(r);
    refresh(false);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Submit registration';
    if (err.code === 'slot_full') {
      regDialog.close();
      state.slotId = null;
      await refresh(false);
      toast('That slot just filled up. Pick another time — your details are still filled in.', 'bad');
    } else if (err.code === 'name_taken') {
      setStep(1);
      showFormError(err.message);
      $('#groupName').focus();
    } else {
      showFormError(err.message);
    }
  } finally {
    state.submitting = false;
  }
}

function showSuccess(r) {
  const s = state.event.settings;
  $('#successCode').textContent = r.code;
  $('#copyCode').textContent = 'Copy code';
  const rows = [
    ['Group', r.groupName],
    ['Time slot', `${dateShort(r.slot.date)}, ${slotRange(r.slot.start, r.slot.end)}`],
    ['Players', String(r.players)],
    ['Amount paid', money(s.currency, r.amount)],
    ['Status', 'Pending approval'],
  ];
  $('#successSummary').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
  setStep(3);
}

function resetRegistration() {
  $('#regForm').reset();
  state.receipt = null;
  state.slotId = null;
  showReceipt();
  setStep(1);
  render();
}

function showFormError(msg) {
  const el = $('#formError');
  el.textContent = msg;
  el.hidden = !msg;
  if (msg) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* -------------------------------------------------------------- receipts */

async function takeReceipt(file) {
  showFormError('');
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isImage = /^image\//.test(file.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
  try {
    if (isPdf) {
      if (file.size > 8 * 1024 * 1024) throw new Error('That PDF is over 8 MB. Upload a smaller file or a screenshot instead.');
      state.receipt = { name: file.name, data: await toBase64(file), size: file.size, preview: null, isPdf: true };
    } else if (isImage) {
      const blob = await shrinkImage(file);
      state.receipt = { name: file.name, data: await toBase64(blob), size: blob.size, preview: URL.createObjectURL(blob), isPdf: false };
    } else {
      throw new Error('Upload a JPG, PNG or WebP screenshot, or a PDF.');
    }
  } catch (err) {
    state.receipt = null;
    showFormError(err.message);
  }
  showReceipt();
}

function showReceipt() {
  const r = state.receipt;
  $('#dropEmpty').hidden = !!r;
  $('#dropFilled').hidden = !r;
  $('#drop').classList.toggle('is-filled', !!r);
  if (!r) return;
  $('#receiptThumb').replaceChildren(r.isPdf ? h('span', { class: 'pdf-badge', text: 'PDF' }) : h('img', { src: r.preview, alt: 'Receipt preview' }));
  $('#receiptName').textContent = r.name;
  $('#receiptSize').textContent = fileSize(r.size);
}

/** Resize big phone screenshots so uploads stay fast on mobile data. */
async function shrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, hgt);
    ctx.drawImage(img, 0, 0, w, hgt);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (!blob) throw new Error('encode failed');
    return blob;
  } catch {
    throw new Error("That image couldn't be opened. Upload a JPG or PNG screenshot instead.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error("That file couldn't be read. Try again."));
    reader.readAsDataURL(blob);
  });
}

/* ---------------------------------------------------------------- status */

function openStatus() {
  const saved = storageGet(SAVED_KEY);
  if (saved && !$('#statusCode').value) {
    $('#statusCode').value = saved.code;
    $('#statusEmail').value = saved.email || '';
  }
  $('#statusResult').replaceChildren();
  $('#statusError').hidden = true;
  statusDialog.showModal();
  ($('#statusCode').value ? $('#statusSubmit') : $('#statusCode')).focus();
}

async function onStatusSubmit(e) {
  e.preventDefault();
  const err = $('#statusError');
  err.hidden = true;
  for (const el of [$('#statusCode'), $('#statusEmail')]) {
    if (!el.checkValidity()) { el.reportValidity(); return; }
  }
  const btn = $('#statusSubmit');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const r = await api('/api/status', { method: 'POST', body: { code: $('#statusCode').value, email: $('#statusEmail').value } });
    const s = state.event ? state.event.settings : { currency: '' };
    const stampClass = r.status === 'approved' ? ' is-approved' : r.status === 'rejected' ? ' is-rejected' : '';
    const message = {
      pending: 'Your slot is held. The organizer still needs to check your payment receipt.',
      approved: 'Your slot is confirmed. Arrive 15 minutes early for the briefing.',
      rejected: 'The organizer could not confirm this registration. Contact them using the details on this page.',
    }[r.status];
    $('#statusResult').replaceChildren(h('div', { class: 'status-result' },
      h('div', { class: 'row' }, h('strong', { text: r.groupName }), h('span', { class: `stamp${stampClass}`, text: STATUS_LABEL[r.status] })),
      h('p', { class: 'small muted', text: message }),
      h('dl', { class: 'summary' },
        h('dt', { text: 'Code' }), h('dd', { class: 'mono', text: r.code }),
        h('dt', { text: 'Time slot' }), h('dd', { text: r.slot ? `${dateLong(r.slot.date)}, ${slotRange(r.slot.start, r.slot.end)}` : 'The organizer will contact you about a new slot.' }),
        h('dt', { text: 'Players' }), h('dd', { text: String(r.players) }),
        h('dt', { text: 'Amount' }), h('dd', { text: money(s.currency, r.amount) })),
      r.adminNote ? h('div', { class: 'note-box' }, h('strong', { text: 'Note from the organizer' }), h('br'), r.adminNote) : null));
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check status';
  }
}

/* ----------------------------------------------------------------- cover */

/** Draws the combination-dial cover art. The dial spins into place once on load. */
function buildCover() {
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs, parent) => {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.append(el);
    return el;
  };
  const cx = 228;
  const cy = 158;
  const svgEl = s('svg', { viewBox: '0 0 400 400', class: 'cover-art', 'aria-hidden': 'true', focusable: 'false', preserveAspectRatio: 'xMidYMid slice' });
  const defs = s('defs', {}, svgEl);
  const bg = s('radialGradient', { id: 'cvBg', cx: '0.6', cy: '0.38', r: '0.8' }, defs);
  s('stop', { offset: '0', 'stop-color': '#174247' }, bg);
  s('stop', { offset: '0.55', 'stop-color': '#0b2528' }, bg);
  s('stop', { offset: '1', 'stop-color': '#051114' }, bg);
  const brass = s('linearGradient', { id: 'cvBrass', x1: '0', y1: '0', x2: '1', y2: '1' }, defs);
  s('stop', { offset: '0', 'stop-color': '#f2cf86' }, brass);
  s('stop', { offset: '0.5', 'stop-color': '#c48f35' }, brass);
  s('stop', { offset: '1', 'stop-color': '#7d5517' }, brass);
  const knob = s('radialGradient', { id: 'cvKnob', cx: '0.4', cy: '0.35', r: '0.75' }, defs);
  s('stop', { offset: '0', 'stop-color': '#2b5e63' }, knob);
  s('stop', { offset: '1', 'stop-color': '#0c2a2d' }, knob);
  const fade = s('linearGradient', { id: 'cvFade', x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
  s('stop', { offset: '0.45', 'stop-color': '#051114', 'stop-opacity': '0' }, fade);
  s('stop', { offset: '1', 'stop-color': '#051114', 'stop-opacity': '0.92' }, fade);

  s('rect', { width: 400, height: 400, fill: 'url(#cvBg)' }, svgEl);
  // vault-door rivets around the edge
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    s('circle', { cx: cx + Math.cos(a) * 168, cy: cy + Math.sin(a) * 168, r: 3.2, fill: '#c48f35', opacity: 0.35 }, svgEl);
  }
  s('circle', { cx, cy, r: 150, fill: 'none', stroke: '#c48f35', 'stroke-opacity': 0.18, 'stroke-width': 1 }, svgEl);
  s('circle', { cx, cy, r: 124, fill: 'url(#cvBrass)' }, svgEl);
  s('circle', { cx, cy, r: 118, fill: '#0a2023' }, svgEl);

  const dial = s('g', { class: 'dial' }, svgEl);
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2 - Math.PI / 2;
    const long = i % 5 === 0;
    const r1 = 114;
    const r2 = long ? 96 : 104;
    s('line', {
      x1: cx + Math.cos(a) * r1, y1: cy + Math.sin(a) * r1, x2: cx + Math.cos(a) * r2, y2: cy + Math.sin(a) * r2,
      stroke: '#e2b05a', 'stroke-width': long ? 3 : 1.4, 'stroke-linecap': 'round', opacity: long ? 1 : 0.7,
    }, dial);
  }
  [0, 10, 20, 30].forEach((n, i) => {
    const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
    const t = s('text', {
      x: cx + Math.cos(a) * 82, y: cy + Math.sin(a) * 82 + 6, 'text-anchor': 'middle',
      fill: '#f3ddb0', 'font-family': 'JetBrains Mono, Consolas, monospace', 'font-size': 16, 'font-weight': 700,
    }, dial);
    t.textContent = String(n);
  });
  s('circle', { cx, cy, r: 58, fill: 'url(#cvKnob)', stroke: '#c48f35', 'stroke-width': 2 }, dial);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    s('line', { x1: cx + Math.cos(a) * 46, y1: cy + Math.sin(a) * 46, x2: cx + Math.cos(a) * 56, y2: cy + Math.sin(a) * 56, stroke: '#c48f35', 'stroke-opacity': 0.45, 'stroke-width': 2 }, dial);
  }
  s('circle', { cx, cy, r: 12, fill: 'url(#cvBrass)' }, dial);
  // fixed pointer above the dial
  s('path', { d: `M${cx - 9} ${cy - 138} L${cx + 9} ${cy - 138} L${cx} ${cy - 122} Z`, fill: '#f2cf86' }, svgEl);
  s('rect', { width: 400, height: 400, fill: 'url(#cvFade)' }, svgEl);
  $('#coverArt').append(svgEl);
}
