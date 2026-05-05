# WebRTC Browser Calling — Setup Guide

**Service URL:** `https://browser-calling-5194.twil.io`  
**Last updated:** May 2025 — covers Phase 1 (core calling) and Phase 2 (attribution, whisper, transcription)

---

## Architecture Overview

```
Customer browser  →  Twilio (WebRTC)  →  voice-handler
                         ↑                     │
                  generate-token         ┌─────┼──────────────────┐
                                         ▼     ▼                  ▼
                                   whisper-  transcript-    GAS doPost
                                   handler   handler        (HubSpot log)
                                                │                  │
                                          Twilio Sync    scheduleTranscriptLookup
                                                │                  │
                                          GAS trigger (45s)        ▼
                                                └──────→  appendTranscriptFromSync
                                                                    │
                                                              HubSpot API
```

---

## Prerequisites

Before starting, you need accounts/access for:
- Twilio (paid account — trial restrictions prevent calling unverified numbers)
- Google Workspace (for Google Apps Script)
- HubSpot (Private App token with correct scopes)

---

## Phase 1 — Core Calling

### Step 1 — Twilio account

1. Sign up at [twilio.com](https://www.twilio.com) and upgrade to a paid account
2. Note your **Account SID** from the Console dashboard (`AC...`)
3. Note your **Auth Token** from the Console dashboard

---

### Step 2 — Buy a New Zealand phone number

1. Console → **Phone Numbers → Manage → Buy a number**
2. Country: **New Zealand**, filter by **Voice**
3. Purchase a local NZ number (~USD $1–3/month)
4. Note the number in E.164 format: `+64XXXXXXXXX` — this is `TWILIO_NUMBER`

> **Regulatory bundle:** Twilio requires identity verification for NZ numbers. Create a bundle at Console → Phone Numbers → Regulatory Compliance → Bundles. Submit business registration documents. Approval takes 1–3 business days. Use a US number temporarily while waiting.

---

### Step 3 — Create an API Key

1. Console → **Account → API Keys & Tokens → API Keys**
2. Click **Create API Key**, name it `browser-calling-key`, type **Standard**
3. Copy both values — shown only once:
   - `API_KEY_SID` (starts `SK...`)
   - `API_KEY_SECRET`

---

### Step 4 — Create a TwiML App

1. Console → **Voice → TwiML → TwiML Apps → Create new TwiML App**
2. Name: `Browser Calling`
3. Leave Voice Request URL blank for now
4. Save and copy the **TwiML App SID** (`AP...`) — this is `TWIML_APP_SID`

---

### Step 5 — Deploy the Twilio Functions

#### Create the Function Service

1. Console → **Functions → Services → Create Service**
2. Name: `browser-calling`

#### Set Environment Variables

In the Service editor → **Environment Variables**, add:

| Variable | Value |
|---|---|
| `API_KEY_SID` | `SK...` from Step 3 |
| `API_KEY_SECRET` | Secret from Step 3 |
| `TWIML_APP_SID` | `AP...` from Step 4 |
| `AIRCALL_NUMBER` | Your Aircall inbound number in E.164 |
| `TWILIO_NUMBER` | Your Twilio NZ number in E.164 |
| `TOKEN_SECRET` | Generate at generate-secret.vercel.app/32 |
| `GAS_WEBHOOK_URL` | Add after Step 9 (GAS deployment) |
| `WHISPER_HANDLER_URL` | `https://browser-calling-5194.twil.io/whisper-handler` |
| `TRANSCRIPT_HANDLER_URL` | `https://browser-calling-5194.twil.io/transcript-handler` |
| `SYNC_SERVICE_SID` | `IS...` from Step 11 |

#### Deploy Functions

Add each Function (Add → Add Function), set visibility to **Public**, paste code, save:

| Path | File | Visibility |
|---|---|---|
| `/generate-token` | `generate-token.js` | Public |
| `/voice-handler` | `voice-handler.js` | Public |
| `/whisper-handler` | `whisper-handler.js` | Public |
| `/transcript-handler` | `transcript-handler.js` | Public |

Click **Deploy All**. Note the base URL: `https://browser-calling-5194.twil.io`

---

### Step 6 — Update the TwiML App

1. Console → **Voice → TwiML → TwiML Apps → Browser Calling**
2. Set **Voice Request URL** to: `https://browser-calling-5194.twil.io/voice-handler`
3. Method: **HTTP POST**
4. Save

---

### Step 7 — Download the Twilio Voice SDK

The Twilio Voice JS SDK v2 is not CDN-hosted — you must self-host it.

1. Go to [github.com/twilio/twilio-voice.js/releases/latest](https://github.com/twilio/twilio-voice.js/releases/latest)
2. Download the `.tar.gz` or `.zip` from the Assets section
3. Extract — find `/dist/twilio.min.js`
4. In the Function Service editor → **Add → Upload File**
5. Upload `twilio.min.js`, path `/twilio.min.js`, visibility **Public**

---

### Step 8 — Upload the call page

1. Open `call-page.html` — confirm `TOKEN_URL` points to your Function URL and `TOKEN_SECRET` matches the env var
2. In the Function Service editor → **Add → Upload File**
3. Upload `call-page.html`, path `/index.html`, visibility **Public**
4. Click **Deploy All**

Call page live at: `https://browser-calling-5194.twil.io/index.html`

---

### Step 9 — Deploy the Google Apps Script

1. Open [script.google.com](https://script.google.com) → **New Project**
2. Rename to `Twilio to HubSpot Handler`
3. Create two script files: `CallLogger.gs` and `TestSuite.gs` — paste contents of each
4. **Project Settings → Script Properties** — add:

| Property | Value |
|---|---|
| `HUBSPOT_OWNER_ID` | Your HubSpot user ID (optional) |
| `ALERT_EMAIL` | Email to receive daily monitoring alerts |
| `TWILIO_ACCOUNT_SID` | `AC...` from Twilio Console |
| `TWILIO_AUTH_TOKEN` | Auth token from Twilio Console |
| `SYNC_SERVICE_SID` | `IS...` from Step 11 |

5. **Deploy → New Deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Copy the web app URL — this is `GAS_WEBHOOK_URL`
7. Add `GAS_WEBHOOK_URL` to Twilio environment variables and **Deploy All** in Twilio

---

### Step 10 — Enable AI/ML Addendum (required for transcription)

1. Console → **Voice → Settings → General**
2. Find **Predictive and Generative AI/ML Features Addendum**
3. Select **Enabled** and save

Without this, `<Start><Transcription>` in the TwiML will cause calls to fail with error 31603.

---

### Step 11 — Create Twilio Sync Service

1. Console → **Explore Products → Sync → Services**
2. Click **Create new Service**, name it `browser-calling-transcripts`
3. Copy the SID (`IS...`) — this is `SYNC_SERVICE_SID`
4. Add to both Twilio environment variables and GAS Script Properties

---

### Step 12 — Set up monitoring trigger

Run once from the GAS editor:

```
setupMonitoringTrigger()
```

This installs a daily trigger that runs `monitorCallLog()` at 8am NZT and emails `ALERT_EMAIL` if any issues are found.

---

## Phase 2 Test Checklist

Run these in order after completing all setup steps:

- [ ] Run `testHubSpotConnectivity()` — confirms HubSpot API token is valid
- [ ] Run `testDealLookup()` — confirms deal → contact lookup works for a real booking ref
- [ ] Run `testTokenSecurity()` — confirms 403 on requests without valid secret
- [ ] Run `testMonitoringEmail()` — confirms alert email delivery
- [ ] Open call page on a phone with SIM data **disabled**, connected to Wi-Fi only
- [ ] Place a call — confirm status pill reaches "Line open" and call button activates
- [ ] Answer in Aircall — confirm whisper plays (customer name + booking ref)
- [ ] Have a short conversation — hang up
- [ ] Check Call Log sheet — confirm `Logged ✓` in HubSpot Status column with a HubSpot Call ID in column I
- [ ] Wait ~60 seconds — confirm status updates to `Logged ✓ + Transcript ✓`
- [ ] Check HubSpot contact record — confirm Call engagement with transcript in the body

---

## Generating tracked call links

Embed in booking confirmation emails:

```
https://browser-calling-5194.twil.io/index.html?ref={{BOOKING_REF}}&name={{FIRST_NAME}}+{{LAST_NAME}}
```

**HubSpot email merge tag example:**
```
https://browser-calling-5194.twil.io/index.html?ref={{ contact.booking_reference }}&name={{ contact.firstname }}+{{ contact.lastname }}
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "SDK failed to load" | `twilio.min.js` not uploaded | Upload to `/twilio.min.js` as Twilio Asset, Deploy All |
| "Could not connect — check Wi-Fi" | Token fetch failing | Check browser Network tab for token endpoint response |
| Status badge stuck on "Initialising…" | `TOKEN_URL` wrong in call-page.html | Confirm URL matches deployed Function |
| 403 from token endpoint | `TOKEN_SECRET` mismatch | Confirm secret matches between call-page.html and Twilio env var exactly |
| Application error on call | TwiML error in voice-handler | Check Monitor → Logs → Calls → Request Inspector for the failed call |
| 31603 Decline error | AI/ML addendum not enabled | Enable in Console → Voice → Settings → General |
| Whisper not heard | whisper-handler not Public, or Function not deployed | Check visibility and confirm it's deployed |
| Call logged but no transcript | Sync not ready / trigger failed | Check GAS → Triggers for runPendingTranscriptLookup entries |
| "No deal found" in Call Log | Booking ref doesn't match deal name | Check exact deal name format in HubSpot vs ref in URL |
| Aircall double logging | Aircall HubSpot integration also logs | Expected — GAS engagement contains transcript + booking ref; Aircall's does not |
| Daily alert not arriving | Trigger not installed or ALERT_EMAIL not set | Run `setupMonitoringTrigger()`, confirm Script Property set |

---

## Rotating the token secret

1. Generate a new secret at [generate-secret.vercel.app/32](https://generate-secret.vercel.app/32)
2. Update `TOKEN_SECRET` in Twilio environment variables → **Deploy All**
3. Update `TOKEN_SECRET` in `call-page.html` → re-upload → **Deploy All**

All active page sessions will immediately stop working until the customer refreshes — existing calls in progress are not affected.

---

*Setup Guide — browser-calling-5194.twil.io — May 2025*
