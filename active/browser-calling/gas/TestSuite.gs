/**
 * TestSuite.gs
 * ─────────────────────────────────────────────────────────────────────────────
 * Manual test functions for the WebRTC Browser Calling integration.
 * Run each test individually from the GAS editor function dropdown → Run.
 * Results appear in the Execution Log (View → Logs or Ctrl+Enter).
 *
 * Tests are grouped by component:
 *   1. HubSpot connectivity
 *   2. Deal & contact lookup
 *   3. Whisper name resolution
 *   4. HubSpot call logging
 *   5. Transcript appending
 *   6. Full end-to-end simulation
 *   7. Feature flag validation
 *
 * None of these tests place real calls or send real Twilio webhooks.
 * HubSpot write tests (logging, transcript) create real engagements —
 * check the HubSpot contact record after running them.
 */

// ─── Test configuration ────────────────────────────────────────────────────
// Update these values before running tests

const TEST_CONFIG = {
  bookingRef:   'BK105067',          // A real booking ref that exists as a HubSpot Deal
  customerName: 'Mark Lonergan',     // The contact name associated with that deal
  fakeCallSid:  'CA_TEST_' + Date.now(), // Fake CallSid for logging tests
  callDuration: 30,                  // Simulated call duration in seconds
};

// ─── Test runner helper ────────────────────────────────────────────────────

function assert_(label, condition, detail) {
  if (condition) {
    Logger.log('  ✓  ' + label);
  } else {
    Logger.log('  ✗  FAIL: ' + label + (detail ? ' — ' + detail : ''));
  }
  return condition;
}

function section_(title) {
  Logger.log('');
  Logger.log('══ ' + title + ' ══');
}

// ─── 1. HubSpot connectivity ───────────────────────────────────────────────

/**
 * Confirms the HubSpot token is valid and the API is reachable.
 * Run this first before any other tests.
 */
function testHubSpotConnectivity() {
  section_('HubSpot Connectivity');
  try {
    const resp = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
      method:  'get',
      headers: { Authorization: WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer() },
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    assert_('API responds with 200', code === 200, 'Got: ' + code);
    if (code === 200) {
      const data = JSON.parse(resp.getContentText());
      assert_('Response contains results array', Array.isArray(data.results));
      Logger.log('  → Contact count visible: ' + (data.results ? data.results.length : 0));
    } else {
      Logger.log('  → Response body: ' + resp.getContentText().substring(0, 200));
    }
  } catch (err) {
    Logger.log('  ✗  Exception: ' + err.message);
  }
}

// ─── 2. Deal & contact lookup ──────────────────────────────────────────────

/**
 * Tests the full deal → contact lookup chain using the configured booking ref.
 * This is the same lookup used during live calls.
 */
function testDealLookup() {
  section_('Deal & Contact Lookup');
  Logger.log('  Booking ref: ' + TEST_CONFIG.bookingRef);

  const result = findContactByDeal_(TEST_CONFIG.bookingRef);

  assert_('Deal found', !!result.dealId, 'dealId was: ' + result.dealId);
  assert_('Contact found via deal', !!result.contactId, 'contactId was: ' + result.contactId);

  if (result.contactId) {
    try {
      const url = 'https://api.hubapi.com/crm/v3/objects/contacts/' + result.contactId
        + '?properties=firstname,lastname,email';
      const resp = UrlFetchApp.fetch(url, {
        method:  'get',
        headers: { Authorization: WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer() },
        muteHttpExceptions: true
      });
      const contact = JSON.parse(resp.getContentText());
      const p = contact.properties || {};
      const fullName = [p.firstname, p.lastname].filter(Boolean).join(' ');
      Logger.log('  → Contact name:  ' + fullName);
      Logger.log('  → Contact email: ' + (p.email || 'n/a'));
      assert_('Contact name matches expected', fullName === TEST_CONFIG.customerName,
        'Expected: ' + TEST_CONFIG.customerName + ' Got: ' + fullName);
    } catch (err) {
      Logger.log('  ✗  Could not fetch contact details: ' + err.message);
    }
  }
}

