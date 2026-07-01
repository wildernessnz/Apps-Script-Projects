# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Google Apps Script project (bound to a Google Sheet) that reads data pipeline
health and business reporting into sheets/dashboards, and lets a human manually
re-fire individual sync endpoints. It is a **thin consumer** on top of a BigQuery
dataset (`wilderness-data`) populated by a separate pipeline (`wilderness-pipeline`
Cloud Run service + Cloud Scheduler jobs) — this repo contains no ETL logic itself,
only read/query/display code plus a few manual-trigger and admin actions.

## Maintenance policy

**After every change to this repo, update this file and log the change:**
1. If the change affects anything described above (new file, new sheet, new
   trigger, new dependency, changed behavior) — update the relevant section(s) so
   this file stays accurate. Don't leave stale descriptions of removed/changed code.
2. Append an entry to **Change History** below (newest entry on top) with the date,
   a one-line summary, and the files touched. Keep entries terse — this is a log, not
   a commit message essay.
3. Create a git commit for the change, with a descriptive commit message (subject +
   short body if needed). One commit per logical change — don't batch unrelated
   changes into a single commit just to save a step.

## Commands

This is a [clasp](https://github.com/google/clasp)-managed project (`.clasp.json`
holds the target script ID) — there is no build, lint, or test tooling; it's plain
Apps Script (V8 runtime) files pushed directly to the Apps Script project.

- `clasp push` — push local `.js` files to the Apps Script project (run after any edit)
- `clasp pull` — pull the current state from Apps Script (check before editing if unsure local is current)
- `clasp open` — open the project in the Apps Script web editor

There is no automated test suite. Verifying a change means: `clasp push`, then run
the relevant function from the Apps Script editor's Run dropdown (or the sheet's
custom menu / checkboxes) and inspect the resulting sheet and/or `Logger.log` output
(View → Logs, or `clasp logs`).

## Architecture

**Apps Script global scope**: every `.js` file in this project shares one global
scope. `GCP_PROJECT_ID` is declared once (`Core.js`) and used everywhere else
without re-declaring — a duplicate `const`/`var` of the same name across files throws
"Identifier has already been declared." Function names must also be unique
project-wide (`onOpen`, `onManualTriggerEdit`, every `triggerX()`/`refreshX()`
wrapper).

**One reporting class per file, thin wrapper functions on top.** Each file (e.g.
`HubSpot Deals Reporting.js`, `Fleetio Work Order Reporting.js`,
`Health Check Reporting.js`) defines a `var XReporting = function() { ... }`
constructor exposing public methods (`this.refresh`, `this.refreshSummary`, ...) plus
private helpers (trailing-underscore naming: `writeToSheet_`, `applyXFormatting_`).
Top-level bare functions (`function refreshDealsSummary() { new
DealsReporting().refreshSummary(); }`) exist only so Apps Script's Run-menu function
picker and sheet menus have something to bind to — business logic never lives in
these wrappers.

**Business logic lives in BigQuery views, not here.** Every reporting file queries a
`wilderness-data.reporting.*` view with a `SELECT *` or a light `GROUP BY` — casting,
stage grouping, NZT conversion, staleness thresholds, cost rollups, etc. are computed
in the view. If a number or column looks wrong, first suspect the view, not this
code. Two exceptions that talk to non-BigQuery APIs directly:
- `Scheduled Job Reporting.js` calls the Cloud Scheduler REST API directly (job state
  isn't in BigQuery) and computes next-run times client-side by hand-parsing cron
  expressions — `parseNextRun_()` is deliberately **not** a general cron parser, only
  handles the specific patterns this pipeline's jobs actually use (every-N-minutes,
  hourly, daily, weekly-on-day). Extend it if a new schedule pattern is added upstream.
- `Health Check Reporting.js`'s `triggerSync()` / `Manual Triggers.js` call the
  `wilderness-pipeline` Cloud Run service directly to kick off a sync.

**`writeToSheet_` pattern, duplicated per file, not shared.** Every reporting class
has its own private `writeToSheet_(sheetName, headers, data)`: clear sheet → write
header row (bold, frozen) → write data rows → append a `last_refresh` timestamp
(Pacific/Auckland) as the final column. This is intentionally copy-pasted across
files rather than factored into a shared helper — keep that in mind when fixing a bug
in one copy; check whether the same bug exists in the others (`Health Check
Reporting.js`, `HubSpot Deals Reporting.js`, `Fleetio Work Order Reporting.js`,
`Scheduled Job Reporting.js` each have their own copy).

**Region**: all BigQuery queries pass `location: 'australia-southeast1'`
explicitly (data migrated from a US region) — carry this through if adding a new
query against `wilderness-data`.

