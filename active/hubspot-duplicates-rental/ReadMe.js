/**
 * @fileoverview Generates a "Read Me" sheet tab documenting the Duplicate
 * Tools rules in plain, formatted Google Sheets cells - no markdown syntax,
 * so it's readable directly in the spreadsheet rather than only in the
 * Apps Script editor. Run buildReadMeSheet() once (or re-run it any time
 * the rules change) to (re)create the tab.
 */

function buildReadMeSheet() {
  new ReadMeBuilder().build();
}

var ReadMeBuilder = function() {
  const SHEET_NAME = 'Read Me';

  this.build = () => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (sheet) {
      sheet.clear();
    } else {
      sheet = ss.insertSheet(SHEET_NAME, 0); // pin as the first tab
    }

    sheet.setColumnWidth(1, 340);
    sheet.setColumnWidth(2, 340);
    sheet.setColumnWidth(3, 200);

    let row = 1;
    row = writeTitle_(sheet, row, 'HubSpot Duplicate Detection — Rules Reference');
    row = writeParagraph_(sheet, row,
      'How the Duplicate Tools script decides how likely a pair of contacts is to be a ' +
      'duplicate, which pairs get auto-merged, and which contact survives a merge.');

    row = writeHeading_(sheet, row, '1. How every pair gets scored (Duplicate Ratings sheet)');
    row = writeParagraph_(sheet, row,
      'Every row starts at 0 points. Points are added for each matching signal found, then capped at 100.');
    row = writeTable_(sheet, row, ['Signal', 'Points', 'Notes'], [
      ['Email identical', '45', 'Exact match'],
      ['Same domain, punctuation-only difference (e.g. john.smith vs johnsmith)', '40', 'Near-certainly the same mailbox'],
      ['Same username, domain is a known typo (e.g. gmsil.com to gmail.com)', '38', 'Edit distance 1-2 from a real provider'],
      ['Same username, domain is a known alias (e.g. gmail.com / googlemail.com)', '38', 'Literally the same mailbox'],
      ['Same domain, near-identical username (typo in the name part)', '15', 'Edit distance <=2'],
      ['Same distinctive username (6+ chars), different unrelated providers', '30', 'e.g. janedoe123@gmail.com vs janedoe123@yahoo.com'],
      ['Same short/common username, different unrelated providers', '12', 'Weaker - common usernames can coincide'],
      ['Phone or mobile number matches', '25', ''],
      ['First name identical', '10', ''],
      ['First name near-identical (nickname/typo)', '6', ''],
      ['Last name identical', '15', ''],
      ['Last name near-identical', '8', ''],
      ['Company identical (after stripping Ltd/Inc/Limited/etc.)', '8', ''],
      ['Company near-identical', '4', ''],
      ['Created within 5 minutes of each other', '20', 'Strongest timing signal - likely a resubmission'],
      ['Created within 1 hour', '12', ''],
      ['Created within 1 day', '6', ''],
      ['Same city / country / zip', '3 / 2 / 4', 'Weak, corroborating only']
    ]);

    row = writeSubheading_(sheet, row, 'Rating bands');
    row = writeTable_(sheet, row, ['Score', 'Rating'], [
      ['65+', 'Very High'],
      ['45-64', 'High'],
      ['25-44', 'Medium'],
      ['0-24', 'Low']
    ]);

    row = writeHeading_(sheet, row, '2. Which pairs get auto-merged (no human review)');
    row = writeParagraph_(sheet, row,
      'Auto-merge is deliberately much stricter than the scoring above. A pair only qualifies ' +
      'if first name AND last name both match exactly, plus one of these four patterns:');
    row = writeNumberedList_(sheet, row, [
      ['Same mailbox, punctuation variant', 'Same domain, username identical once dots/hyphens/underscores/+tags are stripped. Safest pattern - same provider, same underlying inbox.'],
      ['Same username, phone also matches', 'Usernames match exactly, domains are unrelated. The matching phone number is treated as independent proof it is the same person.'],
      ['Known domain alias or typo', 'The two domains are either a recognised alias pair (gmail.com/googlemail.com, gmail.com/google.com, outlook.com.au/outlook.au, or Apple\u2019s icloud.com/me.com/mac.com - all three are genuinely the same mailbox depending on how old the Apple ID is) or one is a 1-2 character typo of a recognised real provider (gmail.com, outlook.com, yahoo.com, sbcglobal.net, etc. - see the editable list in the script).'],
      ['Same domain, near-identical username, created within 5 minutes', 'A real (not punctuation-only) difference in the username, only trusted when created within 5 minutes of each other (e.g. a system-generated tracking address, or a resubmitted form). Without that tight timing, a same-domain near-miss stays manual.']
    ]);
    row = writeParagraph_(sheet, row,
      'Deliberately excluded from auto-merge: same username on two unrelated real providers with no ' +
      'phone match and no domain relationship (e.g. vbquilter@triad.com vs vbquilter@gmail.com) - a decent ' +
      'manual-review signal, but not proof on its own.');

    row = writeHeading_(sheet, row, '3. Which contact survives the merge ("Suggested Master ID")');
    row = writeNumberedList_(sheet, row, [
      ['Domain-typo pair', 'The contact with the correct/real domain always wins, regardless of which record is older. A typo must never become the surviving contact\u2019s email address.'],
      ['Otherwise', 'Whichever contact was created earlier wins.'],
      ['If neither record has a usable creation date', 'Defaults to the first ID in the pair - an arbitrary fallback, flagged as such in the "Primary Reason" column.']
    ]);
    row = writeParagraph_(sheet, row,
      'This suggestion is shown on every row, not just auto-merge candidates, so a human merging a ' +
      '"High" or "Medium" row manually doesn\u2019t have to work it out by hand.');

    row = writeHeading_(sheet, row, '4. What\'s logged');
    row = writeBulletList_(sheet, row, [
      ['Auto-Merge Candidates (Dry Run)', 'Every pair the rules above flagged, with the pattern, reasoning, and suggested master ID. Nothing is merged while DRY_RUN = true.'],
      ['Merge Log', 'A permanent, append-only record of every merge ever attempted (dry-run or live): timestamp, both IDs, result (MERGED / FAILED / ALREADY MERGED (now <id>) / DRY RUN), and the full error detail on failure.'],
      ['Duplicate Ratings', 'Every pair, scored, with a Yes/No flag for auto-merge eligibility so nothing is hidden from the manual reviewer.']
    ]);

    sheet.setFrozenRows(2);
    Logger.log(`[ReadMeBuilder.build] complete | rows=${row - 1}`);
  };

  /** @param {Sheet} sheet @param {number} row @param {string} text @returns {number} next free row */
  const writeTitle_ = (sheet, row, text) => {
    sheet.getRange(row, 1).setValue(text).setFontSize(16).setFontWeight('bold').setFontColor('#4472C4');
    return row + 2;
  };

  const writeHeading_ = (sheet, row, text) => {
    sheet.getRange(row, 1).setValue(text).setFontSize(13).setFontWeight('bold').setFontColor('#2c4a7c');
    return row + 1;
  };

  const writeSubheading_ = (sheet, row, text) => {
    sheet.getRange(row, 1).setValue(text).setFontWeight('bold');
    return row + 1;
  };

  const writeParagraph_ = (sheet, row, text) => {
    sheet.getRange(row, 1, 1, 3).merge().setValue(text).setWrap(true).setVerticalAlignment('top');
    sheet.setRowHeight(row, Math.max(21, Math.ceil(text.length / 90) * 16));
    return row + 2;
  };

  /** @returns {number} next free row */
  const writeTable_ = (sheet, row, headers, dataRows) => {
    const width = headers.length;
    sheet.getRange(row, 1, 1, width).setValues([headers])
      .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#4472C4');
    if (dataRows.length > 0) {
      sheet.getRange(row + 1, 1, dataRows.length, width).setValues(dataRows).setWrap(true).setVerticalAlignment('top');
    }
    return row + dataRows.length + 2;
  };

  const writeNumberedList_ = (sheet, row, items) => {
    items.forEach((item, i) => {
      const text = `${i + 1}. ${item[0]}\n${item[1]}`;
      sheet.getRange(row, 1, 1, 3).merge().setValue(text).setWrap(true).setVerticalAlignment('top');
      sheet.setRowHeight(row, Math.max(34, Math.ceil(text.length / 90) * 16));
      row += 1;
    });
    return row + 1;
  };

  const writeBulletList_ = (sheet, row, items) => {
    items.forEach((item) => {
      const text = `\u2022 ${item[0]} - ${item[1]}`;
      sheet.getRange(row, 1, 1, 3).merge().setValue(text).setWrap(true).setVerticalAlignment('top');
      sheet.setRowHeight(row, Math.max(21, Math.ceil(text.length / 90) * 16));
      row += 1;
    });
    return row + 1;
  };
};