# Wilderness Internal Tools — As Built

**Project:** Standalone Google Apps Script web app
**Status:** Live — all 6 tools built and deployed. Recurring Tasks has open
cutover steps (Jira OAuth Script Properties, daily trigger, retiring the
old standalone project) — see section 9.
**Time zone:** Pacific/Auckland
**Access:** Domain-restricted web app, executes as the accessing user

## 1. Purpose

Unifies six previously-separate internal tools behind one sidebar-navigated
shell, as a single Apps Script project:

| Tool | Nav id | Section | Purpose |
|---|---|---|---|
| Booking Finder | `booking-finder` | Adventure Support | Look up bookings |
| Interislander Availability | `interislander` | Adventure Support | Check ferry sailing availability |
| Relo Rates | `relo-rates` | Adventure Support | Vehicle relocation pay rates |
| Weather Alert | `weather-alert` | Adventure Support | Send weather alerts to on-road guests |
| Service History | `service-history` | Workshop | Generate a branded vehicle service history PDF from Fleetio |
| Recurring Tasks | `recurring-tasks` | Leadership | Auto-create recurring Jira tickets on a schedule |

Each tool's underlying spreadsheet is untouched and unmerged — this project
only adds a shared UI shell on top. No data migration occurred. One
exception: a dedicated cross-tool container spreadsheet (`SHEET_IDS.ACTIVITY_LOG`)
holds the activity log shared by all 6 tools — see section 7.

## 2. Architecture overview

```
Browser request
      │
      ▼
doGet()  (WebApp.gs)
      │  HtmlService.createTemplateFromFile('Shell').evaluate()
      ▼
Shell.html  (server-rendered once)
  ├─ include('Styles')   → inlined CSS + embedded Averta font
  ├─ NAV_CONFIG loop     → sidebar markup (Config.gs)
  ├─ include('Modal')    → shared ITModal component
  └─ include('Router')   → client-side router <script>
      │
      ▼  (page loaded, #itContent empty)
ITRouter (Router.html)
      │  google.script.run.getToolContentForNavId(navId)   [on load]
      │  google.script.run.getToolContent(partialName)      [on nav click]
      ▼
ContentLoader.gs
  ├─ ACCESS_GATES check        → per-tool permission gate
  ├─ PLACEHOLDER_PARTIALS check → "coming soon" stub if unbuilt
  └─ HtmlService.createHtmlOutputFromFile(partialName)
      │  returns raw HTML string over the RPC bridge
      ▼
ITRouter.setContent(html)
  → createContextualFragment() injects into #itContent
    (executes the partial's own inline <script> for init)
```

There is exactly one server route (`doGet`). All navigation between tools
happens client-side via `google.script.run` RPC calls — there is no URL or
query-param routing.

## 3. File inventory

The entire project is 23 files, no subfolders (Apps Script/clasp requirement):

```
appsscript.json        — manifest: scopes, timezone, WildernessAppScriptLibrary dependency
Config.gs               — SHEET_IDS, NAV_CONFIG (nav structure, icons, content width)
WebApp.gs               — doGet(), include(), getSidebarUserInfo()
ContentLoader.gs        — getToolContent(), getToolContentForNavId(), access gating, view logging
Logging.gs              — logEvent_() — cross-tool activity log, see section 7
Shell.html               — sidebar + content area shell, built from NAV_CONFIG
Styles.html              — all styling + embedded Averta font (~875KB, base64)
Router.html              — client-side nav + content-swap logic (ITRouter)
Modal.html               — shared ITModal (confirm/notify), tooltip positioning, escapeHtml()
Placeholder.html         — "coming soon" stub for unmigrated tools (currently unused, all 6 live)
BookingFinderLogic.gs / BookingFinder.html
InterislanderLogic.gs / Interislander.html
ReloRatesLogic.gs / ReloRates.html
WeatherAlertLogic.gs / WeatherAlert.html
ServiceHistoryLogic.gs / ServiceHistory.html / ServiceHistoryTemplate.html
RecurringTasksLogic.gs / RecurringTasks.html
```