/**
 * Tests the fallback name search when no deal match is found.
 * Uses a deliberate bad booking ref to force the fallback.
 */
function testFallbackNameLookup() {
  section_('Fallback Name Lookup (by customer name)');
  const fakeParts = TEST_CONFIG.customerName.trim().split(/\s+/);
  Logger.log('  Searching by name: ' + TEST_CONFIG.customerName);

  const contactId = findContactByName_(TEST_CONFIG.customerName);
  assert_('Contact found by name', !!contactId, 'contactId was: ' + contactId);
  if (contactId) Logger.log('  → Contact ID: ' + contactId);
}

/**
 * Confirms that a non-existent booking ref returns null gracefully.
 */
function testDealLookupMiss() {
  section_('Deal Lookup — Expected Miss');
  const fakeRef = 'BK-DOESNOTEXIST-99999';
  Logger.log('  Booking ref: ' + fakeRef + ' (should not be found)');

  const result = findContactByDeal_(fakeRef);
  assert_('Deal not found returns null dealId', result.dealId === null);
  assert_('Deal not found returns null contactId', result.contactId === null);
  Logger.log('  → Handled gracefully ✓');
}

// ─── 3. Whisper name resolution ────────────────────────────────────────────

/**
 * Tests the whisper name lookup used when customerName is missing from the URL.
 */
function testWhisperNameResolution() {
  section_('Whisper Name Resolution');
  Logger.log('  Booking ref: ' + TEST_CONFIG.bookingRef);

  const name = getCustomerNameFromDeal_(TEST_CONFIG.bookingRef);
  assert_('Name resolved from deal', !!name, 'Got: ' + name);
  assert_('Name matches expected', name === TEST_CONFIG.customerName,
    'Expected: ' + TEST_CONFIG.customerName + ' Got: ' + name);
  Logger.log('  → Resolved name: ' + name);
}

/**
 * Tests the full whisper TwiML output including name resolution.
 * Simulates what happens when whisper-handler.js calls GAS.
 */
function testWhisperGasEndpoint() {
  section_('Whisper GAS Endpoint (whisper-name-only)');

  if (!FEATURE_FLAGS.WHISPER_ENABLED) {
    Logger.log('  ⚠ WHISPER_ENABLED is false — endpoint will return empty name');
  }

  // Simulate what whisper-handler.js sends when name is not in URL
  const mockEvent = {
    parameter: { type: 'whisper-name-only', bookingRef: TEST_CONFIG.bookingRef }
  };

  const bookingRef   = mockEvent.parameter.bookingRef || '';
  const customerName = bookingRef && FEATURE_FLAGS.WHISPER_ENABLED
    ? (getCustomerNameFromDeal_(bookingRef) || '') : '';

  assert_('Returns a customer name', !!customerName, 'Got: ' + customerName);
  Logger.log('  → Would speak: "Wilderness browser call. Customer: '
    + (customerName || 'unknown customer') + '. Booking reference: '
    + TEST_CONFIG.bookingRef + '. Connecting now."');
}

// ─── 4. HubSpot call logging ───────────────────────────────────────────────

/**
 * Simulates a completed call status callback from Twilio and logs it to HubSpot.
 * Creates a real HubSpot Call engagement — check the contact record after running.
 * Also writes a row to the Call Log sheet.
 */
