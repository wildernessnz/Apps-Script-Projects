# Phase 0 — Foundation

Drop these files into the new standalone Apps Script project (via `clasp push`
or pasted directly into the Apps Script editor).

## Files
- `appsscript.json` — manifest: merged scopes from all 4 tools, `WildernessAppScriptLibrary`
  dependency, standalone web app config (`USER_ACCESSING` / `DOMAIN`)
- `Config.gs` — the 4 spreadsheet IDs (`SHEET_IDS`) + sidebar nav structure (`NAV_CONFIG`)
- `WebApp.gs` — `doGet()` entry point + `include()` templating helper
- `Shell.html` — sidebar + content-area layout, built entirely from `NAV_CONFIG`
- `Styles.html` — design tokens ported from the design system CSS + shell layout styles
- `Router.html` — client-side nav click handling + content swap (no full page reload)
- `ContentLoader.gs` — server functions the router calls (`getToolContent`,
  `getToolContentForNavId`); returns a placeholder for any tool not yet built
- `Placeholder.html` — "coming soon" stub shown for unmigrated tools

## What this gets you
Push these files and deploy as a web app — you'll get a working shell with all
4 tools in the sidebar, each showing a placeholder except whichever you flip
`false` in `ContentLoader.gs`'s `PLACEHOLDER_PARTIALS` once its real partial
exists. This is deliberately runnable end-to-end *before* any tool logic is
ported, so the shell/nav/routing pattern gets validated on its own.

## Open decisions before Phase 1

1. **Averta font** — not embedded yet. `Styles.html` falls back to system-ui.
   Options: (a) base64-embed the 3 .otf weights directly in the CSS (~870KB,
   simplest, no external hosting, one-time load), or (b) host WOFF2 versions
   somewhere reachable (Drive public file, or elsewhere) and `@font-face` from
   a URL. Your call — (a) is more self-contained, (b) is a smaller payload.
2. **Logo URL** — `Shell.html` currently points at `https://wilderness.co.nz/logo.svg`
   as a placeholder. Swap for wherever the actual brand logo should be served
   from (the design file's `assets/logo.svg` will need real hosting too, same
   question as the fonts).
3. **Icons** — nav items reference icon names (`alert-triangle`, `calendar`,
   `ferry`, `clock`) via `data-icon` but no icon set is wired in yet. Fine to
   defer until Phase 1 once we know whether you want inline SVGs (matches the
   design system exactly) or an icon font/library.

None of these block Phase 1 — Booking Finder doesn't depend on any of them.
