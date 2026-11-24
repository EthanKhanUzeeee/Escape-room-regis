// Escape room booking: Google connector. Stores the app's data and files in this Google account's Drive,
// sends email from its Gmail, and keeps the Google Sheet up to date.
// The staff dashboard (Settings > Connect Google) shows this same script with your secret key and app link
// already filled in. Copy it from there; this file is only a reference copy.
const SECRET = 'PASTE-THE-SECRET-FROM-THE-DASHBOARD';
const APP_URL = 'PASTE-THE-APP-LINK';
const SHEET_NAME = 'Master';
const DATA_FOLDER = 'Escape Room App Data';

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: 'The request could not be read.' });
  }
  if (body.secret !== SECRET) return reply({ ok: false, error: 'Wrong secret key. Copy the script again from the staff dashboard.' });
  try {
    switch (body.action) {
      case 'load': return reply(loadState());
      case 'save': return reply(saveState(body));
      case 'putFile': return reply(putFile(body));
      case 'getFile': return reply(getFile(body));
      case 'deleteFile': return reply(deleteFile(body));
      case 'email': return reply(sendEmail(body));
      case 'ping':
        return reply({
          ok: true,
          account: Session.getEffectiveUser().getEmail(),
          remaining: MailApp.getRemainingDailyQuota(),
          sheet: SpreadsheetApp.getActiveSpreadsheet().getName(),
          folder: dataFolder().getName(),
        });
      default: return reply(syncSheet(body));
    }
  } catch (err) {
    return reply({ ok: false, error: String((err && err.message) || err) });
  }
}

/* ---------------------------------------------------------------- data file */

function props() {
  return PropertiesService.getScriptProperties();
}

function dataFolder() {
  const id = props().getProperty('folderId');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* deleted: make a new one */ }
  }
  const folder = DriveApp.createFolder(DATA_FOLDER);
  props().setProperty('folderId', folder.getId());
  return folder;
}

function subFolder(name) {
  const parent = dataFolder();
  const found = parent.getFoldersByName(name);
  return found.hasNext() ? found.next() : parent.createFolder(name);
}

function stateFile(create) {
  const id = props().getProperty('stateId');
  if (id) {
    try { return DriveApp.getFileById(id); } catch (err) { /* deleted */ }
  }
  if (!create) return null;
  const file = dataFolder().createFile('escape-room-data.json', '{}', 'application/json');
  props().setProperty('stateId', file.getId());
  return file;
}

function loadState() {
  const file = stateFile(false);
  if (!file) return { ok: true, state: null };
  const text = file.getBlob().getDataAsString('UTF-8');
  return { ok: true, state: text && text !== '{}' ? text : null, savedAt: props().getProperty('savedAt') };
}

// Saves the whole data file. Tells the app if a different copy of it saved in the last 5 minutes,
// because two copies running at once would overwrite each other's changes.
function saveState(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const p = props();
    const lastBy = p.getProperty('savedBy');
    const lastAt = Number(p.getProperty('savedAtMs') || 0);
    const otherWriter = !!(lastBy && lastBy !== body.instance && Date.now() - lastAt < 5 * 60 * 1000);
    stateFile(true).setContent(body.state);
    p.setProperties({ savedBy: String(body.instance || ''), savedAtMs: String(Date.now()), savedAt: new Date().toISOString() });
    backupHourly(body.state);
    return { ok: true, otherWriter: otherWriter };
  } finally {
    lock.releaseLock();
  }
}

// Keeps a copy of the data file every hour in Escape Room App Data/Backups (the newest 72 are kept).
function backupHourly(state) {
  const p = props();
  if (Date.now() - Number(p.getProperty('backupAtMs') || 0) < 60 * 60 * 1000) return;
  const folder = subFolder('Backups');
  folder.createFile('escape-room-data ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH-mm') + '.json', state, 'application/json');
  p.setProperty('backupAtMs', String(Date.now()));
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(72).forEach(function (f) { f.setTrashed(true); });
}

/* ------------------------------------------------- receipts and pictures */

function putFile(body) {
  const blob = Utilities.newBlob(Utilities.base64Decode(body.data), body.type || 'application/octet-stream', body.name || 'file');
  const file = subFolder('Files').createFile(blob);
  return { ok: true, id: file.getId() };
}

// Only hands out files the app stored itself.
function appFile(id) {
  const file = DriveApp.getFileById(id);
  const filesId = subFolder('Files').getId();
  const parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === filesId) return file;
  throw new Error('That file is not one of the app\'s files.');
}

function getFile(body) {
  const file = appFile(body.id);
  return { ok: true, data: Utilities.base64Encode(file.getBlob().getBytes()), type: file.getMimeType() };
}

function deleteFile(body) {
  try { appFile(body.id).setTrashed(true); } catch (err) { /* already gone */ }
  return { ok: true };
}

/* -------------------------------------------------------------------- email */

// Sends one email from this Google account. Gmail allows about 100 a day (1,500 on Google Workspace);
// when the limit is reached the app keeps the email and tries again later.
function sendEmail(body) {
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, quota: true, error: 'Daily email limit reached. The app will retry later.' };
  const inlineImages = {};
  (body.inline || []).forEach(function (img) {
    inlineImages[img.cid] = Utilities.newBlob(Utilities.base64Decode(img.data), img.type || 'image/png', img.name || 'image.png');
  });
  try {
    MailApp.sendEmail({ to: body.to, subject: body.subject, htmlBody: body.html, body: body.text || '', name: body.name || 'Escape Room', inlineImages: inlineImages });
  } catch (err) {
    const msg = String((err && err.message) || err);
    return { ok: false, quota: /too many times|quota|limit/i.test(msg), error: msg };
  }
  return { ok: true, remaining: MailApp.getRemainingDailyQuota() };
}

/* ------------------------------------------------------------- Google Sheet */

// Rewrites the Master tab: one row per player, sorted by time, then room, then team.
function syncSheet(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME, 0);
    const width = body.header.length;
    const rows = [body.header].concat(body.rows);
    sheet.clear();
    sheet.getRange(1, 1, rows.length, width).setNumberFormat('@').setValues(rows);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#0a2225').setFontColor('#e2b05a');
    // shade every other room-and-time group so each roster stands out
    const colors = [];
    let shade = false;
    let last = null;
    body.rows.forEach(function (r) {
      const key = r[0] + '|' + r[1];
      if (key !== last) { shade = !shade; last = key; }
      colors.push(new Array(width).fill(shade ? '#f4f7f6' : '#ffffff'));
    });
    if (colors.length) sheet.getRange(2, 1, colors.length, width).setBackgrounds(colors);
    sheet.autoResizeColumns(1, width);
    sheet.getRange(1, width + 2).setValue('Last synced ' + new Date().toLocaleString());
    return { ok: true, rows: body.rows.length };
  } finally {
    lock.releaseLock();
  }
}

/* --------------------------------------------- keep a free cloud host awake */

// Free hosts (like Render) put the app to sleep after 15 quiet minutes, and waking takes about a minute.
// Run installKeepAwake once (select it above and click Run) to visit the app every 10 minutes.
function keepAwake() {
  if (APP_URL.indexOf('https://') !== 0) return;
  try { UrlFetchApp.fetch(APP_URL + '/api/ping', { muteHttpExceptions: true }); } catch (err) { /* try again next time */ }
}

function installKeepAwake() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'keepAwake') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('keepAwake').timeBased().everyMinutes(10).create();
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
