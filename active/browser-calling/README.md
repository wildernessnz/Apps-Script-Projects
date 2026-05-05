# Browser Calling (WebRTC)

Wi-Fi browser calling for customers arriving without a working SIM. Calls route through Twilio to Aircall with full HubSpot attribution, agent whisper, and call transcription.

**Live URL:** https://browser-calling-5194.twil.io/index.html  
**Version:** 1.0 — May 2026

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
├── .github/workflows/      CI/CD — auto-deploys on push to main
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

## GitHub Actions

Pushes to `main` touching `functions/` or `assets/` auto-deploy to Twilio.
Add secrets prefixed with `BROWSER_CALLING_` to the repo — see `.github/workflows/deploy.yml` for the full list.

## GAS Script Properties

| Property | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | AC... |
| `TWILIO_AUTH_TOKEN` | From Twilio Console |
| `SYNC_SERVICE_SID` | IS... |
| `HUBSPOT_OWNER_ID` | HubSpot user ID (optional) |
| `ALERT_EMAIL` | Daily monitoring alert recipient |
