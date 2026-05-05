/**
 * Twilio Function: voice-handler.js
 * ------------------------------------
 * Called by Twilio when a customer places a call via the browser call page
 * (call-page.html). This is the Voice URL configured on the TwiML App.
 *
 * PHASE 1 — Core call routing
 *   Receives the call from the browser (Twilio.Device.connect), plays a
 *   brief connecting message to the customer, then dials through to the
 *   Aircall number. If no one answers within 30 seconds, plays an apology
 *   message and ends the call.
 *
 * PHASE 2 — Attribution & agent identity
 *
 * PHASE 3 — Call transcription
 *   Starts a real-time transcription on both audio tracks (customer browser
 *   + Aircall agent) using Twilio's <Start><Transcription> verb. Twilio
 *   streams utterances to transcript-handler.js as they occur. When the
 *   call ends, transcript-handler.js assembles the full text and POSTs it
 *   to GAS, which appends it to the existing HubSpot Call engagement.
 *   Two additions to the Phase 1 dial:
 *
 *   1. Call whisper (url on <Number>)
 *      When the Aircall agent answers — but before the customer is bridged —
 *      Twilio calls whisper-handler.js (a separate Twilio Function) on the
 *      agent's leg. That Function returns a TwiML <Say> announcing the
 *      customer name and booking reference. Using a Twilio Function (not GAS)
 *      ensures sub-200ms response time, avoiding cold-start latency that
 *      causes the whisper to be skipped when GAS takes too long to respond.
 *      The customer continues to hear ringing. Requires answerOnBridge: true.
 *
 *   2. Status callback (action on <Dial>)
 *      When the Aircall leg ends (answered and hung up, no-answer, busy,
 *      or failed), Twilio POSTs the call outcome to the GAS webhook. The
 *      GAS script logs the call as a HubSpot Call engagement against the
 *      matching contact, looked up by booking reference.
 *
 * Environment Variables (set in Twilio Console → Functions → browser-calling
 * → Environment Variables):
 *
 *   AIRCALL_NUMBER   - Aircall inbound number in E.164 format
 *                      e.g. +6436672294
 *                      Phase 1 ✓  Phase 2 ✓  (unchanged)
 *
 *   TWILIO_NUMBER    - Your Twilio NZ phone number in E.164 format
 *                      e.g. +6498001234
 *                      Shown as caller ID to Aircall for all browser calls.
 *                      Phase 1 ✓  Phase 2 ✓  (unchanged)
 *
 *   GAS_WEBHOOK_URL       - Google Apps Script web app URL (CallLogger.gs)
 *                           e.g. https://script.google.com/macros/s/YOUR_ID/exec
 *                           Used for the status callback (HubSpot logging).
 *                           Phase 2 only ✓
 *
 *   WHISPER_HANDLER_URL      - URL of the whisper-handler Twilio Function
 *                               e.g. https://browser-calling-5194.twil.io/whisper-handler
 *                               Phase 2 only ✓
 *
 *   TRANSCRIPT_HANDLER_URL  - URL of the transcript-handler Twilio Function
 *                               e.g. https://browser-calling-5194.twil.io/transcript-handler
 *                               Used as the statusCallbackUrl for real-time transcription.
 *                               Phase 3 only ✓
 *
 * Call parameters received from the browser (via Twilio.Device.connect):
 *   bookingRef    - Booking reference from the call page URL (?ref=BK-12345)
 *   customerName  - Customer name from the call page URL (?name=Sarah+Smith)
 *   Both are passed through to the whisper and status callback for attribution.
 */

exports.handler = function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();

  // Read custom parameters passed from the browser via Twilio.Device.connect({ params: {...} })
  // These originate from the call page URL query string (?ref=BK-12345&name=Sarah+Smith)
  const bookingRef   = event.bookingRef   || '';
  const customerName = event.customerName || '';
  const callSid      = event.CallSid      || '';

  // Log all call parameters to Twilio Function logs for debugging
  // Visible in: Twilio Console → Functions → browser-calling → Logs
  console.log('Voice handler called:', JSON.stringify({
    caller:       event.Caller,       // e.g. client:browser-caller_BK-12345_1234567890
    callSid:      event.CallSid,      // Unique Twilio call identifier
    bookingRef,
    customerName
  }));

  // ── Phase 3: Real-time transcription ────────────────────────────────────
  // The Twilio Functions bundled helper library doesn't support
  // start.transcription() — we return raw XML instead of using the TwiML
  // builder for this response, which guarantees compatibility with any
  // library version.
  const transcriptCallbackUrl = `${context.TRANSCRIPT_HANDLER_URL}`
    + `?bookingRef=${encodeURIComponent(bookingRef)}`
    + `&customerName=${encodeURIComponent(customerName)}`;

  const whisperUrl = `${context.WHISPER_HANDLER_URL}`
    + `?bookingRef=${encodeURIComponent(bookingRef)}`
    + `&customerName=${encodeURIComponent(customerName)}`;

  const actionUrl = `${context.GAS_WEBHOOK_URL}`
    + `?bookingRef=${encodeURIComponent(bookingRef)}`
    + `&customerName=${encodeURIComponent(customerName)}`;

  const noAnswerMsg = "Sorry, we weren't able to connect your call right now. "
    + "Please send us a message on WhatsApp and we'll get back to you shortly.";

  // XML-encode URLs — bare & in XML attribute values causes a parse failure.
  // encodeURIComponent encodes the param values but the & joining params is bare.
  const xmlEncode = url => url.replace(/&/g, '&amp;');

  // Build entire response as raw XML — avoids all helper library version issues
  const rawXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Transcription
      name="transcript_${callSid}"
      statusCallbackUrl="${xmlEncode(transcriptCallbackUrl)}"
      statusCallbackMethod="POST"
      track="both_tracks"
      languageCode="en-US"/>
  </Start>
  <Dial
    callerId="${context.TWILIO_NUMBER}"
    timeout="30"
    record="record-from-answer"
    answerOnBridge="true"
    action="${xmlEncode(actionUrl)}"
    method="POST">
    <Number url="${xmlEncode(whisperUrl)}" method="GET">${context.AIRCALL_NUMBER}</Number>
  </Dial>
  <Say voice="Polly.Amy" language="en-NZ">${noAnswerMsg}</Say>
</Response>`;

  const response = new Twilio.Response();
  response.setStatusCode(200);
  response.appendHeader('Content-Type', 'text/xml');
  response.setBody(rawXml);
  return callback(null, response);
};
