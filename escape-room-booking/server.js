'use strict';
/*
 * Escape room booking, matchmaking and QR check-in.
 * Run: npm install (once), then node server.js.
 * Data lives in ./data, or in the event's Google Drive once the Google connector is set up
 * (then any laptop, or a cloud host, can run the app with the same data).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

/* config.env: copy it to another laptop and that laptop runs the app with the same Google storage */
const CONFIG_FILE = path.join(__dirname, 'config.env');
if (fs.existsSync(CONFIG_FILE)) {
  for (const line of fs.readFileSync(CONFIG_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const CONNECTOR_AT_BOOT = !!process.env.GOOGLE_SCRIPT_URL; // set by config.env or the host, so it survives restarts
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const FILES_DIR = path.join(DATA_DIR, 'files'); // receipts and pictures, when stored on this computer
const CACHE_DIR = path.join(DATA_DIR, 'cache'); // copies of Google Drive files, so they load fast
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PASSWORD_FILE = path.join(DATA_DIR, 'STAFF-PASSWORD.txt');
const PUBLIC_DIR = path.join(__dirname, 'public');
const JSQR_FILE = path.join(__dirname, 'node_modules', 'jsqr', 'dist', 'jsQR.js');
const MAX_BODY_BYTES = 14 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const SESSION_MS = 14 * 60 * 60 * 1000;

for (const d of [FILES_DIR, CACHE_DIR]) fs.mkdirSync(d, { recursive: true });

/* ------------------------------------------------------------------ helpers */

const pad = (n) => String(n).padStart(2, '0');
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fromMin = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const newId = () => crypto.randomBytes(8).toString('hex');
const sum = (list, f) => list.reduce((n, x) => n + (Number(f(x)) || 0), 0);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[0-9+()\-\s]{7,30}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CONTACT_KINDS = ['messenger', 'facebook', 'instagram', 'phone', 'other'];
const TYPES = ['team', 'group', 'private'];

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

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function time12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return { t: `${((h + 11) % 12) + 1}:${pad(m)}`, ap: h < 12 ? 'AM' : 'PM' };
}
const timeLabel = (hhmm) => { const x = time12(hhmm); return `${x.t} ${x.ap}`; };
function rangeLabel(start, end) {
  const a = time12(start);
  const b = time12(end);
  return a.ap === b.ap ? `${a.t} – ${b.t} ${b.ap}` : `${a.t} ${a.ap} – ${b.t} ${b.ap}`;
}
function dateLabel(iso) {
  if (!iso) return 'Date to be announced';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
function money(n) {
  return `${db.settings.currency}${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/* -------------------------------------------------------------------- store */

// Cloud hosts such as Render run their clocks on UTC, which is never the event's own time zone.
const DEFAULT_TIMEZONE = 'Asia/Manila';
const isUtcZone = (tz) => !tz || /^(Etc\/)?(UTC|UCT|GMT([+-]?0)?|Universal|Zulu|Greenwich)$/i.test(String(tz).trim());

function detectTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isUtcZone(tz) ? DEFAULT_TIMEZONE : tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

const DEFAULT_SETTINGS = {
  configured: false,
  eventName: 'Escape Room Challenge',
  tagline: 'Three rooms. 45 minutes each. Find the clues, crack the locks and get out.',
  hostName: 'Your Organization',
  contactInfo: 'Add your Facebook page, mobile number or email in Settings.',
  venue: 'Venue to be announced',
  venueAddress: '',
  mapUrl: '',
  description: [
    'Pick a room and a 45-minute time slot. Come as a full team of 6, or come solo or as a small group and we will fill your room with other players booking the same time.',
    '',
    'House rules',
    '- Arrive 15 minutes before your time for check-in and the briefing.',
    '- Check-in closes when your time starts. Spots of players who have not checked in go to people waiting on the standby list.',
    '- Booked spots are non-refundable.',
    '- Phones and bags stay outside the room.',
    '- Never force a lock or move heavy furniture. Every puzzle can be solved without strength.',
  ].join('\n'),
  eventDate: '',
  timezone: detectTimezone(),
  currency: '₱',
  pricePerPlayer: 150,
  paymentInstructions: 'Send the total by GCash to 09XX XXX XXXX (Account Name).\nThen upload a screenshot of the successful transfer below.',
  registrationOpen: true,
  roomCapacity: 6,
  schedule: { firstStart: '09:00', lastStart: '19:00', length: 45, every: 60 },
  arriveBefore: 15,
  alertBefore: 10,
  publicUrl: '',
  poster: null,
  mail: { host: 'smtp.gmail.com', port: 465, user: '', pass: '', fromName: '' },
  sheet: { url: '', secret: '' },
};

const DEFAULT_ROOMS = [
  { id: 'r1', name: 'Abandoned House', difficulty: 1, teaser: '', image: null },
  { id: 'r2', name: 'Night at the Museum', difficulty: 2, teaser: '', image: null },
  { id: 'r3', name: 'Resident Evil', difficulty: 3, teaser: '', image: null },
];

function readLocal() {
  return fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : {};
}

function normalizeDb(raw) {
  const settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
  // Data first saved on a UTC server took UTC as its time zone; slot times are local, so switch it back.
  if (isUtcZone(settings.timezone)) {
    if (raw.settings) console.log(`Time zone was "${settings.timezone}" (the server's clock); changed it to ${DEFAULT_TIMEZONE}.`);
    settings.timezone = DEFAULT_TIMEZONE;
  }
  settings.schedule = { ...DEFAULT_SETTINGS.schedule, ...(settings.schedule || {}) };
  settings.mail = { ...DEFAULT_SETTINGS.mail, ...(settings.mail || {}) };
  settings.sheet = { ...DEFAULT_SETTINGS.sheet, ...(settings.sheet || {}) };
  if (!settings.sheet.secret) settings.sheet.secret = crypto.randomBytes(12).toString('hex');
  return {
    settings,
    rooms: Array.isArray(raw.rooms) && raw.rooms.length === 3 ? raw.rooms : DEFAULT_ROOMS.map((r) => ({ ...r })),
    bookings: Array.isArray(raw.bookings) ? raw.bookings : [],
    walkins: Array.isArray(raw.walkins) ? raw.walkins : [],
    releases: raw.releases && typeof raw.releases === 'object' ? raw.releases : {},
    emails: Array.isArray(raw.emails) ? raw.emails : [],
    sheetStatus: raw.sheetStatus || null,
    googleStatus: raw.googleStatus || null,
    mailQuota: raw.mailQuota || null,
    admin: raw.admin || null,
  };
}

let db = normalizeDb({});

/*
 * Storage. 'local': ./data is the only copy. 'google': the event's Google Drive holds the data file, receipts
 * and pictures, so any laptop (or a cloud host) can run the app; ./data only keeps a cache and a mirror.
 */
const store = { mode: 'local', dirty: false, timer: null, flushing: null, lastSavedAt: null, lastError: '', warning: '', instance: crypto.randomBytes(6).toString('hex') };
const googleConfigured = () => !!(process.env.GOOGLE_SCRIPT_URL && process.env.GOOGLE_SECRET);

function writeLocal() {
  const json = JSON.stringify(db, null, 2);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, json);
  try {
    fs.renameSync(tmp, DB_FILE);
  } catch {
    fs.writeFileSync(DB_FILE, json);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function saveDb() {
  writeLocal();
  if (store.mode !== 'google') return;
  store.dirty = true;
  clearTimeout(store.timer);
  store.timer = setTimeout(() => { flushDb(); }, 400); // a burst of changes becomes one upload
}

/** Upload pending changes to Google Drive. Never throws: failures are kept and retried. */
async function flushDb() {
  if (store.mode !== 'google') return;
  if (store.flushing) await store.flushing;
  if (!store.dirty) return;
  clearTimeout(store.timer);
  store.dirty = false;
  const state = JSON.stringify(db);
  store.flushing = (async () => {
    try {
      const r = await callScript('save', { state, instance: store.instance });
      if (!r.ok) throw new Error(r.error || 'Google Drive did not confirm the save.');
      store.lastSavedAt = new Date().toISOString();
      store.lastError = '';
      store.warning = r.otherWriter ? 'Another copy of the app saved to this Google Drive in the last few minutes. Run only one copy at a time, or changes can overwrite each other.' : '';
    } catch (err) {
      store.dirty = true;
      store.lastError = err.message;
      console.error(`Saving to Google Drive failed, retrying in 10 s: ${err.message}`);
      clearTimeout(store.timer);
      store.timer = setTimeout(() => { flushDb(); }, 10000);
    }
  })();
  try { await store.flushing; } finally { store.flushing = null; }
}

/** At startup: load from Google Drive when configured (first time: upload this computer's data), else from ./data. */
async function loadState() {
  if (!googleConfigured()) {
    db = normalizeDb(readLocal());
    return;
  }
  store.mode = 'google';
  const r = await callScript('load', { instance: store.instance });
  if (!r.ok) throw new Error(r.error || 'Google Drive did not answer.');
  if (r.state) {
    db = normalizeDb(JSON.parse(r.state));
    store.lastSavedAt = r.savedAt || null;
    writeLocal();
  } else {
    db = normalizeDb(readLocal());
    await migrateFilesToGoogle();
    store.dirty = true;
    await flushDb();
    if (store.lastError) throw new Error(store.lastError);
  }
}

/** Sets the staff password at startup and says which rule applied (shown in the startup log). */
function initAdmin() {
  const envPw = (process.env.STAFF_PASSWORD || '').trim(); // a value pasted with a stray space still works
  if (envPw && (!db.admin || process.env.STAFF_PASSWORD_RESET === '1')) {
    db.admin = hashPassword(envPw);
    return process.env.STAFF_PASSWORD_RESET === '1' ? 'set from STAFF_PASSWORD (STAFF_PASSWORD_RESET=1)' : 'set from STAFF_PASSWORD';
  }
  if (!db.admin) {
    const pw = `${randomString(4)}-${randomString(4)}-${randomString(4)}`.toLowerCase();
    db.admin = hashPassword(pw);
    fs.writeFileSync(PASSWORD_FILE, `Staff password: ${pw}\n\nSign in at /staff. Everyone on staff shares this password.\nWhen you set your own password in Settings, this file is deleted.\n`);
    // on a cloud host nobody can open that file, so show it in the host's private logs instead
    return process.env.RENDER ? `generated: ${pw} (set STAFF_PASSWORD in Render's Environment to choose your own)` : `see ${path.relative(process.cwd(), PASSWORD_FILE) || PASSWORD_FILE}`;
  }
  return envPw
    ? 'kept the saved one (STAFF_PASSWORD only sets the first password; add STAFF_PASSWORD_RESET=1 to force it)'
    : 'kept the saved one';
}
let passwordNote = '';

/* ---------------------------------------------------- receipts and pictures */

const cachePath = (ref) => path.join(CACHE_DIR, ref.replace(/[^A-Za-z0-9_-]/g, '_'));

/** Store a file and return its reference: 'gdrive:<id>' in Google mode, 'file:<name>' on this computer. */
async function putBlob(name, buf, type) {
  if (store.mode === 'google') {
    const r = await callScript('putFile', { name, type, data: buf.toString('base64') });
    if (!r.ok || !r.id) throw httpError(502, `Couldn't save the file to Google Drive: ${r.error || 'no answer'}. Try again.`);
    const ref = `gdrive:${r.id}`;
    fs.writeFileSync(cachePath(ref), buf);
    return ref;
  }
  const file = `${Date.now()}-${name}`.replace(/[^A-Za-z0-9._-]/g, '_');
  fs.writeFileSync(path.join(FILES_DIR, file), buf);
  return `file:${file}`;
}

async function getBlob(ref) {
  if (typeof ref !== 'string' || !ref) throw httpError(404, 'File not found.');
  if (ref.startsWith('file:')) {
    const f = path.join(FILES_DIR, path.basename(ref.slice(5)));
    if (!fs.existsSync(f)) throw httpError(404, 'File not found on this computer.');
    return fs.readFileSync(f);
  }
  if (ref.startsWith('gdrive:')) {
    const c = cachePath(ref);
    if (fs.existsSync(c)) return fs.readFileSync(c);
    const r = await callScript('getFile', { id: ref.slice(7) });
    if (!r.ok || !r.data) throw httpError(404, `Couldn't load the file from Google Drive: ${r.error || 'no answer'}.`);
    const buf = Buffer.from(r.data, 'base64');
    fs.writeFileSync(c, buf);
    return buf;
  }
  // files saved by the first version of the app
  for (const dir of ['receipts', 'images']) {
    const f = path.join(DATA_DIR, dir, path.basename(ref));
    if (fs.existsSync(f)) return fs.readFileSync(f);
  }
  throw httpError(404, 'File not found.');
}

async function deleteBlob(ref) {
  try {
    if (ref.startsWith('file:')) fs.unlinkSync(path.join(FILES_DIR, path.basename(ref.slice(5))));
    else if (ref.startsWith('gdrive:')) {
      try { fs.unlinkSync(cachePath(ref)); } catch { /* not cached */ }
      if (store.mode === 'google') await callScript('deleteFile', { id: ref.slice(7) });
    }
  } catch { /* already gone */ }
}

/** Copy receipts and pictures stored on this computer into Google Drive, updating their references. */
async function migrateFilesToGoogle() {
  const move = async (ref, name, type) => (ref && !ref.startsWith('gdrive:') ? putBlob(name, await getBlob(ref), type) : ref);
  for (const b of db.bookings) {
    if (b.receiptFile) b.receiptFile = await move(b.receiptFile, `receipt-${b.code}`, b.receiptType);
  }
  if (db.settings.poster) db.settings.poster = await move(db.settings.poster, 'poster', 'image/jpeg');
  for (const r of db.rooms) if (r.image) r.image = await move(r.image, `room-${r.id}`, 'image/jpeg');
}

/* ------------------------------------------------------------ staff access */

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') };
}
function checkPassword(pw) {
  if (!db.admin) return false;
  const attempt = crypto.scryptSync(String(pw), db.admin.salt, 32);
  return crypto.timingSafeEqual(attempt, Buffer.from(db.admin.hash, 'hex'));
}

const sessions = new Map();
const loginFailures = new Map();

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
    }
  }
  return out;
}
function isStaff(req) {
  const token = parseCookies(req).escape_staff;
  const exp = token && sessions.get(token);
  if (!exp || exp < Date.now()) { if (token) sessions.delete(token); return false; }
  return true;
}

