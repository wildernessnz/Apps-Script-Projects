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
code. Three exceptions that talk to non-BigQuery APIs directly:
- `Scheduled Job Reporting.js` calls the Cloud Scheduler REST API directly (job state
  isn't in BigQuery) and computes next-run times client-side by hand-parsing cron
  expressions — `parseNextRun_()` is deliberately **not** a general cron parser, only
  handles the specific patterns this pipeline's jobs actually use (every-N-minutes,
  hourly, daily, weekly-on-day). Extend it if a new schedule pattern is added upstream.
- `Health Check Reporting.js`'s `triggerSync()` / `Manual Triggers.js` call the
  `wilderness-pipeline` Cloud Run service directly to kick off a sync.
- `Pipeline Logs Reporting.js` calls the Cloud Logging API directly (raw stdout/stderr
  text logs aren't in BigQuery either) to pull recent Cloud Run activity.

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
- `triggerSync(platform, table)` POSTs to the Cloud Run service authenticated with an
  **impersonated OIDC ID token**, not `ScriptApp.getOAuthToken()` directly — Cloud
  Run's auth check rejects plain OAuth access tokens outright (confirmed empirically,
  2026-07-01), regardless of IAM bindings on the calling identity, because the token
  type itself doesn't carry an audience claim. `mintIdToken_()` calls the IAM
  Credentials API's `generateIdToken`, impersonating `wilderness-pipeline-sa@wilderness-data.iam.gserviceaccount.com`
  (which has `roles/run.invoker` on the service) with `audience` set to the exact
  target URL — mirroring how Cloud Scheduler's own jobs authenticate to this same
  service. This means the calling identity needs `roles/iam.serviceAccountTokenCreator`
  on `wilderness-pipeline-sa` (not `roles/run.invoker` directly — that's now on the
  impersonated SA instead). 32 individual `triggerX()` wrappers exist for one-click
  re-runs of specific sync targets from the Script editor's Run menu — 17 incremental
  (10 base + 6 associations + 1 Fleetio) and 15 weekly `_reconciliation` counterparts
  (owners/pipelines have none). These are hand-maintained ON PURPOSE: Apps Script's
  Run-menu dropdown is populated by static analysis of named top-level functions, so
  there's no way to generate them dynamically — unlike the Manual Triggers sheet
  below, which doesn't have that constraint.

### Manual Triggers sheet (`Manual Triggers.js`)

Gives non-technical / non-editor access to `triggerSync()` via checkboxes in a
"Manual Triggers" sheet, instead of requiring the Apps Script editor. Checkboxes are
**selection only** — firing happens from the "Pipeline Tools > Run Selected Triggers"
menu item (`runSelectedManualTriggers()`), which reads every checked row, shows a
native `Ui.alert()` confirmation listing exactly what's about to run, and only calls
`triggerSync()` per row on Yes.

**Endpoint list is fetched LIVE from Cloud Scheduler, not hand-maintained.**
`fetchManualTriggerEndpoints_()` calls the same Cloud Scheduler REST API
`Scheduled Job Reporting.js` already uses (same `roles/cloudscheduler.viewer` grant,
no new permission needed), filters job target URIs matching `/sync/<platform>/<table>`
(excluding non-sync routes like `/maintenance/clear-stale-locks`), and reshapes them
into sheet rows via `describeManualTriggerEndpoint_()`. `setupManualTriggersSheet()`
("Rebuild Manual Triggers Sheet" in the menu) re-fetches and rebuilds every time it's
run, so the sheet can never silently drift from what's actually deployed — which is
exactly what happened with a hand-maintained array (v1 of this file), which missed
all 15 `_reconciliation` targets entirely until someone noticed and asked "where are
the reconciliation jobs?" (2026-07-01). **To pick up a newly added/removed Cloud
Scheduler sync job, just run "Rebuild Manual Triggers Sheet" again — no code change
needed.** (The `triggerX()` wrappers above are the one place that still needs a
manual code update when a target is added, for the reason given there.)

