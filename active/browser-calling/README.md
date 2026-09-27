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

Pushes to `main` touching `functions/` or `assets/` auto-deploy the Twilio Functions and the Twilio Asset copy of `index.html`.
Add secrets prefixed with `BROWSER_CALLING_` to the repo — see `.github/workflows/deploy.yml` (lives at the monorepo root, `Apps-Script-Projects/.github/workflows/`, **not** under this folder) for the full list.

**This does not update the customer-facing page.** `call.wilderness.co.nz` is a separate AWS S3 + CloudFront deployment (see `docs/SETUP_GUIDE.md` → "Updating the call page") that this workflow never touches — every change to `index.html` still needs a manual S3 upload + CloudFront invalidation to actually reach customers.

> **Fixed 28 Sept 2026:** this workflow file was previously nested at `active/browser-calling/.github/workflows/deploy.yml`, which GitHub Actions never recognised (it only reads `.github/workflows/` from the repo root) — so despite this README's claim, it had never actually run. It's now at the correct path and works going forward.

## GAS Script Properties

| Property | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | AC... |
| `TWILIO_AUTH_TOKEN` | From Twilio Console |
| `SYNC_SERVICE_SID` | IS... |
| `HUBSPOT_OWNER_ID` | HubSpot user ID (optional) |
| `ALERT_EMAIL` | Daily monitoring alert recipient |
