# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Google Apps Script project that fetches booking data from Heroku Dataclips and populates a Google Sheet with live bookings, unfinished bookings, and payment data. Runs on a scheduled trigger limited to working hours (7 AM–7 PM, Pacific/Auckland).

## Development Workflow

This project uses [Clasp](https://github.com/google/clasp) to sync local code with Google Apps Script.

```bash
npm install          # Install type definitions
clasp login          # Authenticate with Google (first time)
clasp push           # Deploy local code to Apps Script
clasp pull           # Sync remote changes locally
```

There are no build, lint, or test steps configured.

## Architecture

All logic lives in `Code.js` (a single Apps Script file):

- **`updateFromHerokDataSource()`** — The scheduled entry point. Guards execution to working hours using `WildernessAppScriptLibrary.Utility`, then calls `populateSheet()` for each of the three Heroku Dataclip endpoints.
- **`populateSheet(sheetName, url, startCol, endCol)`** — Fetches JSON from a Dataclip URL, clears the target column range in the named sheet, merges field headers with row data, and writes the result.

**External dependency:** `WildernessAppScriptLibrary` is a shared Apps Script library (v0, development mode) providing time/utility helpers. Its types are declared in `WildernessAppScriptLibrary.d.ts`.

**Data sources** (Heroku Dataclip IDs):
- `rtsvjpzqklpiqphnhelhxwnbgakr` — Live Bookings
- `fckrgutyhvrgcqyecrvuemyzcvon` — Unfinished Bookings (24 months)
- `xkgimixvartntefflcqyqigkmtil` — Booking Payments

## Key Configuration Files

- `appsscript.json` — Apps Script manifest (runtime: V8, timezone: Pacific/Auckland, Stackdriver logging enabled)
- `.clasp.json` — Script ID and file extension filters for deployment
- `.claspignore` — Excludes `node_modules`, `.git`, `README*`, and `package*.json` from push
- `jsconfig.json` — ES2020 target with `@types/google-apps-script` for IDE type checking
