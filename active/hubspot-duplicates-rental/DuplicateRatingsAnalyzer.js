/**
 * @fileoverview Scores HubSpot contact duplicate-pair exports and splits each row
 * into either:
 *   - Auto-Merge Candidates (Dry Run): "obvious, low-risk" domain-alias or
 *     email-spelling-typo pairs where the contact's first+last name also match.
 *     Logged only - DRY_RUN gates the actual merge call.
 *   - Duplicate Ratings: everything else, scored and rated for manual review.
 *
 * Reads the "Raw - Duplicates" tab so this can be re-run every time a fresh
 * export is pasted into that same tab, without touching the code.
 */

// Global wrappers (menu / manual run only)
function runDuplicateRatings() { new DuplicateRatingsAnalyzer().run(); }
function runDuplicateRatingsOnly() { new DuplicateRatingsAnalyzer().runRatingsOnly(); }

/**
 * Manually merges two specific contact IDs via the LIVE HubSpot API - for
 * testing the merge endpoint directly, independent of DRY_RUN and the
 * auto-merge classifier. Edit the parameters below and run this function
 * directly from the Apps Script editor (select it in the dropdown, then Run).
 * @param {string|number} primaryId - the contact ID that will survive the merge
 * @param {string|number} secondaryId - the contact ID that gets merged away
 */
function testMergeContacts(primaryId, secondaryId) {
  new DuplicateRatingsAnalyzer().testMerge(primaryId, secondaryId);
}

/**
 * Same as testMergeContacts, but prompts for the two IDs interactively -
 * for use from the spreadsheet menu without opening the script editor.
 */
function testMergeContactsPrompt() {
  const ui = SpreadsheetApp.getUi();
  const primaryResponse = ui.prompt(
    'Test Merge - Step 1 of 2',
    'Enter the PRIMARY contact ID (this record SURVIVES the merge):',
    ui.ButtonSet.OK_CANCEL
  );
  if (primaryResponse.getSelectedButton() !== ui.Button.OK) return;

  const secondaryResponse = ui.prompt(
    'Test Merge - Step 2 of 2',
    'Enter the SECONDARY contact ID (this record gets MERGED AWAY):',
    ui.ButtonSet.OK_CANCEL
  );
  if (secondaryResponse.getSelectedButton() !== ui.Button.OK) return;

  new DuplicateRatingsAnalyzer().testMerge(
    primaryResponse.getResponseText().trim(),
    secondaryResponse.getResponseText().trim()
  );
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Duplicate Tools')
    .addItem('Run Duplicate Detection (auto-merge + ratings)', 'runDuplicateRatings')
    .addItem('Run Ratings Only (no auto-merge)', 'runDuplicateRatingsOnly')
    .addSeparator()
    .addItem('Test Merge (enter 2 IDs)', 'testMergeContactsPrompt')
    .addToUi();
}