/* ----------------------------------------------------------- time + rooms */

function nowInTz() {
  if (process.env.FAKE_NOW) {
    const [d, t] = process.env.FAKE_NOW.split('T');
    return { date: d, minutes: toMin(t.slice(0, 5)) };
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: db.settings.timezone || 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

function allSlots(schedule = db.settings.schedule) {
  const out = [];
  for (let t = toMin(schedule.firstStart); t <= toMin(schedule.lastStart); t += schedule.every) {
    out.push({ id: fromMin(t).replace(':', ''), start: fromMin(t), end: fromMin(t + schedule.length), startMin: t, endMin: t + schedule.length });
  }
  return out;
}
const slotById = (id) => allSlots().find((s) => s.id === id);
const roomById = (id) => db.rooms.find((r) => r.id === id);

function eventDayState() {
  const n = nowInTz();
  const date = db.settings.eventDate;
  if (!date) return { ...n, phase: 'undated' };
  if (n.date < date) return { ...n, phase: 'before' };
  if (n.date > date) return { ...n, phase: 'after' };
  const slots = allSlots();
  const last = slots[slots.length - 1];
  return { ...n, phase: last && n.minutes > last.endMin ? 'after' : 'day' };
}

/** Check-in has closed and missing players' spots are open to standby. */
function isReleased(slot, roomId) {
  if (db.releases[`${slot.id}:${roomId}`]) return true;
  const st = eventDayState();
  return st.phase === 'after' || (st.phase === 'day' && st.minutes >= slot.startMin);
}

function isClosedOnline(slot) {
  const st = eventDayState();
  return st.phase === 'after' || (st.phase === 'day' && st.minutes >= slot.startMin);
}

const liveBookings = (slotId, roomId) => db.bookings.filter((b) => b.slotId === slotId && b.roomId === roomId && b.payment !== 'rejected');
const placedWalkins = (slotId, roomId) => db.walkins.filter((w) => w.status === 'placed' && w.placed && w.placed.slotId === slotId && w.placed.roomId === roomId);
const checkedInCount = (b) => b.players.filter((p) => p.inAt).length;

function roomState(slot, roomId, excludeBookingId) {
  const cap = db.settings.roomCapacity;
  const bs = liveBookings(slot.id, roomId).filter((b) => b.id !== excludeBookingId);
  const walk = sum(placedWalkins(slot.id, roomId), (w) => w.size);
  const booked = sum(bs, (b) => b.spots);
  const released = isReleased(slot, roomId);
  const heldAtDoor = sum(bs, (b) => (b.type === 'private' ? b.spots : checkedInCount(b)));
  const onlineFree = Math.max(0, cap - booked - walk);
  return {
    capacity: cap,
    booked,
    players: sum(bs, (b) => b.players.length) + walk,
    walkins: walk,
    checkedIn: sum(bs, checkedInCount) + walk,
    toReview: bs.filter((b) => b.payment === 'pending').length,
    hasPrivate: bs.some((b) => b.type === 'private'),
    released,
    onlineFree,
    doorFree: released ? Math.max(0, cap - heldAtDoor - walk) : onlineFree,
    closed: isClosedOnline(slot),
  };
}

/** Why a booking of this type and size can't go in this room, or null if it fits. */
function fitProblem(type, size, slot, roomId, excludeBookingId, { ignoreClosed = false } = {}) {
  const st = roomState(slot, roomId, excludeBookingId);
  if (st.closed && !ignoreClosed) return 'Booking for this time has closed.';
  if (type === 'group') {
    if (st.onlineFree < size) return st.onlineFree ? `Only ${st.onlineFree} ${st.onlineFree === 1 ? 'spot is' : 'spots are'} left in this room.` : 'This room is full.';
    return null;
  }
  if (st.onlineFree < st.capacity) return 'This room already has other players booked, so it can’t be booked as a whole room.';
  return null;
}

function bookingLabel(b) {
  if (b.teamName) return b.teamName;
  return b.players.length === 1 ? `${b.players[0].name} (solo)` : `${b.players[0].name}'s group`;
}

/* --------------------------------------------------------------------- urls */

function baseUrl() {
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || db.settings.publicUrl || `http://localhost:${PORT}`).replace(/\/+$/, '');
}
const ticketUrl = (b) => `${baseUrl()}/t/${b.token}`;

/* -------------------------------------------------------------------- email */

let transport = null;
let transportKey = '';
function smtpReady() {
  const m = db.settings.mail;
  return !!(m.host && m.user && m.pass);
}
function scriptUrl() {
  return process.env.GOOGLE_SCRIPT_URL || db.settings.sheet.url || '';
}
const connectorSecret = () => process.env.GOOGLE_SECRET || db.settings.sheet.secret;
/** 'smtp' with a Gmail app password, 'google' through the Apps Script connector, or 'preview' (saved only). */
function mailMode() {
  if (smtpReady()) return 'smtp';
  return scriptUrl() ? 'google' : 'preview';
}
const mailReady = () => mailMode() !== 'preview';
function getTransport() {
  if (!smtpReady()) return null;
  const m = db.settings.mail;
  const key = JSON.stringify([m.host, m.port, m.user, m.pass]);
  if (key !== transportKey) {
    transport = nodemailer.createTransport({ host: m.host, port: Number(m.port), secure: Number(m.port) === 465, auth: { user: m.user, pass: m.pass } });
    transportKey = key;
  }
  return transport;
}

function emailLayout(heading, bodyHtml) {
  const s = db.settings;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#edf1ef;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#132120">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#edf1ef;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #d7dfdc">
<tr><td style="background:#0a2225;padding:18px 24px;color:#e2b05a;font:600 12px/1.4 Consolas,monospace;letter-spacing:2px;text-transform:uppercase">${esc(s.eventName)}</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 12px;font:800 26px/1.15 Segoe UI,Roboto,Arial,sans-serif;color:#132120">${esc(heading)}</h1>
${bodyHtml}
</td></tr>
<tr><td style="padding:16px 24px;background:#f4f7f6;color:#70807d;font-size:12px;line-height:1.5">${esc(s.hostName)} · ${esc(s.venue)}${s.contactInfo ? `<br>${esc(s.contactInfo).replace(/\n/g, '<br>')}` : ''}</td></tr>
</table></td></tr></table></body></html>`;
}

function detailsTable(rows) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:12px 0 16px;font-size:14px;line-height:1.5">${rows
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#70807d;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:4px 0;font-weight:600">${esc(v)}</td></tr>`)
    .join('')}</table>`;
}

function button(href, label) {
  return `<a href="${esc(href)}" style="display:inline-block;background:#8a5d10;color:#ffffff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:10px;margin:4px 8px 4px 0">${esc(label)}</a>`;
}

const TYPE_LABEL = { team: 'Full team', group: 'Small group / solo', private: 'Private room' };

function bookingRows(b) {
  const slot = slotById(b.slotId);
  const room = roomById(b.roomId);
  return [
    ['Booking code', b.code],
    ['Team', bookingLabel(b)],
    ['Room', room ? room.name : 'Room removed'],
    ['Date', dateLabel(db.settings.eventDate)],
    ['Time', slot ? rangeLabel(slot.start, slot.end) : 'To be confirmed'],
    ['Players', `${b.players.length} (${b.players.map((p) => p.name).join(', ')})`],
    ['Booking type', TYPE_LABEL[b.type]],
    ['Amount', money(b.amount)],
  ];
}

/** POST to the Google Apps Script connector (Sheets + Gmail). Resolves its JSON answer. */
/** Explain a non-JSON answer from Google in plain steps, based on the most common setup mistakes. */
function connectorProblem(status, url, body) {
  if (/\/dev(\?|$)/.test(url)) return 'The link is the test link (it ends in /dev). In Apps Script, open Deploy › Manage deployments and copy the Web app URL that ends in /exec.';
  if (status === 404) return 'Google has no web app at that link. In Apps Script, open Deploy › Manage deployments and copy the Web app URL again (it ends in /exec).';
  if (status === 401 || status === 403 || /accounts\.google\.com|ServiceLogin/i.test(body)) {
    return `Google refused the request (${status}). In Apps Script, open Deploy › Manage deployments, click the pencil, set "Execute as" to Me and "Who has access" to Anyone (not "Anyone with Google account"), pick Version: New version, and click Deploy. If the script belongs to a school or work Google account, that account may not allow "Anyone": make the script from a regular @gmail.com account instead.`;
  }
  if (/authoriz/i.test(body)) return 'The script hasn\'t been authorized yet. In Apps Script, click Deploy › Test deployments or Run once, and allow access with the event Gmail.';
  return `The Google connector answered with ${status}. Check the link and that it's deployed with access for "Anyone".`;
}