**Why menu-driven, not straight off the checkbox edit**: Apps Script's `Ui` service
(`alert()`, `prompt()`, HTML dialogs) cannot be called from ANY trigger context —
simple or installable — so there's no point inside an `onEdit` handler where a
confirmation dialog could be shown at all. A menu click, by contrast, runs with a
normal UI-attached, fully authorized execution context (same as the Script editor's
Run button), so `Ui.alert()` and `triggerSync()`'s authorized calls (`UrlFetchApp`,
`ScriptApp.getOAuthToken()`, IAM Credentials API impersonation) all just work — no
installable trigger needed.

(An earlier revision fired `triggerSync()` directly from an installable `onEdit`
trigger, with no confirmation step — that's what originally required
`ScriptApp.newTrigger()`. Removed once confirmation became a requirement; see Change
History, 2026-07-01. `cleanupLegacyEditTrigger_()`, called from
`setupManualTriggersSheet()`, removes that old trigger from any spreadsheet still
running it.)

`onOpen()` (a simple trigger) builds the "Pipeline Tools" menu with both "Run
Selected Triggers" and "Rebuild Manual Triggers Sheet". It's the only simple trigger
in the project — if a second file ever needs its own `onOpen`, it must merge into
this one rather than redeclaring the function.

The endpoint list in `MANUAL_TRIGGER_ENDPOINTS` is hand-kept in sync with the
`triggerX()` wrappers in `Health Check Reporting.js` — adding a new sync target
requires updating both places.

### Pipeline Logs (`Pipeline Logs Reporting.js`)

`refreshPipelineLogs()` pulls the last 24h of `wilderness-pipeline` Cloud Run logs
via the Cloud Logging API (`entries:list`, `orderBy: timestamp desc` so the sheet
reads newest-first, paginated up to a 20-page/20,000-entry safety cap) and writes
matching lines to a "Pipeline Logs" sheet (`timestamp`, `severity`, `revision`,
`message`, `last_refresh`). Filters to `resource.type="cloud_run_revision"` +
`resource.labels.service_name="wilderness-pipeline"` for the rolling window, then
keeps only lines starting with a bracketed component tag (`/^\[[^\]]+\]/` —
matches this pipeline's own log-line convention, e.g. `[PipelineRunner] ...`,
`[BQWriter] ...`, `[HubSpotRentalConnector] ...`) to drop Cloud Run request/infra
noise. This regex is intentionally generic across platform/table/job — it replaces
what would otherwise be a one-off `gcloud logging read | grep <job-specific-keywords>`
per debugging session. Uses `ScriptApp.getOAuthToken()` directly (no impersonation
needed, unlike `triggerSync()` — the Cloud Logging API accepts plain OAuth access
tokens) under the existing `cloud-platform` scope; the calling user's identity needs
`roles/logging.viewer` on `wilderness-data` (separate grant, not yet made — see file
header for the `gcloud` command).

## Dependencies

Two Apps Script libraries, declared in `appsscript.json`:
- `BigQueryLibrary` — wraps `runQuery_V2(projectId, sql, options)`, returning
  `{ headers, data, totalRows }` (or `{ rows }` when `returnObjects: true`). All
  BigQuery access goes through this; there is no raw BigQuery Advanced Service usage
  in this repo's own code beyond enabling it as a dependency.
- `WildernessAppScriptLibrary` — linked but not yet referenced by name in current
  code; check before assuming it's unused if adding new features.

OAuth scopes (`appsscript.json`) cover Sheets, external HTTP requests (Cloud Run,
Cloud Scheduler, IAM Credentials API), full `cloud-platform` (BigQuery + IAM
Credentials impersonation), `script.send_mail` (health digest emails), and
`script.scriptapp` (needed for `ScriptApp` trigger management —
`getProjectTriggers()`/`deleteTrigger()` in `cleanupLegacyEditTrigger_()`, originally
`newTrigger()` before that was removed; auto-added by Apps Script the first time
`setupManualTriggersSheet()` was run/authorized, not something added by hand here) —
extend this list if a new external API is called.

## Change History

Newest first. History prior to this file's creation is in `git log`.

- **2026-07-02** — Pipeline Logs: added `severity` and `revision` columns, and
  switched ordering to `timestamp desc` so the sheet reads newest-first (was
  ascending). Files: `Pipeline Logs Reporting.js`, `CLAUDE.md`.
