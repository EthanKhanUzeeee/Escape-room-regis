'use strict';
/* Door scanner: camera → QR → booking with player checkboxes. Search and standby for people without a QR. */

const V = { view: 'scan', stream: null, detector: null, scanning: false, lastText: '', lastAt: 0, openId: null, canvas: document.createElement('canvas') };
const video = $('#video');

STAFF.onData = onData;
STAFF.onSignedOut = showLogin;
bind();
boot();
// refresh in the background, but never while a booking is open (it would undo ticks not yet saved)
setInterval(() => {
  if (!STAFF.data || document.visibilityState !== 'visible' || V.openId || /^(INPUT|SELECT)$/.test((document.activeElement || {}).tagName || '')) return;
  staffCall('/api/staff/data').then(setStaffData).catch(() => {});
}, 20000);

async function boot() {
  try {
    setStaffData(await api('/api/staff/data'));
    showApp();
  } catch (err) {
    showLogin(err.status === 401 ? '' : err.message);
  }
}

function showLogin(message) {
  stopCamera();
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  $('#loginError').textContent = message || '';
  $('#loginError').hidden = !message;
}

function showApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  setView('scan');
}

function bind() {
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#password');
    if (!pw.value) { pw.reportValidity(); return; }
    try {
      await api('/api/staff/login', { method: 'POST', body: { password: pw.value } });
      pw.value = '';
      setStaffData(await api('/api/staff/data'));
      showApp();
    } catch (err) { showLogin(err.message); }
  });
  for (const b of $$('.scan-tabs button')) b.addEventListener('click', () => setView(b.dataset.view));
  $('#searchBox').addEventListener('input', renderResults);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopCamera();
    else if (V.view === 'scan' && $('#sheet').hidden && !$('#appView').hidden) startCamera();
  });
}

function setView(view) {
  V.view = view;
  for (const b of $$('.scan-tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  $('#searchPanel').hidden = view !== 'search';
  $('#standbyPanel').hidden = view !== 'standby';
  closeSheet(false);
  if (view === 'scan') startCamera();
  else stopCamera();
  if (view === 'search') { renderResults(); $('#searchBox').focus(); }
  if (view === 'standby') renderStandby();
}

function onData() {
  const d = STAFF.data;
  const slot = d.now.currentSlotId ? slotOf(d.now.currentSlotId) : null;
  $('#nowLabel').textContent = slot ? `Now ${slotRange(slot.start, slot.end)}` : 'Door scanner';
  $('#nowSub').textContent = slot ? '' : d.now.phase === 'day' ? '' : '· not event day';
  if (V.openId) renderSheet();
  if (V.view === 'search') renderResults();
  if (V.view === 'standby') renderStandby();
}

/* ---------------------------------------------------------------- camera */

async function startCamera() {
  if (V.stream || V.view !== 'scan') return;
  const msg = $('#scanMsg');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    msg.textContent = window.isSecureContext
      ? "This browser can't use the camera. Use Search to find bookings by name."
      : 'Phones only allow the camera on a secure (https) link. Put the app online (see the README), or use Search for now.';
    return;
  }
  try {
    V.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = V.stream;
    await video.play().catch(() => {});
    if ('BarcodeDetector' in window && !V.detector) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) V.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch { V.detector = null; }
    }
    msg.textContent = 'Point the camera at a ticket QR code';
    V.scanning = true;
    loop();
  } catch (err) {
    V.stream = null;
    msg.textContent = err && err.name === 'NotAllowedError'
      ? 'Camera access was blocked. Allow the camera for this site in your browser settings, or use Search.'
      : "Couldn't start the camera. Use Search to find bookings by name.";
  }
}

function stopCamera() {
  V.scanning = false;
  if (V.stream) for (const t of V.stream.getTracks()) t.stop();
  V.stream = null;
  video.srcObject = null;
}

async function loop() {
  if (!V.scanning) return;
  try {
    const text = await decodeFrame();
    if (text) onScan(text);
  } catch { /* try the next frame */ }
  if (V.scanning) setTimeout(() => requestAnimationFrame(loop), 120);
}

async function decodeFrame() {
  if (video.readyState < 2 || !video.videoWidth) return null;
  if (V.detector) {
    const codes = await V.detector.detect(video);
    return codes.length ? codes[0].rawValue : null;
  }
  const decode = typeof window.jsQR === 'function' ? window.jsQR : window.jsQR && window.jsQR.default;
  if (typeof decode !== 'function') return null;
  const scale = Math.min(1, 640 / video.videoWidth);
  const w = Math.round(video.videoWidth * scale);
  const hgt = Math.round(video.videoHeight * scale);
  const c = V.canvas;
  c.width = w;
  c.height = hgt;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, hgt);
  const img = ctx.getImageData(0, 0, w, hgt);
  const code = decode(img.data, w, hgt, { inversionAttempts: 'dontInvert' });
  return code ? code.data : null;
}

