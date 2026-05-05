/**
 * Twilio Function: generate-token.js
 * ------------------------------------
 * Issues a short-lived Access Token for the Twilio Voice JS SDK.
 * Deploy this as a Twilio Function (public visibility).
 *
 * SECURITY: Requests must include a valid shared secret to receive a token.
 * The secret is passed as a query parameter from call-page.html and validated
 * here before a token is issued. This prevents unauthorised use of the endpoint
 * by anyone who discovers the URL.
 *
 * Required Environment Variables (set in Twilio Console → Functions →
 * browser-calling → Environment Variables):
 *
 *   ACCOUNT_SID        - Your Twilio Account SID (auto-available in Functions)
 *   API_KEY_SID        - Twilio API Key SID (Console → Voice → API Keys)
 *   API_KEY_SECRET     - Twilio API Key Secret
 *   TWIML_APP_SID      - TwiML App SID (Console → Voice → TwiML Apps)
 *   TOKEN_SECRET       - A long random string you generate (min 32 chars).
 *                        Generate one at: https://generate-secret.vercel.app/32
 *                        Add the same value to call-page.html TOKEN_SECRET const.
 *                        Rotate this if you suspect abuse — then redeploy both
 *                        this Function and call-page.html.
 */

const AccessToken = require('twilio').jwt.AccessToken;
const VoiceGrant  = AccessToken.VoiceGrant;

exports.handler = function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  // Handle preflight OPTIONS request
  if (event.request && event.request.method === 'OPTIONS') {
    response.setStatusCode(200);
    callback(null, response);
    return;
  }

  // ── Security: validate shared secret ──────────────────────────────────────
  // call-page.html sends TOKEN_SECRET as a query parameter.
  // Reject the request immediately if it doesn't match.
  const expectedSecret = context.TOKEN_SECRET || '';
  const providedSecret = event.secret         || '';

  if (!expectedSecret) {
    // TOKEN_SECRET env var not set — fail safe by refusing all requests
    console.error('TOKEN_SECRET environment variable is not set. Refusing token request.');
    response.setStatusCode(500);
    response.setBody({ error: 'Server misconfiguration' });
    callback(null, response);
    return;
  }

  if (providedSecret !== expectedSecret) {
    // Wrong or missing secret — log and reject with 403
    console.warn('Unauthorised token request. bookingRef:', event.bookingRef || 'none',
      'ip:', (event.request && event.request.headers && event.request.headers['x-forwarded-for']) || 'unknown');
    response.setStatusCode(403);
    response.setBody({ error: 'Unauthorised' });
    callback(null, response);
    return;
  }

  // ── Issue token ───────────────────────────────────────────────────────────
  try {
    const bookingRef   = event.bookingRef   || 'unknown';
    const customerName = event.customerName || 'Customer';

    // Unique identity embeds booking ref for traceability in Twilio logs
    const identity = `browser-caller_${bookingRef}_${Date.now()}`;

    const token = new AccessToken(
      context.ACCOUNT_SID,
      context.API_KEY_SID,
      context.API_KEY_SECRET,
      { identity, ttl: 3600 }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: context.TWIML_APP_SID,
      incomingAllow: false
    });
    token.addGrant(voiceGrant);

    console.log('Token issued for:', identity);

    response.setStatusCode(200);
    response.setBody({
      token: token.toJwt(),
      identity,
      bookingRef,
      customerName
    });

    callback(null, response);

  } catch (err) {
    console.error('Token generation error:', err);
    response.setStatusCode(500);
    response.setBody({ error: 'Failed to generate token' });
    callback(null, response);
  }
};