async function callScript(action, payload = {}) {
  // a link copied while signed in to several Google accounts contains /u/1/, which outside servers can't use
  const url = scriptUrl().replace(/\/macros\/u\/\d+\/s\//, '/macros/s/');
  if (!url) throw httpError(400, 'Add the Google connector link in Settings first.');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: connectorSecret(), action, ...payload }),
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    const e = new Error(`Couldn't reach the Google connector: ${err.message}`);
    e.retry = true;
    throw e;
  }
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    const e = new Error(connectorProblem(res.status, url, body));
    e.retry = res.status >= 500;
    throw e;
  }
}

/** Inline images for an email (the ticket QR), rebuilt from the booking each time it's sent. */
async function emailAttachments(cidMap) {
  const out = [];
  for (const [cid, url] of Object.entries(cidMap || {})) {
    const m = url.match(/^\/t\/([A-Za-z0-9_-]+)\/qr\.png$/);
    const b = m && db.bookings.find((x) => x.token === m[1]);
    if (b) out.push({ cid, filename: `ticket-${b.code}.png`, content: await QRCode.toBuffer(ticketUrl(b), { errorCorrectionLevel: 'M', margin: 2, width: 360 }) });
  }
  return out;
}

/**
 * Emails are stored as a short record (kind, recipient, booking) and built when sent or previewed,
 * so nothing but the data file needs to be kept, and a queued email still works after a restart.
 */
function renderEmail(rec) {
  const x = rec.extra || {};
  const b = rec.bookingId ? db.bookings.find((y) => y.id === rec.bookingId) : null;
  if (rec.bookingId && !b) {
    const e = new Error('The booking for this email was deleted.');
    e.permanent = true;
    throw e;
  }
  if (rec.kind === 'received') return renderReceived(b);
  if (rec.kind === 'ticket') return renderTicket(b);
  if (rec.kind === 'rejected') return renderRejected(b);
  if (rec.kind === 'leader-alert') return renderLeaderAlert(b, slotById(x.slotId) || slotById(b.slotId), x.missing || []);
  if (rec.kind === 'walkin-alert') return renderWalkinAlert(x.name || 'there', slotById(x.slotId), roomById(x.roomId));
  if (rec.kind === 'test') {
    return { subject: `Test email from ${db.settings.eventName}`, html: emailLayout('Email is working', '<p style="font-size:15px">Tickets and alerts will be sent from this address.</p>'), text: 'Email is working.', cidMap: {} };
  }
  const e = new Error(`Unknown email type: ${rec.kind}`);
  e.permanent = true;
  throw e;
}

/** Try to send an email. Temporary problems (daily limit, network) leave it queued for a retry. */
async function deliver(rec) {
  const mode = mailMode();
  if (mode === 'preview') return rec;
  let m;
  try {
    m = renderEmail(rec);
  } catch (err) {
    rec.status = 'failed';
    rec.error = err.message;
    saveDb();
    return rec;
  }
  const attachments = await emailAttachments(m.cidMap);
  const fromName = db.settings.mail.fromName || db.settings.eventName;
  rec.attempts = (rec.attempts || 0) + 1;
  rec.lastTry = new Date().toISOString();
  try {
    if (mode === 'smtp') {
      await getTransport().sendMail({ from: { name: fromName, address: db.settings.mail.user }, to: rec.to, subject: m.subject, html: m.html, text: m.text, attachments });
    } else {
      const r = await callScript('email', {
        to: rec.to, subject: m.subject, html: m.html, text: m.text || '', name: fromName,
        inline: attachments.map((a) => ({ cid: a.cid, name: a.filename, type: 'image/png', data: a.content.toString('base64') })),
      });
      if (typeof r.remaining === 'number') db.mailQuota = { remaining: r.remaining, at: new Date().toISOString() };
      if (!r.ok) {
        const e = new Error(r.error || 'The Google connector could not send it.');
        e.retry = !!r.quota;
        e.quota = !!r.quota;
        throw e;
      }
    }
    rec.status = 'sent';
    rec.error = '';
    rec.sentAt = new Date().toISOString();
  } catch (err) {
    const msg = String(err.message || err).slice(0, 300);
    const temporary = err.retry || /timeout|timed out|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket|fetch failed/i.test(msg);
    rec.status = temporary && rec.attempts < 60 ? 'queued' : 'failed';
    rec.error = msg;
    rec.retryAt = new Date(Date.now() + (err.quota ? 60 : 10) * 60 * 1000).toISOString();
    console.error(`Email to ${rec.to} ${rec.status === 'queued' ? 'will be retried' : 'failed'}: ${msg}`);
  }
  saveDb();
  return rec;
}

async function sendEmail(kind, to, { bookingId = null, extra = {} } = {}) {
  const rec = { id: newId(), kind, to, bookingId, extra, subject: '', createdAt: new Date().toISOString(), status: 'saved', error: '', attempts: 0 };
  rec.subject = renderEmail(rec).subject;
  db.emails.unshift(rec);
  if (db.emails.length > 500) db.emails.length = 500;
  saveDb();
  return deliver(rec);
}

let retrying = false;
async function retryQueued() {
  if (retrying || mailMode() === 'preview') return;
  retrying = true;
  try {
    const due = db.emails.filter((e) => e.status === 'queued' && (!e.retryAt || e.retryAt <= new Date().toISOString())).reverse();
    for (const rec of due) {
      await deliver(rec);
      if (rec.status === 'queued' && /limit/i.test(rec.error)) break; // daily limit: no point trying the rest now
    }
  } finally {
    retrying = false;
  }
}
setInterval(() => { retryQueued().catch((e) => console.error(e)); }, 5 * 60 * 1000).unref();
setTimeout(() => { retryQueued().catch((e) => console.error(e)); }, 15 * 1000).unref(); // pick up anything left queued before a restart

function renderReceived(b) {
  const html = emailLayout('We got your booking', `
<p style="margin:0 0 8px;font-size:15px;line-height:1.6">Hi ${esc(b.leaderName)}, thanks for booking! We're checking your payment now. Your QR ticket will arrive in a second email once it's approved.</p>
${detailsTable(bookingRows(b))}
${button(ticketUrl(b), 'View your booking')}
<p style="margin:16px 0 0;font-size:13px;color:#70807d">Keep your booking code. You can use it to look up your booking at any time.</p>`);
  return { subject: `Booking received: ${b.code}`, html, text: `We got your booking ${b.code}. We're checking your payment. View it at ${ticketUrl(b)}`, cidMap: {} };
}

function renderTicket(b) {
  const slot = slotById(b.slotId);
  const room = roomById(b.roomId);
  const arrive = slot ? timeLabel(fromMin(slot.startMin - db.settings.arriveBefore)) : '';
  const html = emailLayout('Your ticket is confirmed', `
<p style="margin:0 0 16px;font-size:15px;line-height:1.6">Hi ${esc(b.leaderName)}, your payment is approved. Show this QR code at the door. Anyone in your group can show it, so share the link with them.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border:2px dashed #8a5d10;border-radius:14px;background:#f5e9d0"><tr><td align="center" style="padding:20px">
<div style="font:700 13px/1.4 Consolas,monospace;letter-spacing:2px;color:#8a5d10;text-transform:uppercase">${esc(room ? room.name : '')}</div>
<div style="font:800 20px/1.3 Segoe UI,Arial,sans-serif;margin:4px 0">${esc(bookingLabel(b))}</div>
<div style="font-size:14px;color:#465755">${esc(dateLabel(db.settings.eventDate))}<br>${esc(slot ? rangeLabel(slot.start, slot.end) : '')} · arrive by ${esc(arrive)}</div>
<img src="cid:qrticket" width="200" height="200" alt="QR ticket ${esc(b.code)}" style="display:block;margin:16px auto 8px;background:#ffffff;border-radius:8px">
<div style="font:700 18px/1 Consolas,monospace;letter-spacing:3px">${esc(b.code)}</div>
</td></tr></table>
${detailsTable(bookingRows(b))}
${button(ticketUrl(b), 'Open ticket')} ${button(ticketUrl(b), 'Share with your group')}
<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#465755">Check-in closes when your time starts. Spots of players who haven't checked in by then go to people on the standby list, and booked spots are non-refundable.${b.type === 'group' ? ' Your ticket page shows who else is playing in your room.' : ''}</p>`);
  return {
    subject: `Your QR ticket: ${room ? room.name : 'Escape room'}, ${slot ? timeLabel(slot.start) : ''}`,
    html,
    text: `Your booking ${b.code} is confirmed. Open your QR ticket: ${ticketUrl(b)}`,
    cidMap: { qrticket: `/t/${b.token}/qr.png` },
  };
}