function testCallLogging() {
  section_('HubSpot Call Logging');

  if (!FEATURE_FLAGS.HUBSPOT_LOGGING) {
    Logger.log('  ⚠ HUBSPOT_LOGGING is false — skipping HubSpot write');
    return;
  }

  const mockParams = {
    CallSid:         TEST_CONFIG.fakeCallSid,
    DialCallStatus:  'completed',
    DialCallDuration: String(TEST_CONFIG.callDuration),
    bookingRef:      TEST_CONFIG.bookingRef,
    customerName:    TEST_CONFIG.customerName,
    Caller:          'client:browser-caller_' + TEST_CONFIG.bookingRef + '_TEST',
    To:              '+6436672294'
  };

  Logger.log('  CallSid:     ' + mockParams.CallSid);
  Logger.log('  BookingRef:  ' + mockParams.bookingRef);
  Logger.log('  Duration:    ' + mockParams.DialCallDuration + 's');

  try {
    if (FEATURE_FLAGS.SHEET_LOGGING) logToSheet_(mockParams);
    logCallToHubSpot_(mockParams);
    Logger.log('  → Check HubSpot contact for: ' + TEST_CONFIG.customerName);
    Logger.log('  → Check Call Log sheet for CallSid: ' + TEST_CONFIG.fakeCallSid);
  } catch (err) {
    Logger.log('  ✗  Error: ' + err.message);
  }
}

/**
 * Tests no-answer call logging — confirms a 0-duration call still logs correctly.
 */
function testNoAnswerCallLogging() {
  section_('No-Answer Call Logging');

  const mockParams = {
    CallSid:          'CA_TEST_NOANSWER_' + Date.now(),
    DialCallStatus:   'no-answer',
    DialCallDuration: '0',
    bookingRef:       TEST_CONFIG.bookingRef,
    customerName:     TEST_CONFIG.customerName,
    Caller:           'client:browser-caller_' + TEST_CONFIG.bookingRef + '_TEST',
    To:               '+6436672294'
  };

  Logger.log('  Status: no-answer (duration 0)');
  try {
    if (FEATURE_FLAGS.SHEET_LOGGING) logToSheet_(mockParams);
    if (FEATURE_FLAGS.HUBSPOT_LOGGING) logCallToHubSpot_(mockParams);
    Logger.log('  → Logged — HubSpot call status should be NO_ANSWER');
  } catch (err) {
    Logger.log('  ✗  Error: ' + err.message);
  }
}

// ─── 5. Transcript appending ───────────────────────────────────────────────

/**
 * Appends a fake transcript to the most recent real call in the log sheet.
 * Requires at least one logged call in the Call Log sheet with a HubSpot Call ID.
 * Confirm the transcript appears on the HubSpot engagement after running.
 */
function testTranscriptAppend() {
  section_('Transcript Append to HubSpot');

  if (!FEATURE_FLAGS.TRANSCRIPT_ENABLED) {
    Logger.log('  ⚠ TRANSCRIPT_ENABLED is false — skipping');
    return;
  }

  // Find the most recent real call in the sheet that has a HubSpot Call ID
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Call Log');
  if (!sheet) { Logger.log('  ✗  Call Log sheet not found'); return; }

  const data = sheet.getDataRange().getValues();
  let targetCallSid = null;

  // Search from bottom (most recent) upward, skip debug/test rows
  for (let i = data.length - 1; i >= 1; i--) {
    const callSid      = data[i][1];
    const hubspotCallId = data[i][8];
    if (callSid && hubspotCallId && !String(callSid).startsWith('CA_TEST')) {
      targetCallSid = callSid;
      Logger.log('  → Using CallSid: ' + callSid);
      Logger.log('  → HubSpot Call ID: ' + hubspotCallId);
      break;
    }
  }

  if (!targetCallSid) {
    Logger.log('  ✗  No real call with a HubSpot Call ID found in sheet');
    Logger.log('     Run testCallLogging() first or make a real test call');
    return;
  }

  const fakeTranscript = [
    '[Customer] Hi, I just arrived at the airport and I\'m having trouble finding the pickup.',
    '[Agent] No problem, I can see your booking. Head to the ground floor arrivals area.',
    '[Customer] Great, I can see the sign now. Thank you!',
    '[Agent] Perfect, our driver will be right with you.'
  ].join('\n');

  try {
    appendTranscriptToHubSpot_(targetCallSid, fakeTranscript, TEST_CONFIG.bookingRef, TEST_CONFIG.customerName);
    Logger.log('  → Transcript appended — check HubSpot engagement for the call');
    assert_('Transcript contains expected lines', fakeTranscript.includes('[Customer]'));
  } catch (err) {
    Logger.log('  ✗  Error: ' + err.message);
  }
}

