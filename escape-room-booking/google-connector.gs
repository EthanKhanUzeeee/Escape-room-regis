// Escape room booking: Google connector (Google Sheet + Gmail).
// The staff dashboard (Settings > Google Sheet and Gmail) shows this same script with your secret key
// already filled in. Copy it from there; this file is only a reference copy.
const SECRET = 'PASTE-THE-SECRET-FROM-THE-DASHBOARD';
const SHEET_NAME = 'Master';

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: 'The request could not be read.' });
  }
  if (body.secret !== SECRET) return reply({ ok: false, error: 'Wrong secret key. Copy the script again from the staff dashboard.' });
  try {
    if (body.action === 'email') return reply(sendEmail(body));
    if (body.action === 'ping') {
      return reply({
        ok: true,
        account: Session.getEffectiveUser().getEmail(),
        remaining: MailApp.getRemainingDailyQuota(),
        sheet: SpreadsheetApp.getActiveSpreadsheet().getName(),
      });
    }
    return reply(syncSheet(body));
  } catch (err) {
    return reply({ ok: false, error: String((err && err.message) || err) });
  }
}

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

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