**Timezone**: everything user-facing is formatted in `Pacific/Auckland` (NZT), set
project-wide via `appsscript.json`'s `timeZone`.

### Health Check dashboard (`Health Check Reporting.js`)

The most complex file — a multi-sheet dashboard (Current Status, Recent Errors,
Unacknowledged Alerts, Volume Trends + chart, Performance Metrics, Volume
Anomalies) plus alert-acknowledgement and manual-resync actions:
- Conditional row coloring is applied via direct `setBackground()` calls (not native
  Sheets conditional-format rules) so it rebuilds cleanly on every refresh instead of
  accumulating rules. Severity priority order used consistently: **error > stale lock
  > stale**.
- `runHealthCheckDigest(email)` / `runHealthCheckDigestScheduled()` sends an HTML+
  plaintext email **only when something needs attention** (error, stale schedule,
  stale lock, unacked alert, or volume anomaly) — silent when healthy, to avoid digest
  fatigue. The email's row colors intentionally reuse the same hex values as the
  sheet's own formatting — keep both in sync if either changes.
- The Volume Trends Chart sheet's chart is created once and bound to a fixed range;
  it deliberately never gets a `last_refresh` column appended (unlike every other
  sheet) because that would shift the chart's bound range and break it.
- `triggerSync(platform, table)` POSTs to the Cloud Run service using
  `ScriptApp.getOAuthToken()` as a bearer token — requires the Apps Script identity to
  have `roles/run.invoker` on the `wilderness-pipeline` Cloud Run service (grant
  command is in the function's doc comment). 17 individual `triggerX()` wrappers exist
  for one-click re-runs of specific sync targets from the Script editor's Run menu.

### Manual Triggers sheet (`Manual Triggers.js`)

Gives non-technical / non-editor access to the same 17 `triggerSync()` targets via
checkboxes in a "Manual Triggers" sheet, instead of requiring the Apps Script editor.

Key constraint: `triggerSync()` needs authorized services (`UrlFetchApp`,
`ScriptApp.getOAuthToken()`), which a **simple** `onEdit(e)` trigger cannot access. This
is why the checkbox handler is registered as an **installable** trigger
(`ScriptApp.newTrigger('onManualTriggerEdit').forSpreadsheet(...).onEdit().create()`),
installed idempotently by `setupManualTriggersSheet()` (checks
`ScriptApp.getProjectTriggers()` before creating). Running
`setupManualTriggersSheet()` once from the Apps Script editor (to grant
authorization) is a one-time requirement; after that, the sheet's "Pipeline Tools"
menu (built by the simple trigger `onOpen()`) can rebuild the sheet layout without
going back into the editor. `onOpen` is the only other simple trigger in the
project — if a second file ever needs its own `onOpen`, it must merge into this one
rather than redeclaring the function.

The endpoint list in `MANUAL_TRIGGER_ENDPOINTS` is hand-kept in sync with the
`triggerX()` wrappers in `Health Check Reporting.js` — adding a new sync target
requires updating both places.

## Dependencies

Two Apps Script libraries, declared in `appsscript.json`:
- `BigQueryLibrary` — wraps `runQuery_V2(projectId, sql, options)`, returning
  `{ headers, data, totalRows }` (or `{ rows }` when `returnObjects: true`). All
  BigQuery access goes through this; there is no raw BigQuery Advanced Service usage
  in this repo's own code beyond enabling it as a dependency.
- `WildernessAppScriptLibrary` — linked but not yet referenced by name in current
  code; check before assuming it's unused if adding new features.

OAuth scopes (`appsscript.json`) cover Sheets, external HTTP requests (Cloud Run,
Cloud Scheduler), full `cloud-platform` (BigQuery), and `script.send_mail` (health
digest emails) — extend this list if a new external API is called.

## Change History

Newest first. History prior to this file's creation is in `git log`.

- **2026-07-01** — Added maintenance policy (update this file + log + git commit
  after every change) and this Change History section. Files: `CLAUDE.md`.
- **2026-07-01** — Added "Manual Triggers" sheet: checkbox per sync endpoint (17
  targets), backed by an installable `onEdit` trigger (`onManualTriggerEdit`) since
  `triggerSync()` needs authorized services a simple trigger can't access. Adds a
  "Pipeline Tools" menu (`onOpen`) to rebuild the sheet without the Script editor.
  Files: `Manual Triggers.js`.
- **2026-07-01** — Created initial `CLAUDE.md` documenting architecture, commands,
  and per-file patterns. Files: `CLAUDE.md`.
