# Wilderness Internal Tools

Single standalone Apps Script project (clasp, flat files, no subfolders)
unifying 8 tools behind one sidebar-navigated shell. This file is the
always-loaded summary — read `README.md` in full before any non-trivial
change. It has the 24 numbered "Hard-won gotchas," "Resolved decisions"
(don't re-litigate without a real reason), and "Still open / deferred"
sections that are intentionally left out of this file to keep it short.
`AS_BUILT.md` has a fuller architecture writeup covering the same ground in
more detail, if README doesn't answer something.

## Deploying changes

`clasp push` and `clasp deploy` both act on whatever's in the working
directory regardless of git branch — git history doesn't protect the live
tool from an in-progress/broken iteration the way it might in a
CI/CD-deployed project. Two deployments exist
(`clasp deployments`): `@HEAD` (test deployment, URL ends `/dev`, only
reachable by someone with edit access to the script) and a versioned one
pinned to a specific deployment ID that's what staff actually use. While
iterating (e.g. tightening a PDF template's layout across several rounds
of screenshot feedback): `clasp push` after each change and test against
`@HEAD`'s `/dev` URL; only run
`clasp deploy --deploymentId <the live one> --description "..."` once the
change is actually verified, so staff never see a broken intermediate
state. Get the live deployment ID from `clasp deployments` — it's the one
with a version number, not `@HEAD`.

## Non-negotiables (violate these and it breaks silently, no error)

- No native `alert()`/`confirm()`/`prompt()` — HtmlService's IFRAME sandbox
  silently no-ops them. Use `ITModal.confirm()`/`ITModal.notify()` from
  `Modal.html`.
- Never `innerHTML = html` for content that may include `<script>` tags —
  it won't execute. Use `Router.html`'s
  `document.createRange().createContextualFragment(html)` pattern instead.
- Escape any sheet/API-sourced string before it goes into HTML: client-side
  `escapeHtml()` (`Modal.html`, loaded globally), server-side
  `escapeHtml_()` (`WeatherAlertLogic.gs`).
- Never build "today" via `new Date().toISOString().slice(0,10)` — it
  converts to UTC first, which rolls back a day in NZ time before midday.
  Build from local `getFullYear()`/`getMonth()`/`getDate()` instead.
- `appsscript.json`'s `oauthScopes` list is explicit, not
  auto-augmented — any new built-in service call needs its scope added by
  hand, or it fails only at runtime (deployed web app's Executions log),
  never at push/deploy time.
- Script Properties are prefixed per tool (`WEATHER_ALERT_*`,
  `SERVICE_HISTORY_*`, etc.) since all tools share one properties store.
  Never add an unprefixed one.

## Generating a PDF (Service History, CIN Generator)

Both PDF tools use the same `HtmlService.createTemplateFromFile(...).evaluate()`
→ `Utilities.newBlob(html, 'text/html', ...).getAs('application/pdf')`
mechanism, which has its own non-obvious limits (README gotchas #19–21):

- `background`/`background-color` is dropped by default (browsers'
  print-to-PDF ink-saving behavior) — add
  `print-color-adjust: exact;`/`-webkit-print-color-adjust: exact;` to any
  element that needs one. `border` is unaffected, so a colored border
  showing while its fill doesn't is the signature of this exact issue.
- `page-break-inside`/`break-inside: avoid` are not honored at all — size
  content to fit within a page rather than relying on split-avoidance.
- A `table-layout: fixed` table needs every row's `colspan`s to sum to the
  same total, or short rows leave blank trailing columns instead of
  stretching to fill.

## Adding a new tool

1. One entry in `Config.gs`'s `NAV_CONFIG` (id, label, icon SVG, partial
   name, content width) — existing section or a new `{ section, items }`
   block.
2. New `<Name>Logic.gs` + `<Name>.html` pair. A `.gs` and `.html` file
   can't share a base name (Apps Script restriction).
3. Flip its `PLACEHOLDER_PARTIALS` entry in `ContentLoader.gs` to `false`.
4. Wire `logEvent_()` (`Logging.gs`) into the tool's own
   `google.script.run` entry point(s) for its primary action(s) — view
   logging is automatic (goes through `getToolContent()`), action logging
   is not.
5. If porting in an existing standalone Apps Script app: prefix every
   private helper and rename every public entry point first — generic
   names (`getSheet_`, `saveSchedule`, ...) never collided in their own
   project but will here, since every tool now shares one script's global
   namespace. See README gotcha #15 for the pattern used for Recurring
   Tasks.

Nothing else needs touching for the shell/routing itself — `NAV_CONFIG` is
the single source of truth for both the sidebar and the content loader.

## File naming

`<ToolName>Logic.gs` + `<ToolName>.html`. `ServiceHistoryTemplate.html` is
a third file for that tool — the PDF's internal layout, evaluated by
`ServiceHistoryPdf`, not the sidebar UI partial. Don't conflate the two.
