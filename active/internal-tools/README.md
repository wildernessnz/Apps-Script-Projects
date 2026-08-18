# Wilderness Internal Tools — Handoff to Claude Code

Single standalone Apps Script project unifying Booking Finder, Interislander
Availability, Relo Rates, and Weather Alert (section "Adventure Support"),
Service History (section "Workshop"), and Recurring Tasks (section
"Leadership"), behind one sidebar-navigated shell. All 6 tools are built and
deployed. Recurring Tasks specifically still has open cutover steps (Script
Properties, daily trigger, retiring the old standalone project) — see
"Still open / deferred" below before assuming it's fully live. This doc is
the orientation a fresh Claude Code session needs — read this before
touching anything.

## Getting set up

These 23 files are the entire project. Drop them into your local clasp
folder (matching filenames exactly, no subfolders) and `clasp push`.

```
appsscript.json         — manifest (scopes, WildernessAppScriptLibrary dependency)
Config.gs                — SHEET_IDS, NAV_CONFIG (nav structure + icons + content width)
WebApp.gs                — doGet(), include(), getSidebarUserInfo()
ContentLoader.gs         — getToolContent(), access gating, view logging
Logging.gs               — logEvent_() — cross-tool activity log (see below)
Shell.html                — sidebar + content area, built from NAV_CONFIG
Styles.html               — ALL styling + embedded Averta font (~875KB — this is why
                             the file is large; don't be alarmed)
Router.html               — client-side nav + content swap
Modal.html               — shared ITModal (confirm/notify) + tooltip positioning + escapeHtml()
Placeholder.html         — unused now (all 6 tools built) but harmless to keep
BookingFinderLogic.gs / BookingFinder.html
InterislanderLogic.gs / Interislander.html
ReloRatesLogic.gs / ReloRates.html
WeatherAlertLogic.gs / WeatherAlert.html
ServiceHistoryLogic.gs / ServiceHistory.html / ServiceHistoryTemplate.html
RecurringTasksLogic.gs / RecurringTasks.html
```

`ServiceHistoryTemplate.html` is a third file for that tool — it's the PDF's
internal HTML layout (evaluated by `ServiceHistoryPdf`), not the sidebar UI
partial. Don't conflate it with `ServiceHistory.html`.

Before it'll actually work, Script Properties need setting (Project Settings
→ Script Properties) — none of these are in the code, by design:

**Weather Alert:** `WEATHER_ALERT_APPROVED_SENDERS`, `WEATHER_ALERT_OVERRIDE_EMAILS`,
`WEATHER_ALERT_TEST_MODE`, `WEATHER_ALERT_SENDGRID_API_KEY`,
`WEATHER_ALERT_SENDGRID_TEMPLATE_ID`, `WEATHER_ALERT_FROM_EMAIL`,
`WEATHER_ALERT_FROM_NAME`, `WEATHER_ALERT_HUBSPOT_WHATSAPP_FLOW_ID`,
`WEATHER_ALERT_CONFIRMATION_CC` (optional), `WEATHER_ALERT_BCC_EMAIL` (optional)

**Interislander:** `KIWIRAIL_PRODUCTION_MODE`, `KIWIRAIL_PROD_API_KEY`,
`KIWIRAIL_PROD_BASE64_HEADER`, `KIWIRAIL_UAT_API_KEY`, `KIWIRAIL_UAT_BASE64_HEADER`