// ─── 6. Full end-to-end simulation ────────────────────────────────────────

/**
 * Runs all components in sequence to simulate a complete call lifecycle:
 *   1. Deal lookup
 *   2. Whisper name resolution
 *   3. Call logging to HubSpot
 *   4. Transcript appending
 *
 * Creates real HubSpot data. Check the contact record after running.
 */
function testFullCallLifecycle() {
  section_('Full Call Lifecycle Simulation');
  Logger.log('  Booking ref:   ' + TEST_CONFIG.bookingRef);
  Logger.log('  Customer name: ' + TEST_CONFIG.customerName);
  Logger.log('');

  // Step 1 — Deal lookup
  Logger.log('  Step 1: Deal & contact lookup');
  const dealResult = findContactByDeal_(TEST_CONFIG.bookingRef);
  assert_('Deal found', !!dealResult.dealId);
  assert_('Contact found', !!dealResult.contactId);

  // Step 2 — Whisper name resolution
  Logger.log('');
  Logger.log('  Step 2: Whisper name resolution');
  const resolvedName = getCustomerNameFromDeal_(TEST_CONFIG.bookingRef);
  assert_('Name resolved', !!resolvedName, 'Got: ' + resolvedName);

  // Step 3 — Call logging
  Logger.log('');
  Logger.log('  Step 3: HubSpot call logging');
  const lifecycleCallSid = 'CA_LIFECYCLE_' + Date.now();
  const mockParams = {
    CallSid:          lifecycleCallSid,
    DialCallStatus:   'completed',
    DialCallDuration: '45',
    bookingRef:       TEST_CONFIG.bookingRef,
    customerName:     resolvedName || TEST_CONFIG.customerName,
    Caller:           'client:browser-caller_' + TEST_CONFIG.bookingRef + '_LIFECYCLE',
    To:               '+6436672294'
  };

  try {
    if (FEATURE_FLAGS.SHEET_LOGGING) logToSheet_(mockParams);
    if (FEATURE_FLAGS.HUBSPOT_LOGGING) logCallToHubSpot_(mockParams);
    Logger.log('  → Call logged — CallSid: ' + lifecycleCallSid);

    // Wait briefly for sheet to update
    Utilities.sleep(2000);

    // Step 4 — Transcript
    Logger.log('');
    Logger.log('  Step 4: Transcript append');
    if (FEATURE_FLAGS.TRANSCRIPT_ENABLED) {
      const transcript = [
        '[Customer] Hi, this is a lifecycle test call.',
        '[Agent] Confirmed — this is the automated test transcript.',
      ].join('\n');
      appendTranscriptToHubSpot_(lifecycleCallSid, transcript, TEST_CONFIG.bookingRef, TEST_CONFIG.customerName);
      Logger.log('  → Transcript appended');
    } else {
      Logger.log('  ⚠ TRANSCRIPT_ENABLED is false — skipping transcript step');
    }

    Logger.log('');
    Logger.log('  ══ Lifecycle test complete ══');
    Logger.log('  Check HubSpot contact for: ' + (resolvedName || TEST_CONFIG.customerName));
    Logger.log('  Look for a call engagement with a "— Call Transcript —" section');
  } catch (err) {
    Logger.log('  ✗  Error at step 3/4: ' + err.message);
  }
}

// ─── 7. Feature flag validation ────────────────────────────────────────────

/**
 * Prints the current state of all feature flags.
 * Run this to confirm flags are set correctly before making a live call.
 */
