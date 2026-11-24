'use strict';
/* Pieces shared by the staff dashboard and the door scanner. */

const STAFF = { data: null, onData: null, onSignedOut: null };
const PAY_LABEL = { pending: 'To review', approved: 'Paid', rejected: 'Rejected' };

function setStaffData(d) {
  STAFF.data = d;
  if (STAFF.onData) STAFF.onData(d);
}

async function staffCall(path, opts) {
  try {
    return await api(path, opts);
  } catch (err) {
    if (err.status === 401 && STAFF.onSignedOut) STAFF.onSignedOut('Your session ended. Sign in again.');
    throw err;
  }
}

const slotOf = (id) => STAFF.data.slots.find((s) => s.id === id);
const roomOf = (id) => STAFF.data.rooms.find((r) => r.id === id);
const bookingOf = (id) => STAFF.data.bookings.find((b) => b.id === id);
const staffMoney = (n) => money(STAFF.data.settings.currency, n);

function payPill(p) {
  return h('span', { class: `pill ${p === 'approved' ? 'pill-approved' : p === 'pending' ? 'pill-pending' : 'pill-rejected'}`, text: PAY_LABEL[p] });
}

function telDigits(phone) {
  return String(phone || '').replace(/[^0-9+]/g, '');
}

/** Call and Text buttons. They open the staff member's own phone app. */
function callText(phone, message) {
  return h('span', { class: 'contact-row' },
    h('a', { class: 'btn btn-small', href: `tel:${telDigits(phone)}`, text: 'Call' }),
    h('a', { class: 'btn btn-small', href: `sms:${telDigits(phone)}?&body=${encodeURIComponent(message || '')}`, text: 'Text' }),
    h('span', { class: 'small mono faint', text: phone }));
}

function whenLabel(slotId, roomId) {
  const s = slotOf(slotId);
  const r = roomOf(roomId);
  return `${s ? slotRange(s.start, s.end) : 'Removed time'} · ${r ? r.name : 'Removed room'}`;
}

function inTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

async function approvePayment(b) {
  const d = await staffCall(`/api/staff/bookings/${b.id}/payment`, { method: 'POST', body: { status: 'approved' } });
  setStaffData(d);
  toast(`Payment approved. The QR ticket was emailed to ${b.email}.`);
}

/**
 * One booking with a checkbox per player, as used in the room view, the booking view and the scanner.
 * Players already checked in stay ticked; untick to undo.
 */
function checkinCard(b, { showWhen = true } = {}) {
  const data = STAFF.data;
  const slot = slotOf(b.slotId);
  const nowId = data.now.currentSlotId;
  const paid = b.payment === 'approved';
  const boxes = b.players.map((p, i) => {
    const input = h('input', { type: 'checkbox', 'data-player': p.id });
    input.checked = !!p.inAt;
    input.disabled = !paid;
    return h('li', null, h('label', null, input,
      h('span', { text: `${p.name}${i === 0 ? ' (leader)' : ''}` }),
      h('span', { class: 'when', text: p.inAt ? `in ${inTime(p.inAt)}` : '' })));
  });
  const list = h('ul', { class: 'check-list' }, boxes);
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', disabled: !paid, text: 'Save check-in' });
  const updateBtn = () => {
    const ins = $$('input', list).filter((x) => x.checked && !b.players.find((p) => p.id === x.dataset.player).inAt).length;
    const outs = $$('input', list).filter((x) => !x.checked && b.players.find((p) => p.id === x.dataset.player).inAt).length;
    saveBtn.disabled = !paid || (!ins && !outs);
    saveBtn.textContent = ins && !outs ? `Check in ${plural(ins, 'player')}` : outs && !ins ? `Undo ${plural(outs, 'check-in')}` : ins || outs ? 'Save check-in' : `${b.players.filter((p) => p.inAt).length} of ${b.players.length} checked in`;
  };
  list.addEventListener('change', updateBtn);
  saveBtn.addEventListener('click', async () => {
    const ins = [];
    const outs = [];
    for (const x of $$('input', list)) {
      const p = b.players.find((pp) => pp.id === x.dataset.player);
      if (x.checked && !p.inAt) ins.push(p.id);
      if (!x.checked && p.inAt) outs.push(p.id);
    }
    saveBtn.disabled = true;
    try {
      const r = await staffCall(`/api/staff/bookings/${b.id}/checkin`, { method: 'POST', body: { in: ins, out: outs } });
      setStaffData(r.data);
      if (ins.length) toast(`Checked in ${plural(ins.length, 'player')} from ${r.booking.label}`);
      else toast('Check-in updated');
      if (navigator.vibrate) navigator.vibrate(40);
    } catch (err) {
      toast(err.message, 'bad');
      saveBtn.disabled = false;
    }
  });
  updateBtn();

  const missing = b.players.filter((p) => !p.inAt).length;
  const msg = slot ? `Hi ${b.leaderName}, this is ${data.settings.eventName}. ${roomOf(b.roomId) ? roomOf(b.roomId).name : 'Your room'} starts at ${timeLabel(slot.start)} and ${missing} of your players haven't checked in. Please come to the desk now.` : '';

  const parts = [
    h('header', null,
      h('div', null, h('strong', { text: b.label }), h('span', { class: 'small faint', text: ` · ${TYPE_INFO[b.type].label} · ${b.code}` })),
      payPill(b.payment)),
  ];
  if (showWhen) {
    const wrongTime = nowId && b.slotId !== nowId;
    parts.push(h('p', { class: wrongTime ? 'small strong' : 'small muted', text: `${whenLabel(b.slotId, b.roomId)}${wrongTime ? ' · not the current time slot' : ''}` }));
  }
  if (!paid) {
    parts.push(h('div', { class: 'contact-row' },
      h('span', { class: 'small', text: b.payment === 'rejected' ? 'Payment was rejected.' : 'Payment not approved yet.' }),
      h('a', { class: 'btn btn-small', href: `/staff/receipt/${b.id}`, target: '_blank', rel: 'noopener', text: 'View receipt' }),
      h('button', {
        type: 'button', class: 'btn btn-small btn-ok', text: 'Approve payment',
        onclick: async (e) => { e.target.disabled = true; try { await approvePayment(b); } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; } },
      })));
  }
  parts.push(list, saveBtn);
  parts.push(h('div', { class: 'contact-row' }, h('span', { class: 'small muted', text: `Leader: ${b.leaderName}` }), callText(b.phone, msg)));
  if (b.contact) parts.push(h('div', { class: 'contact-row' }, h('span', { class: 'small muted', text: 'Shared with roommates:' }), contactNode(b.contact)));
  return h('section', { class: 'roster-item' }, parts);
}

/** Spots a walk-in could take right now: rooms where check-in has closed, plus unbooked spots in the current and next time slot. */
function openSpotsNow() {
  const d = STAFF.data;
  const ids = d.slots.map((s) => s.id);
  const cur = d.now.currentSlotId ? ids.indexOf(d.now.currentSlotId) : -1;
  const near = new Set(cur >= 0 ? ids.slice(cur, cur + 2) : []);
  const out = [];
  for (const s of d.slots) {
    for (const r of d.rooms) {
      const st = s.rooms[r.id];
      if (st.doorFree > 0 && (st.released || near.has(s.id))) out.push({ slot: s, room: r, free: st.doorFree, released: st.released });
    }
  }
  return out;
}

function standbyMessage(slot, room) {
  return `Hi! A spot just opened in ${room.name} at ${timeLabel(slot.start)}. Please come to the check-in desk now to take it.`;
}