**Service History:** `SERVICE_HISTORY_ALLOWLIST` (comma-separated emails —
gates the whole tool, same pattern as Weather Alert's approved senders),
`SERVICE_HISTORY_EXCLUDED_TASKS` (comma-separated Fleetio service task names
to exclude from every PDF, matched case- and whitespace-insensitively;
defaults to `Rental Turn Around,Detail` if unset). Matching tasks are
dropped from a work order's task list rather than hiding the whole entry —
a work order that mixes a rental turnaround with real service work still
shows the real work.

**Recurring Tasks:** `RECURRING_TASKS_JIRA_CLIENT_ID`,
`RECURRING_TASKS_JIRA_CLIENT_SECRET`, `RECURRING_TASKS_JIRA_REDIRECT_URI`
(Atlassian OAuth 2.0 app credentials — copy from the old standalone
recurring-task-engine project's gitignored `Config.js`), and
`RECURRING_TASKS_JIRA_REFRESH_TOKEN` (mint fresh in *this* project via
`rtAuthoriseJira()` then `rtExchangeCodeForTokens(code)` from the Apps
Script editor — rotates itself on every use after that, never set by
hand again). **Not yet set as of this handoff** — until they are, the
tool's own CRUD/pause/resume/delete/history all work fine (Sheet-only),
but Run Now and the daily trigger fail with "No OAuth refresh token
found." Access is a Google Group check (`ACCESS_GROUPS` in
`RecurringTasksLogic.gs`, currently `leaders@wilderness.co.nz` and
`jirataskengine@wilderness.co.nz` — membership in *either* grants
access), not a Script Property allowlist like Weather Alert/Service
History — same mechanism the standalone app used, just relocated into
`ACCESS_GATES`.

Booking Finder and Relo Rates need no properties.

Don't manually set `WEATHER_ALERT_LAST_SEND_DATE` / `WEATHER_ALERT_LAST_SEND_BY`
— the send/reset-lock code manages those itself.

## Architecture, in short

- **Standalone project, data stays put.** Each tool's spreadsheet is untouched
  and unmerged — `Config.gs`'s `SHEET_IDS` holds all tool sheet IDs plus
  `ACTIVITY_LOG` (see "Cross-tool activity log" below), every tool opens its
  sheet via `getSpreadsheet_(key)` (wraps `SpreadsheetApp.openById`).
  Explicit decision, not an oversight — see "Resolved decisions" below.
- **One shell, swappable content.** `Shell.html` is the only thing `doGet()`
  serves. Everything else loads via `google.script.run` calls to
  `getToolContent(partialName)` and gets injected into `#itContent`.
- **Adding a new tool:** one entry in `Config.gs`'s `NAV_CONFIG` (id, label,
  icon SVG, partial name, contentWidth) — either in an existing section or a
  new `{ section: '...', items: [...] }` block (Service History got its own
  "Workshop" section; Recurring Tasks got its own "Leadership" section) —
  one new `<Name>Logic.gs` + `<Name>.html` pair, flip its
  `PLACEHOLDER_PARTIALS` entry in `ContentLoader.gs` to `false` once the
  partial exists. Nothing else needs touching for the shell/routing itself.
  If porting in an existing standalone Apps Script app (as both Service
  History and Recurring Tasks were), rename every server function first —
  see gotcha #15 below on why generic names like the source's `getSheet_`/
  `saveSchedule`/`logAudit_` are a latent collision risk once everything
  shares one script's global namespace.
- **File naming:** `<ToolName>Logic.gs` + `<ToolName>.html` — Apps Script
  doesn't allow a `.gs` and `.html` file to share a base name (learned this
  the hard way with `BookingFinder.gs` vs `BookingFinder.html`).
- **Booking Finder reads sheet columns by position.** `BookingFinderLogic.gs`'s
  `COL_*` constants map to the "Linked - Bookings" tab's header row:
  `booking_number, hubspot_vid, state, vehicle_type, pick_up_location,
  pick_up_date, drop_off_location, drop_off_date, booking_type, vehicle_rego,
  customer_name, ...`. If that sheet's columns are ever reordered, update the
  constants, not just the code that reads them.

## Cross-tool activity log