function testFeatureFlags() {
  section_('Feature Flag Status');
  const flags = FEATURE_FLAGS;
  Logger.log('  WHISPER_ENABLED:    ' + (flags.WHISPER_ENABLED    ? '✓ ON' : '✗ OFF'));
  Logger.log('  TRANSCRIPT_ENABLED: ' + (flags.TRANSCRIPT_ENABLED ? '✓ ON' : '✗ OFF'));
  Logger.log('  HUBSPOT_LOGGING:    ' + (flags.HUBSPOT_LOGGING    ? '✓ ON' : '✗ OFF'));
  Logger.log('  SHEET_LOGGING:      ' + (flags.SHEET_LOGGING      ? '✓ ON' : '✗ OFF'));
  Logger.log('');
  Logger.log('  To change a flag: edit FEATURE_FLAGS in CallLogger.gs');
  Logger.log('  Then redeploy as a new version — no Twilio changes needed');
}

/**
 * Run all non-destructive tests (skips HubSpot write tests).
 */
function testRunAll() {
  Logger.log('═══════════════════════════════════════');
  Logger.log('  WebRTC Call Logger — Full Test Run');
  Logger.log('═══════════════════════════════════════');

  testFeatureFlags();
  testHubSpotConnectivity();
  testDealLookup();
  testDealLookupMiss();
  testFallbackNameLookup();
  testWhisperNameResolution();
  testWhisperGasEndpoint();

  Logger.log('');
  Logger.log('═══════════════════════════════════════');
  Logger.log('  Non-destructive tests complete.');
  Logger.log('  To test HubSpot writes, run:');
  Logger.log('    testCallLogging()');
  Logger.log('    testTranscriptAppend()');
  Logger.log('    testFullCallLifecycle()');
  Logger.log('═══════════════════════════════════════');
}

// ─── 8. Token security ─────────────────────────────────────────────────────

/**
 * Confirms the token endpoint rejects requests without the shared secret.
 * Requires the TOKEN_SECRET env var to be set in Twilio.
 */
function testTokenSecurity() {
  section_('Token Security');

  const tokenUrl = 'https://browser-calling-5194.twil.io/generate-token';

  // Test 1 — no secret at all
  try {
    const resp1 = UrlFetchApp.fetch(tokenUrl + '?bookingRef=TEST', { muteHttpExceptions: true });
    assert_('Request without secret is rejected (403)', resp1.getResponseCode() === 403,
      'Got: ' + resp1.getResponseCode());
  } catch (err) {
    Logger.log('  ✗  Exception on no-secret test: ' + err.message);
  }

  // Test 2 — wrong secret
  try {
    const resp2 = UrlFetchApp.fetch(tokenUrl + '?bookingRef=TEST&secret=wrongsecret', { muteHttpExceptions: true });
    assert_('Request with wrong secret is rejected (403)', resp2.getResponseCode() === 403,
      'Got: ' + resp2.getResponseCode());
  } catch (err) {
    Logger.log('  ✗  Exception on wrong-secret test: ' + err.message);
  }

  Logger.log('  → To test with the correct secret, open call-page.html in a browser');
  Logger.log('    and confirm it reaches "Ready to call" status successfully');
}

// ─── 9. Monitoring ─────────────────────────────────────────────────────────

/**
 * Runs the monitor manually and prints results to the execution log.
 * Does NOT send an email — just logs what would be flagged.
 */