File naming convention: `<ToolName>Logic.gs` + `<ToolName>.html`. Apps Script
does not allow a `.gs` and `.html` file to share a base name.
`ServiceHistoryTemplate.html` is a third file for that one tool — it's the
PDF's internal layout (evaluated by `ServiceHistoryPdf`, itself defined in
`ServiceHistoryLogic.gs`), not a sidebar UI partial.

## 4. Core mechanisms

### 4.1 Entry point — `WebApp.gs`

```js
function doGet(e) {
  return HtmlService.createTemplateFromFile('Shell')
    .evaluate()
    .setTitle('Wilderness Internal Tools')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
```

Always serves `Shell.html`, evaluated as an Apps Script HTML template (so
`<? ?>` / `<?= ?>` / `<?!= ?>` scriptlets run server-side once, at request
time).

`include(filename)` stitches other server files into a template at
evaluation time:

```js
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
```

`getSidebarUserInfo()` derives a display name and initials from
`Session.getActiveUser().getEmail()`, assuming the org's
`firstname.lastname@` convention (falls back to the first 2 characters of
the email otherwise).

### 4.2 Shell — `Shell.html`

Server-rendered once per page load. Responsibilities:

- `<?!= include('Styles'); ?>` inlines shared CSS into `<head>`.
- Sidebar markup is generated by iterating `NAV_CONFIG` (from `Config.gs`)
  server-side; each nav item's `onclick` embeds its target partial name and
  content width directly:
  ```html
  onclick="ITRouter.navigate('booking-finder', 'BookingFinder', 'wide')"
  ```
- The first item of the first section starts `active`, with an empty
  `<main id="itContent">Loading…</main>` — no content is rendered
  server-side, only a placeholder.
- `<?!= include('Modal'); ?>` and `<?!= include('Router'); ?>` inline the
  shared modal markup and the router script at the bottom.

### 4.3 Nav/routing data — `Config.gs`

```js
const NAV_CONFIG = [
  {
    section: 'Adventure Support',
    items: [
      { id: 'booking-finder', label: 'Booking Finder', icon: ICON_CALENDAR, partial: 'BookingFinder', contentWidth: 'wide' },
      { id: 'interislander',  label: 'Interislander Availability', icon: ICON_FERRY, partial: 'Interislander', contentWidth: 'wide' },
      { id: 'relo-rates',     label: 'Relo Rates', icon: ICON_CLOCK, partial: 'ReloRates', contentWidth: 'wide' },
      { id: 'weather-alert',  label: 'Weather Alert', icon: ICON_ALERT_TRIANGLE, partial: 'WeatherAlert', contentWidth: 'wide' },
    ],
  },
  {
    section: 'Workshop',
    items: [
      { id: 'service-history', label: 'Service History', icon: ICON_WRENCH, partial: 'ServiceHistory', contentWidth: 'wide' },
    ],
  },
  {
    section: 'Leadership',
    items: [
      { id: 'recurring-tasks', label: 'Recurring Tasks', icon: ICON_REPEAT, partial: 'RecurringTasks', contentWidth: 'xwide' },
    ],
  },
];
```