function renderRejected(b) {
  const html = emailLayout('We couldn’t confirm your payment', `
<p style="margin:0 0 8px;font-size:15px;line-height:1.6">Hi ${esc(b.leaderName)}, we couldn't confirm the payment for booking ${esc(b.code)}.</p>
${b.rejectReason ? `<p style="margin:0 0 12px;padding:10px 12px;border-left:3px solid #ab3333;background:#f8e1e1;font-size:14px">${esc(b.rejectReason)}</p>` : ''}
<p style="margin:0 0 12px;font-size:15px;line-height:1.6">Your spots are no longer held. Upload a correct receipt from your booking page to try again while spots are still open.</p>
${button(ticketUrl(b), 'Upload a new receipt')}`);
  return { subject: `Payment not confirmed: ${b.code}`, html, text: `We couldn't confirm the payment for ${b.code}. ${b.rejectReason || ''} Upload a new receipt: ${ticketUrl(b)}`, cidMap: {} };
}

function renderLeaderAlert(b, slot, missingNames) {
  const room = roomById(b.roomId);
  const start = slot ? timeLabel(slot.start) : 'soon';
  const html = emailLayout('Your room starts soon', `
<p style="margin:0 0 8px;font-size:15px;line-height:1.6">Hi ${esc(b.leaderName)}, ${esc(room ? room.name : 'your room')} starts at ${esc(start)}. These players haven't checked in yet:</p>
<ul style="margin:0 0 12px;padding-left:20px;font-size:15px;line-height:1.6">${missingNames.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6">Please come to the check-in desk now. At ${esc(start)}, spots of players who haven't checked in go to people on the standby list.</p>
${button(ticketUrl(b), 'Open your QR ticket')}`);
  return { subject: `Starts at ${start}: ${missingNames.length} of your players aren't checked in`, html, text: `${missingNames.length} of your players haven't checked in. Come to the desk now.`, cidMap: {} };
}

function renderWalkinAlert(name, slot, room) {
  const roomName = room ? room.name : 'a room';
  const when = slot ? rangeLabel(slot.start, slot.end) : 'the current time';
  const html = emailLayout('A spot just opened', `
<p style="margin:0 0 8px;font-size:15px;line-height:1.6">Hi ${esc(name)}, a spot opened in <strong>${esc(roomName)}</strong> at ${esc(when)}. Come to the check-in desk right away to take it.</p>`);
  return { subject: `A spot opened: ${roomName}, ${slot ? timeLabel(slot.start) : ''}`, html, text: `A spot opened in ${roomName} at ${when}. Come to the check-in desk now.`, cidMap: {} };
}

const emailReceived = (b) => sendEmail('received', b.email, { bookingId: b.id });
const emailTicket = (b) => sendEmail('ticket', b.email, { bookingId: b.id });
const emailRejected = (b) => sendEmail('rejected', b.email, { bookingId: b.id });
const emailLeaderAlert = (b, slot, missing) => sendEmail('leader-alert', b.email, { bookingId: b.id, extra: { slotId: slot.id, missing: missing.map((p) => p.name) } });
const emailWalkinAlert = (w, slot, room) => sendEmail('walkin-alert', w.email, { extra: { name: w.name, slotId: slot.id, roomId: room.id } });

/* -------------------------------------------------------------- sheet sync */

const SHEET_HEADER = ['Time', 'Room', 'Team', 'Player', 'Leader', 'Booking type', 'Booking code', 'Leader phone', 'Leader email', 'Payment', 'Checked in', 'Amount', 'Reference no.', 'Receipt'];

function sheetCell(v) {
  const s = v == null ? '' : String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s; // keep Sheets from treating it as a formula
}

function sheetRows() {
  const slots = allSlots();
  const slotOrder = Object.fromEntries(slots.map((s, i) => [s.id, i]));
  const roomOrder = { r1: 0, r2: 1, r3: 2 };
  const rows = [];
  for (const b of db.bookings) {
    const slot = slotById(b.slotId);
    const room = roomById(b.roomId);
    b.players.forEach((p, i) => {
      rows.push({
        k: [slotOrder[b.slotId] ?? 99, roomOrder[b.roomId] ?? 9, b.payment === 'rejected' ? 1 : 0, bookingLabel(b).toLowerCase(), b.createdAt, i],
        cells: [slot ? timeLabel(slot.start) : '', room ? room.name : '', bookingLabel(b), p.name, i === 0 ? 'Yes' : '', TYPE_LABEL[b.type], b.code, b.phone, b.email,
          { pending: 'To review', approved: 'Paid', rejected: 'Rejected' }[b.payment], p.inAt ? new Date(p.inAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: db.settings.timezone }) : '',
          i === 0 ? b.amount : '', i === 0 ? b.referenceNo : '', i === 0 ? `${baseUrl()}/staff/receipt/${b.id}` : ''],
      });
    });
  }
  for (const w of db.walkins.filter((x) => x.status === 'placed' && x.placed)) {
    const slot = slotById(w.placed.slotId);
    const room = roomById(w.placed.roomId);
    rows.push({
      k: [slotOrder[w.placed.slotId] ?? 99, roomOrder[w.placed.roomId] ?? 9, 0, 'zz walk-in', w.createdAt, 0],
      cells: [slot ? timeLabel(slot.start) : '', room ? room.name : '', 'Walk-in (standby)', w.size > 1 ? `${w.name} +${w.size - 1}` : w.name, 'Yes', 'Walk-in', '', w.phone, w.email, `Paid at venue (${w.method})`, 'Yes', w.amountPaid, '', ''],
    });
  }
  rows.sort((a, b) => {
    for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return a.k[i] < b.k[i] ? -1 : 1;
    return 0;
  });
  return { header: SHEET_HEADER, rows: rows.map((r) => r.cells.map(sheetCell)) };
}

let syncTimer = null;
function scheduleSync() {
  if (!scriptUrl()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncSheet().catch(() => {}); }, 3000);
}

async function syncSheet() {
  if (!scriptUrl()) throw httpError(400, 'Add the Google connector link in Settings first.');
  const { header, rows } = sheetRows();
  const status = { at: new Date().toISOString(), ok: false, rows: rows.length, error: '' };
  try {
    const parsed = await callScript('sync', { event: db.settings.eventName, header, rows });
    if (parsed && parsed.ok) status.ok = true;
    else status.error = (parsed && parsed.error) || 'The Google connector did not confirm the update.';
  } catch (err) {
    status.error = err.message;
  }
  db.sheetStatus = status;
  saveDb();
  return status;
}

/* ------------------------------------------------------------------ bodies */

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) {
      req.resume();
      reject(httpError(413, 'That upload is too large. Use a file under 8 MB.'));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY_BYTES) tooBig = true; else chunks.push(c); });
    req.on('end', () => (tooBig ? reject(httpError(413, 'That upload is too large. Use a file under 8 MB.')) : resolve(Buffer.concat(chunks))));
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

function decodeUpload(r, { allowPdf = true, label = 'file' } = {}) {
  if (!r || typeof r.data !== 'string' || !r.data) throw httpError(400, `Upload the ${label}.`);
  const buf = Buffer.from(r.data, 'base64');
  if (!buf.length) throw httpError(400, `The ${label} is empty. Upload it again.`);
  if (buf.length > MAX_UPLOAD_BYTES) throw httpError(413, `The ${label} is over 8 MB. Upload a smaller one.`);
  const kind = sniffFile(buf);
  if (!kind || (!allowPdf && kind.ext === 'pdf')) throw httpError(400, allowPdf ? `The ${label} must be a JPG, PNG or WebP image, or a PDF.` : `The ${label} must be a JPG, PNG or WebP image.`);
  return { buf, ...kind, originalName: text(r.name, 200, { label: 'File name' }) };
}

/* ------------------------------------------------------------- public views */

/** Public pictures (poster, rooms) are served by reference; receipts never are. */
const mediaUrl = (ref) => (ref ? `/media/${encodeURIComponent(ref)}` : null);
const publicMediaRefs = () => new Set([db.settings.poster, ...db.rooms.map((r) => r.image)].filter(Boolean));

function publicRoom(r) {
  return { id: r.id, name: r.name, difficulty: r.difficulty, teaser: r.teaser, image: mediaUrl(r.image) };
}

function publicEvent() {
  const s = db.settings;
  const slots = allSlots();
  return {
    settings: {
      eventName: s.eventName, tagline: s.tagline, hostName: s.hostName, contactInfo: s.contactInfo, venue: s.venue, venueAddress: s.venueAddress,
      mapUrl: s.mapUrl, description: s.description, eventDate: s.eventDate, currency: s.currency, pricePerPlayer: s.pricePerPlayer,
      paymentInstructions: s.paymentInstructions, registrationOpen: s.registrationOpen, roomCapacity: s.roomCapacity, arriveBefore: s.arriveBefore,
      poster: mediaUrl(s.poster),
    },
    rooms: db.rooms.map(publicRoom),
    slots: slots.map((slot) => ({
      id: slot.id, start: slot.start, end: slot.end,
      rooms: Object.fromEntries(db.rooms.map((r) => { const st = roomState(slot, r.id); return [r.id, { free: st.onlineFree, closed: st.closed }]; })),
    })),
    playersBooked: sum(db.bookings.filter((b) => b.payment !== 'rejected'), (b) => b.players.length),
    totalSpots: slots.length * db.rooms.length * s.roomCapacity,
  };
}