var DuplicateRatingsAnalyzer = function() {

  const SOURCE_SHEET_NAME = 'Raw - Duplicates';
  const OUTPUT_SHEET_NAME = 'Duplicate Ratings';
  const AUTO_MERGE_SHEET_NAME = 'Auto-Merge Candidates (Dry Run)';
  const MERGE_LOG_SHEET_NAME = 'Merge Log';

  // Set to false only after reviewing dry-run output and testing mergeContact_
  // against a couple of real pairs by hand.
  const DRY_RUN = false;

  // Known-equivalent domain pairs. Add more here as you confirm them - a wrong
  // equivalence merges two genuinely different mailboxes, so don't guess.
  const DOMAIN_ALIAS_GROUPS = [
    ['gmail.com', 'googlemail.com'],
    ['outlook.com.au', 'outlook.au'],
    // "google.com" is a common misconception, not a typo (people believe their
    // Gmail address's domain is google.com) - but it's also Google's real
    // internal corporate email domain, so this could misfire on an actual
    // Google employee contact. Judged an acceptable trade-off for this business.
    ['gmail.com', 'google.com'],
    // Apple's iCloud Mail: depending on when someone's Apple ID was created,
    // icloud.com/me.com/mac.com can all be genuine, interchangeable addresses
    // for the exact same mailbox - not a typo relationship at all.
    ['icloud.com', 'me.com', 'mac.com']
  ];

  // Common webmail domains used as the "correct" target when checking whether a
  // domain looks like a 1-2 character typo of a real provider.
  const CANONICAL_DOMAINS = [
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.nz', 'yahoo.com.au', 'yahoo.co.uk',
    'hotmail.com', 'hotmail.co.nz', 'hotmail.co.uk', 'outlook.com', 'outlook.co.nz',
    'outlook.com.au', 'outlook.au', 'icloud.com', 'me.com', 'aol.com', 'msn.com', 'xtra.co.nz',
    'sbcglobal.net', 'att.net', 'comcast.net', 'verizon.net', 'bigpond.com'
  ];

  const AUTO_MERGE_HEADERS = [
    'ID_1', 'ID_2', 'Email_1', 'Email_2', 'Name_1', 'Name_2', 'Pattern', 'Detail',
    'Suggested Master ID', 'Primary Reason', 'Status'
  ];

  // Merge Log is append-only across runs - never cleared - so there's a
  // permanent record of every merge attempted, dry-run or live.
  const MERGE_LOG_HEADERS = [
    'Timestamp', 'Primary ID', 'Secondary ID', 'Primary Reason', 'Name_1', 'Name_2', 'Email_1', 'Email_2',
    'Pattern', 'Detail', 'Dry Run', 'Result', 'HTTP Status', 'Error Message'
  ];

  const RATING_THRESHOLDS = [
    { min: 65, label: 'Very High' },
    { min: 45, label: 'High' },
    { min: 25, label: 'Medium' },
    { min: 0,  label: 'Low' }
  ];

  const RATING_COLORS = {
    'Very High': '#C6EFCE',
    'High': '#E2EFDA',
    'Medium': '#FFEB9C',
    'Low': '#FFC7CE'
  };

  const OUTPUT_HEADERS = [
    'ID_1', 'ID_2', 'Suggested Master ID', 'Name_1', 'Name_2', 'Email_1', 'Email_2', 'Phone_1', 'Phone_2',
    'Company_1', 'Company_2', 'Score', 'Rating', 'Reasons', 'Would Auto-Merge', 'Auto-Merge Detail'
  ];

  const SOURCE_COLUMNS = [
    'ID_1', 'ID_2', 'FIRSTNAME_1', 'FIRSTNAME_2', 'LASTNAME_1', 'LASTNAME_2',
    'EMAIL_1', 'EMAIL_2', 'PHONE_1', 'PHONE_2', 'MOBILEPHONE_1', 'MOBILEPHONE_2',
    'COMPANY_1', 'COMPANY_2', 'CITY_1', 'CITY_2', 'COUNTRY_1', 'COUNTRY_2', 'ZIP_1', 'ZIP_2',
    'CREATEDATE_1', 'CREATEDATE_2'
  ];

  // Common legal-entity suffixes stripped before comparing company names, so
  // "Acme Ltd" / "Acme Limited" / "ACME" are treated as the same company.
  const COMPANY_SUFFIXES_ = [
    'limited', 'ltd', 'llc', 'llp', 'inc', 'incorporated', 'corp', 'corporation',
    'co', 'company', 'plc', 'pty', 'pvt', 'group', 'holdings'
  ];

  // Time-proximity tiers: two records created close together are one of the
  // strongest real-world duplicate signals (form re-submission, retry after an error, etc.)
  const TIME_PROXIMITY_TIERS = [
    { maxMinutes: 5, points: 20, label: 'Created within 5 minutes of each other' },
    { maxMinutes: 60, points: 12, label: 'Created within 1 hour of each other' },
    { maxMinutes: 60 * 24, points: 6, label: 'Created within 1 day of each other' }
  ];

  /**
   * Entry point. Reads the "Raw - Duplicates" tab, classifies every row as an
   * auto-merge candidate or a manual-review candidate, and (re)writes both sheets.
   */
  this.run = () => {
    Logger.log('[DuplicateRatingsAnalyzer.run] starting');
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sourceSheet = ss.getSheetByName(SOURCE_SHEET_NAME);

    if (!sourceSheet) {
      const msg = `No sheet found named "${SOURCE_SHEET_NAME}". Rename your export tab and re-run.`;
      Logger.log(`[DuplicateRatingsAnalyzer.run] error=${msg}`);
      SpreadsheetApp.getUi().alert(msg);
      return;
    }
    Logger.log(`[DuplicateRatingsAnalyzer.run] sourceSheet=${sourceSheet.getName()}`);

    const { header, rows } = readSourceData_(sourceSheet);
    Logger.log(`[DuplicateRatingsAnalyzer.run] rowCount=${rows.length}`);

    const colIndex = buildColumnIndex_(header);
    const autoMergeCandidates = [];
    const manualReviewResults = [];

    rows.forEach((row) => {
      const get = (name) => {
        const idx = colIndex[name];
        return idx === undefined || idx === -1 ? '' : row[idx];
      };

      const autoMergeMatch = classifyRowForAutoMerge_(get);
      const scored = scoreRow_(get);
      scored.wouldAutoMerge = !!autoMergeMatch;
      scored.autoMergeDetail = autoMergeMatch ? `${autoMergeMatch.pattern}: ${autoMergeMatch.detail}` : '';
      manualReviewResults.push(scored);

      if (autoMergeMatch) {
        autoMergeCandidates.push(autoMergeMatch);
      }
    });

    manualReviewResults.sort((a, b) => b.score - a.score);

    const mergeResults = processMergeCandidates_(autoMergeCandidates);

    writeAutoMergeSheet_(ss, mergeResults);
    writeOutput_(ss, manualReviewResults);
    appendMergeLog_(ss, mergeResults);

    const mergedCount = mergeResults.filter((r) => r.result === 'MERGED').length;
    const failedCount = mergeResults.filter((r) => r.result === 'FAILED').length;
    const dryRunCount = mergeResults.filter((r) => r.result === 'DRY RUN - NOT MERGED').length;

    Logger.log(
      `[DuplicateRatingsAnalyzer.run] complete | autoMerge=${autoMergeCandidates.length} ` +
      `merged=${mergedCount} failed=${failedCount} dryRun=${dryRunCount} | ` +
      `veryHigh=${countRating_(manualReviewResults, 'Very High')} high=${countRating_(manualReviewResults, 'High')} ` +
      `medium=${countRating_(manualReviewResults, 'Medium')} low=${countRating_(manualReviewResults, 'Low')}`
    );

    if (failedCount > 0) {
      SpreadsheetApp.getUi().alert(
        `${failedCount} contact merge(s) failed - see the "${MERGE_LOG_SHEET_NAME}" sheet for details.`
      );
    }
  };

  /**
   * Entry point for a ratings-only run: scores every row for manual review,
   * with no auto-merge classification and no merge sheet/call at all. Useful
   * when you want the full likelihood ranking on every pair, including ones
   * that would otherwise have been routed to auto-merge.
   */
  this.runRatingsOnly = () => {
    Logger.log('[DuplicateRatingsAnalyzer.runRatingsOnly] starting');
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sourceSheet = ss.getSheetByName(SOURCE_SHEET_NAME);

    if (!sourceSheet) {
      const msg = `No sheet found named "${SOURCE_SHEET_NAME}". Rename your export tab and re-run.`;
      Logger.log(`[DuplicateRatingsAnalyzer.runRatingsOnly] error=${msg}`);
      SpreadsheetApp.getUi().alert(msg);
      return;
    }
    Logger.log(`[DuplicateRatingsAnalyzer.runRatingsOnly] sourceSheet=${sourceSheet.getName()}`);

    const { header, rows } = readSourceData_(sourceSheet);
    Logger.log(`[DuplicateRatingsAnalyzer.runRatingsOnly] rowCount=${rows.length}`);

    const colIndex = buildColumnIndex_(header);
    const results = rows.map((row) => {
      const get = (name) => {
        const idx = colIndex[name];
        return idx === undefined || idx === -1 ? '' : row[idx];
      };
      const autoMergeMatch = classifyRowForAutoMerge_(get);
      const scored = scoreRow_(get);
      scored.wouldAutoMerge = !!autoMergeMatch;
      scored.autoMergeDetail = autoMergeMatch ? `${autoMergeMatch.pattern}: ${autoMergeMatch.detail}` : '';
      return scored;
    });

    results.sort((a, b) => b.score - a.score);
    writeOutput_(ss, results);

    Logger.log(
      `[DuplicateRatingsAnalyzer.runRatingsOnly] complete | veryHigh=${countRating_(results, 'Very High')} ` +
      `high=${countRating_(results, 'High')} medium=${countRating_(results, 'Medium')} low=${countRating_(results, 'Low')}`
    );
  };

  /**
   * Manually merges two specific contact IDs via the LIVE HubSpot API,
   * bypassing DRY_RUN and the auto-merge classifier entirely - for testing
   * the merge endpoint directly. Confirms with the user first (a merge is
   * irreversible), then logs the result to the same Merge Log sheet as any
   * other merge, tagged with pattern "Manual Test" so it's clearly
   * distinguishable from classifier-driven merges in the audit trail.
   * @param {string|number} primaryId - the contact ID that will survive
   * @param {string|number} secondaryId - the contact ID that gets merged away
   */
  this.testMerge = (primaryId, secondaryId) => {
    const ui = SpreadsheetApp.getUi();

    if (!primaryId || !secondaryId) {
      Logger.log('[DuplicateRatingsAnalyzer.testMerge] error=missing primaryId or secondaryId');
      ui.alert('Both a primary ID and a secondary ID are required.');
      return;
    }

    const confirmed = ui.alert(
      'Confirm test merge',
      `This calls the LIVE HubSpot merge API (DRY_RUN is ignored for this test):\n\n` +
      `Primary (survives):     ${primaryId}\n` +
      `Secondary (merged away): ${secondaryId}\n\n` +
      `This cannot be undone. Continue?`,
      ui.ButtonSet.YES_NO
    );
    if (confirmed !== ui.Button.YES) {
      Logger.log(`[DuplicateRatingsAnalyzer.testMerge] cancelled by user | primary=${primaryId} secondary=${secondaryId}`);
      return;
    }

    const candidate = {
      id1: primaryId, id2: secondaryId,
      primaryId, secondaryId,
      primaryReason: 'manual test - explicitly specified',
      pattern: 'Manual Test',
      detail: 'Manually triggered via testMergeContacts / testMergeContactsPrompt',
      name1: '', name2: '', email1: '', email2: ''
    };

    const mergeResult = mergeContact_(candidate);
    const { result, errorMessage } = classifyMergeResult_(mergeResult);

    Logger.log(
      `[DuplicateRatingsAnalyzer.testMerge] primary=${primaryId} secondary=${secondaryId} ` +
      `result=${result} httpStatus=${mergeResult.httpStatus}` +
      (errorMessage ? ` note=${errorMessage}` : '')
    );

    appendMergeLog_(SpreadsheetApp.getActiveSpreadsheet(), [{
      ...candidate,
      timestamp: new Date(),
      dryRun: false,
      result,
      httpStatus: mergeResult.httpStatus,
      errorMessage
    }]);

    let alertMessage;
    if (mergeResult.success) {
      alertMessage = `Contact ${secondaryId} was merged into ${primaryId}. See the "${MERGE_LOG_SHEET_NAME}" sheet for the record.`;
    } else if (mergeResult.alreadyMerged) {
      alertMessage = `${secondaryId} or ${primaryId} was already merged in a previous round. Current canonical ID is ${mergeResult.canonicalId} - try the test merge again using that ID.`;
    } else {
      alertMessage = `HTTP ${mergeResult.httpStatus}: ${mergeResult.errorMessage}`;
    }

    ui.alert(
      mergeResult.success ? 'Merge succeeded' : (mergeResult.alreadyMerged ? 'Already merged' : 'Merge failed'),
      alertMessage,
      ui.ButtonSet.OK
    );
  };

  /**
   * Reads the header row and non-empty data rows from the source sheet.
   * @param {Sheet} sheet
   * @returns {{header: Array<string>, rows: Array<Array>}}
   */
  const readSourceData_ = (sheet) => {
    const values = sheet.getDataRange().getValues();
    const header = values[0];
    const rows = values.slice(1).filter((r) => r.some((v) => v !== '' && v !== null));
    return { header, rows };
  };

  /**
   * Maps each needed column name to its index in the header row. Missing columns
   * (e.g. HubSpot export doesn't include MOBILEPHONE) map to -1 and are skipped safely.
   * @param {Array<string>} header
   * @returns {Object<string, number>}
   */
  const buildColumnIndex_ = (header) => {
    const index = {};
    SOURCE_COLUMNS.forEach((name) => {
      index[name] = header.indexOf(name);
    });
    return index;
  };

  /**
   * @param {*} v
   * @returns {string} trimmed, lowercased string, or '' for null/undefined
   */
  const normStr_ = (v) => (v === null || v === undefined ? '' : String(v).trim().toLowerCase());

  /**
   * Normalizes a phone number to its last 8 digits so country codes / formatting
   * differences don't block a match.
   * @param {*} v
   * @returns {string}
   */
  const normPhone_ = (v) => {
    if (v === null || v === undefined) return '';
    const digits = String(v).replace(/\D/g, '');
    return digits.length >= 8 ? digits.slice(-8) : digits;
  };

  /**
   * Splits a normalized email into [localPart, domain].
   * @param {string} email
   * @returns {[string, string]}
   */
  const emailParts_ = (email) => {
    const idx = email.indexOf('@');
    if (idx === -1) return ['', ''];
    return [email.slice(0, idx), email.slice(idx + 1)];
  };

  /**
   * Normalizes an email local-part for cross-punctuation comparison: drops a
   * "+tag" suffix (plus-addressing) and strips dots/hyphens/underscores, so
   * "princess-fiona01", "princess.fiona01", and "princessfiona01" all compare
   * equal.
   * @param {string} localPart
   * @returns {string}
   */
  const normalizeLocalPart_ = (localPart) => {
    const beforePlus = localPart.split('+')[0];
    return beforePlus.replace(/[^a-z0-9]/g, '');
  };

  /**
   * Classifies a same-username email pair as a Domain Alias or Spelling Typo
   * match, or returns null if neither "obvious, low-risk" pattern applies.
   * @param {string} email1
   * @param {string} email2
   * @returns {{pattern: string, detail: string}|null}
   */
  const classifyDomainPair_ = (email1, email2) => {
    const [l1, d1] = emailParts_(email1);
    const [l2, d2] = emailParts_(email2);
    const nl1 = normalizeLocalPart_(l1);
    const nl2 = normalizeLocalPart_(l2);
    if (!nl1 || !nl2 || nl1 !== nl2 || !d1 || !d2 || d1 === d2) return null;

    for (const group of DOMAIN_ALIAS_GROUPS) {
      if (group.indexOf(d1) !== -1 && group.indexOf(d2) !== -1) {
        // Both sides are the same real mailbox - no side is "more correct".
        return { pattern: 'Domain Alias', detail: `${d1} <-> ${d2} (known-equivalent domains)`, canonicalEmail: null };
      }
    }

    const d1Canonical = CANONICAL_DOMAINS.indexOf(d1) !== -1;
    const d2Canonical = CANONICAL_DOMAINS.indexOf(d2) !== -1;
    if (d1Canonical !== d2Canonical) {
      const canonical = d1Canonical ? d1 : d2;
      const typo = d1Canonical ? d2 : d1;
      const dist = levenshtein_(canonical, typo);
      if (dist >= 1 && dist <= 2) {
        return {
          pattern: 'Spelling Typo',
          detail: `"${typo}" looks like a typo of "${canonical}" (edit distance ${dist})`,
          canonicalEmail: d1Canonical ? 'email1' : 'email2'
        };
      }
    }

    return null;
  };

  /**
   * Decides whether a row qualifies for auto-merge. First+last name must
   * always match as corroboration; beyond that, one of three patterns must
   * also hold, in priority order:
   *   1. Same domain, local-part differs only by punctuation (safest - same
   *      provider, same underlying mailbox).
   *   2. Same normalized username across unrelated providers, corroborated by
   *      a matching phone number (an independent identity channel).
   *   3. A known domain-alias or spelling-typo pattern (see classifyDomainPair_).
   * Everything else falls through to manual review.
   * @param {function(string): *} get
   * @returns {Object|null} auto-merge candidate, or null if not eligible
   */
  const classifyRowForAutoMerge_ = (get) => {
    const email1 = normStr_(get('EMAIL_1'));
    const email2 = normStr_(get('EMAIL_2'));
    if (!email1 || !email2 || email1 === email2) return null;

    const fn1 = normStr_(get('FIRSTNAME_1')), fn2 = normStr_(get('FIRSTNAME_2'));
    const ln1 = normStr_(get('LASTNAME_1')), ln2 = normStr_(get('LASTNAME_2'));
    const sameFirst = fn1 && fn1 === fn2;
    const sameLast = ln1 && ln1 === ln2;
    if (!sameFirst || !sameLast) return null; // demoted silently - surfaces via manual review instead

    const [rawL1, d1] = emailParts_(email1);
    const [rawL2, d2] = emailParts_(email2);
    const nl1 = normalizeLocalPart_(rawL1);
    const nl2 = normalizeLocalPart_(rawL2);
    const usernameMatches = nl1 && nl1 === nl2;

    const ph1 = normPhone_(get('PHONE_1')) || normPhone_(get('MOBILEPHONE_1'));
    const ph2 = normPhone_(get('PHONE_2')) || normPhone_(get('MOBILEPHONE_2'));
    const phoneMatches = ph1 && ph2 && ph1 === ph2;

    let classification = null;

    if (usernameMatches && d1 === d2 && d1) {
      // Same domain, local-part differs only by punctuation - the safest
      // pattern available: same provider, same underlying mailbox.
      classification = {
        pattern: 'Same Mailbox (Punctuation Variant)',
        detail: `Same domain (${d1}), local-part differs only by punctuation (${rawL1} vs ${rawL2})`,
        canonicalEmail: null
      };
    } else if (usernameMatches && phoneMatches) {
      // Same username across unrelated providers, but corroborated by a
      // matching phone number - an independent identity channel, so the
      // odds of this being two different people collapse.
      classification = {
        pattern: 'Username + Phone Match',
        detail: `Same username (${nl1}) across ${d1} vs ${d2}, corroborated by matching phone number`,
        canonicalEmail: null
      };
    } else if (d1 === d2 && d1 && rawL1 !== rawL2) {
      // Same domain, local-part differs by an actual character (not just
      // punctuation) - e.g. a system-generated tracking address with an
      // incrementing suffix. Riskier than a pure punctuation variant, so
      // only auto-merge eligible when corroborated by the tightest time
      // window (created within 5 minutes) - otherwise it could just as
      // easily be two different people on the same company domain.
      const dist = levenshtein_(rawL1, rawL2);
      if (dist >= 1 && dist <= 2 && Math.min(rawL1.length, rawL2.length) > 3) {
        const timeSignal = timeProximity_(get('CREATEDATE_1'), get('CREATEDATE_2'));
        if (timeSignal.points >= 20) { // 20 = the "within 5 minutes" tier only
          classification = {
            pattern: 'Same Domain, Near-Identical Local-Part (Tight Timing)',
            detail: `Same domain (${d1}), local-part differs by ${dist} character(s) (${rawL1} vs ${rawL2}), ${timeSignal.reason.toLowerCase()}`,
            canonicalEmail: null
          };
        }
      }
    } else {
      classification = classifyDomainPair_(email1, email2);
    }

    if (!classification) return null;

    const id1 = get('ID_1'), id2 = get('ID_2');
    const { primaryId, secondaryId, primaryReason } = determinePrimary_(get);

    return {
      id1, id2,
      email1: get('EMAIL_1'), email2: get('EMAIL_2'),
      name1: `${get('FIRSTNAME_1') || ''} ${get('LASTNAME_1') || ''}`.trim(),
      name2: `${get('FIRSTNAME_2') || ''} ${get('LASTNAME_2') || ''}`.trim(),
      pattern: classification.pattern,
      detail: classification.detail,
      primaryId, secondaryId, primaryReason
    };
  };

  /**
   * Determines which contact should be primary (survive) in a merge: the
   * side with the canonical email domain if this is a spelling-typo pair
   * (a typo must never become the surviving contact's email address),
   * otherwise the earliest-created record, otherwise ID_1 by default.
   * Shared by both the auto-merge classifier and the manual-review scorer,
   * so every row - not just auto-merge candidates - gets a suggested master ID.
   * @param {function(string): *} get
   * @returns {{primaryId: *, secondaryId: *, primaryReason: string}}
   */
  const determinePrimary_ = (get) => {
    const id1 = get('ID_1'), id2 = get('ID_2');
    const email1 = normStr_(get('EMAIL_1'));
    const email2 = normStr_(get('EMAIL_2'));

    if (email1 && email2 && email1 !== email2) {
      const classification = classifyDomainPair_(email1, email2);
      if (classification && classification.canonicalEmail === 'email1') {
        return { primaryId: id1, secondaryId: id2, primaryReason: 'canonical email domain' };
      }
      if (classification && classification.canonicalEmail === 'email2') {
        return { primaryId: id2, secondaryId: id1, primaryReason: 'canonical email domain' };
      }
    }

    const t1 = parseDate_(get('CREATEDATE_1'));
    const t2 = parseDate_(get('CREATEDATE_2'));
    if (t1 !== null && t2 !== null) {
      return t2 < t1
        ? { primaryId: id2, secondaryId: id1, primaryReason: 'earliest createdate' }
        : { primaryId: id1, secondaryId: id2, primaryReason: 'earliest createdate' };
    }

    return { primaryId: id1, secondaryId: id2, primaryReason: 'default (ID_1)' };
  };

  /**
   * Calls the HubSpot contacts merge API to merge secondaryId into primaryId.
   * Only actually invoked when DRY_RUN is false - see processMergeCandidates_.
   * Never throws: network/API failures are captured in the returned result so
   * the caller can log them rather than aborting the whole run.
   * @param {Object} candidate
   * @returns {{success: boolean, httpStatus: number|string, errorMessage: string}}
   */
  const mergeContact_ = (candidate) => {
    const url = 'https://api.hubapi.com/crm/v3/objects/contacts/merge';
    const payload = {
      primaryObjectId: String(candidate.primaryId),
      objectIdToMerge: String(candidate.secondaryId)
    };

    let httpStatus = '';
    let errorMessage = '';
    let success = false;
    let alreadyMerged = false;
    let canonicalId = null;

    try {
      const options = {
        headers: {
          'Accept': 'application/json',
          'Authorization': WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer()
        },
        method: 'POST',
        contentType: 'application/json',
        muteHttpExceptions: true,
        payload: JSON.stringify(payload)
      };
      const response = UrlFetchApp.fetch(url, options);
      httpStatus = response.getResponseCode();
      success = httpStatus < 300;
      if (!success) {
        errorMessage = response.getContentText();
        // One or both IDs may already have been merged away in a previous
        // round (common when working off repeated manual exports over
        // time). HubSpot's error embeds the current canonical ID, so pull
        // it out rather than just reporting a generic failure.
        const forwardRefMatch = errorMessage.match(/forward reference to (\d+)/);
        if (forwardRefMatch) {
          alreadyMerged = true;
          canonicalId = forwardRefMatch[1];
        }
      }
    } catch (e) {
      errorMessage = e && e.message ? e.message : String(e);
    }

    return { success, httpStatus, errorMessage, alreadyMerged, canonicalId };
  };

  /**
   * Processes every auto-merge candidate: in DRY_RUN mode, logs what would
   * happen without calling the API; otherwise calls mergeContact_ for each
   * and records the real outcome. Every attempt - dry-run, success, or
   * failure - gets a structured Logger.log line plus a row destined for the
   * permanent Merge Log sheet.
   * @param {Array<Object>} candidates
   * @returns {Array<Object>} candidates enriched with timestamp/result/httpStatus/errorMessage
   */
  const processMergeCandidates_ = (candidates) => candidates.map((candidate) => {
    const timestamp = new Date();

    if (DRY_RUN) {
      Logger.log(
        `[DuplicateRatingsAnalyzer.processMergeCandidates_] DRY_RUN primary=${candidate.primaryId} ` +
        `secondary=${candidate.secondaryId} pattern=${candidate.pattern} | ${candidate.detail}`
      );
      return {
        ...candidate,
        timestamp,
        dryRun: true,
        result: 'DRY RUN - NOT MERGED',
        httpStatus: '',
        errorMessage: ''
      };
    }

    const mergeResult = mergeContact_(candidate);
    const { result, errorMessage } = classifyMergeResult_(mergeResult);

    Logger.log(
      `[DuplicateRatingsAnalyzer.processMergeCandidates_] primary=${candidate.primaryId} ` +
      `secondary=${candidate.secondaryId} pattern=${candidate.pattern} result=${result} ` +
      `httpStatus=${mergeResult.httpStatus}` +
      (errorMessage ? ` note=${errorMessage}` : '')
    );

    return {
      ...candidate,
      timestamp,
      dryRun: false,
      result,
      httpStatus: mergeResult.httpStatus,
      errorMessage
    };
  });

  /**
   * Turns a raw mergeContact_ result into a display-friendly result label and
   * error message, distinguishing "already merged in a previous round" (which
   * embeds the current canonical ID to retry against) from a genuine failure.
   * @param {{success: boolean, httpStatus: number|string, errorMessage: string, alreadyMerged: boolean, canonicalId: string|null}} mergeResult
   * @returns {{result: string, errorMessage: string}}
   */
  const classifyMergeResult_ = (mergeResult) => {
    if (mergeResult.success) {
      return { result: 'MERGED', errorMessage: '' };
    }
    if (mergeResult.alreadyMerged) {
      return {
        result: `ALREADY MERGED (now ${mergeResult.canonicalId})`,
        errorMessage: `This ID was already merged into canonical contact ${mergeResult.canonicalId} in a previous round - re-run using ${mergeResult.canonicalId} instead. Raw: ${mergeResult.errorMessage}`
      };
    }
    return { result: 'FAILED', errorMessage: mergeResult.errorMessage };
  };

  /**
   * Standard Levenshtein edit distance between two strings.
   * @param {string} a
   * @param {string} b
   * @returns {number}
   */
  const levenshtein_ = (a, b) => {
    if (a === b) return 0;
    if (!a) return b.length;
    if (!b) return a.length;
    let prev = [];
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  };

  /**
   * Normalizes a company name for comparison: lowercases, strips common legal-entity
   * suffixes (Ltd, Inc, Limited, Corp, &, etc.) and punctuation, and collapses whitespace,
   * so "Acme Ltd", "Acme Limited", and "ACME" all compare equal.
   * @param {*} v
   * @returns {string}
   */
  const normCompany_ = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v).toLowerCase();
    s = s.replace(/&/g, ' and ');
    s = s.replace(/[.,'']/g, '');
    s = s.replace(/[^a-z0-9\s]/g, ' ');
    const words = s.split(/\s+/).filter((w) => w && COMPANY_SUFFIXES_.indexOf(w) === -1);
    return words.join(' ').trim();
  };

  /**
   * Parses a HubSpot CREATEDATE cell into epoch milliseconds. Handles values that come
   * through as a native Date (Sheets auto-parsed), an epoch-ms number/numeric string
   * (raw HubSpot export), or an ISO date string. Returns null if unparseable.
   * @param {*} v
   * @returns {number|null}
   */
  const parseDate_ = (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    const asNumber = Number(v);
    if (!isNaN(asNumber) && String(v).trim() !== '') return asNumber;
    const parsed = Date.parse(v);
    return isNaN(parsed) ? null : parsed;
  };

  /**
   * Scores how close two CREATEDATE values are, in points plus a human reason.
   * Two records created within minutes of each other (form re-submission, retry
   * after an error, etc.) are one of the strongest real-world duplicate signals.
   * @param {*} createdate1
   * @param {*} createdate2
   * @returns {{points: number, reason: string|null}}
   */
  const timeProximity_ = (createdate1, createdate2) => {
    const t1 = parseDate_(createdate1);
    const t2 = parseDate_(createdate2);
    if (t1 === null || t2 === null) return { points: 0, reason: null };

    const diffMinutes = Math.abs(t1 - t2) / 60000;
    const tier = TIME_PROXIMITY_TIERS.find((t) => diffMinutes <= t.maxMinutes);
    return tier ? { points: tier.points, reason: tier.label } : { points: 0, reason: null };
  };

  /**
   * Scores a single duplicate-pair row.
   * @param {function(string): *} get
   * @returns {Object} display fields plus score, rating, and reasons
   */
  const scoreRow_ = (get) => {
    const reasons = [];
    let score = 0;

    const fn1 = normStr_(get('FIRSTNAME_1')), fn2 = normStr_(get('FIRSTNAME_2'));
    const ln1 = normStr_(get('LASTNAME_1')), ln2 = normStr_(get('LASTNAME_2'));
    const em1 = normStr_(get('EMAIL_1')), em2 = normStr_(get('EMAIL_2'));
    const ph1 = normPhone_(get('PHONE_1')) || normPhone_(get('MOBILEPHONE_1'));
    const ph2 = normPhone_(get('PHONE_2')) || normPhone_(get('MOBILEPHONE_2'));
    const co1 = normCompany_(get('COMPANY_1')), co2 = normCompany_(get('COMPANY_2'));
    const ci1 = normStr_(get('CITY_1')), ci2 = normStr_(get('CITY_2'));
    const cnt1 = normStr_(get('COUNTRY_1')), cnt2 = normStr_(get('COUNTRY_2'));
    const zip1 = normStr_(get('ZIP_1')), zip2 = normStr_(get('ZIP_2'));

    // Email: exact match, same-username punctuation variants, alias/typo'd
    // domains, or the same distinctive username reused across unrelated providers
    if (em1 && em1 === em2) {
      score += 45;
      reasons.push('Email identical');
    } else if (em1 && em2) {
      const [rawL1, d1] = emailParts_(em1);
      const [rawL2, d2] = emailParts_(em2);
      const nl1 = normalizeLocalPart_(rawL1);
      const nl2 = normalizeLocalPart_(rawL2);

      if (nl1 && nl1 === nl2) {
        if (d1 === d2) {
          // Same domain, local-part differs only by dots/hyphens/plus-tag -
          // near-certain the same mailbox (Gmail treats dots as insignificant;
          // elsewhere it's still overwhelmingly a punctuation typo on re-entry)
          score += 40;
          reasons.push(`Same domain, local-part differs only by punctuation (likely same mailbox: ${rawL1} vs ${rawL2})`);
        } else {
          const domainDist = levenshtein_(d1, d2);
          if (domainDist <= 2) {
            score += 38;
            reasons.push(`Same username, near-identical domain typo (${d1} vs ${d2})`);
          } else {
            // Entirely different, unrelated providers - still meaningful on a
            // distinctive username, but weaker than a same-domain/typo match
            // since two different people could independently pick a common one
            const distinctive = nl1.length >= 6;
            score += distinctive ? 30 : 12;
            reasons.push(
              distinctive
                ? `Same distinctive username across unrelated providers (${rawL1} vs ${rawL2}, ${d1} vs ${d2})`
                : `Same short/common username across unrelated providers (${d1} vs ${d2}) - weaker signal`
            );
          }
        }
      } else if (d1 && d1 === d2 && rawL1 !== rawL2) {
        const dist = levenshtein_(rawL1, rawL2);
        if (dist <= 2 && Math.min(rawL1.length, rawL2.length) > 3) {
          score += 15;
          reasons.push('Same domain, near-identical local-part');
        }
      }
    }

    // Phone / mobile
    if (ph1 && ph2 && ph1 === ph2) {
      score += 25;
      reasons.push('Phone/mobile number matches');
    }

    // First name
    if (fn1 && fn1 === fn2) {
      score += 10;
      reasons.push('First name identical');
    } else if (fn1 && fn2 && levenshtein_(fn1, fn2) <= 1 && Math.min(fn1.length, fn2.length) > 2) {
      score += 6;
      reasons.push('First name near-identical (nickname/typo)');
    }

    // Last name
    if (ln1 && ln1 === ln2) {
      score += 15;
      reasons.push('Last name identical');
    } else if (ln1 && ln2 && levenshtein_(ln1, ln2) <= 1 && Math.min(ln1.length, ln2.length) > 2) {
      score += 8;
      reasons.push('Last name near-identical');
    }

    // Company (compared after stripping legal suffixes like Ltd/Inc/Limited)
    if (co1 && co1 === co2) {
      score += 8;
      reasons.push('Company identical (after normalizing legal suffixes)');
    } else if (co1 && co2 && levenshtein_(co1, co2) <= 2 && Math.min(co1.length, co2.length) > 4) {
      score += 4;
      reasons.push('Company near-identical (after normalizing legal suffixes)');
    }

    // Time proximity: records created close together are a strong duplicate signal
    // (form re-submission, retry after an error, accidental double sign-up, etc.)
    const timeSignal = timeProximity_(get('CREATEDATE_1'), get('CREATEDATE_2'));
    if (timeSignal.points > 0) {
      score += timeSignal.points;
      reasons.push(timeSignal.reason);
    }

    // Weak corroborating signals only
    if (ci1 && ci1 === ci2) score += 3;
    if (cnt1 && cnt1 === cnt2) score += 2;
    if (zip1 && zip1 === zip2) {
      score += 4;
      reasons.push('Zip identical');
    }

    score = Math.min(score, 100);
    const rating = RATING_THRESHOLDS.find((t) => score >= t.min).label;
    const { primaryId } = determinePrimary_(get);

    return {
      id1: get('ID_1'),
      id2: get('ID_2'),
      masterId: primaryId,
      name1: `${get('FIRSTNAME_1') || ''} ${get('LASTNAME_1') || ''}`.trim(),
      name2: `${get('FIRSTNAME_2') || ''} ${get('LASTNAME_2') || ''}`.trim(),
      email1: get('EMAIL_1'),
      email2: get('EMAIL_2'),
      phone1: get('PHONE_1') || get('MOBILEPHONE_1'),
      phone2: get('PHONE_2') || get('MOBILEPHONE_2'),
      company1: get('COMPANY_1'),
      company2: get('COMPANY_2'),
      score,
      rating,
      reasons: reasons.length ? reasons.join('; ') : 'No strong matching signals'
    };
  };

  /**
   * @param {Array<Object>} results
   * @param {string} rating
   * @returns {number}
   */
  const countRating_ = (results, rating) => results.filter((r) => r.rating === rating).length;

  /**
   * Writes the dry-run auto-merge candidate sheet.
   * @param {Spreadsheet} ss
   * @param {Array<Object>} candidates
   */
  const writeAutoMergeSheet_ = (ss, mergeResults) => {
    let sheet = ss.getSheetByName(AUTO_MERGE_SHEET_NAME);
    if (sheet) {
      sheet.clearContents();
      sheet.clearFormats();
      const existingFilter = sheet.getFilter();
      if (existingFilter) existingFilter.remove();
    } else {
      sheet = ss.insertSheet(AUTO_MERGE_SHEET_NAME);
    }

    sheet.getRange(1, 1, 1, AUTO_MERGE_HEADERS.length).setValues([AUTO_MERGE_HEADERS]);
    sheet.getRange(1, 1, 1, AUTO_MERGE_HEADERS.length)
      .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#4472C4');

    if (mergeResults.length > 0) {
      const rows = mergeResults.map((c) => [
        c.id1, c.id2, c.email1, c.email2, c.name1, c.name2, c.pattern, c.detail, c.primaryId, c.primaryReason, c.result
      ]);
      sheet.getRange(2, 1, rows.length, AUTO_MERGE_HEADERS.length).setValues(rows);
      sheet.getRange(1, 1, rows.length + 1, AUTO_MERGE_HEADERS.length).createFilter();
    }

    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, AUTO_MERGE_HEADERS.length);
    Logger.log(`[DuplicateRatingsAnalyzer.writeAutoMergeSheet_] rowsWritten=${mergeResults.length}`);
  };

  /**
   * Appends every merge attempt from this run to the permanent Merge Log
   * sheet - creating it with headers on first use. Unlike the other output
   * sheets, this one is never cleared: it's the audit trail across every run,
   * dry-run or live, so failures and successes stay visible over time.
   * @param {Spreadsheet} ss
   * @param {Array<Object>} mergeResults
   */
  const appendMergeLog_ = (ss, mergeResults) => {
    if (mergeResults.length === 0) return;

    let sheet = ss.getSheetByName(MERGE_LOG_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(MERGE_LOG_SHEET_NAME);
      sheet.getRange(1, 1, 1, MERGE_LOG_HEADERS.length).setValues([MERGE_LOG_HEADERS]);
      sheet.getRange(1, 1, 1, MERGE_LOG_HEADERS.length)
        .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#4472C4');
      sheet.setFrozenRows(1);
    }

    const startRow = sheet.getLastRow() + 1;
    const rows = mergeResults.map((r) => [
      r.timestamp, r.primaryId, r.secondaryId, r.primaryReason, r.name1, r.name2, r.email1, r.email2,
      r.pattern, r.detail, r.dryRun ? 'Yes' : 'No', r.result, r.httpStatus, r.errorMessage
    ]);
    sheet.getRange(startRow, 1, rows.length, MERGE_LOG_HEADERS.length).setValues(rows);
    sheet.autoResizeColumns(1, MERGE_LOG_HEADERS.length);

    Logger.log(`[DuplicateRatingsAnalyzer.appendMergeLog_] rowsAppended=${rows.length} startRow=${startRow}`);
  };

  /**
   * Clears/creates the output sheet, writes headers + scored rows in a single bulk
   * write, then applies conditional formatting, freeze row, and a filter.
   * @param {Spreadsheet} ss
   * @param {Array<Object>} results
   */
  const writeOutput_ = (ss, results) => {
    let sheet = ss.getSheetByName(OUTPUT_SHEET_NAME);
    if (sheet) {
      sheet.clearContents();
      sheet.clearFormats();
      const existingFilter = sheet.getFilter();
      if (existingFilter) existingFilter.remove();
    } else {
      sheet = ss.insertSheet(OUTPUT_SHEET_NAME);
    }

    sheet.getRange(1, 1, 1, OUTPUT_HEADERS.length).setValues([OUTPUT_HEADERS]);
    sheet.getRange(1, 1, 1, OUTPUT_HEADERS.length)
      .setFontWeight('bold')
      .setFontColor('#FFFFFF')
      .setBackground('#4472C4');

    if (results.length > 0) {
      const dataRows = results.map((r) => [
        r.id1, r.id2, r.masterId, r.name1, r.name2, r.email1, r.email2, r.phone1, r.phone2,
        r.company1, r.company2, r.score, r.rating, r.reasons, r.wouldAutoMerge ? 'Yes' : 'No', r.autoMergeDetail
      ]);
      sheet.getRange(2, 1, dataRows.length, OUTPUT_HEADERS.length).setValues(dataRows);
      sheet.getRange(1, 1, dataRows.length + 1, OUTPUT_HEADERS.length).createFilter();
      applyConditionalFormatting_(sheet, dataRows.length);
    }

    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, OUTPUT_HEADERS.length);
    Logger.log(`[DuplicateRatingsAnalyzer.writeOutput_] rowsWritten=${results.length}`);
  };

  /**
   * Applies row background colors keyed on the Rating column via conditional format
   * rules (not per-cell setBackground calls, which would be ~2,000+ individual calls).
   * @param {Sheet} sheet
   * @param {number} rowCount
   */
  const applyConditionalFormatting_ = (sheet, rowCount) => {
    const ratingColNum = OUTPUT_HEADERS.indexOf('Rating') + 1;
    const ratingColLetter = String.fromCharCode(64 + ratingColNum);
    const range = sheet.getRange(2, 1, rowCount, OUTPUT_HEADERS.length);

    const rules = Object.keys(RATING_COLORS).map((rating) =>
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied(`=$${ratingColLetter}2="${rating}"`)
        .setBackground(RATING_COLORS[rating])
        .setRanges([range])
        .build()
    );

    sheet.setConditionalFormatRules(rules);
  };
};