This array (now 3 sections) is the routing table — it drives both the
server-rendered sidebar (`Shell.html`) and the server-side partial lookup
(`ContentLoader.gs`). The client never duplicates it. A new tool can either
join an existing section's `items` array or start its own `{ section, items
}` block, as Service History did with "Workshop" and Recurring Tasks did
with "Leadership". Recurring Tasks' `contentWidth: 'xwide'` is also the
first use of the third content-width tier — see section 8 for why `wide`
(1000px) wasn't enough for its table.

`Config.gs` also holds `SHEET_IDS` (each tool's spreadsheet ID) and
`getSpreadsheet_(key)`, a wrapper around `SpreadsheetApp.openById` that
fails with a clear error message on a bad key.

### 4.4 Client-side router — `Router.html` (`ITRouter`)

An IIFE with two entry points:

- **Initial load** (`DOMContentLoaded`): finds the `.it-nav-item.active`
  element and calls `getToolContentForNavId(navId)`.
- **Nav click**: inline `onclick` calls `ITRouter.navigate(toolId,
  partialName, contentWidth)`, which sets the active nav state, shows a
  loading spinner, and calls `getToolContent(partialName)`.

Both paths route through `google.script.run`, with `setContent` as the
success handler.

`setContent(html)` deliberately does **not** use `innerHTML` — that would
silently skip any `<script>` tags in the injected HTML. It instead uses:

```js
const range = document.createRange();
range.selectNode(content);
const fragment = range.createContextualFragment(html);
content.appendChild(fragment);
```

This matters because every tool partial relies on its own inline `<script>`
for init logic.

### 4.5 Content resolution — `ContentLoader.gs`

```js
function getToolContent(partialName) {
  const gateCheck = ACCESS_GATES[partialName];
  if (gateCheck && !gateCheck()) {
    logEvent_('View: ' + partialName, 'Access denied');
    return /* "Access Denied" fragment */;
  }

  logEvent_('View: ' + partialName);

  if (PLACEHOLDER_PARTIALS[partialName]) {
    return HtmlService.createTemplateFromFile('Placeholder')
      .evaluate().getContent().replace('{{TOOL_NAME}}', partialName);
  }
  return HtmlService.createHtmlOutputFromFile(partialName).getContent();
}