function ticketView(b) {
  const slot = slotById(b.slotId);
  const room = roomById(b.roomId);
  const others = slot ? liveBookings(slot.id, b.roomId).filter((x) => x.id !== b.id) : [];
  const st = slot ? roomState(slot, b.roomId) : null;
  return {
    code: b.code, type: b.type, teamName: b.teamName, label: bookingLabel(b), leaderName: b.leaderName,
    players: b.players.map((p) => ({ name: p.name, checkedIn: !!p.inAt })),
    amount: b.amount, payment: b.payment, rejectReason: b.rejectReason || '', referenceNo: b.referenceNo,
    slot: slot ? { id: slot.id, start: slot.start, end: slot.end } : null,
    room: room ? publicRoom(room) : null,
    roommates: others.map((x) => ({
      label: x.teamName || (x.players.length === 1 ? 'A solo player' : `A group of ${x.players.length}`),
      size: x.players.length,
      contact: x.contact ? { kind: x.contact.kind, value: x.contact.value } : null,
    })),
    spotsOpen: st ? st.onlineFree : 0,
    myContact: b.contact,
    event: {
      eventName: db.settings.eventName, hostName: db.settings.hostName, eventDate: db.settings.eventDate, venue: db.settings.venue,
      venueAddress: db.settings.venueAddress, mapUrl: db.settings.mapUrl, currency: db.settings.currency, arriveBefore: db.settings.arriveBefore,
      paymentInstructions: db.settings.paymentInstructions, contactInfo: db.settings.contactInfo,
    },
  };
}

/* --------------------------------------------------------- public handlers */

async function handleBook(req, res) {
  const b = await readJson(req);
  const s = db.settings;
  if (!s.registrationOpen) throw httpError(403, 'Booking is closed.');
  if (!TYPES.includes(b.type)) throw httpError(400, 'Choose how you’re joining.');
  const slot = slotById(b.slotId);
  const room = roomById(b.roomId);
  if (!slot || !room) throw httpError(400, 'Pick a room and time first.', 'no_slot');

  const cap = s.roomCapacity;
  const leaderName = text(b.leaderName, 80, { required: true, label: "Group leader's name" });
  const others = Array.isArray(b.players) ? b.players : [];
  const size = 1 + others.length;
  if (b.type === 'team' && size !== cap) throw httpError(400, `A full team has exactly ${cap} players.`);
  if (b.type === 'group' && (size < 1 || size > cap - 1)) throw httpError(400, `A small group has 1 to ${cap - 1} players.`);
  if (b.type === 'private' && (size < 2 || size > cap - 1)) throw httpError(400, `A private room booking has 2 to ${cap - 1} players.`);
  const names = [leaderName];
  others.forEach((n, i) => names.push(text(n, 80, { required: true, label: `Player ${i + 2}'s name` })));

  const teamName = text(b.teamName, 60, { required: b.type !== 'group', label: 'Team name' });
  const email = text(b.email, 120, { required: true, label: 'Email' }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address.');
  const phone = text(b.phone, 30, { required: true, label: 'Mobile number' });
  if (!PHONE_RE.test(phone)) throw httpError(400, 'Enter a valid mobile number.');
  let contact = null;
  if (b.type === 'group' && b.contact && b.contact.share === true) {
    const kind = CONTACT_KINDS.includes(b.contact.kind) ? b.contact.kind : 'other';
    const value = text(b.contact.value, 120, { required: true, label: 'The contact you want to share' });
    contact = { kind, value };
  }
  const referenceNo = text(b.referenceNo, 60, { required: true, label: 'Reference number' });
  const receipt = decodeUpload(b.receipt, { label: 'payment receipt' });

  // From here on everything is synchronous, so two people can't take the same spots.
  if (teamName && db.bookings.some((x) => x.payment !== 'rejected' && x.teamName && x.teamName.toLowerCase() === teamName.toLowerCase())) {
    throw httpError(409, 'Another team already uses that name. Pick a different team name.', 'name_taken');
  }
  const problem = fitProblem(b.type, size, slot, room.id);
  if (problem) throw httpError(409, `${problem} Pick another room or time.`, 'no_room');

  let code;
  do code = `ESC-${randomString(5)}`; while (db.bookings.some((x) => x.code === code));
  const id = newId();
  const now = new Date().toISOString();
  const spots = b.type === 'group' ? size : cap;
  const booking = {
    id, code, token: crypto.randomBytes(18).toString('base64url'),
    type: b.type, slotId: slot.id, roomId: room.id, teamName, leaderName, email, phone, contact,
    players: names.map((name) => ({ id: crypto.randomBytes(4).toString('hex'), name, inAt: null })),
    spots, amount: Math.round(spots * s.pricePerPlayer * 100) / 100,
    referenceNo, receiptFile: null, receiptType: receipt.type, receiptName: receipt.originalName,
    payment: 'pending', rejectReason: '', flags: {}, createdAt: now, updatedAt: now,
  };
  // hold the spots before the (possibly slow) receipt upload, so nobody else can take them meanwhile
  db.bookings.push(booking);
  try {
    booking.receiptFile = await putBlob(`receipt-${code}.${receipt.ext}`, receipt.buf, receipt.type);
  } catch (err) {
    db.bookings.splice(db.bookings.indexOf(booking), 1);
    throw err;
  }
  saveDb();
  console.log(`New booking ${code}: ${bookingLabel(booking)}, ${room.name} ${slot.start}`);
  emailReceived(booking).catch((e) => console.error(e));
  scheduleSync();
  json(res, 201, { code, token: booking.token, ticket: ticketView(booking) });
}

function findByToken(token) {
  const b = db.bookings.find((x) => x.token === token);
  if (!b) throw httpError(404, 'We couldn’t find that booking. Check the link in your email.');
  return b;
}

async function handleReupload(req, res, token) {
  const b = findByToken(token);
  if (b.payment !== 'rejected') throw httpError(409, 'This booking isn’t waiting for a new receipt.');
  const body = await readJson(req);
  const referenceNo = text(body.referenceNo, 60, { required: true, label: 'Reference number' });
  const receipt = decodeUpload(body.receipt, { label: 'payment receipt' });
  const slot = slotById(b.slotId);
  const check = () => (slot ? fitProblem(b.type, b.players.length, slot, b.roomId, b.id) : 'That time slot no longer exists.');
  let problem = check();
  if (problem) throw httpError(409, `${problem} Contact the organizers to pick another room or time.`);
  const ref = await putBlob(`receipt-${b.code}-${Date.now()}.${receipt.ext}`, receipt.buf, receipt.type);
  problem = check(); // the room may have filled up during the upload
  if (problem || b.payment !== 'rejected') {
    deleteBlob(ref);
    throw httpError(409, problem ? `${problem} Contact the organizers to pick another room or time.` : 'This booking isn’t waiting for a new receipt.');
  }
  const old = b.receiptFile;
  b.receiptFile = ref;
  if (old) deleteBlob(old);
  Object.assign(b, { receiptType: receipt.type, receiptName: receipt.originalName, referenceNo, payment: 'pending', rejectReason: '', updatedAt: new Date().toISOString() });
  saveDb();
  scheduleSync();
  json(res, 200, { ticket: ticketView(b) });
}

async function handleFind(req, res) {
  const body = await readJson(req);
  let code = text(body.code, 20, { required: true, label: 'Booking code' }).toUpperCase().replace(/\s/g, '');
  if (!code.startsWith('ESC-')) code = `ESC-${code.replace(/^ESC/, '')}`;
  const email = text(body.email, 120, { required: true, label: 'Email' }).toLowerCase();
  const b = db.bookings.find((x) => x.code === code && x.email === email);
  if (!b) throw httpError(404, 'No booking matches that code and email. Check both and try again.');
  json(res, 200, { token: b.token });
}

async function serveQr(res, token, format) {
  const b = findByToken(token);
  if (b.payment !== 'approved') throw httpError(404, 'This ticket isn’t active yet.');
  if (format === 'svg') {
    const svg = await QRCode.toString(ticketUrl(b), { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#0a2225', light: '#ffffff' } });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    return res.end(svg);
  }
  const png = await QRCode.toBuffer(ticketUrl(b), { errorCorrectionLevel: 'M', margin: 2, width: 360 });
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' });
  res.end(png);
}

/* ---------------------------------------------------------- staff handlers */

async function handleLogin(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  const f = loginFailures.get(ip);
  if (f && Date.now() - f.since < 10 * 60 * 1000 && f.count >= 10) throw httpError(429, 'Too many wrong passwords. Wait 10 minutes and try again.');
  const b = await readJson(req);
  const typed = String(b.password || '');
  if (!checkPassword(typed) && !(typed.trim() !== typed && checkPassword(typed.trim()))) {
    if (!f || Date.now() - f.since > 10 * 60 * 1000) loginFailures.set(ip, { count: 1, since: Date.now() });
    else f.count++;
    throw httpError(401, 'That password is not right.');
  }
  loginFailures.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `escape_staff=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`);
  json(res, 200, { ok: true });
}

function shareUrls() {
  const urls = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/virtual|vbox|vmware|vethernet|wsl|hyper-v|docker|loopback|tailscale|zerotier/i.test(name)) continue;
    for (const a of list || []) {
      if (/^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:1c:14|00:15:5d|02:42)/i.test(a.mac || '')) continue;
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
    }
  }
  return urls;
}

function staffBooking(b) {
  const { receiptFile, ...rest } = b;
  return { ...rest, label: bookingLabel(b), hasReceipt: !!receiptFile };
}

