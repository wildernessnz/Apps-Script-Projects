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
code. Exceptions that talk to non-BigQuery APIs directly:
- `Scheduled Job Reporting.js` calls the Cloud Scheduler REST API directly (job state
  isn't in BigQuery) and computes next-run times client-side by hand-parsing cron
  expressions — `parseNextRun_()` is deliberately **not** a general cron parser, only
  handles the specific patterns this pipeline's jobs actually use (every-N-minutes,
  hourly, daily, weekly-on-day, daily-at-multiple-fixed-hours). Extend it if a new
  schedule pattern is added upstream. The multi-fixed-hour pattern (`"M H1,H2 * * *"`,
  e.g. `"0 7,13 * * *"` for Xero's twice-daily `purchase_orders` sync, added
  2026-07-02) MUST be checked before the single-fixed-hour branch — `parseInt("7,13",
  10)` resolves to `7` without erroring, so without that ordering the parser would
  silently compute only the first hour and drop every other one, rather than falling
  through to `"(unrecognized schedule pattern)"` as you might expect. Also reads
  `httpTarget.oidcToken`/`.oauthToken`/`.body` on each job to distinguish the two kinds
  of destination Cloud Scheduler jobs hit since the pipeline-side move of 16
  reconciliation targets to a dedicated `wilderness-pipeline-job` Cloud Run Job
  (2026-07-06, in the separate `wilderness-pipeline` repo, not this one — see
  `describeTarget_()`'s doc comment).
- `Health Check Reporting.js`'s `triggerSync()` / `triggerJobRun()` and
  `Manual Triggers.js` call `wilderness-pipeline` (the Cloud Run Service) or
  `wilderness-pipeline-job` (the Cloud Run Job) directly to kick off a sync —
  `triggerSync()` POSTs to the Service's `/sync/<platform>/<table>` route (OIDC
  token, impersonated); `triggerJobRun()` (added 2026-07-06, after the
  reconciliation targets moved to the Job) calls the Cloud Run Admin API's
  `jobs.run` method instead (plain OAuth token, `roles/run.invoker` on the Job).
  Manual Triggers picks whichever one a row needs from its `Target Type` column,
  populated via `describeTarget_()` (shared from `Scheduled Job Reporting.js`) —
  see that file's and `Health Check Reporting.js`'s own doc comments for why
  these need genuinely different transport/auth, not just a different URL.