function getToolContentForNavId(navId) {
  for (const section of NAV_CONFIG) {
    const match = section.items.find(item => item.id === navId);
    if (match) return getToolContent(match.partial);
  }
  throw new Error(`[getToolContentForNavId] Unknown nav id: ${navId}`);
}
```

Resolution order: **access gate → view log → placeholder flag → real partial.**

- `ACCESS_GATES` maps a partial name to a function returning true/false for
  whether the current user may see that tool. `WeatherAlert`
  (`isWeatherAlertApproved()`), `ServiceHistory`
  (`isServiceHistoryApproved()`), and `RecurringTasks`
  (`isRecurringTasksApproved()`) are gated today, since all three
  originally gated their whole page at `doGet()` and now share a page with
  the other tools. Stored as direct function references (not string-keyed
  dynamic dispatch), since top-level `this` isn't reliably the global
  object under Apps Script's V8 runtime. Two different gate mechanisms
  exist: Weather Alert/Service History check a comma-separated email
  allowlist in a Script Property; Recurring Tasks checks Google Group
  membership (`GroupsApp.getGroupByEmail(...).hasUser(email)`, `.some()`
  across `RECURRING_TASKS_CONFIG.ACCESS_GROUPS` — access granted by
  membership in *any* listed group) — carried over unmodified from the
  standalone app rather than converted to the allowlist pattern, since the
  ask was "keep functionality the same," not "make every tool's access
  control identical."
- `getToolContent()` is also the single chokepoint every tool view passes
  through — initial page load (`getToolContentForNavId`) and every nav
  click both route through it — so it's where cross-tool view logging
  (`logEvent_`, defined in `Logging.gs`; see section 7) is hooked in. Access
  denials are logged too, with a `'Access denied'` note.
- `PLACEHOLDER_PARTIALS` is a per-tool feature flag for "not yet built."
  All 5 are currently `false` (all tools shipped); flipping one to `true`
  serves `Placeholder.html` instead, so the shell can run end-to-end before
  every tool is finished.
- The fallback returns the raw partial file's content
  (`HtmlService.createHtmlOutputFromFile`, not a template) — these files are
  plain HTML/JS strings, not evaluated with scriptlets, unlike `Shell.html`.

## 5. Manifest / deployment (`appsscript.json`)

- `timeZone`: `Pacific/Auckland`
- `webapp.executeAs`: `USER_ACCESSING` — runs as whoever opens the app, not
  as the script owner
- `webapp.access`: `DOMAIN` — restricted to the Wilderness Google Workspace domain
- Depends on library `WildernessAppScriptLibrary` (development mode) — used
  by Service History for Fleetio auth (`WildernessAppScriptLibrary.FleetioSecurity`,
  must be instantiated with `new`)
- OAuth scopes: `spreadsheets`, `userinfo.email`, `script.external_request`,
  `script.send_mail`, `script.container.ui`, `drive`, `groups`,
  `script.scriptapp`. The `drive` scope (not the narrower `drive.file`) was
  added for Service History's `DriveApp.createFile()` call — `drive.file`
  looked sufficient but Google's own runtime error confirmed it wasn't, for
  this specific call pattern. `groups` and `script.scriptapp` were added
  for Recurring Tasks' `GroupsApp.getGroupByEmail()` (access check) and
  `ScriptApp.getProjectTriggers()`/`newTrigger()`/`deleteTrigger()`
  (daily-trigger install/status) respectively — **this list is explicit,
  not auto-augmented**, so both were missing on first deploy and only
  surfaced as runtime "Specified permissions are not sufficient" errors in
  the Executions log, not at push/deploy time. Check this list against
  what a new tool's code actually calls before deploying it, not after.

## 6. Configuration (Script Properties)

None of these are in code, by design — set under Project Settings → Script
Properties:

**Weather Alert:** `WEATHER_ALERT_APPROVED_SENDERS`,
`WEATHER_ALERT_OVERRIDE_EMAILS`, `WEATHER_ALERT_TEST_MODE`,
`WEATHER_ALERT_SENDGRID_API_KEY`, `WEATHER_ALERT_SENDGRID_TEMPLATE_ID`,
`WEATHER_ALERT_FROM_EMAIL`, `WEATHER_ALERT_FROM_NAME`,
`WEATHER_ALERT_HUBSPOT_WHATSAPP_FLOW_ID`,
`WEATHER_ALERT_CONFIRMATION_CC` (optional),
`WEATHER_ALERT_BCC_EMAIL` (optional)

**Interislander:** `KIWIRAIL_PRODUCTION_MODE`, `KIWIRAIL_PROD_API_KEY`,
`KIWIRAIL_PROD_BASE64_HEADER`, `KIWIRAIL_UAT_API_KEY`,
`KIWIRAIL_UAT_BASE64_HEADER`

**Service History:** `SERVICE_HISTORY_ALLOWLIST` (comma-separated emails,
gates the whole tool — same pattern as `WEATHER_ALERT_APPROVED_SENDERS`),
`SERVICE_HISTORY_EXCLUDED_TASKS` (comma-separated Fleetio service task names
excluded from every PDF, matched case- and whitespace-insensitively;
defaults to `Rental Turn Around,Detail` if unset). Matching tasks are
dropped from a work order's task list rather than hiding the whole entry —
a work order that mixes a rental turnaround with real service work still
shows the real work.

**Recurring Tasks:** `RECURRING_TASKS_JIRA_CLIENT_ID`,
`RECURRING_TASKS_JIRA_CLIENT_SECRET`, `RECURRING_TASKS_JIRA_REDIRECT_URI`
(Atlassian OAuth 2.0 app credentials), `RECURRING_TASKS_JIRA_REFRESH_TOKEN`
(minted via `rtAuthoriseJira()` + `rtExchangeCodeForTokens(code)` from the
Apps Script editor, then rotates itself on every Jira call thereafter —
never set by hand after the first mint). **Not yet set as of this
handoff** — the tool's Sheet-only operations (list/create/edit/pause/
resume/delete/history) work without them; Run Now and the daily trigger
need them and fail with "No OAuth refresh token found" until they're set.
Access control for this tool is a Google Group membership check
(`RECURRING_TASKS_CONFIG.ACCESS_GROUPS` in `RecurringTasksLogic.gs` itself,
not a Script Property), currently `leaders@wilderness.co.nz` and
`jirataskengine@wilderness.co.nz` — membership in either grants access.

**Booking Finder / Relo Rates:** none required.

`WEATHER_ALERT_LAST_SEND_DATE` / `WEATHER_ALERT_LAST_SEND_BY` are managed
automatically by the send/reset-lock code — do not set manually.

All properties share one store (one project now hosts what used to be
several separate projects), so every property is prefixed per tool
(`WEATHER_ALERT_*`, `KIWIRAIL_PROD_*`/`KIWIRAIL_UAT_*`, `SERVICE_HISTORY_*`,
`RECURRING_TASKS_*`) to avoid collisions.

## 7. Data model

Each tool opens its own pre-existing spreadsheet by ID via
`getSpreadsheet_(key)` — nothing was merged or moved. This was an explicit
decision: trigger jobs already write into these sheets independently of
this UI, and permission boundaries need to stay separate (e.g. Weather
Alert's guest PII shouldn't be visible to whoever has Relo Rates access).

Booking Finder reads its sheet's "Linked - Bookings" tab by **column
position** (`COL_*` constants in `BookingFinderLogic.gs`) — if that sheet's
columns are ever reordered, the constants must be updated to match.

Recurring Tasks' spreadsheet (`SHEET_IDS.RECURRING_TASKS`) holds three tabs
rather than one: `Schedules` (the actual schedule rows), `Creation Log`
(one row per Jira issue actually created, feeds the per-schedule "View
History" drawer), and `Audit Log` (one row per user action — Created/
Updated/Deleted/Paused/Resumed/Run Now — separate from and in addition to
the cross-tool Activity Log in 7.1 below). All three are created lazily
with headers on first write, same pattern as every other lazily-created
tab in this project. Unlike Service History (which authenticates to
Fleetio via the shared `WildernessAppScriptLibrary.FleetioSecurity`
library), Recurring Tasks talks to Jira via its own hand-rolled OAuth 2.0
(3LO) flow — `rtGetOAuthAccessToken_()` refreshes an access token from the
stored refresh token before every call, rotating the refresh token
whenever Atlassian returns a new one. `rtAuthoriseJira()` /
`rtExchangeCodeForTokens()` / `rtRevokeOAuthToken()` / `rtCheckOAuthStatus()`
are editor-only maintenance functions for setting this up — none are
wired to any UI button.

### 7.1 Cross-tool activity log

One exception to "every tool owns its own sheet": `SHEET_IDS.ACTIVITY_LOG`
is a dedicated container spreadsheet shared by all 6 tools, holding a single
"Activity Log" tab (`Timestamp | User | Event | Notes`). `Logging.gs`'s
`logEvent_(event, notes)`:

- Opens `SHEET_IDS.ACTIVITY_LOG` and lazily creates the "Activity Log" tab
  (`insertSheet` + header row) on first write, matching Weather Alert's own
  `getOrCreateLogSheet_` pattern.
- Reads the writing user's email via `Session.getActiveUser()`.
- Swallows any error (`Logger.log` only, never thrown) — a broken log write
  must never break the tool action it's recording.

Because the manifest runs `executeAs: USER_ACCESSING`, every log write
executes under the *visiting user's own* Google identity — so this
container spreadsheet needs edit access shared with everyone who uses any
tool at all, not just a narrow group. This is a materially wider sharing
requirement than any single tool's own sheet has ever needed (contrast with
Weather Alert's log, which only needs access from its small
`APPROVED_SENDERS` group).

Two call sites populate it today:

1. `ContentLoader.gs`'s `getToolContent()` — logs every tool view
   (`View: <partial>`), including access-denied attempts.
2. Each tool's `google.script.run` entry point — logs its primary action on
   both success and failure (search / calculate / generate / send). Pure
   read-only preview calls with no side effect are not logged (Weather
   Alert's `getGuestPreview()`/`previewEmail()`). **Exception:** Recurring
   Tasks' 6 entry points (`saveRecurringTaskSchedule`,
   `updateRecurringTaskSchedule`, `deleteRecurringTaskSchedule`,
   `pauseRecurringTaskSchedule`, `resumeRecurringTaskSchedule`,
   `runRecurringTaskScheduleNow`) only call `logEvent_()` on success —
   failures are captured in `Logger.log` and its own `Audit Log` tab, but
   not in this shared log. Its daily-trigger handler
   (`runRecurringTasksDailyCheck`) is the one function that always logs a
   summary here regardless of outcome. Inconsistent with the rest of this
   list; not yet reconciled.

## 8. Shared components

- **`Modal.html`** — `ITModal.confirm()` / `ITModal.notify()`, used
  everywhere instead of native `alert()`/`confirm()`/`prompt()`, which
  silently no-op inside Apps Script's `IFRAME` sandbox. Also exposes a
  global `escapeHtml()` helper used to sanitize any sheet/API-sourced value
  before it's concatenated into `innerHTML`.
- **`Styles.html`** — all CSS plus the embedded Averta font (3 weights,
  base64), which accounts for its ~875KB size. This is intentional, not
  bloat. Components added while building Recurring Tasks, available to any
  future tool:
  - `.it-content-xwide` — third content-width tier (1100px), for tables
    with more columns than `wide` (1000px) comfortably fits.
  - `.it-table th.sortable` / `.sort-icon` — clickable/sortable column
    headers (↑/↓/↕ indicator).
  - `.it-select` — chevron-decorated `<select>` styled to match `.it-input`.
  - `.it-row-menu` / `.it-row-menu-btn` / `.it-row-menu-item` (+
    danger/warn/success/divider variants) — per-row "···" action dropdown,
    `position: fixed` and placed via `getBoundingClientRect()` for the same
    reason `.it-tooltip-content` is (escapes `.it-card`'s `overflow:
    hidden`).
  - `.it-form-modal-*` — a bigger modal than `.it-modal-card` (which is
    confirm-dialog-sized) for multi-field forms; header/footer visual
    language matches `.wa-modal-header`/`-footer`.
  - `.it-drawer-*` — slide-in panel from the right (history/detail views).
  - `.it-toast-container` / `.it-toast` — bottom-right auto-dismiss
    notification, for non-blocking "action succeeded, here's a link"
    feedback that `ITModal.notify()`'s blocking dialog doesn't suit.
  - `.it-btn-ghost-sm.active` — filled-state modifier for a row of filter
    pills (e.g. Recurring Tasks' department filter).
  - `.it-badge` and `.it-table thead th` both gained `white-space: nowrap`
    — a correctness fix (see "Resolved decisions"), not additive, so every
    tool's existing badges/headers are affected too, not just Recurring
    Tasks'.
- **`Logging.gs`** — `logEvent_(event, notes)`, the cross-tool activity log
  writer (see section 7.1). Called from `ContentLoader.gs` for every tool
  view, and from each tool's own entry-point wrapper for its primary
  action(s).

## 9. Known gaps / deferred work

1. **Trigger-driven data refresh jobs remain on the original container-bound
   projects**, not ported: `getTimeTabledSailings`/`getPaxTypes`
   (Interislander), `cloneLiveBookingsSheet` (Booking Finder), the Heroku
   dataclip pull (Weather Alert). Time-based triggers are independent of
   which UI reads the data, so this carries no migration risk.
2. **Weather Alert's Sheet-bound menu → modal dialog** (`onOpen`,
   `openAlertDialog`, `ui.alert`-based `resetDailyLock`) depends on
   `SpreadsheetApp.getUi()` and only works inside a Sheet context — not
   ported. Still available on the original spreadsheet.
3. **Cutover not done** — the older standalone tool deployments (including
   the original Service History POC project and the standalone
   recurring-task-engine project) are still live; nobody has been
   redirected to this consolidated app yet.
4. **Weather Alert doesn't use the shared `ITModal`** — it has its own
   `wa-backdrop`/`wa-modal` system and a custom `window.toast()`, because
   its preview/confirm/result/lock-reset flow needs richer content than
   `ITModal`'s binary confirm/notify supports. Left as-is deliberately.
5. **Service History's activity log entry doesn't record which specific
   entries were excluded** from the entry-selection preview — only the
   selected/total count is logged on `Generate PDF`. Revisit if
   per-checkbox audit detail is ever needed.
6. **Recurring Tasks cutover is further behind than the other tools' —
   its OAuth Script Properties aren't set in this project yet, its daily
   trigger isn't installed here yet, and the old project's trigger isn't
   uninstalled yet.** Until all three are done, don't assume Run Now or
   the 7am automation work from this shell. See the README's Script
   Properties section for the exact keys and the install/uninstall order
   (installing here before uninstalling there means schedules get a
   duplicate Jira ticket for one day).
7. **Recurring Tasks' `logEvent_()` calls only fire on success**, not
   failure, unlike every other tool's entry points (see section 7.1). Its
   own `Audit Log` tab and `Logger.log` still capture failures — just not
   the shared cross-tool Activity Log.

## 10. Known intentional deviations from the original tools

- **Relo Rates:** fixed a pre-existing `depature`/`departure` id typo that
  silently sent blank departure/destination values (cosmetic only, not
  used in the pay calc) — a genuine bug fix, not a preserved behavior.
- **Interislander:** date labels read "Saturday, 18 July" rather than the
  original's ordinal "Saturday, July 18th" (ordinal-suffix logic dropped;
  easy to reinstate if wanted).
- **Weather Alert:** the guest list guarantees the current user appears
  when `WEATHER_ALERT_TEST_MODE` is on, even without a real on-road
  booking, so the full send flow can be verified end-to-end.
- **Service History:** adds an entry-selection preview step (load → tick/
  untick → generate) the original POC never had — the POC always included
  every fetched entry with no picker. Also relabels the PDF's "Water
  Tightness" field as "Water Tightness Expiration" (confirmed to be an
  expiration date, not a pass/fail result, unlike the POC's original label).
- **Recurring Tasks:** access changed post-migration from a single Google
  Group (`jirataskengine@wilderness.co.nz`, matching the standalone app) to
  checking **two** groups (adding `leaders@wilderness.co.nz`) — membership
  in either now grants access, at Mark's request, not carried over
  unmodified. Dropped `updateNextDue(id, nextDue)` as confirmed dead code
  (nothing in the standalone app's own UI ever called it). Replaced the
  standalone app's own sidebar (Active/Paused nav toggle, with a per-view
  department tree beneath each) with a single page — both "Active
  Schedules" and "Paused Schedules" as stacked cards, filtered together by
  one shared row of department pills — since the shared shell only has
  room for one sidebar. Needed a new, wider `it-content-xwide` tier plus
  tighter cell padding and a horizontal-scroll fallback (all scoped to
  `#rtRoot`, not applied to `.it-table` generally) since its 7-column table
  didn't fit `wide` (1000px) even before accounting for the sidebar this
  tool didn't have to share with anything in its standalone form.