async function onScan(text) {
  const now = Date.now();
  if (text === V.lastText && now - V.lastAt < 2500) return;
  V.lastText = text;
  V.lastAt = now;
  const m = String(text).match(/\/t\/([A-Za-z0-9_-]{20,40})/) || String(text).match(/^([A-Za-z0-9_-]{20,40})$/);
  if (!m) {
    $('#scanMsg').textContent = "That QR code isn't a ticket for this event.";
    if (navigator.vibrate) navigator.vibrate([60, 60, 60]);
    return;
  }
  V.scanning = false;
  try {
    const r = await staffCall(`/api/staff/by-token/${encodeURIComponent(m[1])}`);
    const i = STAFF.data.bookings.findIndex((b) => b.id === r.booking.id);
    if (i >= 0) STAFF.data.bookings[i] = r.booking;
    else STAFF.data.bookings.push(r.booking);
    if (navigator.vibrate) navigator.vibrate(60);
    openSheet(r.booking.id);
  } catch (err) {
    $('#scanMsg').textContent = err.status === 404 ? 'No booking matches this ticket. Search by name instead.' : err.message;
    V.scanning = true;
    loop();
  }
}

/* ----------------------------------------------------------------- sheet */

function openSheet(id) {
  V.openId = id;
  renderSheet();
  $('#sheet').hidden = false;
}

function closeSheet(resume = true) {
  V.openId = null;
  $('#sheet').hidden = true;
  $('#sheet').replaceChildren();
  if (resume && V.view === 'scan') {
    $('#scanMsg').textContent = 'Point the camera at a ticket QR code';
    if (V.stream) { V.scanning = true; loop(); } else startCamera();
  }
}

function renderSheet() {
  const b = bookingOf(V.openId);
  if (!b) { closeSheet(); return; }
  $('#sheet').replaceChildren(
    verdictFor(b),
    checkinCard(b, { showWhen: true }),
    h('button', { type: 'button', class: 'btn btn-block', text: V.view === 'scan' ? 'Scan next ticket' : 'Back', onclick: () => closeSheet(true) }));
}

/* ---------------------------------------------------------------- search */

function renderResults() {
  const q = $('#searchBox').value.trim().toLowerCase();
  const box = $('#results');
  if (!q) {
    const cur = STAFF.data.now.currentSlotId;
    const list = cur ? STAFF.data.bookings.filter((b) => b.slotId === cur && b.payment !== 'rejected') : [];
    box.replaceChildren(list.length ? h('p', { class: 'small muted', text: 'Booked for the current time:' }) : h('p', { class: 'small muted', text: 'Type at least two letters.' }), ...list.map(resultItem));
    return;
  }
  if (q.length < 2) { box.replaceChildren(h('p', { class: 'small muted', text: 'Type at least two letters.' })); return; }
  const hits = STAFF.data.bookings.filter((b) => [b.label, b.teamName, b.code, b.leaderName, ...b.players.map((p) => p.name)].join(' ').toLowerCase().includes(q)).slice(0, 30);
  box.replaceChildren(...(hits.length ? hits.map(resultItem) : [h('p', { class: 'small muted', text: 'No bookings match.' })]));
}

function resultItem(b) {
  const inN = b.players.filter((p) => p.inAt).length;
  return h('button', { type: 'button', class: 'result', onclick: () => openSheet(b.id) },
    h('strong', { text: b.label }),
    h('span', { class: 'small muted', text: `${whenLabel(b.slotId, b.roomId)} · ${inN}/${b.players.length} in · ${PAY_LABEL[b.payment]}` }),
    h('span', { class: 'small faint', text: b.players.map((p) => p.name).join(', ') }));
}

/* --------------------------------------------------------------- standby */

function renderStandby() {
  const spots = openSpotsNow();
  $('#spots').replaceChildren(...(spots.length
    ? spots.map((o) => h('span', { class: 'open-spot', text: `${timeLabel(o.slot.start)} · ${o.room.name} · ${o.free} open` }))
    : [h('p', { class: 'small muted', text: 'No open spots right now.' })]));
  const waiting = STAFF.data.walkins.filter((w) => w.status === 'waiting' || w.status === 'alerted');
  $('#waiting').replaceChildren(...(waiting.length ? waiting.map((w, i) => {
    const fits = spots.filter((o) => o.free >= w.size);
    const sel = h('select', { 'aria-label': `Spot for ${w.name}` }, fits.length ? fits.map((o) => h('option', { value: `${o.slot.id}|${o.room.id}`, text: `${timeLabel(o.slot.start)} · ${o.room.name}` })) : [h('option', { value: '', text: 'No spot fits yet' })]);
    sel.disabled = !fits.length;
    const pick = () => { const [slotId, roomId] = sel.value.split('|'); return { slotId, roomId }; };
    const act = async (action) => {
      try {
        setStaffData(await staffCall(`/api/staff/walkins/${w.id}/${action}`, { method: 'POST', body: pick() }));
        toast(action === 'place' ? `${w.name} got a spot` : w.email ? `Alert emailed to ${w.name}` : `${w.name} marked as alerted`);
      } catch (err) { toast(err.message, 'bad'); }
    };
    return h('article', { class: 'wl' },
      h('header', null, h('strong', { text: `#${i + 1} ${w.name}` }), h('span', { class: `pill ${w.status === 'alerted' ? 'pill-alerted' : 'pill-waiting'}`, text: w.status === 'alerted' ? `Alerted ${inTime(w.alertedAt)}` : plural(w.size, 'player') })),
      h('div', { class: 'wl-actions' }, sel,
        h('button', { type: 'button', class: 'btn btn-small', disabled: !fits.length, text: 'Alert', onclick: () => act('alert') }),
        h('button', { type: 'button', class: 'btn btn-small btn-primary', disabled: !fits.length, text: 'Give spot', onclick: () => act('place') })),
      callText(w.phone, fits[0] ? standbyMessage(fits[0].slot, fits[0].room) : ''));
  }) : [h('p', { class: 'small muted', text: 'Nobody on standby.' })]));
}