`Logging.gs`'s `logEvent_(event, notes)` writes one row (`Timestamp | User |
Event | Notes`) per call to the "Activity Log" tab of the `ACTIVITY_LOG`
spreadsheet in `SHEET_IDS` — a dedicated container sheet, separate from any
one tool's own data. Two things call it today:

1. **`ContentLoader.gs`'s `getToolContent()`** — logs every tool view
   (`View: <partial>`), including access-denied attempts, since this is the
   single chokepoint both the initial page load and every nav click pass
   through.
2. **Each tool's `google.script.run` entry point** — logs its primary action
   (search / calculate / generate / send), both on success and failure. Pure
   read-only preview calls with no side effect (Weather Alert's
   `getGuestPreview()`/`previewEmail()`) are deliberately not logged.

**When adding tool #6, wire up `logEvent_()` in its own entry-point
wrapper(s)** the same way — see any existing `<Name>Logic.gs` for the
try/catch-and-rethrow pattern. View logging is automatic (goes through
`getToolContent()`), action logging is not.

The tab is created lazily on first write (`insertSheet` + header row, same
pattern as Weather Alert's own `getOrCreateLogSheet_`) — no manual sheet
setup needed beyond the container spreadsheet existing already. Log write
failures are swallowed (`Logger.log` only, never thrown) — an audit write
should never block or break the action it's recording.

**Service History's `Generate PDF` entry also logs wall-clock duration**
(2026-08-18) — `generateServiceHistory` times itself from entry to the
Drive file being created and appends `duration=X.XXs` to the `Notes` field
(on both the success and error paths), e.g. `rego=ABC123 | selected=8/12 |
file=<url> | duration=2.14s`. This piggybacks on the existing free-text
`Notes` column rather than adding a dedicated column to the shared sheet
schema, since that schema is used by every tool's log line, not just
Service History's.

## Hard-won gotchas — read before debugging something that looks like this

These cost real back-and-forth to figure out. If you hit something that looks
like one of these, it probably is:

1. **Apps Script's HtmlService `IFRAME` sandbox does not support native
   `alert()`, `confirm()`, or `prompt()`.** They silently no-op — no error,
   just nothing happens. Every tool uses `ITModal.confirm()`/`ITModal.notify()`
   (from `Modal.html`) instead. If you're tempted to use a native dialog
   anywhere, don't — it'll look like it's "not working" with zero clues why.
2. **`innerHTML = html` does NOT execute `<script>` tags.** `Router.html` uses
   `document.createRange().createContextualFragment(html)` instead, which
   does. Any new dynamic content injection should follow this same pattern.
3. **Card headers use `justify-content: space-between`.** If a header has an
   icon + label as two separate direct flex children with nothing else, they
   get pushed to opposite ends instead of sitting together. Always wrap
   icon+label in one shared `<span>` — hit this bug 3 separate times across
   different tools before it became a reflex to check for.
4. **`.it-card` has `overflow: hidden`** (needed for rounded-corner clipping
   on headers/tables). Any absolutely-positioned popover/tooltip inside a
   card will get clipped at the card boundary. Use `position: fixed` +
   JS-computed coordinates instead (see the tooltip system in `Modal.html`
   + `Styles.html`'s `.it-tooltip-content`).
5. **`new Date().toISOString().slice(0,10)` is a timezone bug**, not a safe
   "get today's date" pattern — it converts to UTC first, which rolls back to
   the previous day in NZ time (UTC+12/13) before midday. Both date-defaulting
   tools (`BookingFinder.html`, `Interislander.html`) build the date string
   from local `getFullYear()`/`getMonth()`/`getDate()` instead — copy that
   pattern for any new date default.
6. **Script Properties are prefixed per tool** (`WEATHER_ALERT_*`,
   `KIWIRAIL_PROD_*`/`KIWIRAIL_UAT_*`, `SERVICE_HISTORY_*`) since all tools
   share one properties store now. Never add an unprefixed property.
7. **`Styles.html` is ~875KB** (embedded Averta font, 3 weights, base64). This
   is intentional, not bloat to clean up — don't "optimize" it away without
   knowing that's what it is.
8. **Comparing a `Date` object against `new Date()` to check "is this in the
   past" compares full timestamps, not calendar days.** `InterislanderLogic.gs`'s
   ±1/±2 day extended search used to skip or include a date depending on what
   time of day the search was run, because `new Date()` carries the current
   instant while a date built from a bare `YYYY-MM-DD` string carries a fixed
   ~noon (NZT) time-of-day. Fixed by normalising the comparison date to local
   midnight (`date.setHours(0,0,0,0)`) before comparing. Any new "is this date
   in the past" check should do the same — don't compare raw `Date` instances
   when you mean calendar days.
9. **A "check then act" guard is not atomic across concurrent requests.**
   Weather Alert's one-send-per-day lock used to read `alreadySentToday()`
   and only record the send after all the email/WhatsApp work finished —
   two near-simultaneous sends could both pass the check before either
   recorded it. `triggerWeatherAlert` now wraps the check-and-reserve in
   `LockService.getScriptLock()` (acquired only around the check + record,
   released before the actual send work runs). Any future "only once" guard
   should follow this pattern, not just read-then-write.
10. **Sheet/API/guest data rendered into the DOM via string concatenation is
    not HTML-escaped by the browser** — a stray `<`/`&` in a name, rego, or
    ship name breaks table markup, and it's an XSS vector if that data is
    ever attacker-influenced. `Modal.html` exposes a global `escapeHtml()`
    helper (loaded on every page, since Modal.html is always included) — wrap
    any interpolated sheet/API value in it before concatenating into
    `innerHTML`. Server-side HTML (Weather Alert's confirmation email) has
    its own `escapeHtml_()` in `WeatherAlertLogic.gs` for the same reason.
11. **`String.replace(regex, someString)` treats `$&`, `$$`, `` $` ``, `$'` in
    the replacement string as special patterns, not literal text.** If that
    string is untrusted/user-typed (like Weather Alert's subject/body being
    rendered into the SendGrid preview template), pass a function instead
    (`.replace(regex, () => value)`) so the value is inserted literally.