## 11. Extending the app

To add a 7th tool:

1. Add one entry to `NAV_CONFIG` in `Config.gs` (id, label, icon SVG,
   partial name, content width) — either into an existing section's `items`,
   or as a new `{ section, items }` block (Service History got its own
   "Workshop" section, Recurring Tasks got "Leadership", rather than
   joining "Adventure Support").
2. Add `<Name>Logic.gs` + `<Name>.html`.
3. Add/flip its `PLACEHOLDER_PARTIALS` entry in `ContentLoader.gs` to
   `false` once the partial exists.
4. Wire up `logEvent_()` (from `Logging.gs`) in the new tool's own
   `google.script.run` entry point(s), for its primary action(s). View
   logging is automatic — it goes through `ContentLoader.gs`'s
   `getToolContent()`, which every tool already routes through.
5. **If porting in an existing standalone Apps Script app** (as both
   Service History and Recurring Tasks were): rename every server function
   — generic names like the source's `getSheet_`/`saveSchedule`/`logAudit_`
   never collided in their own project but will here, once everything
   shares one script's global namespace. And check `appsscript.json`'s
   `oauthScopes` against every built-in service the ported code actually
   calls, not just the ones an existing tool already uses — that list is
   explicit, not auto-augmented, and a missing scope only surfaces as a
   runtime error in the deployed app's Executions log, not at push time
   (see section 5).

No other file needs to change for steps 1–4 — this is a direct consequence
of `NAV_CONFIG` being the single source of truth for both the sidebar and
the content loader. Steps 4–5 are the things that don't come for free.
