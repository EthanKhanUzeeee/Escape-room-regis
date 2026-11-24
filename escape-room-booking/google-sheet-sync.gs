// Escape room booking -> Google Sheet.
// The staff dashboard (Settings > Connect the Google Sheet) shows this same script with your
// secret key already filled in. Copy it from there; this file is only a reference copy.
const SECRET = 'PASTE-THE-SECRET-FROM-THE-DASHBOARD';
const SHEET_NAME = 'Master';

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return reply({ ok: false, error: 'Wrong secret key. Copy the script again from the staff dashboard.' });
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
    for (const r of body.rows) {
      const key = r[0] + '|' + r[1];
      if (key !== last) { shade = !shade; last = key; }
      colors.push(new Array(width).fill(shade ? '#f4f7f6' : '#ffffff'));
    }
    if (colors.length) sheet.getRange(2, 1, colors.length, width).setBackgrounds(colors);
    sheet.autoResizeColumns(1, width);
    sheet.getRange(1, width + 2).setValue('Last synced ' + new Date().toLocaleString());
    return reply({ ok: true, rows: body.rows.length });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