function staffData() {
  const s = db.settings;
  const slots = allSlots();
  const day = eventDayState();
  let currentSlotId = null;
  if (day.phase === 'day') {
    for (const slot of slots) if (day.minutes >= slot.startMin - s.arriveBefore) currentSlotId = slot.id;
  }
  const { pass, ...mail } = s.mail;
  return {
    settings: { ...s, mail: { ...mail, passSet: !!pass } },
    rooms: db.rooms.map(publicRoom),
    slots: slots.map((slot) => ({ ...slot, rooms: Object.fromEntries(db.rooms.map((r) => [r.id, roomState(slot, r.id)])) })),
    bookings: [...db.bookings].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(staffBooking),
    walkins: [...db.walkins].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    releases: db.releases,
    emails: db.emails.slice(0, 200),
    sheetStatus: db.sheetStatus,
    now: { ...day, currentSlotId },
    mailReady: mailReady(),
    mailMode: mailMode(),
    mailQuota: db.mailQuota || null,
    googleStatus: db.googleStatus || null,
    connectorFromEnv: CONNECTOR_AT_BOOT,
    publicBase: baseUrl(),
    publicFromEnv: !!(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL),
    networkUrls: shareUrls(),
    passwordFileExists: fs.existsSync(PASSWORD_FILE),
    storage: {
      mode: store.mode,
      lastSavedAt: store.lastSavedAt,
      lastError: store.lastError,
      warning: store.warning,
      pending: store.dirty,
      onCloudHost: !!process.env.RENDER,
      fromConfigFile: fs.existsSync(CONFIG_FILE),
      // what another laptop (config.env) or a cloud host (environment settings) needs to reach the same data
      config: scriptUrl() ? { GOOGLE_SCRIPT_URL: scriptUrl(), GOOGLE_SECRET: connectorSecret() } : null,
    },
  };
}

function findBooking(id) {
  const b = db.bookings.find((x) => x.id === id);
  if (!b) throw httpError(404, 'That booking no longer exists.');
  return b;
}

async function setPayment(req, res, id) {
  const b = findBooking(id);
  const body = await readJson(req);
  const status = body.status;
  if (!['pending', 'approved', 'rejected'].includes(status)) throw httpError(400, 'Unknown payment status.');
  if (status === b.payment) return json(res, 200, staffData());
  if (b.payment === 'rejected') {
    const slot = slotById(b.slotId);
    // its spots were released when rejected, so check they're still free (staff may approve at the door after online booking closed)
    const problem = slot ? fitProblem(b.type, b.players.length, slot, b.roomId, b.id, { ignoreClosed: true }) : 'That time slot no longer exists.';
    if (problem) throw httpError(409, `${problem} Move the booking to another room or time first.`);
  }
  b.payment = status;
  b.rejectReason = status === 'rejected' ? text(body.reason, 300, { label: 'Reason' }) : '';
  b.updatedAt = new Date().toISOString();
  if (status === 'approved') b.approvedAt = b.updatedAt;
  saveDb();
  scheduleSync();
  if (status === 'approved' && !b.flags.ticketSent) {
    b.flags.ticketSent = true;
    saveDb();
    emailTicket(b).catch((e) => console.error(e));
  }
  if (status === 'rejected') emailRejected(b).catch((e) => console.error(e));
  json(res, 200, staffData());
}

async function setCheckin(req, res, id) {
  const b = findBooking(id);
  const body = await readJson(req);
  if (b.payment !== 'approved') throw httpError(409, 'Approve the payment before checking players in.');
  const ins = new Set(Array.isArray(body.in) ? body.in : []);
  const outs = new Set(Array.isArray(body.out) ? body.out : []);
  const now = new Date().toISOString();
  for (const p of b.players) {
    if (ins.has(p.id) && !p.inAt) p.inAt = now;
    if (outs.has(p.id)) p.inAt = null;
  }
  b.updatedAt = now;
  saveDb();
  scheduleSync();
  json(res, 200, { booking: staffBooking(b), data: staffData() });
}

async function moveBooking(req, res, id) {
  const b = findBooking(id);
  const body = await readJson(req);
  const slot = slotById(body.slotId);
  const room = roomById(body.roomId);
  if (!slot || !room) throw httpError(400, 'Pick a room and time.');
  if (slot.id === b.slotId && room.id === b.roomId) return json(res, 200, staffData());
  if (b.payment !== 'rejected') {
    const st = roomState(slot, room.id, b.id);
    const fits = b.type === 'group' ? st.onlineFree >= b.spots : st.onlineFree >= st.capacity;
    if (!fits) throw httpError(409, b.type === 'group' ? `Only ${st.onlineFree} spots are free there.` : 'That room already has players, so a full team or private room can’t move there.');
  }
  b.slotId = slot.id;
  b.roomId = room.id;
  b.flags.leaderAlerted = false;
  b.updatedAt = new Date().toISOString();
  saveDb();
  scheduleSync();
  json(res, 200, staffData());
}

async function resendEmail(res, id) {
  const b = findBooking(id);
  const rec = b.payment === 'approved' ? await emailTicket(b) : b.payment === 'rejected' ? await emailRejected(b) : await emailReceived(b);
  json(res, 200, { email: rec, data: staffData() });
}

function deleteBooking(res, id) {
  const i = db.bookings.findIndex((x) => x.id === id);
  if (i < 0) throw httpError(404, 'That booking no longer exists.');
  const [b] = db.bookings.splice(i, 1);
  saveDb();
  if (b.receiptFile) deleteBlob(b.receiptFile);
  scheduleSync();
  json(res, 200, staffData());
}

async function setRelease(req, res) {
  const body = await readJson(req);
  const slot = slotById(body.slotId);
  if (!slot || !roomById(body.roomId)) throw httpError(400, 'Unknown room or time.');
  const key = `${slot.id}:${body.roomId}`;
  if (body.released) db.releases[key] = true;
  else delete db.releases[key];
  saveDb();
  json(res, 200, staffData());
}

async function addWalkin(req, res) {
  const b = await readJson(req);
  const w = {
    id: newId(),
    name: text(b.name, 80, { required: true, label: 'Name' }),
    phone: text(b.phone, 30, { required: true, label: 'Mobile number' }),
    email: text(b.email, 120, { label: 'Email' }).toLowerCase(),
    size: intIn(b.size, 1, db.settings.roomCapacity, 'Party size'),
    amountPaid: Number(b.amountPaid) >= 0 ? Math.round(Number(b.amountPaid) * 100) / 100 : 0,
    method: text(b.method, 30, { label: 'Payment method' }) || 'Cash',
    note: text(b.note, 200, { label: 'Note' }),
    status: 'waiting', placed: null, alertedAt: null, alertFor: null, createdAt: new Date().toISOString(),
  };
  if (!PHONE_RE.test(w.phone)) throw httpError(400, 'Enter a valid mobile number.');
  if (w.email && !EMAIL_RE.test(w.email)) throw httpError(400, 'Enter a valid email address, or leave it empty.');
  db.walkins.push(w);
  saveDb();
  json(res, 201, staffData());
}

function findWalkin(id) {
  const w = db.walkins.find((x) => x.id === id);
  if (!w) throw httpError(404, 'That standby entry no longer exists.');
  return w;
}

async function walkinAction(req, res, id, action) {
  const w = findWalkin(id);
  const body = action === 'refund' || action === 'unplace' ? {} : await readJson(req);
  if (action === 'alert' || action === 'place') {
    const slot = slotById(body.slotId);
    const room = roomById(body.roomId);
    if (!slot || !room) throw httpError(400, 'Pick the room and time with the open spot.');
    if (action === 'place') {
      const st = roomState(slot, room.id);
      if (st.doorFree < w.size) throw httpError(409, st.doorFree ? `Only ${st.doorFree} spots are open there right now.` : 'No spots are open there right now.');
      w.status = 'placed';
      w.placed = { slotId: slot.id, roomId: room.id, at: new Date().toISOString() };
      scheduleSync();
    } else {
      w.status = 'alerted';
      w.alertedAt = new Date().toISOString();
      w.alertFor = { slotId: slot.id, roomId: room.id };
      if (w.email) emailWalkinAlert(w, slot, room).catch((e) => console.error(e));
    }
  } else if (action === 'unplace') {
    w.status = 'waiting';
    w.placed = null;
    scheduleSync();
  } else if (action === 'refund') {
    if (w.status === 'placed') throw httpError(409, 'This person got a spot. Undo the placement first.');
    w.status = 'refunded';
    w.refundedAt = new Date().toISOString();
  }
  saveDb();
  json(res, 200, staffData());
}

function deleteWalkin(res, id) {
  const i = db.walkins.findIndex((x) => x.id === id);
  if (i < 0) throw httpError(404, 'That standby entry no longer exists.');
  db.walkins.splice(i, 1);
  saveDb();
  scheduleSync();
  json(res, 200, staffData());
}

