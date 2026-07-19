# Wilderness Internal Tools — Unified Web App

A single standalone Apps Script project serving Booking Finder, Interislander
Availability, Relo Rates, and Weather Alert behind one sidebar-navigated
shell, replacing 4 separate deployments with duplicated headers.

## Architecture

- **Standalone project, not container-bound.** Each tool's data still lives in
  its own original spreadsheet — nothing merged. `Config.gs`'s `SHEET_IDS`
  holds all 4 IDs; each tool's logic opens its sheet via `getSpreadsheet_(key)`
  (wraps `SpreadsheetApp.openById`) rather than `getActiveSpreadsheet()`.
- **One shell, swappable content.** `Shell.html` renders the sidebar (built
  entirely from `Config.gs`'s `NAV_CONFIG` — adding a 5th tool later is one
  entry there, nothing else changes) plus an empty content area. `Router.html`
  fetches each tool's HTML via `google.script.run` and injects it with
  `createContextualFragment` (not `innerHTML` — that silently skips `<script>`
  execution, which every tool partial relies on for its own init logic).
- **File naming:** `<ToolName>Logic.gs` paired with `<ToolName>.html` — Apps
  Script doesn't allow a `.gs` and `.html` file to share a base name.
- **Script Properties are prefixed per tool** (`WEATHER_ALERT_*`,
  `KIWIRAIL_PROD_*` / `KIWIRAIL_UAT_*`) since all 4 tools now share one
  properties store — never add an unprefixed property.
- **No native `alert()`/`confirm()`/`prompt()` anywhere** — Apps Script's
  HtmlService `IFRAME` sandbox doesn't support them (silent no-op). Weather
  Alert has its own purpose-built modal/toast system (matching its original
  tool's UX exactly); everything else uses the shared `ITModal` in `Modal.html`.
- **Per-tool access gating** (`ContentLoader.gs`'s `ACCESS_GATES`) — Weather
  Alert's approved-senders check now gates just its own content slot, since
  the original gated its entire page and this tool shares a page with 3 others.

## Resolved decisions (previously open)

- **Data stays in the 4 existing spreadsheets, not merged into one.** No
  functional gain was found to justify the migration risk (re-pointing the
  trigger jobs that write into these same sheets, splitting apart existing
  permission boundaries — e.g. Weather Alert's guest PII shouldn't be visible
  to whoever has access to Relo Rates' pay variables).
- **Averta font** — embedded as base64 in `Styles.html` (~875KB, one-time
  load, no external hosting dependency).
- **Logo** — real Wilderness logo wired in (Hubspot-hosted asset).
- **Nav icons** — inline SVGs in `Config.gs`'s `NAV_CONFIG`, not an icon
  library.
- **Content width** — per the design spec: 680px-ish (bumped up after
  feedback) for form-style tools (Weather Alert, Relo Rates), wider for
  table-heavy ones (Booking Finder, Interislander) — see `it-content-narrow`
  / `it-content-wide` in `Styles.html`.

## Still open / deferred

1. **Trigger-driven data refresh jobs** stay on the *original* container-bound
   projects, not ported here — `getTimeTabledSailings`/`getPaxTypes`
   (Interislander), `cloneLiveBookingsSheet` (Booking Finder), the Heroku
   dataclip pull (Weather Alert). Time-based triggers aren't tied to the UI
   layer, so the old projects can keep running these indefinitely with zero
   migration risk. Revisit only if there's a reason to fully decommission the
   old projects.
2. **Weather Alert's Sheet-bound menu → modal dialog** (`onOpen`,
   `openAlertDialog`, the `ui.alert`-based `resetDailyLock`) wasn't ported —
   depends on `SpreadsheetApp.getUi()`, which only works inside a Sheet
   context. Still exists on the original Weather Alert spreadsheet if that
   access path matters to anyone; otherwise fine to retire once this is the
   only way people send alerts.
3. **Cutover** — redirecting people off the 3 old tool deployments onto this
   one hasn't happened yet.

## Known intentional deviations from the original tools

- Relo Rates: `depature`/`departure` id typo fixed (was silently sending
  blank departure/destination — not used in the pay calc itself, cosmetic
  only, but a genuine bug, not preserved).
- Interislander: date labels use "Saturday, 18 July" rather than the
  original's ordinal "Saturday, July 18th" (dropped the ordinal-suffix logic
  for now — easy to add back if wanted).
- Weather Alert: guest list guarantees the current user appears in test mode
  (even if they aren't a real on-road guest in the sheet right now), so the
  full send flow can be verified without needing a real @wilderness.co.nz
  booking to exist.