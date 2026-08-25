---
name: add-tool
description: Add a new tool to the Wilderness Internal Tools Apps Script shell — either building it fresh or porting in an existing standalone Apps Script app. Use when asked to add a new tool/section to this project.
---

# Adding a tool to Wilderness Internal Tools

Read `CLAUDE.md` first if this session hasn't already (it's auto-loaded,
so it should have). This skill is the step-by-step for the recipe
summarized there.

## 0. Figure out which mode this is

Ask if not already clear from the request:

- **Fresh build** — no existing code, designing from scratch (CIN Generator
  was this — no source app to port from).
- **Port** — an existing standalone Apps Script project is being folded
  in (like Service History and Recurring Tasks were). This mode has extra
  steps (4b) that fresh builds skip — skipping them is how tool #5 and #6
  each shipped with a bug that only showed up after deploy.

Also confirm: what section does it belong in (existing "Adventure
Support"/"Retail Sales"/"Leadership", or a new one), what's the access
model (open to all / Script-Property allowlist like Weather Alert, Service
History & CIN Generator / Google Group check like Recurring Tasks), and
does it need any Script Properties.

## 1. NAV_CONFIG

Add one entry to `Config.gs`'s `NAV_CONFIG` — id, label, icon SVG, partial
name, content width (`it-content-wide` at 1000px is the default; reach
for `it-content-xwide` at 1100px only if a table genuinely needs more than
~6 columns, per README "Resolved decisions"). Put it in the confirmed
section, or add a new `{ section, items }` block.

## 2. The file pair

Create `<Name>Logic.gs` + `<Name>.html`. A `.gs` and `.html` file cannot
share a base name in Apps Script — that's why it's `<Name>Logic.gs`, not
`<Name>.gs`. If the tool needs a third file (like
`ServiceHistoryTemplate.html` for PDF generation), name it descriptively,
not ambiguously close to the partial name.

## 3. Wire it into ContentLoader

Flip the tool's `PLACEHOLDER_PARTIALS` entry in `ContentLoader.gs` to
`false` once the partial file exists. Apply the access model confirmed in
step 0 here if it's not open-to-all.

## 4a. Activity logging

Wire `logEvent_()` (`Logging.gs`) into the new tool's own
`google.script.run` entry point(s) for its primary action(s) (search /
calculate / generate / send — whatever this tool's equivalent is), on both
the success and failure path. View logging is automatic through
`getToolContent()` — don't add it again. Pure read-only preview calls with
no side effect are conventionally left unlogged (see Weather Alert's
`getGuestPreview()`).

## 4b. Extra steps when porting an existing standalone app

Do these *before* wiring anything into the shell, not after:

- **Rename every server function.** Prefix private helpers
  (`getSheet_` → `xtGetSheet_`) and rename public `google.script.run`
  entry points to something tool-specific (`getSchedules` →
  `getRecurringTaskSchedules`). Generic names never collided in the
  source's own standalone project; they will once every tool shares one
  script's global namespace. This is README gotcha #15 — check the
  ported code for every helper name against what other tools already
  define before assuming it's safe.
- **Check `appsscript.json`'s `oauthScopes`** against every built-in
  service the ported code actually calls (`GroupsApp`, `ScriptApp`,
  `DriveApp`, etc.), not just the ones an existing tool already uses. This
  list is explicit, not auto-augmented — a missing scope only fails at
  runtime, in the deployed web app's Executions log, never at push time.
  Recurring Tasks hit this twice post-deploy (`GroupsApp.getGroupByEmail()`
  needing `.../auth/groups`, `ScriptApp.getProjectTriggers()` needing
  `.../auth/script.scriptapp`) — don't repeat that discovery-by-production
  cycle when it's checkable up front.
- **Check `webapp.executeAs: USER_ACCESSING` implications** if the ported
  code does any Drive/Sheets write — it runs as the visiting user, not a
  service account, so verify the actual required OAuth scope (not just the
  minimal-looking one) and who actually needs edit access to any sheet
  it touches. See README gotcha #12.
- Don't port Sheet-bound UI (custom menus, `SpreadsheetApp.getUi()`
  dialogs) — it depends on a Sheet context this shell doesn't have. Leave
  it on the original spreadsheet if that access path still matters to
  anyone (see "Still open / deferred" in README for Weather Alert's
  precedent).

## 4c. If the tool generates a PDF

Service History and CIN Generator both build a PDF via
`HtmlService.createTemplateFromFile('<Name>Template').evaluate()` →
`Utilities.newBlob(html, 'text/html', ...).getAs('application/pdf')` — a
third file, `<Name>Template.html`, alongside the `Logic.gs`/`.html` pair
(step 2). This conversion has its own non-obvious limits, all discovered
the hard way on CIN Generator (README gotchas #19–21) — check a real
rendered PDF against these before calling PDF layout done, not just the
on-screen preview:

- Any element that needs a background fill needs
  `print-color-adjust: exact;` (+ `-webkit-` prefixed variant) — fills are
  dropped by default, same as a browser's print-to-PDF ink-saving
  behavior. Borders are unaffected, so a border showing while its fill
  doesn't is the signature of this specific issue, not a sign the color is
  wrong.
- `page-break-inside`/`break-inside: avoid` do nothing — a table row or a
  bordered box will still tear mid-content across a page boundary with
  these set. Size content to fit within a page instead of relying on
  split-avoidance.
- A `table-layout: fixed` table needs every row's `colspan`s to sum to the
  same total (the widest row's cell count), or shorter rows leave blank
  trailing columns instead of stretching to fill.

## 5. Update the docs in the same change

- Add the new file pair to `README.md`'s file inventory list and, if it
  needs any, its Script Properties section (prefixed `<TOOLNAME>_*`).
- Add an entry to `AS_BUILT.md`'s file inventory / data model sections if
  the change is substantial enough to warrant it.
- If porting, note any intentional behavior deviation from the source app
  under README's "Known intentional deviations" — don't let a silent
  change go undocumented, even a small one.

## Common pitfalls specific to this shell

These aren't tool-addition-specific, but every past tool has hit at least
one — check `CLAUDE.md`'s "Non-negotiables" and README's "Hard-won
gotchas" before writing UI code: no native `alert()`/`confirm()`, no
`innerHTML` for script-bearing content, escape any sheet/API string before
interpolating into HTML, don't build "today" via `.toISOString()`.
