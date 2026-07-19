# Wilderness Internal Tools — Handoff to Claude Code

Single standalone Apps Script project unifying Booking Finder, Interislander
Availability, Relo Rates, and Weather Alert behind one sidebar-navigated shell.
All 4 tools are built, deployed, and confirmed working as of this handoff.
This doc is the orientation a fresh Claude Code session needs — read this
before touching anything.

## Getting set up

These 17 files are the entire project. Drop them into your local clasp
folder (matching filenames exactly, no subfolders) and `clasp push`.

```
appsscript.json         — manifest (scopes, WildernessAppScriptLibrary dependency)
Config.gs                — SHEET_IDS, NAV_CONFIG (nav structure + icons + content width)
WebApp.gs                — doGet(), include(), getSidebarUserInfo()
ContentLoader.gs         — getToolContent(), access gating
Shell.html                — sidebar + content area, built from NAV_CONFIG
Styles.html               — ALL styling + embedded Averta font (~875KB — this is why
                             the file is large; don't be alarmed)
Router.html               — client-side nav + content swap
Modal.html                — shared ITModal (confirm/notify) + tooltip positioning
Placeholder.html          — unused now (all 4 tools built) but harmless to keep
BookingFinderLogic.gs / BookingFinder.html
InterislanderLogic.gs / Interislander.html
ReloRatesLogic.gs / ReloRates.html
WeatherAlertLogic.gs / WeatherAlert.html
```

Before it'll actually work, Script Properties need setting (Project Settings
→ Script Properties) — none of these are in the code, by design:

**Weather Alert:** `WEATHER_ALERT_APPROVED_SENDERS`, `WEATHER_ALERT_OVERRIDE_EMAILS`,
`WEATHER_ALERT_TEST_MODE`, `WEATHER_ALERT_SENDGRID_API_KEY`,
`WEATHER_ALERT_SENDGRID_TEMPLATE_ID`, `WEATHER_ALERT_FROM_EMAIL`,
`WEATHER_ALERT_FROM_NAME`, `WEATHER_ALERT_HUBSPOT_WHATSAPP_FLOW_ID`,
`WEATHER_ALERT_CONFIRMATION_CC` (optional), `WEATHER_ALERT_BCC_EMAIL` (optional)

**Interislander:** `KIWIRAIL_PRODUCTION_MODE`, `KIWIRAIL_PROD_API_KEY`,
`KIWIRAIL_PROD_BASE64_HEADER`, `KIWIRAIL_UAT_API_KEY`, `KIWIRAIL_UAT_BASE64_HEADER`

Booking Finder and Relo Rates need no properties.

Don't manually set `WEATHER_ALERT_LAST_SEND_DATE` / `WEATHER_ALERT_LAST_SEND_BY`
— the send/reset-lock code manages those itself.

## Architecture, in short

- **Standalone project, data stays put.** Each tool's spreadsheet is untouched
  and unmerged — `Config.gs`'s `SHEET_IDS` holds all 4 IDs, every tool opens
  its sheet via `getSpreadsheet_(key)` (wraps `SpreadsheetApp.openById`).
  Explicit decision, not an oversight — see "Resolved decisions" below.
- **One shell, swappable content.** `Shell.html` is the only thing `doGet()`
  serves. Everything else loads via `google.script.run` calls to
  `getToolContent(partialName)` and gets injected into `#itContent`.
- **Adding tool #5:** one entry in `Config.gs`'s `NAV_CONFIG` (id, label, icon
  SVG, partial name, contentWidth), one new `<Name>Logic.gs` + `<Name>.html`
  pair, flip its `PLACEHOLDER_PARTIALS` entry in `ContentLoader.gs` to `false`
  once the partial exists. Nothing else needs touching.
- **File naming:** `<ToolName>Logic.gs` + `<ToolName>.html` — Apps Script
  doesn't allow a `.gs` and `.html` file to share a base name (learned this
  the hard way with `BookingFinder.gs` vs `BookingFinder.html`).

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
   `KIWIRAIL_PROD_*`/`KIWIRAIL_UAT_*`) since all 4 tools share one properties
   store now. Never add an unprefixed property.
7. **`Styles.html` is ~875KB** (embedded Averta font, 3 weights, base64). This
   is intentional, not bloat to clean up — don't "optimize" it away without
   knowing that's what it is.

## Resolved decisions (don't re-litigate these without a real reason)

- **Data stays in the 4 existing spreadsheets, not merged.** No functional
  gain was found to justify the migration risk — trigger jobs writing into
  these same sheets, and permission boundaries (e.g. Weather Alert's guest
  PII shouldn't be visible to whoever has Relo Rates access).
- Averta embedded as base64, not externally hosted.
- Real Wilderness logo + inline SVG nav icons wired in.
- Content width: capped per tool type (`it-content-narrow` for forms,
  `it-content-wide` for tables), left-anchored not centered.

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
3. **Cutover** — the 3 old tool deployments are still live; nobody's been
   redirected off them yet.

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