12. **Because the manifest's `webapp.executeAs` is `USER_ACCESSING`, every
    Drive/Sheets write executes under the visiting user's own Google
    identity, not a shared service account.** This bit twice on Service
    History: (a) `DriveApp.createFile()` needed the full
    `https://www.googleapis.com/auth/drive` scope — `drive.file` looked like
    the minimal/correct choice but wasn't sufficient for this call, per
    Google's own runtime error; (b) the cross-tool activity log needed a
    spreadsheet shared edit-access to *everyone who uses any tool*, not just
    a narrow approved list — unlike Weather Alert's own per-tool log, which
    only ever needed access from its small `APPROVED_SENDERS` group. Any new
    tool doing its own Drive/Sheets write should assume the same: check the
    actual required scope against what the runtime reports, and check who
    actually needs edit access to any sheet it writes to.
13. **Fleetio's `WildernessAppScriptLibrary.FleetioSecurity` must be
    instantiated with `new`**: `new WildernessAppScriptLibrary.FleetioSecurity()`.
    An earlier version of the Service History POC (and its handover doc) had
    this backwards.
14. **Fleetio's Service Entry vendor is a flat `vendor_name` string field**,
    not a nested `vendor: { name }` object — confirmed against Fleetio's live
    OpenAPI schema. `ServiceHistoryLogic.gs`'s `mapEntry_` reads it directly.
15. **Generic global function names are a real collision risk once every
    tool shares one script.** The standalone apps this project ports in were
    each their own Apps Script project, so names like `getSheet_`,
    `saveSchedule`, `logAudit_`, `rowToObject_`, `stripTime_` never collided
    with anything. Here they would. When porting Recurring Tasks in,
    every private helper got an `rt` prefix (`rtGetSheet_`, `rtLogAudit_`,
    etc.) and every public `google.script.run` entry point got renamed to
    something tool-specific (`getRecurringTaskSchedules`, not `getSchedules`)
    — do the same for any future ported tool, not just the obviously
    generic names.
