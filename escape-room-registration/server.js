'use strict';
/*
 * Escape room registration server.
 * No dependencies: run `node server.js` (Node 18 or newer).
 * Everything is saved in ./data: db.json for registrations and settings, receipts/ for payment proofs.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const RECEIPT_DIR = path.join(DATA_DIR, 'receipts');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PASSWORD_FILE = path.join(DATA_DIR, 'ADMIN-PASSWORD.txt');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 14 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const SESSION_MS = 12 * 60 * 60 * 1000;

fs.mkdirSync(RECEIPT_DIR, { recursive: true });

/* ------------------------------------------------------------------ helpers */

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fromMinutes = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const newId = () => crypto.randomBytes(8).toString('hex');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[0-9+()\-\s]{7,30}$/;
const ID_RE = '([a-f0-9]{16})';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function randomString(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** Clean a text field: trim, drop control characters, enforce length and presence. */
function text(value, max, { required = false, label = 'This field', multiline = false } = {}) {
  let s = value == null ? '' : String(value);
  s = s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  s = multiline ? s.replace(/[ \t]+\n/g, '\n').trim() : s.replace(/\s+/g, ' ').trim();
  if (required && !s) throw httpError(400, `${label} is required.`);
  if (s.length > max) throw httpError(400, `${label} is too long (max ${max} characters).`);
  return s;
}

function intIn(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

/* -------------------------------------------------------------------- store */

const DEFAULT_SETTINGS = {
  configured: false,
  eventName: 'Escape Room Challenge',
  tagline: 'Your team has 60 minutes to find the clues, crack the locks and get out.',
  hostName: 'Your Organization',
  contactInfo: 'Add how people can reach you (Facebook page, mobile number or email) in Event settings.',
  venue: 'Venue to be announced',
  venueAddress: '',
  mapUrl: '',
  description: [
    'Gather your team and pick a one-hour time slot. Inside the room you will search for clues, solve puzzles and open locks before the timer runs out.',
    '',
    'House rules',
    '- Arrive 15 minutes before your slot for the briefing. Late groups lose playing time.',
    '- Every player in the group must be listed when you register.',
    '- Phones and bags stay outside the room.',
    '- Never force a lock or move heavy furniture. Every puzzle can be solved without strength.',
    '',
    'Your slot is confirmed once the organizer checks your payment receipt. Use your registration code to check your status at any time.',
  ].join('\n'),
  currency: '₱',
  price: 300,
  priceMode: 'group',
  paymentInstructions: 'Send the registration fee by GCash to 09XX XXX XXXX (Account Name).\nTake a screenshot of the successful transfer and upload it below.',
  minPlayers: 2,
  maxPlayers: 6,
  registrationOpen: true,
};

function makeSlot(date, start, end, capacity) {
  return { id: newId(), date, start, end, capacity };
}

function defaultDb() {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  const date = localDate(d);
  const slots = [];
  for (let h = 9; h < 17; h++) slots.push(makeSlot(date, fromMinutes(h * 60), fromMinutes((h + 1) * 60), 1));
  return { settings: { ...DEFAULT_SETTINGS }, slots, registrations: [], admin: null };
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) return defaultDb();
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return {
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    slots: Array.isArray(raw.slots) ? raw.slots : [],
    registrations: Array.isArray(raw.registrations) ? raw.registrations : [],
    admin: raw.admin || null,
  };
}

let db = loadDb();

function saveDb() {
  const json = JSON.stringify(db, null, 2);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, json);
  try {
    fs.renameSync(tmp, DB_FILE);
  } catch {
    // Windows can refuse the rename while another program (antivirus, backup) has the file open.
    fs.writeFileSync(DB_FILE, json);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/* -------------------------------------------------------------------- admin */

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') };
}

function checkPassword(pw) {
  if (!db.admin) return false;
  const attempt = crypto.scryptSync(String(pw), db.admin.salt, 32);
  return crypto.timingSafeEqual(attempt, Buffer.from(db.admin.hash, 'hex'));
}

function writePasswordFile(pw) {
  fs.writeFileSync(PASSWORD_FILE, `Organizer password: ${pw}\n\nSign in at http://localhost:${PORT}/admin. When you set your own password under Event settings, this file is deleted.\n`);
}

if (process.env.ADMIN_PASSWORD) {
  db.admin = hashPassword(process.env.ADMIN_PASSWORD);
} else if (!db.admin) {
  const pw = `${randomString(4)}-${randomString(4)}-${randomString(4)}`.toLowerCase();
  db.admin = hashPassword(pw);
  writePasswordFile(pw);
}
saveDb();

const sessions = new Map(); // token -> expiry timestamp
const loginFailures = new Map(); // ip -> { count, since }

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAdmin(req) {
  const token = parseCookies(req).escape_admin;
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function tooManyFailures(ip) {
  const f = loginFailures.get(ip);
  if (!f) return false;
  if (Date.now() - f.since > 10 * 60 * 1000) { loginFailures.delete(ip); return false; }
  return f.count >= 10;
}

function noteFailure(ip) {
  const f = loginFailures.get(ip);
  if (!f || Date.now() - f.since > 10 * 60 * 1000) loginFailures.set(ip, { count: 1, since: Date.now() });
  else f.count++;
}

/* -------------------------------------------------------------------- views */

function sortedSlots() {
  return [...db.slots].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

function activeCount(slotId, excludeId) {
  return db.registrations.filter((r) => r.slotId === slotId && r.status !== 'rejected' && r.id !== excludeId).length;
}

function slotView(s) {
  const taken = activeCount(s.id);
  return { id: s.id, date: s.date, start: s.start, end: s.end, capacity: s.capacity, taken, left: Math.max(0, s.capacity - taken) };
}

function publicEvent() {
  const { configured, ...settings } = db.settings;
  return {
    settings,
    slots: sortedSlots().map(slotView),
    groups: db.registrations.filter((r) => r.status !== 'rejected').length,
  };
}

function shareUrls() {
  const urls = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    // skip adapters made by VirtualBox, VMware, WSL, Docker and similar: other devices can't reach them
    if (/virtual|vbox|vmware|vethernet|wsl|hyper-v|docker|loopback|tailscale|zerotier/i.test(name)) continue;
    for (const a of list || []) {
      // VirtualBox, VMware, Hyper-V and Docker hardware-address prefixes (adapter names alone can look like "Ethernet")
      if (/^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:1c:14|00:15:5d|02:42)/i.test(a.mac || '')) continue;
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
    }
  }
  return urls;
}

function adminData() {
  return {
    settings: db.settings,
    slots: sortedSlots().map(slotView),
    registrations: [...db.registrations].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    networkUrls: shareUrls(),
    passwordFileExists: fs.existsSync(PASSWORD_FILE),
  };
}

function amountFor(players) {
  const s = db.settings;
  return s.priceMode === 'player' ? s.price * players : s.price;
}

/* ------------------------------------------------------------------- bodies */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY_BYTES) {
      req.resume();
      reject(httpError(413, 'That upload is too large. Use a receipt file under 8 MB.'));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => (tooBig ? reject(httpError(413, 'That upload is too large. Use a receipt file under 8 MB.')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').includes('application/json')) throw httpError(415, 'Expected a JSON request.');
  const buf = await readBody(req);
  try {
    const value = JSON.parse(buf.toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw httpError(400, 'The request could not be read.');
  }
}

function sniffFile(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' };
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  if (b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return { ext: 'pdf', type: 'application/pdf' };
  return null;
}

function decodeReceipt(r) {
  if (!r || typeof r.data !== 'string' || !r.data) throw httpError(400, 'Upload a screenshot or PDF of your payment receipt.');
  const buf = Buffer.from(r.data, 'base64');
  if (!buf.length) throw httpError(400, 'The receipt file is empty. Upload it again.');
  if (buf.length > MAX_RECEIPT_BYTES) throw httpError(413, 'The receipt file is over 8 MB. Upload a smaller screenshot.');
  const kind = sniffFile(buf);
  if (!kind) throw httpError(400, 'The receipt must be a JPG, PNG or WebP image, or a PDF.');
  return { buf, ...kind, originalName: text(r.name, 200, { label: 'File name' }) };
}

/* ----------------------------------------------------------------- handlers */

async function handleRegister(req, res) {
  const b = await readJson(req);
  const s = db.settings;
  if (!s.registrationOpen) throw httpError(403, 'Registration is closed.');

  const slot = db.slots.find((x) => x.id === b.slotId);
  if (!slot) throw httpError(400, 'Pick a time slot first.', 'no_slot');

  const groupName = text(b.groupName, 60, { required: true, label: 'Group name' });
  const leaderName = text(b.leaderName, 80, { required: true, label: "Group leader's name" });
  const email = text(b.email, 120, { required: true, label: 'Email' }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address.');
  const phone = text(b.phone, 30, { required: true, label: 'Mobile number' });
  if (!PHONE_RE.test(phone)) throw httpError(400, 'Enter a valid mobile number.');
  const school = text(b.school, 100, { label: 'School / organization' });
  const players = Number(b.players);
  if (!Number.isInteger(players) || players < s.minPlayers || players > s.maxPlayers) {
    throw httpError(400, `Groups need ${s.minPlayers} to ${s.maxPlayers} players.`);
  }
  const given = Array.isArray(b.members) ? b.members : [];
  const members = [];
  for (let i = 0; i < players - 1; i++) members.push(text(given[i], 80, { required: true, label: `Player ${i + 2}'s name` }));
  const referenceNo = text(b.referenceNo, 60, { required: true, label: 'Reference number' });
  const notes = text(b.notes, 500, { label: 'Notes', multiline: true });
  const receipt = decodeReceipt(b.receipt);

  // Everything below runs synchronously, so two people can't both take the last spot.
  const nameKey = groupName.toLowerCase();
  if (db.registrations.some((r) => r.status !== 'rejected' && r.groupName.toLowerCase() === nameKey)) {
    throw httpError(409, 'Another group already registered with that name. Pick a different group name.', 'name_taken');
  }
  if (activeCount(slot.id) >= slot.capacity) {
    throw httpError(409, 'That time slot just filled up. Pick another slot.', 'slot_full');
  }

  let code;
  do code = `ESC-${randomString(5)}`; while (db.registrations.some((r) => r.code === code));
  const id = newId();
  const receiptFile = `${id}.${receipt.ext}`;
  fs.writeFileSync(path.join(RECEIPT_DIR, receiptFile), receipt.buf);

  const now = new Date().toISOString();
  const reg = {
    id, code, slotId: slot.id, groupName, leaderName, email, phone, school, players, members,
    amount: amountFor(players), referenceNo, notes,
    receiptFile, receiptType: receipt.type, receiptName: receipt.originalName,
    status: 'pending', adminNote: '', createdAt: now, updatedAt: now,
  };
  db.registrations.push(reg);
  saveDb();
  console.log(`New registration: ${groupName} (${code}) for ${slot.date} ${slot.start}`);
  json(res, 201, { code, status: reg.status, groupName, players, amount: reg.amount, slot: slotView(slot) });
}

async function handleStatus(req, res) {
  const b = await readJson(req);
  const code = text(b.code, 20, { required: true, label: 'Registration code' }).toUpperCase().replace(/\s/g, '');
  const email = text(b.email, 120, { required: true, label: 'Email' }).toLowerCase();
  const normalized = code.startsWith('ESC-') ? code : `ESC-${code.replace(/^ESC/, '')}`;
  const reg = db.registrations.find((r) => r.code === normalized && r.email === email);
  if (!reg) throw httpError(404, 'No registration matches that code and email. Check both and try again.');
  const slot = db.slots.find((s) => s.id === reg.slotId);
  json(res, 200, {
    code: reg.code, groupName: reg.groupName, status: reg.status, adminNote: reg.adminNote,
    players: reg.players, amount: reg.amount, slot: slot ? slotView(slot) : null,
  });
}

async function handleLogin(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (tooManyFailures(ip)) throw httpError(429, 'Too many wrong passwords. Wait 10 minutes and try again.');
  const b = await readJson(req);
  if (!checkPassword(b.password || '')) {
    noteFailure(ip);
    throw httpError(401, 'That password is not right.');
  }
  loginFailures.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `escape_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
  json(res, 200, { ok: true });
}

function handleLogout(req, res) {
  sessions.delete(parseCookies(req).escape_admin);
  res.setHeader('Set-Cookie', 'escape_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  json(res, 200, { ok: true });
}

async function updateRegistration(req, res, id) {
  const reg = db.registrations.find((r) => r.id === id);
  if (!reg) throw httpError(404, 'That registration no longer exists.');
  const b = await readJson(req);
  const nextStatus = b.status === undefined ? reg.status : b.status;
  if (!['pending', 'approved', 'rejected'].includes(nextStatus)) throw httpError(400, 'Unknown status.');
  const nextSlotId = b.slotId === undefined ? reg.slotId : b.slotId;
  const slot = db.slots.find((s) => s.id === nextSlotId);
  if (b.slotId !== undefined && !slot) throw httpError(400, 'That time slot no longer exists.');

  const takesSpot = nextStatus !== 'rejected';
  const tookSpot = reg.status !== 'rejected' && reg.slotId === nextSlotId;
  if (takesSpot && !tookSpot && slot && activeCount(slot.id, reg.id) >= slot.capacity) {
    throw httpError(409, 'That slot is already full. Raise its capacity under Time slots, or move the group to another slot.');
  }
  if (b.adminNote !== undefined) reg.adminNote = text(b.adminNote, 500, { label: 'Note', multiline: true });
  reg.status = nextStatus;
  reg.slotId = nextSlotId;
  reg.updatedAt = new Date().toISOString();
  saveDb();
  json(res, 200, { registration: reg, slots: sortedSlots().map(slotView) });
}

function deleteRegistration(res, id) {
  const i = db.registrations.findIndex((r) => r.id === id);
  if (i < 0) throw httpError(404, 'That registration no longer exists.');
  const [reg] = db.registrations.splice(i, 1);
  saveDb();
  try { fs.unlinkSync(path.join(RECEIPT_DIR, reg.receiptFile)); } catch { /* already gone */ }
  json(res, 200, { ok: true });
}

async function updateSettings(req, res) {
  const b = await readJson(req);
  const s = { ...db.settings };
  s.eventName = text(b.eventName, 90, { required: true, label: 'Event name' });
  s.tagline = text(b.tagline, 200, { label: 'Tagline' });
  s.hostName = text(b.hostName, 90, { required: true, label: 'Host name' });
  s.contactInfo = text(b.contactInfo, 300, { label: 'Contact info', multiline: true });
  s.venue = text(b.venue, 120, { required: true, label: 'Venue' });
  s.venueAddress = text(b.venueAddress, 200, { label: 'Venue address' });
  s.mapUrl = text(b.mapUrl, 500, { label: 'Map link' });
  if (s.mapUrl && !/^https:\/\//i.test(s.mapUrl)) throw httpError(400, 'The map link must start with https://');
  s.description = text(b.description, 5000, { label: 'About the event', multiline: true });
  s.currency = text(b.currency, 5, { required: true, label: 'Currency symbol' });
  const price = Number(b.price);
  if (!Number.isFinite(price) || price < 0 || price > 1e7) throw httpError(400, 'Enter a price of 0 or more.');
  s.price = Math.round(price * 100) / 100;
  if (!['group', 'player'].includes(b.priceMode)) throw httpError(400, 'Choose whether the price is per group or per player.');
  s.priceMode = b.priceMode;
  s.paymentInstructions = text(b.paymentInstructions, 1000, { required: true, label: 'Payment instructions', multiline: true });
  s.minPlayers = intIn(b.minPlayers, 1, 30, 'Minimum players');
  s.maxPlayers = intIn(b.maxPlayers, 1, 30, 'Maximum players');
  if (s.maxPlayers < s.minPlayers) throw httpError(400, 'Maximum players must be at least the minimum.');
  s.registrationOpen = b.registrationOpen === true;
  s.configured = true;
  db.settings = s;
  saveDb();
  json(res, 200, adminData());
}

async function addSlots(req, res) {
  const b = await readJson(req);
  if (!DATE_RE.test(b.date || '')) throw httpError(400, 'Pick a date.');
  if (!TIME_RE.test(b.from || '') || !TIME_RE.test(b.to || '')) throw httpError(400, 'Enter a start and end time.');
  const length = intIn(b.minutes, 10, 480, 'Slot length');
  const capacity = intIn(b.capacity, 1, 100, 'Groups per slot');
  const gap = b.gap === undefined ? 0 : intIn(b.gap, 0, 120, 'Break between slots');
  const from = toMinutes(b.from);
  const to = toMinutes(b.to);
  if (to <= from) throw httpError(400, 'The end time must be after the start time.');
  let added = 0;
  let skipped = 0;
  for (let t = from; t + length <= to; t += length + gap) {
    const start = fromMinutes(t);
    if (db.slots.some((s) => s.date === b.date && s.start === start)) { skipped++; continue; }
    db.slots.push(makeSlot(b.date, start, fromMinutes(t + length), capacity));
    added++;
  }
  if (!added && !skipped) throw httpError(400, 'No slot fits between those times. Make the slot shorter or the window longer.');
  saveDb();
  json(res, 200, { added, skipped, ...adminData() });
}

async function updateSlot(req, res, id) {
  const slot = db.slots.find((s) => s.id === id);
  if (!slot) throw httpError(404, 'That slot no longer exists.');
  const b = await readJson(req);
  const capacity = intIn(b.capacity, 1, 100, 'Groups per slot');
  const booked = activeCount(slot.id);
  if (capacity < booked) throw httpError(409, `${booked} groups are already booked in this slot, so capacity can't go below ${booked}.`);
  slot.capacity = capacity;
  saveDb();
  json(res, 200, adminData());
}

function deleteSlot(res, id) {
  const i = db.slots.findIndex((s) => s.id === id);
  if (i < 0) throw httpError(404, 'That slot no longer exists.');
  const booked = activeCount(id);
  if (booked) throw httpError(409, `${booked === 1 ? 'A group is' : `${booked} groups are`} booked in this slot. Move or reject them first.`);
  db.slots.splice(i, 1);
  saveDb();
  json(res, 200, adminData());
}

async function changePassword(req, res) {
  const b = await readJson(req);
  if (!checkPassword(b.current || '')) throw httpError(400, 'Your current password is not right.');
  const next = String(b.next || '');
  if (next.length < 8) throw httpError(400, 'Use at least 8 characters for the new password.');
  db.admin = hashPassword(next);
  saveDb();
  try { fs.unlinkSync(PASSWORD_FILE); } catch { /* already gone */ }
  json(res, 200, { ok: true });
}

function serveReceipt(res, id) {
  const reg = db.registrations.find((r) => r.id === id);
  if (!reg) throw httpError(404, 'Receipt not found.');
  const file = path.join(RECEIPT_DIR, reg.receiptFile);
  if (!fs.existsSync(file)) throw httpError(404, 'Receipt file is missing.');
  const ext = path.extname(reg.receiptFile);
  res.writeHead(200, {
    'Content-Type': reg.receiptType,
    'Content-Disposition': `inline; filename="receipt-${reg.code}${ext}"`,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheets from running it as a formula
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(res) {
  const head = ['Code', 'Status', 'Date', 'Start', 'End', 'Group', 'Leader', 'Email', 'Mobile', 'School / org', 'Players', 'Other players', 'Amount', 'Reference no.', 'Notes', 'Organizer note', 'Registered at'];
  const rows = [...db.registrations]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((r) => {
      const s = db.slots.find((x) => x.id === r.slotId) || {};
      return [r.code, r.status, s.date, s.start, s.end, r.groupName, r.leaderName, r.email, r.phone, r.school, r.players, r.members.join('; '), r.amount, r.referenceNo, r.notes, r.adminNote, r.createdAt];
    });
  const body = '﻿' + [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="registrations-${localDate(new Date())}.csv"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* ------------------------------------------------------------------ routing */

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function routeApi(req, res, p) {
  const m = req.method;
  if (m === 'GET' && p === '/api/event') return json(res, 200, publicEvent());
  if (m === 'POST' && p === '/api/register') return handleRegister(req, res);
  if (m === 'POST' && p === '/api/status') return handleStatus(req, res);
  if (m === 'POST' && p === '/api/admin/login') return handleLogin(req, res);

  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) throw httpError(401, 'Sign in to the organizer dashboard.');
    let mm;
    if (m === 'POST' && p === '/api/admin/logout') return handleLogout(req, res);
    if (m === 'GET' && p === '/api/admin/data') return json(res, 200, adminData());
    if (m === 'GET' && p === '/api/admin/export.csv') return exportCsv(res);
    if (m === 'PUT' && p === '/api/admin/settings') return updateSettings(req, res);
    if (m === 'POST' && p === '/api/admin/slots') return addSlots(req, res);
    if (m === 'POST' && p === '/api/admin/password') return changePassword(req, res);
    if (m === 'GET' && (mm = p.match(new RegExp(`^/api/admin/receipt/${ID_RE}$`)))) return serveReceipt(res, mm[1]);
    if ((mm = p.match(new RegExp(`^/api/admin/registrations/${ID_RE}$`)))) {
      if (m === 'PATCH') return updateRegistration(req, res, mm[1]);
      if (m === 'DELETE') return deleteRegistration(res, mm[1]);
    }
    if ((mm = p.match(new RegExp(`^/api/admin/slots/${ID_RE}$`)))) {
      if (m === 'PATCH') return updateSlot(req, res, mm[1]);
      if (m === 'DELETE') return deleteSlot(res, mm[1]);
    }
  }
  throw httpError(404, 'Not found.');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const PAGES = { '/': 'index.html', '/admin': 'admin.html', '/admin/': 'admin.html' };

function serveStatic(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Method not allowed.');
  let file;
  if (PAGES[p]) file = path.join(PUBLIC_DIR, PAGES[p]);
  else if (p === '/favicon.ico') file = path.join(PUBLIC_DIR, 'favicon.svg');
  else if (p.startsWith('/static/')) {
    let rel;
    try { rel = decodeURIComponent(p.slice('/static/'.length)); } catch { throw httpError(400, 'Bad path.'); }
    file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw httpError(404, 'Not found.');
  } else {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw httpError(404, 'Not found.');
  const ext = path.extname(file);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
  };
  if (ext === '.html') {
    headers['Content-Security-Policy'] = CSP;
    headers['Referrer-Policy'] = 'same-origin';
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p.startsWith('/api/')) await routeApi(req, res, p);
    else serveStatic(req, res, p);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Something went wrong on the server. Try again.' : err.message, code: err.code });
    else res.end();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Close the other window running this app, or start it on another port:\n  set PORT=3001 && node server.js\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const line = '-'.repeat(60);
  console.log(`\n${line}\n  Escape room registration is running\n${line}`);
  console.log(`  Registration page    http://localhost:${PORT}`);
  for (const u of shareUrls()) console.log(`  Same Wi-Fi           ${u}`);
  console.log(`  Organizer dashboard  http://localhost:${PORT}/admin`);
  if (process.env.ADMIN_PASSWORD) console.log('  Organizer password   (from ADMIN_PASSWORD)');
  else if (fs.existsSync(PASSWORD_FILE)) console.log(`  Organizer password   see ${path.relative(process.cwd(), PASSWORD_FILE) || PASSWORD_FILE}`);
  console.log(`${line}\n  Keep this window open while people register. Press Ctrl+C to stop.\n`);
});
