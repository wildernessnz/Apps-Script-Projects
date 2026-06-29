# WebRTC Browser Calling — Setup Guide

**Twilio Functions URL:** `https://browser-calling-5194.twil.io`  
**Call page URL:** `https://call.wilderness.co.nz`  
**Last updated:** May 2026 — covers Phase 1 (core calling), Phase 2 (attribution, whisper, transcription), and hosting setup

---

## Architecture Overview

```
Customer browser  →  Twilio (WebRTC)  →  voice-handler
(call.wilderness.co.nz)  ↑                    │
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
- AWS account (S3 + CloudFront for call page hosting)
- DNSimple access for DNS management

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
4. Upload to S3 alongside `index.html` (see Step 13)

---

### Step 8 — Deploy the Google Apps Script

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

### Step 9 — Enable AI/ML Addendum (required for transcription)

1. Console → **Voice → Settings → General**
2. Find **Predictive and Generative AI/ML Features Addendum**
3. Select **Enabled** and save

Without this, `<Start><Transcription>` in the TwiML will cause calls to fail with error 31603.

---

### Step 10 — Create Twilio Sync Service

1. Console → **Explore Products → Sync → Services**
2. Click **Create new Service**, name it `browser-calling-transcripts`
3. Copy the SID (`IS...`) — this is `SYNC_SERVICE_SID`
4. Add to both Twilio environment variables and GAS Script Properties

---

### Step 11 — Set up monitoring trigger

Run once from the GAS editor:

```
setupMonitoringTrigger()
```

This installs a daily trigger that runs `monitorCallLog()` at 8am NZT and emails `ALERT_EMAIL` if any issues are found. Confirm by running `testMonitoringEmail()`.

---

## Phase 3 — Call Page Hosting (AWS S3 + CloudFront)

Twilio Functions does not support custom domains. The call page is hosted on AWS S3 + CloudFront so customers see `https://call.wilderness.co.nz` rather than the Twilio URL.

### Step 12 — Create S3 bucket

1. Go to **AWS Console → S3 → Create bucket**
2. Name: `call.wilderness.co.nz` (match your intended subdomain exactly)
3. Region: `ap-southeast-2` (Sydney — closest to NZ)
4. **Uncheck** Block all public access (all four boxes must be off)
5. Create bucket

#### Enable static website hosting

1. S3 → your bucket → **Properties** tab → scroll to **Static website hosting**
2. Click **Edit** → select **Enable**
3. Set Index document: `index.html`
4. Save
5. Copy the **Bucket website endpoint** — it will look like:
   `http://call.wilderness.co.nz.s3-website-ap-southeast-2.amazonaws.com`
   You'll need this when setting up the CloudFront origin.

#### Add bucket policy

