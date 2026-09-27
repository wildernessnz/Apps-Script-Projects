# Browser Calling (WebRTC)

Wi-Fi browser calling for customers arriving without a working SIM. Calls route through Twilio to Aircall with full HubSpot attribution, agent whisper, and call transcription.

**Twilio Functions URL:** https://browser-calling-5194.twil.io (generate-token, voice-handler, whisper-handler, transcript-handler — plus a Twilio Asset copy of `index.html` used for direct/CI testing, not what customers use)  
**Customer-facing URL:** https://call.wilderness.co.nz (separately hosted on AWS S3 + CloudFront — see `docs/SETUP_GUIDE.md` Phase 3. This is the actual live link customers get; deploying `index.html` to Twilio does **not** update it)  
**Version:** 1.1 — September 2026

## Structure

```
browser-calling/
├── functions/              Twilio Functions (Node.js)
│   ├── generate-token.js   Token issuance with secret validation
│   ├── voice-handler.js    Call routing, transcription, whisper, HubSpot callback
│   ├── whisper-handler.js  Agent announcement before bridging
│   └── transcript-handler.js  Real-time transcript accumulation via Sync
├── assets/
│   └── index.html          Customer-facing call page
├── gas/                    Google Apps Script
│   ├── CallLogger.gs       HubSpot logging, transcript retrieval, monitoring
│   ├── TestSuite.gs        Manual test functions
│   ├── appsscript.json     GAS project manifest
│   └── .clasp.json         clasp CLI config (update scriptId before use)
├── docs/                   Setup guide and as-built documentation
├── .env.example            Environment variable template
└── .twilioserverlessrc     Twilio Serverless project config
```

## Call link format

```
https://browser-calling-5194.twil.io/index.html?ref={BOOKING_REF}&name={CUSTOMER_NAME}
```

`ref` and `name` are optional — name is resolved from HubSpot via deal lookup if not provided.

## Deploy — Twilio Functions

```bash
npm install -g twilio-cli @twilio-labs/plugin-serverless
cp .env.example .env   # fill in values
twilio serverless:deploy
```

## Deploy — Google Apps Script

```bash
npm install -g @google/clasp
clasp login
# Update gas/.clasp.json with your Script ID
cd gas && clasp push
```

## Deployment

Deployment is manual — there is no CI/CD. `twilio serverless:deploy` pushes the Twilio Functions and a Twilio Asset copy of `index.html` (see "Deploy — Twilio Functions" above); the customer-facing page at `call.wilderness.co.nz` is a separate AWS S3 + CloudFront deployment that needs its own manual upload + CloudFront invalidation after every change (see `docs/SETUP_GUIDE.md` → "Updating the call page").

> **Note (Sept 2026):** a GitHub Actions auto-deploy workflow existed for a while but had been silently broken since the project's initial build (nested one directory too deep for GitHub Actions to ever recognise it) and was never actually functional. Rather than fix and maintain it, it's been removed — manual deploys are the intended process going forward.

## GAS Script Properties

| Property | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | AC... |
| `TWILIO_AUTH_TOKEN` | From Twilio Console |
| `SYNC_SERVICE_SID` | IS... |
| `HUBSPOT_OWNER_ID` | HubSpot user ID (optional) |
| `ALERT_EMAIL` | Daily monitoring alert recipient |