- **2026-07-02** — Added "Pipeline Logs" sheet (`Pipeline Logs Reporting.js`,
  `refreshPipelineLogs()`): pulls the last 24h of `wilderness-pipeline` Cloud Run
  logs from the Cloud Logging API, filtered generically to bracket-tagged
  job-activity lines (not hardcoded to any specific job/keyword), replacing ad hoc
  `gcloud logging read | grep` debugging with a repeatable in-sheet view. Requires a
  separate `roles/logging.viewer` grant (not yet made). Files: `Pipeline Logs
  Reporting.js`, `CLAUDE.md`.
- **2026-07-01** — Confirmed via `pipeline.sync_runs` query (not just inferred from
  naming) that reconciliation targets are genuine full-table re-pulls: rows_fetched
  == rows_written, both near full table size every run (e.g. `deals_reconciliation`
  ~16,600 rows vs ~18/run for incremental `deals`), 15-45+ min vs under 2 min.
  Updated the doc comment above the `triggerX()` wrappers accordingly. Files:
  `Health Check Reporting.js`.
- **2026-07-01** — Manual Triggers now fetches its endpoint list LIVE from Cloud
  Scheduler (`fetchManualTriggerEndpoints_()`) instead of a hardcoded array, and
  added all 15 weekly `_reconciliation` sync targets that the hardcoded list had
  missed entirely. "Rebuild Manual Triggers Sheet" now always reflects whatever's
  actually deployed — no more hand-kept list to drift. Also added matching
  `triggerXReconciliation()` wrappers in `Health Check Reporting.js` (still
  hand-maintained — Run-menu functions can't be generated dynamically) and fixed a
  stale "9 reconciliation jobs" count in `Scheduled Job Reporting.js`'s doc comment
  (actually 15). Files: `Manual Triggers.js`, `Health Check Reporting.js`,
  `Scheduled Job Reporting.js`.

- **2026-07-01** — Redesigned Manual Triggers to require confirmation before firing:
  checkboxes are now selection-only; a new "Pipeline Tools > Run Selected Triggers"
  menu item (`runSelectedManualTriggers()`) shows a native `Ui.alert()` listing what's
  about to run and only fires on Yes. Required because Apps Script's `Ui` service
  can't be called from any trigger context — so confirmation could never have worked
  from the old checkbox-fires-immediately `onEdit` design. Removed the installable
  `onEdit` trigger entirely (`cleanupLegacyEditTrigger_()` deletes any leftover one).
  Files: `Manual Triggers.js`.
- **2026-07-01** — Fixed a follow-on 403 from the ID-token fix below:
  `generateIdToken`'s endpoint path is `projects/-/...` (wildcard), so Google Cloud
  checked API enablement against the Apps Script's own hidden default GCP project
  (not `wilderness-data`) and failed with `SERVICE_DISABLED`, quoting an unrelated
  project number. Fixed by adding an explicit `x-goog-user-project: wilderness-data`
  header to the `generateIdToken` call in `mintIdToken_()`, overriding that fallback.
  Files: `Health Check Reporting.js`.
- **2026-07-01** — Fixed `triggerSync()` 401s: Cloud Run rejects
  `ScriptApp.getOAuthToken()`'s plain OAuth access token outright (confirmed live,
  not just a theoretical caveat) — it needs an OIDC ID token audienced to the exact
  target URL. Now mints one via IAM Credentials API impersonation of
  `wilderness-pipeline-sa` (which already has `run.invoker`), matching how Cloud
  Scheduler's own jobs authenticate to the same service. Required granting
  `mark.lonergan@wilderness.co.nz` `roles/iam.serviceAccountTokenCreator` on
  `wilderness-pipeline-sa` (IAM change, not in git). Files: `Health Check Reporting.js`.
- **2026-07-01** — Added maintenance policy (update this file + log + git commit
  after every change) and this Change History section. Files: `CLAUDE.md`.
- **2026-07-01** — Added "Manual Triggers" sheet: checkbox per sync endpoint (17
  targets), backed by an installable `onEdit` trigger (`onManualTriggerEdit`) since
  `triggerSync()` needs authorized services a simple trigger can't access. Adds a
  "Pipeline Tools" menu (`onOpen`) to rebuild the sheet without the Script editor.
  Files: `Manual Triggers.js`.
- **2026-07-01** — Created initial `CLAUDE.md` documenting architecture, commands,
  and per-file patterns. Files: `CLAUDE.md`.