S3 → your bucket → **Permissions** tab → **Bucket policy** → Edit → paste:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::call.wilderness.co.nz/*"
    }
  ]
}
```

#### Upload files

Upload both files to the bucket root:
- `index.html` (the call page — rename from `call-page.html`)
- `twilio.min.js` (the Twilio Voice SDK)

Ensure `call-page.html` references the SDK as a relative path (`./twilio.min.js`) before uploading.

---

### Step 13 — Request ACM SSL certificate

> **Important:** ACM certificates for CloudFront must be created in `us-east-1` (N. Virginia) regardless of where your bucket is.

1. Switch AWS region to **us-east-1**
2. Go to **AWS Certificate Manager → Request certificate**
3. Select **Request a public certificate**
4. Domain name: `call.wilderness.co.nz`
5. Validation method: **DNS validation**
6. Request
7. AWS will give you a CNAME record to add to DNSimple — add it and wait for validation (usually 5–15 minutes)

---

### Step 14 — Create CloudFront distribution

1. **AWS Console → CloudFront → Create distribution**

2. **Origin settings:**
   - Origin domain: paste the S3 **website endpoint** URL (NOT the S3 REST API URL)
     e.g. `call.wilderness.co.nz.s3-website-ap-southeast-2.amazonaws.com`
   - Protocol: **HTTP only** (S3 website endpoints don't support HTTPS — CloudFront handles SSL)

   > **Common mistake:** If you select the bucket from the dropdown, AWS uses the REST API endpoint (`call.wilderness.co.nz.s3.amazonaws.com`) which requires authentication and causes Access Denied errors. Always paste the website endpoint URL manually.

3. **Default cache behaviour:**
   - Viewer protocol policy: **Redirect HTTP to HTTPS**
   - Cache policy: **CachingDisabled** (or a short TTL during testing)

4. **Settings:**
   - Alternate domain names (CNAMEs): `call.wilderness.co.nz`
   - Custom SSL certificate: select the ACM certificate from Step 13
   - Default root object: `index.html`

5. Create distribution — note the **Distribution domain name** (e.g. `d2zjy8cax3ynft.cloudfront.net`)

6. Wait 2–5 minutes for the distribution to deploy (Status changes from "Deploying" to "Enabled")

---

### Step 15 — Configure DNS in DNSimple

1. Log in to **DNSimple → your domain**
2. Go to **Manage → DNS**
3. Add a new record:
   - Type: **CNAME**
   - Name: `call`
   - Value: your CloudFront distribution domain (e.g. `d2zjy8cax3ynft.cloudfront.net`)
   - TTL: 3600
4. Save

DNS propagation typically takes 5–15 minutes. Test by opening `https://call.wilderness.co.nz` in a browser.

---

## Phase 2 Test Checklist

Run these in order after completing all setup steps:

- [ ] Run `testHubSpotConnectivity()` — confirms HubSpot API token is valid
- [ ] Run `testDealLookup()` — confirms deal → contact lookup works for a real booking ref
- [ ] Run `testTokenSecurity()` — confirms 403 on requests without valid secret
- [ ] Run `testMonitoringEmail()` — confirms alert email delivery
- [ ] Open `https://call.wilderness.co.nz` on a phone with SIM data **disabled**, connected to Wi-Fi only
- [ ] Place a call — confirm status pill reaches "Line open" and call button activates
- [ ] Answer in Aircall — confirm whisper plays (customer name before bridging)
- [ ] Have a short conversation — hang up
- [ ] Check Call Log sheet — confirm `Logged ✓` in HubSpot Status column with a HubSpot Call ID in column I
- [ ] Wait ~60 seconds — confirm status updates to `Logged ✓ + Transcript ✓`
- [ ] Check HubSpot contact record — confirm Call engagement with transcript in the body

---

## Generating tracked call links

Embed in booking confirmation emails:

```
https://call.wilderness.co.nz?ref={{BOOKING_REF}}&name={{FIRST_NAME}}+{{LAST_NAME}}
```

Both `ref` and `name` parameters are optional. If `name` is omitted, it is resolved automatically from HubSpot via the booking reference deal lookup.

**HubSpot email merge tag example:**
```
https://call.wilderness.co.nz?ref={{ contact.booking_reference }}&name={{ contact.firstname }}+{{ contact.lastname }}
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Access Denied on CloudFront | Origin set to S3 REST endpoint not website endpoint | Edit origin — paste website endpoint URL manually, set protocol to HTTP only |
| SSL error on custom domain | ACM certificate not validated or in wrong region | Certificate must be in us-east-1; check DNS validation CNAME is in DNSimple |
| CloudFront serving stale content | Cache not invalidated after S3 update | Create an invalidation in CloudFront for `/*` after uploading new files |
| "SDK failed to load" | `twilio.min.js` not in S3 bucket | Upload `twilio.min.js` to S3 bucket root, confirm relative path in `index.html` |
| "Could not connect — check Wi-Fi" | Token fetch failing | Check browser Network tab for token endpoint response |
| Status badge stuck on "Initialising…" | `TOKEN_URL` wrong in call-page.html | Confirm URL matches deployed Twilio Function |
| 403 from token endpoint | `TOKEN_SECRET` mismatch | Confirm secret matches between `index.html` and Twilio env var exactly |
| Application error on call | TwiML error in voice-handler | Check Monitor → Logs → Calls → Request Inspector for the failed call |
| 31603 Decline error | AI/ML addendum not enabled | Enable in Console → Voice → Settings → General |
| Whisper not heard | whisper-handler not Public, or GAS redirect not followed | Check visibility and confirm fetchJson_ is following GAS 302 redirects |
| Call logged but no transcript | Sync not ready / trigger failed | Check GAS → Triggers for runPendingTranscriptLookup entries |
| "No deal found" in Call Log | Booking ref doesn't match deal name | Check exact deal name format in HubSpot vs ref in URL |
| Daily alert not arriving | Trigger not installed or ALERT_EMAIL not set | Run `setupMonitoringTrigger()`, confirm Script Property set |

---

## Rotating the token secret

1. Generate a new secret at [generate-secret.vercel.app/32](https://generate-secret.vercel.app/32)
2. Update `TOKEN_SECRET` in Twilio environment variables → **Deploy All**
3. Update `TOKEN_SECRET` in `index.html` → re-upload to S3 → create CloudFront invalidation for `/*`

All active page sessions will stop working until the customer refreshes — existing calls in progress are not affected.

---

## Updating the call page

After any change to `index.html` or `twilio.min.js`:

1. Upload the updated file to S3
2. Go to **CloudFront → your distribution → Invalidations → Create invalidation**
3. Path: `/*`
4. Create — CloudFront will serve the new version within 1–2 minutes

Without an invalidation, CloudFront may serve a cached version for hours.

---

*Setup Guide — call.wilderness.co.nz — May 2026*