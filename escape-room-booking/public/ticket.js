'use strict';
/* Ticket page: QR when approved, status otherwise, plus who's in the room. */

const token = location.pathname.split('/')[2];
let T = null;
let receipt;

init();

async function init() {
  receipt = attachReceiptPicker($('#drop'), showReError);
  $('#shareBtn').addEventListener('click', share);
  $('#copyBtn').addEventListener('click', async () => {
    const ok = await copyText(location.href);
    toast(ok ? 'Link copied. Send it to your group.' : 'Copy the link from the address bar.');
  });
  $('#reupload').addEventListener('submit', onReupload);
  await load();
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
}

async function load() {
  try {
    T = await api(`/api/ticket/${encodeURIComponent(token)}`);
    try { localStorage.setItem('escape-room:booking', JSON.stringify({ token, code: T.code })); } catch { /* private mode */ }
    render();
  } catch (err) {
    $('#ticket').hidden = true;
    $('#loadError').hidden = false;
    $('#loadError').textContent = err.message;
  }
}

function render() {
  const e = T.event;
  document.title = `${T.room ? T.room.name : 'Ticket'} · ${T.label}`;
  $('#brandName').textContent = e.hostName;
  $('#loadError').hidden = true;
  $('#ticket').hidden = false;
  $('#tEvent').textContent = e.eventName;
  $('#tRoom').textContent = T.room ? T.room.name : 'Room to be confirmed';
  $('#tLocks').replaceChildren(T.room ? locks(T.room.difficulty) : '');
  const when = [e.eventDate ? dateLong(e.eventDate) : 'Date to be announced'];
  if (T.slot) when.push(slotRange(T.slot.start, T.slot.end));
  $('#tWhen').textContent = when.join(' · ');
  $('#tType').textContent = `${TYPE_INFO[T.type].label} · ${plural(T.players.length, 'player')}`;
  $('#tTeam').textContent = T.label;

  $('#tApproved').hidden = T.payment !== 'approved';
  $('#tPending').hidden = T.payment !== 'pending';
  $('#tRejected').hidden = T.payment !== 'rejected';
  if (T.payment === 'approved') {
    const src = `/t/${encodeURIComponent(token)}/qr.svg`;
    if ($('#tQr').getAttribute('src') !== src) $('#tQr').src = src;
    $('#tCode').textContent = T.code;
  }
  $('#tReason').hidden = !T.rejectReason;
  $('#tReason').textContent = T.rejectReason ? `From the organizers: ${T.rejectReason}` : '';
  $('#tActions').hidden = T.payment === 'rejected';

  $('#tPlayers').replaceChildren(...T.players.map((p, i) => h('li', { class: p.checkedIn ? 'is-in' : '' },
    h('span', { text: `${p.name}${i === 0 ? ' (leader)' : ''}` }),
    h('span', { class: p.checkedIn ? 'pill pill-approved' : 'small faint', text: p.checkedIn ? 'Checked in' : 'Not checked in' }))));

  renderRoommates();

  const rows = [
    ['Booking code', T.code],
    ['Venue', [e.venue, e.venueAddress].filter(Boolean).join(', ')],
    ['Amount', money(e.currency, T.amount)],
    ['Reference no.', T.referenceNo],
  ];
  $('#tDetails').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { class: k === 'Booking code' ? 'mono' : null, text: v })]));
  const map = $('#tMap');
  map.hidden = !/^https:\/\//i.test(e.mapUrl || '');
  if (!map.hidden) map.href = e.mapUrl;
  $('#tArrive').textContent = T.slot ? `Arrive by ${timeLabel(addMinutes(T.slot.start, -e.arriveBefore))} for check-in and the briefing.` : 'Arrive 15 minutes early for check-in.';
  $('#tContact').textContent = e.contactInfo ? `Questions? ${e.contactInfo}` : '';
}

function renderRoommates() {
  const box = $('#tRoommates');
  if (T.type !== 'group') {
    box.replaceChildren(h('p', { class: 'muted', text: T.type === 'private' ? 'Nobody else. You booked the whole room.' : 'Just your team. You have the whole room.' }));
    return;
  }
  const items = T.roommates.map((m) => h('li', null,
    h('div', null, h('strong', { text: m.label }), h('span', { class: 'small faint', text: ` · ${plural(m.size, 'player')}` })),
    m.contact ? contactNode(m.contact) : h('span', { class: 'small faint', text: 'No contact shared' })));
  const parts = [];
  if (items.length) parts.push(h('ul', { class: 'mate-list' }, items));
  else parts.push(h('p', { class: 'muted', text: 'No one else has booked your room yet.' }));
  if (T.spotsOpen > 0) parts.push(h('p', { class: 'small faint', text: `${plural(T.spotsOpen, 'spot')} still open. More players may join.` }));
  parts.push(h('p', { class: 'small muted', text: T.myContact ? 'You shared your contact with your roommates.' : "You'll meet everyone at the briefing." }));
  box.replaceChildren(...parts);
}

function addMinutes(hhmm, delta) {
  const [h1, m1] = hhmm.split(':').map(Number);
  const t = h1 * 60 + m1 + delta;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

async function share() {
  const data = { title: `${T.event.eventName} ticket`, text: `Our escape room ticket for ${T.room ? T.room.name : 'the event'}`, url: location.href };
  if (navigator.share) {
    try { await navigator.share(data); return; } catch (err) { if (err && err.name === 'AbortError') return; }
  }
  const ok = await copyText(location.href);
  toast(ok ? 'Link copied. Send it to your group.' : 'Copy the link from the address bar.');
}

function showReError(msg) {
  $('#reError').textContent = msg;
  $('#reError').hidden = !msg;
}

async function onReupload(e) {
  e.preventDefault();
  showReError('');
  if (!receipt.value) { showReError('Upload the new receipt first.'); return; }
  if (!$('#refNo').checkValidity()) { $('#refNo').reportValidity(); return; }
  const btn = $('#reSubmit');
  btn.disabled = true;
  try {
    const r = await api(`/api/ticket/${encodeURIComponent(token)}/receipt`, { method: 'POST', body: { referenceNo: $('#refNo').value, receipt: { name: receipt.value.name, data: receipt.value.data } } });
    T = r.ticket;
    receipt.reset();
    render();
    toast('New receipt sent. We’ll check it soon.');
  } catch (err) {
    showReError(err.message);
  } finally {
    btn.disabled = false;
  }
}
