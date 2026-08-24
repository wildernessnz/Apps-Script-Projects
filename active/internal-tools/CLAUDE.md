# Wilderness Internal Tools

Single standalone Apps Script project (clasp, flat files, no subfolders)
unifying 6 tools behind one sidebar-navigated shell. This file is the
always-loaded summary — read `README.md` in full before any non-trivial
change. It has the 18 numbered "Hard-won gotchas," "Resolved decisions"
(don't re-litigate without a real reason), and "Still open / deferred"
sections that are intentionally left out of this file to keep it short.
`AS_BUILT.md` has a fuller architecture writeup covering the same ground in
more detail, if README doesn't answer something.

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