async function updateSettings(req, res) {
  const b = await readJson(req);
  const s = JSON.parse(JSON.stringify(db.settings));
  s.eventName = text(b.eventName, 90, { required: true, label: 'Event name' });
  s.tagline = text(b.tagline, 200, { label: 'Tagline' });
  s.hostName = text(b.hostName, 90, { required: true, label: 'Hosted by' });
  s.contactInfo = text(b.contactInfo, 300, { label: 'Contact info', multiline: true });
  s.venue = text(b.venue, 120, { required: true, label: 'Venue' });
  s.venueAddress = text(b.venueAddress, 200, { label: 'Venue address' });
  s.mapUrl = text(b.mapUrl, 500, { label: 'Map link' });
  if (s.mapUrl && !/^https:\/\//i.test(s.mapUrl)) throw httpError(400, 'The map link must start with https://');
  s.description = text(b.description, 5000, { label: 'About the event', multiline: true });
  s.eventDate = text(b.eventDate, 10, { label: 'Event date' });
  if (s.eventDate && !DATE_RE.test(s.eventDate)) throw httpError(400, 'Pick a valid event date.');
  s.timezone = text(b.timezone, 60, { required: true, label: 'Time zone' });
  try { new Intl.DateTimeFormat('en-US', { timeZone: s.timezone }); } catch { throw httpError(400, 'That time zone isn’t recognized. Use a name like Asia/Manila.'); }
  if (isUtcZone(s.timezone)) throw httpError(400, 'Use the time zone where the event happens, like Asia/Manila. UTC is the server’s clock, so slots would open and close at the wrong time.');
  s.currency = text(b.currency, 5, { required: true, label: 'Currency' });
  const price = Number(b.pricePerPlayer);
  if (!Number.isFinite(price) || price < 0 || price > 1e6) throw httpError(400, 'Enter a price per player of 0 or more.');
  s.pricePerPlayer = Math.round(price * 100) / 100;
  s.paymentInstructions = text(b.paymentInstructions, 1000, { required: true, label: 'Payment instructions', multiline: true });
  s.registrationOpen = b.registrationOpen === true;
  s.arriveBefore = intIn(b.arriveBefore, 0, 120, 'Arrive-early minutes');
  s.alertBefore = intIn(b.alertBefore, 1, 120, 'Leader alert minutes');

  const sch = b.schedule || {};
  if (!TIME_RE.test(sch.firstStart || '') || !TIME_RE.test(sch.lastStart || '')) throw httpError(400, 'Enter the first and last start times.');
  const schedule = {
    firstStart: sch.firstStart, lastStart: sch.lastStart,
    length: intIn(sch.length, 10, 240, 'Game length'), every: intIn(sch.every, 10, 240, 'Time between starts'),
  };
  if (toMin(schedule.lastStart) < toMin(schedule.firstStart)) throw httpError(400, 'The last start time must be after the first.');
  if (schedule.every < schedule.length) throw httpError(400, 'Slots would overlap: the time between starts must be at least the game length.');
  if (toMin(schedule.lastStart) + schedule.length > 24 * 60) throw httpError(400, 'The last game must end before midnight.');
  const newIds = new Set(allSlots(schedule).map((x) => x.id));
  const stranded = db.bookings.filter((x) => !newIds.has(x.slotId) && x.payment !== 'rejected').length;
  if (stranded) throw httpError(409, `${stranded} booking${stranded === 1 ? ' is' : 's are'} in time slots this schedule would remove. Move them first.`);
  s.schedule = schedule;

  const cap = intIn(b.roomCapacity, 2, 20, 'Players per room');
  for (const slot of allSlots(schedule)) {
    for (const r of db.rooms) {
      const booked = sum(liveBookings(slot.id, r.id), (x) => x.players.length) + sum(placedWalkins(slot.id, r.id), (w) => w.size);
      if (booked > cap) throw httpError(409, `${r.name} at ${timeLabel(slot.start)} already has ${booked} players, more than ${cap}.`);
    }
  }
  s.roomCapacity = cap;

  s.publicUrl = text(b.publicUrl, 300, { label: 'Public link' }).replace(/\/+$/, '');
  if (s.publicUrl && !/^https?:\/\/[^\s/]+/i.test(s.publicUrl)) throw httpError(400, 'The public link must start with https:// (or http://).');
  const m = b.mail || {};
  s.mail.host = text(m.host, 120, { label: 'Email server' });
  s.mail.port = intIn(m.port || 465, 1, 65535, 'Email port');
  s.mail.user = text(m.user, 120, { label: 'Email address' });
  if (s.mail.user && !EMAIL_RE.test(s.mail.user)) throw httpError(400, 'Enter the full email address that sends tickets.');
  s.mail.fromName = text(m.fromName, 90, { label: 'Sender name' });
  if (typeof m.pass === 'string' && m.pass.trim()) s.mail.pass = m.pass.replace(/\s/g, '');
  if (m.clearPass === true) s.mail.pass = '';
  s.sheet.url = text((b.sheet || {}).url, 500, { label: 'Google Sheet script link' });
  if (s.sheet.url && !/^https:\/\/script\.google(usercontent)?\.com\//i.test(s.sheet.url)) throw httpError(400, 'Paste the web app link from Apps Script. It starts with https://script.google.com/');

  const rooms = Array.isArray(b.rooms) ? b.rooms : [];
  const nextRooms = db.rooms.map((r) => {
    const given = rooms.find((x) => x && x.id === r.id) || {};
    return {
      ...r,
      name: text(given.name, 60, { required: true, label: 'Room name' }),
      difficulty: intIn(given.difficulty, 1, 3, 'Difficulty'),
      teaser: text(given.teaser, 400, { label: 'Room description', multiline: true }),
    };
  });

  s.configured = true;
  db.settings = s;
  db.rooms = nextRooms;
  saveDb();
  scheduleSync();
  json(res, 200, staffData());
}

async function uploadImage(req, res) {
  const b = await readJson(req);
  const target = b.target;
  if (target !== 'poster' && !roomById(target)) throw httpError(400, 'Unknown image slot.');
  let old;
  let ref = null;
  if (b.remove !== true) {
    const img = decodeUpload(b.image, { allowPdf: false, label: 'image' });
    ref = await putBlob(`${target}-${Date.now()}.${img.ext}`, img.buf, img.type);
  }
  if (target === 'poster') { old = db.settings.poster; db.settings.poster = ref; }
  else { const r = roomById(target); old = r.image; r.image = ref; }
  saveDb();
  if (old) deleteBlob(old);
  json(res, 200, staffData());
}

function writeConfigFile() {
  fs.writeFileSync(CONFIG_FILE, [
    '# Escape room app: where the data lives (the event\'s Google Drive).',
    '# Put this file in the escape-room-booking folder on any laptop that should run the app.',
    '# Keep it private: anyone with these two lines can read and change the bookings.',
    `GOOGLE_SCRIPT_URL=${process.env.GOOGLE_SCRIPT_URL}`,
    `GOOGLE_SECRET=${process.env.GOOGLE_SECRET}`,
    '',
  ].join('\n'));
}

/** Settings › "Move data to Google Drive": copy this computer's data and files into the event's Drive and keep using it from there. */
async function enableGoogleStorage(res) {
  if (store.mode === 'google') throw httpError(409, 'Data is already stored in Google Drive.');
  if (!scriptUrl()) throw httpError(400, 'Save the Google connector link in Settings first.');
  const r = await callScript('load', { instance: store.instance });
  if (!r.ok) throw httpError(502, r.error || 'The Google connector did not answer. Click Test connection to see why.');
  if (r.state) throw httpError(409, 'That Google Drive already holds app data, maybe from another laptop. To use it here, put its config.env file in this app\'s folder and restart the app.');
  process.env.GOOGLE_SCRIPT_URL = scriptUrl();
  process.env.GOOGLE_SECRET = connectorSecret();
  store.mode = 'google';
  try {
    await migrateFilesToGoogle();
    store.dirty = true;
    await flushDb();
    if (store.lastError) throw new Error(store.lastError);
  } catch (err) {
    store.mode = 'local';
    delete process.env.GOOGLE_SCRIPT_URL;
    delete process.env.GOOGLE_SECRET;
    writeLocal();
    throw httpError(502, `Moving the data to Google Drive failed: ${err.message}`);
  }
  if (!process.env.RENDER) writeConfigFile();
  json(res, 200, staffData());
}

async function testEmail(req, res) {
  const b = await readJson(req);
  const to = text(b.to, 120, { required: true, label: 'Email' });
  if (!EMAIL_RE.test(to)) throw httpError(400, 'Enter a valid email address.');
  if (!mailReady()) throw httpError(400, 'Connect Google (or Gmail) in Settings and save, then send a test.');
  const rec = await sendEmail('test', to);
  if (rec.status !== 'sent') throw httpError(502, `Sending ${rec.status === 'queued' ? 'is delayed' : 'failed'}: ${rec.error}`);
  json(res, 200, { ok: true, data: staffData() });
}

/** Check the Google connector: which account it runs as, emails left today, and the sheet it writes to. */
async function testGoogle(res) {
  const status = { at: new Date().toISOString(), ok: false, account: '', remaining: null, sheet: '', error: '' };
  try {
    const r = await callScript('ping');
    if (r.ok) Object.assign(status, { ok: true, account: r.account || '', remaining: r.remaining ?? null, sheet: r.sheet || '' });
    else status.error = r.error || 'The connector did not answer as expected.';
  } catch (err) {
    status.error = err.message;
  }
  db.googleStatus = status;
  if (status.ok && typeof status.remaining === 'number') db.mailQuota = { remaining: status.remaining, at: status.at };
  saveDb();
  if (status.ok) retryQueued().catch(() => {});
  json(res, 200, { status, data: staffData() });
}

async function sendSavedEmail(res, id) {
  const rec = db.emails.find((e) => e.id === id);
  if (!rec) throw httpError(404, 'That email is no longer saved.');
  if (rec.status === 'sent') throw httpError(409, 'That email was already sent.');
  if (!mailReady()) throw httpError(400, 'Connect Google (or Gmail) in Settings first.');
  await deliver(rec);
  json(res, 200, { email: rec, data: staffData() });
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

async function serveReceipt(res, id) {
  const b = findBooking(id);
  if (!b.receiptFile) throw httpError(404, 'This booking has no receipt yet.');
  const buf = await getBlob(b.receiptFile);
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' }[b.receiptType] || '';
  res.writeHead(200, {
    'Content-Type': b.receiptType,
    'Content-Disposition': `inline; filename="receipt-${b.code}${ext}"`,
    'Cache-Control': 'private, max-age=600',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}

async function serveMedia(req, res, ref) {
  if (!publicMediaRefs().has(ref)) throw httpError(404, 'Not found.');
  const buf = await getBlob(ref);
  const kind = sniffFile(buf);
  res.writeHead(200, { 'Content-Type': kind ? kind.type : 'application/octet-stream', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

async function serveEmailPreview(res, id) {
  const rec = db.emails.find((e) => e.id === id);
  if (!rec) throw httpError(404, 'That email is no longer saved.');
  const m = renderEmail(rec);
  let html = m.html;
  // the preview is sandboxed, so inline the QR instead of linking to it
  for (const [cid, url] of Object.entries(m.cidMap || {})) {
    const m = url.match(/^\/t\/([A-Za-z0-9_-]+)\/qr\.png$/);
    const b = m && db.bookings.find((x) => x.token === m[1]);
    const src = b ? await QRCode.toDataURL(ticketUrl(b), { errorCorrectionLevel: 'M', margin: 2, width: 360 }) : url;
    html = html.split(`cid:${cid}`).join(src);
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(res) {
  const { header, rows } = sheetRows();
  const body = '﻿' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="escape-room-players.csv"',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* --------------------------------------------------------------- scheduler */

function runAlerts() {
  const day = eventDayState();
  if (day.phase !== 'day') return;
  for (const b of db.bookings) {
    if (b.payment === 'rejected' || b.flags.leaderAlerted) continue;
    const slot = slotById(b.slotId);
    if (!slot) continue;
    if (day.minutes < slot.startMin - db.settings.alertBefore || day.minutes >= slot.startMin) continue;
    const missing = b.players.filter((p) => !p.inAt);
    if (!missing.length) continue;
    b.flags.leaderAlerted = true;
    saveDb();
    emailLeaderAlert(b, slot, missing).catch((e) => console.error(e));
  }
}
setInterval(runAlerts, 30 * 1000).unref();

/* ------------------------------------------------------------------ routing */

/** Send a JSON answer, after any change has reached Google Drive (waits at most 15 s; failed saves keep retrying). */
async function json(res, status, obj) {
  if (store.mode === 'google' && (store.dirty || store.flushing)) {
    await Promise.race([flushDb(), new Promise((r) => setTimeout(r, 15000))]);
  }
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const ID = '([a-f0-9]{16})';
const TOKEN = '([A-Za-z0-9_-]{20,40})';

async function routeApi(req, res, p) {
  const m = req.method;
  let mm;
  if (m === 'GET' && p === '/api/ping') return json(res, 200, { ok: true }); // health check and keep-awake
  if (m === 'GET' && p === '/api/event') return json(res, 200, publicEvent());
  if (m === 'POST' && p === '/api/book') return handleBook(req, res);
  if (m === 'POST' && p === '/api/find') return handleFind(req, res);
  if ((mm = p.match(new RegExp(`^/api/ticket/${TOKEN}$`))) && m === 'GET') return json(res, 200, ticketView(findByToken(mm[1])));
  if ((mm = p.match(new RegExp(`^/api/ticket/${TOKEN}/receipt$`))) && m === 'POST') return handleReupload(req, res, mm[1]);
  if (m === 'POST' && p === '/api/staff/login') return handleLogin(req, res);

  if (p.startsWith('/api/staff/')) {
    if (!isStaff(req)) throw httpError(401, 'Sign in with the staff password.');
    if (m === 'POST' && p === '/api/staff/logout') {
      sessions.delete(parseCookies(req).escape_staff);
      res.setHeader('Set-Cookie', 'escape_staff=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/staff/data') return json(res, 200, staffData());
    if (m === 'GET' && p === '/api/staff/export.csv') return exportCsv(res);
    if (m === 'PUT' && p === '/api/staff/settings') return updateSettings(req, res);
    if (m === 'POST' && p === '/api/staff/images') return uploadImage(req, res);
    if (m === 'POST' && p === '/api/staff/test-email') return testEmail(req, res);
    if (m === 'POST' && p === '/api/staff/password') return changePassword(req, res);
    if (m === 'POST' && p === '/api/staff/release') return setRelease(req, res);
    if (m === 'POST' && p === '/api/staff/sheet/sync') { const st = await syncSheet(); return json(res, 200, { status: st, data: staffData() }); }
    if (m === 'POST' && p === '/api/staff/walkins') return addWalkin(req, res);
    if ((mm = p.match(new RegExp(`^/api/staff/by-token/${TOKEN}$`))) && m === 'GET') return json(res, 200, { booking: staffBooking(findByToken(mm[1])) });
    if ((mm = p.match(new RegExp(`^/api/staff/receipt/${ID}$`))) && m === 'GET') return serveReceipt(res, mm[1]);
    if ((mm = p.match(new RegExp(`^/api/staff/emails/${ID}$`))) && m === 'GET') return await serveEmailPreview(res, mm[1]);
    if ((mm = p.match(new RegExp(`^/api/staff/emails/${ID}/send$`))) && m === 'POST') return sendSavedEmail(res, mm[1]);
    if (m === 'POST' && p === '/api/staff/google/test') return testGoogle(res);
    if (m === 'POST' && p === '/api/staff/storage/google') return enableGoogleStorage(res);
    if (m === 'GET' && p === '/api/staff/google/script') {
      const src = fs.readFileSync(path.join(__dirname, 'google-connector.gs'), 'utf8')
        .replace("'PASTE-THE-SECRET-FROM-THE-DASHBOARD'", `'${connectorSecret()}'`)
        .replace("'PASTE-THE-APP-LINK'", `'${baseUrl()}'`)
        .replace(/^\/\/ The staff dashboard[^\n]*\n\/\/ already filled in[^\n]*\n/m, '// Your secret key and app link are already filled in below.\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(src);
    }
    if ((mm = p.match(new RegExp(`^/api/staff/bookings/${ID}(/[a-z]+)?$`)))) {
      const [, id, sub] = mm;
      if (m === 'DELETE' && !sub) return deleteBooking(res, id);
      if (m === 'POST' && sub === '/payment') return setPayment(req, res, id);
      if (m === 'POST' && sub === '/checkin') return setCheckin(req, res, id);
      if (m === 'POST' && sub === '/move') return moveBooking(req, res, id);
      if (m === 'POST' && sub === '/resend') return resendEmail(res, id);
    }
    if ((mm = p.match(new RegExp(`^/api/staff/walkins/${ID}(/[a-z]+)?$`)))) {
      const [, id, sub] = mm;
      if (m === 'DELETE' && !sub) return deleteWalkin(res, id);
      if (m === 'POST' && ['/alert', '/place', '/unplace', '/refund'].includes(sub)) return walkinAction(req, res, id, sub.slice(1));
    }
  }
  throw httpError(404, 'Not found.');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self'",
  "frame-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

function sendFile(req, res, file, { html = false, cache = 'no-cache' } = {}) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw httpError(404, 'Not found.');
  const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': html ? 'no-store' : cache };
  if (html) {
    headers['Content-Security-Policy'] = CSP;
    headers['Referrer-Policy'] = 'same-origin';
    headers['Permissions-Policy'] = 'camera=(self), microphone=(), geolocation=()';
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function routePage(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Method not allowed.');
  let mm;
  if (p === '/') return sendFile(req, res, path.join(PUBLIC_DIR, 'index.html'), { html: true });
  if (p === '/staff' || p === '/staff/') return sendFile(req, res, path.join(PUBLIC_DIR, 'staff.html'), { html: true });
  if (p === '/staff/scan') return sendFile(req, res, path.join(PUBLIC_DIR, 'scan.html'), { html: true });
  if ((mm = p.match(new RegExp(`^/staff/receipt/${ID}$`)))) {
    if (!isStaff(req)) { res.writeHead(302, { Location: '/staff' }); return res.end(); }
    return serveReceipt(res, mm[1]);
  }
  if ((mm = p.match(new RegExp(`^/t/${TOKEN}$`)))) return sendFile(req, res, path.join(PUBLIC_DIR, 'ticket.html'), { html: true });
  if ((mm = p.match(new RegExp(`^/t/${TOKEN}/qr\\.(svg|png)$`)))) return serveQr(res, mm[1], mm[2]);
  if (p === '/vendor/jsQR.js') return sendFile(req, res, JSQR_FILE, { cache: 'public, max-age=86400' });
  if (p === '/favicon.ico') return sendFile(req, res, path.join(PUBLIC_DIR, 'favicon.svg'));
  if (p.startsWith('/media/')) {
    let ref;
    try { ref = decodeURIComponent(p.slice('/media/'.length)); } catch { throw httpError(400, 'Bad path.'); }
    return serveMedia(req, res, ref);
  }
  if (p.startsWith('/static/')) {
    let rel;
    try { rel = decodeURIComponent(p.slice('/static/'.length)); } catch { throw httpError(400, 'Bad path.'); }
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw httpError(404, 'Not found.');
    return sendFile(req, res, file);
  }
  res.writeHead(302, { Location: '/' });
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p.startsWith('/api/')) await routeApi(req, res, p);
    else await routePage(req, res, p);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Something went wrong on the server. Try again.' : err.message, code: err.code });
    else res.end();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is already in use. Close the other window running the app, or start it on another port (set PORT=3001).\n`);
  else console.error(err);
  process.exit(1);
});

// save anything pending to Google Drive before the app stops (Ctrl+C, or the host restarting it)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (store.mode === 'google' && (store.dirty || store.flushing)) {
      console.log('Saving to Google Drive before stopping…');
      await Promise.race([flushDb(), new Promise((r) => setTimeout(r, 10000))]);
    }
    process.exit(0);
  });
}

(async () => {
  // brief network or Google hiccups get a few retries; setup mistakes stop right away with the fix spelled out
  for (let attempt = 1; ; attempt++) {
    try {
      await loadState();
      break;
    } catch (err) {
      if (err.retry && attempt < 4) {
        console.error(`Loading from Google Drive failed (try ${attempt} of 4), retrying in ${attempt * 5} s: ${err.message}`);
        await new Promise((r) => setTimeout(r, attempt * 5000));
        continue;
      }
      console.error(`\nCouldn't load the data from Google Drive.\n${err.message}\n\nAlso check that GOOGLE_SCRIPT_URL and GOOGLE_SECRET (in config.env or the host's Environment settings) match the script, and that the script was copied from this app's staff dashboard.\n`);
      process.exit(1);
    }
  }
  passwordNote = initAdmin();
  saveDb();
  server.listen(PORT, HOST, onListening);
})();

function onListening() {
  const line = '-'.repeat(62);
  console.log(`\n${line}\n  Escape room booking is running\n${line}`);
  const pub = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || db.settings.publicUrl;
  if (pub) {
    const base = pub.replace(/\/+$/, '');
    console.log(`  Share this link   ${base}`);
    console.log(`  Staff dashboard   ${base}/staff`);
    console.log(`  Door scanner      ${base}/staff/scan`);
    console.log(`  On this computer  http://localhost:${PORT}`);
  } else {
    console.log(`  Booking page      http://localhost:${PORT}`);
    for (const u of shareUrls()) console.log(`  Same Wi-Fi        ${u}`);
    console.log(`  Staff dashboard   http://localhost:${PORT}/staff`);
    console.log(`  Door scanner      http://localhost:${PORT}/staff/scan`);
  }
  console.log(`  Email             ${{ smtp: 'Gmail (app password)', google: 'Google connector', preview: 'not connected: emails are only saved' }[mailMode()]}`);
  console.log(`  Data              ${store.mode === 'google' ? 'Google Drive (any laptop with config.env sees the same data)' : `this computer (${DATA_DIR})`}`);
  console.log(`  Staff password    ${passwordNote}`);
  const now = nowInTz();
  console.log(`  Time zone         ${db.settings.timezone} (event clock now ${now.date} ${fromMin(now.minutes)})`);
  if (process.env.FAKE_NOW) console.log(`  Clock override    FAKE_NOW=${process.env.FAKE_NOW}`);
  console.log(`${line}\n  Keep this window open while people book. Press Ctrl+C to stop.\n`);
}