16. **`appsscript.json`'s `oauthScopes` list is explicit, not a starting
    point Apps Script augments automatically.** Any built-in service call a
    new tool makes that no existing tool already used needs its scope added
    by hand, or it fails at runtime with "Specified permissions are not
    sufficient..." — not at push/deploy time, only when that code path
    actually runs. Recurring Tasks hit this twice after its first deploy:
    `GroupsApp.getGroupByEmail()` needed `.../auth/groups`, and
    `ScriptApp.getProjectTriggers()` (called on every page load, for the
    trigger-status badge) needed `.../auth/script.scriptapp`. Neither was
    caught by testing the happy path in the editor — both only surfaced from
    the deployed web app's Executions log. Before deploying a tool that uses
    a service no other tool here already exercises, check `Config.gs`'s
    existing scope list against what that service actually needs.
17. **A time-based trigger function needs to log that it ran, even when it
    finds nothing to do.** `runRecurringTasksDailyCheck` originally only
    logged individual failures — a normal 7am run that created tickets fine,
    or found nothing due, left zero trace in Executions. Since nobody's
    watching a UI when a trigger fires, "silent" and "broken" look
    identical from the outside. Fixed by adding start/summary `Logger.log`
    lines regardless of outcome. Any future unattended trigger should do
    the same.
18. **Fleetio's published OpenAPI schema (the dated `2025-05-05.yaml`) does
    not describe what's actually live at `/api/v2/meter_entries`.** That
    schema documents `filter[...]`/`sort[...]` deepObject query params with
    cursor pagination — but calling `/api/v2/meter_entries` with that exact
    shape returns a flat `HTTP 404 {"status":404,"error":"not found"}`
    against this account, discovered only once Service History's odometer
    fallback ran for real. The fix was dropping back to `/api/v1/` with the
    same Ransack-style params (`q[vehicle_id_eq]`, `q[date_lteq]`,
    `q[s]=date+desc`, `page`/`per`) every other list call in
    `ServiceHistoryLogic.gs` already uses successfully. Don't trust the
    published schema over this file's own proven-working call shape when
    the two disagree — verify any new Fleetio endpoint against a real call
    before relying on the docs.

## Resolved decisions (don't re-litigate these without a real reason)