- `Pipeline Logs Reporting.js` calls the Cloud Logging API directly (raw stdout/stderr
  text logs aren't in BigQuery either) to pull recent Cloud Run activity.
- `Rate Limit Reporting.js` calls the Cloud Logging API directly to surface 429
  rate-limit warnings — a GAS-side stopgap, not the long-term home for this data (see
  the file's own header doc for why).
- `Cost Reporting.js` calls the Cloud Run Admin API and Cloud Monitoring API directly
  to estimate current Cloud Run spend — nothing here is derived from BigQuery either.

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
- `applyAlertsFormatting_()` colors the Unacknowledged Alerts sheet by `severity`
  (red for `'critical'`, yellow for anything else) — added 2026-07-02; this sheet
  previously had NO severity-based coloring at all, unlike every other sheet in this
  file. Uses the same two hex values and the same critical-vs-other split as
  `runDigest()`'s alerts table — keep both in sync if either changes. `'critical'` is
  a new severity introduced by the Xero connector (fires on OAuth refresh failure or
  a token-persist failure after retries); every `pipeline.alerts` row before that used
  `'warning'`.
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

Manual Triggers' endpoint list needs no manual upkeep (it's fetched live — see
above); the `triggerX()`/`triggerXReconciliation()` wrappers in `Health Check
Reporting.js` are the only place that still requires a manual code change when a
sync target is added or removed upstream (Run-menu functions can't be generated
dynamically — see that file's doc comment above the wrappers).

### Pipeline Logs (`Pipeline Logs Reporting.js`)

`refreshPipelineLogs()` pulls the last 24h of `wilderness-pipeline` Cloud Run logs
via the Cloud Logging API (`entries:list`, `orderBy: timestamp desc` so the sheet
reads newest-first, paginated up to a 20-page/20,000-entry safety cap) and writes
matching lines to a "Pipeline Logs" sheet (`timestamp`, `severity`, `platform`,
`table`, `mode`, `component`, `message`, `run_id`, `revision`, `last_refresh`).
Filters to `resource.type="cloud_run_revision"` +
`resource.labels.service_name="wilderness-pipeline"` for the rolling window.

`wilderness-pipeline` (the separate Cloud Run repo) emits structured JSON log
lines — `{"severity":...,"message":...,"component":...,"runId":...,"platform":...,
"table":...,"mode":...}` — with `runId`/`platform`/`table`/`mode` present on every
line logged during a sync invocation (via that repo's `withRunContext()`,
AsyncLocalStorage-based), keyed to the same platform/table/mode taxonomy as
`pipeline.sync_runs` and the Cloud Scheduler job's target URI. Cloud Run's logging
agent promotes the JSON's `severity` key to the LogEntry's own field and the rest
lands in `jsonPayload`; `extractRow_()` reads `jsonPayload.component` as the
"this is a job-activity line, not Cloud Run request/infra noise" signal (replacing
the plain-text `/^\[[^\]]+\]/` bracket-tag regex the pipeline used before it had
structured logging), and falls back to that legacy regex against `textPayload` for
any pre-migration lines still inside the lookback window. **This is what makes it
possible to see which scheduled job a given log line belongs to** — before the
structured-logging change, only lines whose message text happened to spell out the
table name could be attributed at all, and most (e.g. `BQWriter` batch-insert
lines) couldn't. Uses `ScriptApp.getOAuthToken()` directly (no impersonation
needed, unlike `triggerSync()` — the Cloud Logging API accepts plain OAuth access
tokens) under the existing `cloud-platform` scope; the calling user's identity needs
`roles/logging.viewer` on `wilderness-data` (separate grant, not yet made — see file
header for the `gcloud` command).

### Scheduled Jobs target detail (`Scheduled Job Reporting.js`)

Added 2026-07-06. The "Scheduled Jobs" sheet gained five columns —
`target_type`, `target_uri`, `auth_type`, `target_platform`, `target_table` —
via `describeTarget_()`, to distinguish the two kinds of destination Cloud
Scheduler jobs now hit after the pipeline-side move of the 16 reconciliation
targets to a dedicated `wilderness-pipeline-job` Cloud Run Job (that move
happened in the separate `wilderness-pipeline` repo, not here):
- **Service targets** (the fast/incremental syncs): `httpTarget.uri` is
  `wilderness-pipeline`'s own `/sync/<platform>/<table>` route, authenticated
  with `oidcToken` — `target_platform`/`target_table` are parsed straight out
  of the URI path.
- **Job targets** (all 15 `_reconciliation` syncs): `httpTarget.uri` is Cloud
  Run's Admin API (`.../jobs/wilderness-pipeline-job:run`), authenticated
  with `oauthToken` instead. The Job resource itself is generic and reused
  across all 16 targets, so the actual platform/table is only recoverable by
  base64-decoding `httpTarget.body` (a `RunJobRequest` JSON payload) and
  reading `overrides.containerOverrides[0].args` (e.g.
  `["run-job.js","--platform=xero","--table=bills_reconciliation"]`).

### Rate Limit Events (`Rate Limit Reporting.js`)

Added 2026-07-06. `refreshRateLimitEvents()` pulls `core/httpUtils.js`'s
`"429 rate limited — waiting Xs before retry"` warnings from the Cloud
Logging API (same auth pattern as `Pipeline Logs Reporting.js` —
`ScriptApp.getOAuthToken()`, `roles/logging.viewer`, no impersonation) into a
"Health - Rate Limit Events" sheet (`timestamp`, `source` [Service/Job],
`platform`, `table`, `mode`, `wait_seconds`, `message`, `run_id`,
`revision_or_execution`, `last_refresh`). Filters across BOTH
`resource.type="cloud_run_revision"` (the `wilderness-pipeline` Service) and
`resource.type="cloud_run_job"` (the `wilderness-pipeline-job` Job) — 429s can
happen from either since both run the same `httpUtils.js`.

This is a deliberate GAS-side stopgap, not this project's normal pattern —
it exists because nothing in the pipeline writes 429 occurrences to BigQuery
today. The preferred long-term fix (not done here — requires a change in the
separate `wilderness-pipeline` repo) is for the pipeline to write these to
BigQuery so this could become a normal `reporting.*`-view-backed sheet like
everything else; revisit and delete this file's Cloud Logging query entirely
once that lands. Directly related to this project's accepted
cross-process-rate-limiter blind spot (Service instances and Job executions
can't see each other's rate-limit state) — this sheet is the monitoring half
of that risk, not a fix for it.

### Cost Summary (`Cost Reporting.js`)

Added 2026-07-06, deliberately scoped as an MVP (current-month running total
+ Service vs Job split only — no per-connector breakdown, no historical
trend). `refreshCostSummary()` writes a "Health - Cost Summary" sheet by
combining:
- **Rates** — hardcoded constants (`COST_RATES`), pulled from the Cloud
  Billing Catalog API (`cloudbilling.googleapis.com/v1/services/152E-C115-5142/skus`,
  service `152E-C115-5142` = Cloud Run) for `australia-southeast1` on
  2026-07-06. NOT re-queried live on every refresh (SKU-matching that API's
  response is fiddly enough that a wrong live parse could silently produce a
  wrong cost with no way to notice) — re-verify by hand periodically instead.
- **Config** — `containers[0].resources.limits.cpu`/`.memory` and
  `resources.cpuIdle` (Service only — distinguishes request-based/throttled
  vs instance-based/`--no-cpu-throttling` billing; Jobs have no such toggle,
  always instance-based) via the Cloud Run Admin API (`services.get` /
  `jobs.get`).
- **Usage** — `run.googleapis.com/container/billable_instance_time` via the
  Cloud Monitoring API for the Service; summed
  `(completionTime - startTime) × taskCount` across `executions.list` for the
  Job (completed executions only — a still-running execution's eventual
  duration isn't counted until it finishes, a minor known undercount at the
  tail of the month).

Needed two new IAM grants beyond what this repo already required —
`roles/run.viewer` (Cloud Run Admin API reads) and `roles/monitoring.viewer`
(Cloud Monitoring API reads) on `wilderness-data`, granted to
`mark.lonergan@wilderness.co.nz` 2026-07-06 (see the file's header doc for
the exact `gcloud` commands used). Uses
`ScriptApp.getOAuthToken()` directly, same as `Scheduled Job Reporting.js`
and `Pipeline Logs Reporting.js` — no impersonation needed, the existing
`cloud-platform` scope already covers both APIs.

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

- **2026-07-06** — Fixed the `triggerSync()`/Manual Triggers gap flagged in the
  entry below, same day: added `HealthCheckReporting.triggerJobRun()`, which
  starts a `wilderness-pipeline-job` execution via the Cloud Run Admin API's
  `jobs.run` method (plain OAuth token, no impersonation — unlike `triggerSync()`,
  the Admin API isn't the Cloud Run push endpoint and doesn't need an OIDC ID
  token) instead of POSTing to the Service. Repointed all 15 `_reconciliation`
  `triggerX()` wrappers at it. Also hoisted `describeTarget_()` out of
  `ScheduledJobsReporting` to top-level scope in `Scheduled Job Reporting.js` so
  `Manual Triggers.js` could reuse the exact same Service-vs-Job decoding — that
  file's `fetchManualTriggerEndpoints_()` previously matched only `/sync/
  <platform>/<table>` URIs directly, which would have made all 15 reconciliation
  targets silently vanish from the Manual Triggers sheet (not just mis-fire) on
  the next rebuild, since Job-targeted rows hit a `run.googleapis.com/.../
  jobs/...:run` URI instead. The sheet gained a `Target Type` column (Service/
  Job) driving which function `runSelectedManualTriggers()` calls per row.
  Needed one more IAM grant beyond `roles/run.viewer`/`roles/monitoring.viewer`
  below: `roles/run.invoker` on `wilderness-pipeline-job`, to actually START an
  execution rather than just read its config — granted to
  `mark.lonergan@wilderness.co.nz` 2026-07-06 (see `triggerJobRun()`'s doc
  comment for the exact `gcloud` command used). Files:
  `Scheduled Job Reporting.js`, `Health Check Reporting.js`,
  `Manual Triggers.js`, `CLAUDE.md`.
- **2026-07-06** — Health Monitor enhancements, following a handoff about
  pipeline-side changes made in the separate `wilderness-pipeline` repo (a
  Cloud Run CPU-throttling fix, and moving the 16 reconciliation targets to a
  new `wilderness-pipeline-job` Cloud Run Job — none of that is code in this
  repo). Three additions: (1) `Scheduled Job Reporting.js` gained
  `target_type`/`target_uri`/`auth_type`/`target_platform`/`target_table`
  columns via `describeTarget_()`, decoding Cloud Scheduler's `httpTarget` to
  show which jobs hit the Service vs the new Job, and — for Job-targeted
  rows — decoding `httpTarget.body`'s container-override args to recover the
  actual platform/table (the Job resource itself is generic and reused
  across all 16). (2) New "Health - Rate Limit Events" sheet
  (`Rate Limit Reporting.js`) reading 429 warnings from Cloud Logging across
  both the Service and the Job — a deliberate GAS-side stopgap pending a
  proper pipeline-side BigQuery write (see the file's own header doc). (3)
  New "Health - Cost Summary" sheet (`Cost Reporting.js`), an MVP
  current-month cost estimate (Service vs Job split) combining hardcoded
  Cloud Billing Catalog rates with live Cloud Run Admin API config and Cloud
  Monitoring API usage data. **Known gap surfaced but not fixed in this
  pass:** `triggerSync()`/Manual Triggers still only know how to hit the
  Service's `/sync/<platform>/<table>` route — the 15 reconciliation
  `triggerX()` wrappers and any reconciliation row in Manual Triggers are
  likely broken post-move, since they never learned about the new Job
  target. (Fixed later the same day — see the entry above.) Needs two new
  IAM grants (`roles/run.viewer`, `roles/monitoring.viewer`), not yet made —
  see `Cost Reporting.js`'s header for the `gcloud` commands. (Also granted
  later the same day — see the "Grant roles/run.viewer..." entry.) Files:
  `Scheduled Job Reporting.js`,
  `Rate Limit Reporting.js` (new), `Cost Reporting.js` (new), `CLAUDE.md`.
- **2026-07-02** — Xero connector follow-up (part 1 of a multi-part fix — see project
  memory for the full 4-item handoff): fixed `parseNextRun_()`/`describeSchedule_()`
  in `Scheduled Job Reporting.js` to correctly handle daily schedules with a
  comma-separated hour list (`"M H1,H2 * * *"`), needed for the new twice-daily
  `purchase_orders` Xero sync (`"0 7,13 * * *"`). Without this, `parseInt("7,13",
  10)` would have silently computed only the 7am run — not the "(unrecognized
  schedule pattern)" fallback one might expect. Also added `applyAlertsFormatting_()`
  to color the Unacknowledged Alerts sheet by `severity` (red for `'critical'`,
  yellow otherwise) — that sheet had no severity-based coloring at all before this,
  unlike every other sheet in `Health Check Reporting.js`; `runDigest()`'s email
  already handled `'critical'` distinctly (added when the Xero connector introduced
  that severity), the sheet just hadn't caught up. Still outstanding from that
  handoff: 2 corrections to the live `reporting.health_current_status` BigQuery view
  (`has_stale_lock` thresholds for `purchase_orders`/`bills_reconciliation`, and
  missing `is_stale`/`expected_max_staleness_minutes` entries for `purchase_orders`/
  `bills`) — that view isn't tracked in this repo, pending review before applying.
  Files: `Scheduled Job Reporting.js`, `Health Check Reporting.js`, `CLAUDE.md`.
- **2026-07-02** — Pipeline Logs: read `wilderness-pipeline`'s new structured JSON
  log lines (`jsonPayload.component/runId/platform/table/mode`) instead of the old
  plain-text `[Component] message` convention, adding `platform`, `table`, `mode`,
  `component`, and `run_id` columns — this is what finally lets a log line be
  attributed to the scheduled job/run that produced it. Kept a legacy-format
  fallback for pre-migration lines still inside the 24h lookback window. Files:
  `Pipeline Logs Reporting.js`, `CLAUDE.md`.
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
