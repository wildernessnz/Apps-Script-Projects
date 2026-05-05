/**
 * Twilio Function: transcript-handler.js
 * ----------------------------------------
 * Receives real-time transcription webhook events from Twilio during a call.
 * Accumulates transcript chunks in Twilio Sync (serverless key-value store),
 * then POSTs the full transcript to GAS when transcription ends so it can be
 * appended to the HubSpot Call engagement.
 *
 * Twilio fires two event types to this URL:
 *
 *   TranscriptionEvent: "transcription-content"
 *     Fired in near real-time as speech is detected.
 *     Contains a TranscriptionData JSON blob with utterances and speaker info.
 *
 *   TranscriptionEvent: "transcription-stopped"
 *     Fired once when the call ends and transcription stops.
 *     At this point we assemble the full transcript and send it to GAS.
 *
 * Environment Variables:
 *   GAS_WEBHOOK_URL   - Google Apps Script web app URL (CallLogger.gs)
 *   SYNC_SERVICE_SID  - Twilio Sync Service SID (create in Console →
 *                       Sync → Services → Create Service, copy the SID)
 *                       Used to temporarily store transcript chunks per call.
 *
 * Setup:
 *   1. Create a Twilio Sync Service in the Console → Sync → Services
 *   2. Copy its SID into the SYNC_SERVICE_SID environment variable
 *   3. Deploy this Function as /transcript-handler (Public visibility)
 *   4. Add TRANSCRIPT_HANDLER_URL env var pointing to this Function
 *   5. voice-handler.js uses TRANSCRIPT_HANDLER_URL in the <Start><Transcription> block
 */

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.setStatusCode(200);
  response.setBody('OK');

  const transcriptionEvent = event.TranscriptionEvent;
  const callSid            = event.CallSid || '';

  // bookingRef and customerName are in the statusCallbackUrl query string,
  // not in the Twilio POST body. Twilio Functions exposes URL params via event
  // only for GET requests — for POSTs we must parse the request URL manually.
  // Twilio passes the original URL params merged into the event object for
  // Functions, so try event first, then fall back to empty string.
  const bookingRef   = event.bookingRef   || event['bookingRef']   || '';
  const customerName = event.customerName || event['customerName'] || '';

  console.log('Transcript event:', transcriptionEvent, 'CallSid:', callSid);

  try {
    const client      = context.getTwilioClient();
    const syncService = client.sync.v1.services(context.SYNC_SERVICE_SID);
    const docKey      = `transcript_${callSid}`;

    if (transcriptionEvent === 'transcription-content') {
      // ── Accumulate transcript chunk ──────────────────────────────────────
      // Speaker identification comes from event.Track (top-level field), NOT
      // from anything inside TranscriptionData. Twilio sends one webhook per
      // track, labelled as:
      //   inbound_track  = audio Twilio RECEIVES = customer speaking into browser
      //   outbound_track = audio Twilio SENDS    = Aircall agent speaking
      let chunks = [];
      try {
        const raw   = JSON.parse(event.TranscriptionData || '{}');
        const track = event.Track || ''; // 'inbound_track' or 'outbound_track'
        if (raw.transcript) {
          // inbound = customer, outbound = agent
          const speaker = track === 'outbound_track' ? 'Agent' : 'Customer';
          chunks.push({ speaker, text: raw.transcript, ts: Date.now() });
        }
      } catch (e) {
        console.log('Could not parse TranscriptionData:', event.TranscriptionData);
      }

      if (chunks.length === 0) {
        callback(null, response);
        return;
      }

      // Read existing doc, append new chunks, write back
      let existing = [];
      try {
        const doc = await syncService.documents(docKey).fetch();
        existing  = doc.data.chunks || [];
      } catch (e) {
        // Doc doesn't exist yet — first chunk for this call
      }

      const updated = [...existing, ...chunks];
      try {
        // Include bookingRef and customerName in every update so they are never wiped
        await syncService.documents(docKey).update({
          data: { chunks: updated, bookingRef, customerName }
        });
      } catch (e) {
        // Doc didn't exist — create it
        await syncService.documents.create({
          uniqueName: docKey,
          data:       { chunks: updated, bookingRef, customerName },
          ttl:        86400
        });
      }

    } else if (transcriptionEvent === 'transcription-stopped') {
      // ── Transcription complete — store in Sync, let status callback pick it up
      // We do NOT post to GAS here. The Twilio status callback (action on <Dial>)
      // fires at the same time and calls GAS — that handler has the HubSpot Call ID
      // and reads the transcript from Sync directly. This eliminates the race condition.
      let chunks     = [];
      let storedRef  = bookingRef;
      let storedName = customerName;

      try {
        const doc  = await syncService.documents(docKey).fetch();
        chunks     = doc.data.chunks      || [];
        storedRef  = doc.data.bookingRef  || bookingRef;
        storedName = doc.data.customerName || customerName;
      } catch (e) {
        console.log('No transcript doc found for call:', callSid);
      }

      if (chunks.length === 0) {
        console.log('No transcript content for call:', callSid);
        callback(null, response);
        return;
      }

      const transcriptText = chunks
        .map(c => {
          // speaker is stored as 'Customer' or 'Agent' directly from the Track field
          return '[' + (c.speaker || 'Unknown') + '] ' + c.text;
        })
        .join('\n');

      console.log('Transcript ready, length:', transcriptText.length, '— storing in Sync for status callback');

      // Update Sync doc with finished transcript — TTL 1 hour
      try {
        await syncService.documents(docKey).update({
          data: { chunks, bookingRef: storedRef, customerName: storedName, transcript: transcriptText, transcriptReady: true },
          ttl:  3600
        });
        console.log('Transcript stored in Sync doc:', docKey);
      } catch (e) {
        // Doc may have expired — recreate
        try {
          await syncService.documents.create({
            uniqueName: docKey,
            data: { chunks, bookingRef: storedRef, customerName: storedName, transcript: transcriptText, transcriptReady: true },
            ttl:  3600
          });
          console.log('Transcript Sync doc recreated:', docKey);
        } catch (e2) {
          console.error('Could not store transcript in Sync:', e2.message);
        }
      }
    }

  } catch (err) {
    console.error('transcript-handler error:', err.message);
  }

  callback(null, response);
};

/**
 * HTTPS POST helper for calling GAS from a Twilio Function.
 * Follows 302 redirects — GAS web apps redirect the initial request
 * to the actual execution URL before processing.
 */
function postToGas_(url, body) {
  return new Promise((resolve, reject) => {
    const https   = require('https');
    const payload = JSON.stringify(body);

    function doRequest(targetUrl, redirectsLeft) {
      const urlObj = new URL(targetUrl);
      const options = {
        hostname: urlObj.hostname,
        path:     urlObj.pathname + urlObj.search,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        // GAS web apps return a 302 redirect — must follow it AND resend the
        // POST body, otherwise the body is dropped and GAS receives empty data.
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirectsLeft > 0) {
          console.log('GAS redirect (' + res.statusCode + ') to:', res.headers.location);
          // Drain the redirect response body before following
          res.resume();
          return doRequest(res.headers.location, redirectsLeft - 1);
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log('GAS response status:', res.statusCode, 'body:', data.substring(0, 100));
          resolve(data);
        });
      });
      req.on('error', (err) => {
        console.error('postToGas_ error:', err.message);
        reject(err);
      });
      req.write(payload);
      req.end();
    }

    doRequest(url, 3);
  });
}