- **Data stays in the existing tool spreadsheets, not merged.** No functional
  gain was found to justify the migration risk — trigger jobs writing into
  these same sheets, and permission boundaries (e.g. Weather Alert's guest
  PII shouldn't be visible to whoever has Relo Rates access).
- Averta embedded as base64, not externally hosted.
- Real Wilderness logo + inline SVG nav icons wired in.
- Content width: originally split narrow/wide per tool type, then unified
  so every tool used `it-content-wide` (1000px) — **no longer universal**.
  Recurring Tasks' 7-column schedule table didn't fit `wide` even with
  tighter cell padding, so `Styles.html` gained a third tier,
  `it-content-xwide` (1100px, still capped rather than left unconstrained,
  so it doesn't keep growing on very large monitors). Set per-item in
  `NAV_CONFIG` same as the other two. Use `xwide` for any future tool whose
  table genuinely needs more than 6 columns' worth of room; don't reach for
  it by default. Content stays left-anchored, not centered, in all three
  tiers.
- **`Styles.html`'s shared `.it-table`/`.it-badge` cell rules didn't have
  `white-space: nowrap`** — harmless for every existing tool's short,
  single-word cell content, but Recurring Tasks' multi-word department
  names ("Digital Experience") wrapped into ugly 2-line badges, and table
  headers ("Recurs Every") wrapped too. Added `white-space: nowrap` to both
  shared rules — a correctness fix, not a Recurring-Tasks-specific
  override, so every tool's badges/headers benefit.
- **Service History generates a Drive-hosted PDF + link, not a direct
  browser download.** Matches the original POC's behaviour; explicitly kept
  as-is rather than switched to a direct download.
- **The cross-tool activity log lives in its own dedicated container
  spreadsheet** (`SHEET_IDS.ACTIVITY_LOG`), not as a tab inside any one
  tool's existing sheet — a log meant to capture every user's view of every
  tool needs edit access from a much wider audience than any single tool's
  sheet was ever shared with.
- Service History's "Water Tightness" custom field is confirmed as an
  **expiration date**, not a pass/fail test result — the PDF label reads
  "Water Tightness Expiration" accordingly (was previously "Water Tightness
  Result", flagged as unconfirmed in the original POC).
- Service History's "Cost" column (Fleetio's `total_amount` on Service Entry)
  remains deliberately **excluded** from the PDF, pending a decision on
  exposing spend data to customers. (Odometer used to be excluded here too,
  on the belief it came back empty for real entries — added back
  2026-08-18 once it turned out `service_entries` just doesn't carry it
  *directly*; see the Odometer bullet under "Known intentional deviations"
  below.)
- **Per-entry Fleetio detail calls in `generateServiceHistory` are batched
  via `UrlFetchApp.fetchAll()`, not looped one call at a time**, and the
  vehicle's Meter Entry history is fetched at most **once per PDF**
  (`fetchAllMeterEntries_`) and searched in memory for each entry's nearest
  reading, rather than re-querying Fleetio per entry. Added 2026-08-18 after
  the original per-entry `fetchNearestMeterEntry_` implementation was found
  to redundantly re-fetch the same Meter Entry (2 calls) for every selected
  entry sharing the same gap in meter data — the common case, since most
  service entries on a vehicle cluster around the same handful of odometer
  readings. Don't revert to a sequential per-entry loop without re-checking
  this reasoning.

## Still open / deferred — genuinely unresolved, pick these up if relevant

1. **Trigger-driven data refresh jobs stay on the *original* container-bound
   projects**, not ported here: `getTimeTabledSailings`/`getPaxTypes`
   (Interislander), `cloneLiveBookingsSheet` (Booking Finder), the Heroku
   dataclip pull (Weather Alert). These are time-based triggers, independent
   of which UI reads the data — zero migration risk leaving them as-is.
   Revisit only if there's a reason to fully decommission the old projects.
2. **Weather Alert's Sheet-bound menu → modal dialog** (`onOpen`,
   `openAlertDialog`, the `ui.alert`-based `resetDailyLock`) — depends on
   `SpreadsheetApp.getUi()`, only works inside a Sheet context, wasn't
   ported. Still exists on the original spreadsheet if that access path
   matters to anyone.
3. **Cutover** — the older standalone tool deployments (including the
   original Service History POC project and the standalone
   recurring-task-engine project) are still live; nobody's been redirected
   off them yet.
4. **Weather Alert's modal/toast UI doesn't use the shared `ITModal`
   component** (`Modal.html`) — it built its own `wa-backdrop`/`wa-modal`
   system plus a custom `window.toast()`, because its flow (preview / confirm
   / result / lock-reset) needs richer content than `ITModal`'s binary
   confirm/notify can hold. Left as-is deliberately: unifying it means
   extending `ITModal` into a generic modal system, which isn't worth the
   risk to a working tool unless a future tool needs similarly rich modals
   too.
5. **Service History's entry-selection preview isn't logged at the
   per-checkbox level** — only the final selected/total count is recorded
   in the activity log's `Generate PDF` entry, not which specific entries a
   user excluded. Revisit if finer-grained audit detail is ever needed.
6. **Recurring Tasks cutover checklist, specifically** — this one has more
   open steps than the others since it involves live OAuth tokens and a
   daily trigger, not just a URL redirect: (a) set the 4
   `RECURRING_TASKS_JIRA_*` Script Properties in *this* project (see
   "Script Properties" above); (b) run `rtInstallDailyTrigger()` here; (c)
   only once that's confirmed working, run `uninstallDailyTrigger()` on the
   **old** recurring-task-engine project — skipping this step means both
   triggers fire at 7am and every due schedule gets a duplicate Jira ticket;
   (d) retire the old project once its trigger is off.
7. **Recurring Tasks only writes to the shared Activity Log on success**,
   not on failure — its own `Audit Log` sheet tab and `Logger.log` cover
   failures, but every other tool's `logEvent_()` calls fire on both success
   and failure. Inconsistent; revisit if cross-tool failure visibility in
   the Activity Log specifically (not just per-tool logs) turns out to
   matter.
8. **`previewServiceHistory` and `generateServiceHistory` each independently
   call `fetcher.fetchByRego()`** — the preview step (shown so staff can
   tick/untick entries) already does the vehicle lookup + full paginated
   service-entries fetch, and `generateServiceHistory` repeats that same
   round of Fleetio calls from scratch seconds later rather than reusing
   what the client already received from the preview. Passing that
   previewed data back into the generate call (instead of just `rego` +
   `selectedEntryIds`) would drop this duplicated fetch. Flagged
   2026-08-18 during a performance pass that fixed two related issues
   (batching per-entry detail calls, caching the vehicle's meter-entry
   history) but left this one as a follow-up rather than changing the
   client/server call contract in the same pass.

## Known intentional deviations from the original tools

- Relo Rates: fixed the `depature`/`departure` id typo (was silently sending
  blank departure/destination — not used in the pay calc itself, cosmetic
  only, but a genuine pre-existing bug, not preserved on purpose).
- Interislander: date labels use "Saturday, 18 July" rather than the
  original's ordinal "Saturday, July 18th" — dropped the ordinal-suffix
  logic, easy to add back if wanted.
- Weather Alert: guest list guarantees the current user appears when
  `WEATHER_ALERT_TEST_MODE` is on, even if they aren't a real on-road guest,
  so the full send flow can be verified without a real booking needing to exist.
- Service History: adds an entry-selection preview step (load → tick/untick
  → generate) that the original POC didn't have — the POC always included
  every fetched entry with no picker.
- Service History (2026-08-18): the PDF header brand is now the real
  Wilderness logo (JPEG, embedded as a base64 data URI directly in
  `ServiceHistoryTemplate.html` — this is a flat clasp project with no
  binary-asset support, so that's the only way to ship an image with the
  template) instead of a plain-text "Wilderness Motorhomes" wordmark.
- Service History (2026-08-18): a Service Entry with no `vendor_name` in
  Fleetio now displays as **"Wilderness Motorhomes Auckland"** rather than
  "—" — unattributed work is assumed done in-house, per Mark. See
  `mapEntry_` in `ServiceHistoryLogic.gs`.
- Service History (2026-08-18): added an **Odometer** column to the PDF's
  service table. Uses the Service Entry's own `meter_entry.value` when
  Fleetio has one recorded against it; otherwise falls back to the
  vehicle's Meter Entry nearest that service's date (`GET /meter_entries`)
  and labels it "as at `<date>`" in the PDF so it's clear the reading isn't
  from the exact service date. See the `fetchEntryDetailsBatch` /
  `resolveOdometer_` chain in `ServiceHistoryLogic.gs`.
- Recurring Tasks: access is a Google Group check, but now against **two**
  groups (`leaders@wilderness.co.nz` OR `jirataskengine@wilderness.co.nz`)
  rather than the standalone app's single `jirataskengine@wilderness.co.nz`
  — changed post-migration at Mark's request, not carried over unmodified.
- Recurring Tasks: dropped `updateNextDue(id, nextDue)` — confirmed dead
  code in the standalone app; nothing in its UI ever called it (the edit
  modal already folds next-due overrides into the general update call).
- Recurring Tasks: the standalone app's own sidebar (Active/Paused nav
  toggle + per-view department tree) doesn't exist here — replaced with a
  single page showing both "Active Schedules" and "Paused Schedules" as
  stacked cards, filtered by one shared row of department pills above
  both. A deliberate redesign to fit the shared shell's one-sidebar model,
  not a straight port.