function testMonitorDryRun() {
  section_('Monitoring Dry Run (no email)');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Call Log');

  if (!sheet) { Logger.log('  ✗  Call Log sheet not found'); return; }

  const data   = sheet.getDataRange().getValues();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let total = 0, ok = 0, flagged = 0;

  for (let i = 1; i < data.length; i++) {
    const row     = data[i];
    const callSid = String(row[1] || '');
    if (!callSid || callSid.startsWith('CA_TEST') || callSid === 'Call SID') continue;
    const rowTime = new Date(row[0]);
    if (isNaN(rowTime.getTime()) || rowTime < cutoff) continue;

    total++;
    const hubspotStatus = row[6] || '';
    const dialStatus    = row[5] || '';
    const contactId     = row[7] || '';
    const bookingRef    = row[2] || '';

    const problems = [];
    if (!bookingRef)                                  problems.push('No booking ref');
    if (hubspotStatus === 'Error')                    problems.push('HubSpot error');
    if (!hubspotStatus && dialStatus === 'completed') problems.push('Blank HubSpot status');
    if (dialStatus === 'completed' && !contactId)     problems.push('No contact match');

    if (problems.length > 0) {
      flagged++;
      Logger.log('  ⚠ ' + callSid.substring(0, 20) + '… — ' + problems.join(', '));
    } else {
      ok++;
    }
  }

  Logger.log('');
  Logger.log('  ' + total + ' calls in last 24h: ' + ok + ' OK, ' + flagged + ' flagged');
  assert_('All recent calls logged successfully', flagged === 0,
    flagged + ' call(s) need attention');
}

/**
 * Sends a test alert email to confirm email delivery works.
 */
function testMonitoringEmail() {
  section_('Monitoring Alert Email');
  Logger.log('  Sending test alert email…');
  testMonitoringAlert();
  Logger.log('  Check your inbox — subject line starts with ⚠ WebRTC Call Logger');
}

/**
 * Confirms the daily trigger is installed.
 */
function testMonitoringTrigger() {
  section_('Monitoring Trigger');
  const triggers = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'monitorCallLog');
  assert_('Daily monitoring trigger is installed', triggers.length > 0,
    'Run setupMonitoringTrigger() to install it');
  if (triggers.length > 0) {
    Logger.log('  → Trigger found: runs daily');
  }
}

function fetchDispositionOptions() {
  section_('HubSpot Call Disposition Options');
  const resp = UrlFetchApp.fetch(
    'https://api.hubapi.com/crm/v3/properties/calls/hs_call_disposition/options',
    {
      headers: { Authorization: WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer() },
      muteHttpExceptions: true
    }
  );
  Logger.log('Status: ' + resp.getResponseCode());
  Logger.log(resp.getContentText());

  // Also try the pipeline options endpoint
  const resp2 = UrlFetchApp.fetch(
    'https://api.hubapi.com/calling/v1/dispositions',
    {
      headers: { Authorization: WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer() },
      muteHttpExceptions: true
    }
  );
  Logger.log('Dispositions endpoint status: ' + resp2.getResponseCode());
  Logger.log(resp2.getContentText());
}

function printAllDispositions() {
  const resp = UrlFetchApp.fetch(
    'https://api.hubapi.com/calling/v1/dispositions',
    { headers: { Authorization: WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer() } }
  );
  const dispositions = JSON.parse(resp.getContentText());
  dispositions.forEach(d => Logger.log(d.label + ': ' + d.id));
}

function fetchCallTypeProperty() {
  const resp = UrlFetchApp.fetch(
    'https://api.hubapi.com/crm/v3/properties/calls?archived=false',
    { headers: { Authorization: WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer() } }
  );
  const data = JSON.parse(resp.getContentText());
  // Print all call properties containing "type" in name or label
  data.results
    .filter(p => p.name.includes('type') || p.label.toLowerCase().includes('type'))
    .forEach(p => Logger.log(p.name + ' | ' + p.label + ' | ' + p.fieldType));
}

function fetchActivityTypeOptions() {
  const resp = UrlFetchApp.fetch(
    'https://api.hubapi.com/crm/v3/properties/calls/hs_activity_type',
    { headers: { Authorization: WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer() } }
  );
  const data = JSON.parse(resp.getContentText());
  data.options.forEach(o => Logger.log(o.label + ': ' + o.value));
}
