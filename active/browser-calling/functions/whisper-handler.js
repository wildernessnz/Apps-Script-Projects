/**
 * Twilio Function: whisper-handler.js
 * ------------------------------------
 * Returns TwiML <Say> spoken privately to the Aircall agent after they
 * answer but before the customer is bridged. Executes entirely within
 * Twilio's infrastructure so response time is <200ms — no cold-start
 * latency issues that can cause the whisper to be skipped.
 *
 * Called by the url attribute on <Number> in voice-handler.js.
 * The customer continues to hear ringing while this executes.
 *
 * If customerName is not in the URL params (i.e. the call link was opened
 * without a &name= parameter), this function calls the GAS webhook to
 * resolve the name from HubSpot via the deal lookup before speaking.
 *
 * Environment Variables:
 *   GAS_WEBHOOK_URL  - Google Apps Script web app URL (CallLogger.gs)
 *                      Used to resolve customer name when not in params.
 */

const https = require('https');

exports.handler = function (context, event, callback) {
  const bookingRef   = event.bookingRef   || '';
  const customerName = event.customerName || '';

  const needsLookup = !customerName && bookingRef !== '';

  console.log('Whisper handler:', JSON.stringify({ bookingRef, customerName, needsLookup }));

  if (needsLookup) {
    // Call GAS to resolve the customer name from HubSpot, then speak
    const lookupUrl = `${context.GAS_WEBHOOK_URL}?type=whisper-name-only`
      + `&bookingRef=${encodeURIComponent(bookingRef)}`;

    fetchJson_(lookupUrl, (err, data) => {
      const resolvedName = (!err && data && data.customerName) ? data.customerName : '';
      callback(null, buildTwiML_(resolvedName, bookingRef));
    });
  } else {
    // Name already known — respond immediately, no external call needed
    callback(null, buildTwiML_(customerName, bookingRef));
  }
};

/**
 * Builds the TwiML <Say> response for the whisper.
 * Example spoken: "Browser call. Mark Lonergan. B, K, 1, 0, 5, 0, 6, 7. Connecting."
 *
 * The booking ref is spelled character by character to prevent Twilio TTS
 * from reading numeric sequences as large numbers (e.g. "one million" instead
 * of "one zero five zero six seven").
 */
function buildTwiML_(customerName, bookingRef) {
  const twiml = new Twilio.twiml.VoiceResponse();

  const name    = (customerName && customerName !== 'Customer') ? customerName : 'a customer';
  const refRaw  = bookingRef && bookingRef !== 'unknown' ? bookingRef : 'not provided';

  // Spell out each character with commas so TTS reads digit by digit.
  // e.g. "BK105067" → "B, K, 1, 0, 5, 0, 6, 7"
  const refSpoken = refRaw === 'not provided'
    ? 'not provided'
    : refRaw.split('').join(', ');

  // Aircall's SIP answer handshake takes ~2-3 seconds before audio is audible.
  // Pause first, then repeat twice so the agent catches the full booking ref.
  twiml.pause({ length: 3 });

  twiml.say({
    voice:    'Polly.Amy',
    language: 'en-NZ'
  }, `Browser call. ${name}.`);

  twiml.pause({ length: 1 });

  twiml.say({
    voice:    'Polly.Amy',
    language: 'en-NZ'
  }, `Browser call. ${name}. Connecting.`);

  return twiml;
}

/**
 * HTTPS GET helper that follows 302 redirects.
 * GAS web apps always redirect on first request — without following the redirect
 * the response body is empty and name resolution silently fails.
 * Calls callback(error, parsedJson).
 */
function fetchJson_(url, callback, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = 3;

  const urlObj = new URL(url);
  const options = {
    hostname: urlObj.hostname,
    path:     urlObj.pathname + urlObj.search,
    method:   'GET',
    headers:  { 'Accept': 'application/json' }
  };

  https.request(options, (res) => {
    // Follow redirects (GAS always returns 302 on first hit)
    if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirectsLeft > 0) {
      console.log('fetchJson_ redirect to:', res.headers.location);
      res.resume(); // drain response before following
      return fetchJson_(res.headers.location, callback, redirectsLeft - 1);
    }
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.log('fetchJson_ response status:', res.statusCode, 'body:', body.substring(0, 100));
      try {
        callback(null, JSON.parse(body));
      } catch (e) {
        callback(e, null);
      }
    });
  }).on('error', (err) => {
    console.error('fetchJson_ error:', err.message);
    callback(err, null);
  }).end();
}
