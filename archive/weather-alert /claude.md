# Weather Alert Tool — Project Memory

Google Apps Script project (Sheet-bound + standalone web app) for sending weather alerts to on-road Wilderness guests via SendGrid email and HubSpot WhatsApp.

## Architecture

- **Sheet-bound dialog** (`Index.html` + `WeatherAlert.gs`) — opened via a custom menu in the booking spreadsheet, visible only to approved senders. No deployment needed; always runs latest saved code.
- **Standalone web app** (`WebApp.html` + `WebApp.gs` + `WeatherAlert.gs`) — deployed separately with its own URL. **Must be redeployed to a new version after every code change** — unlike the Sheet dialog, web app deployments are pinned to a version and silently run stale code otherwise.
- All business logic lives in the `WeatherAlert` constructor in `WeatherAlert.gs`. Functions inside are private (`const fn = () => {}`); only `this.method = () => {}` assignments are public. Global top-level functions are thin one-line wrappers that exist solely because Apps Script's menu system and `google.script.run` require global scope — they all just do `new WeatherAlert().method()`.

## Critical gotchas (hard-won, don't relitigate)

1. **`google.script.run` silently drops `false` boolean arguments.** If a function parameter has a default value (e.g. `sendEmail = true`) and the client passes `false`, the server receives `undefined`, which falls through to the default — making it look like the value was always `true`. **Workaround in place:** client passes `1`/`0` integers instead of booleans; server coerces with `!!value`. Do not revert this to plain booleans.

2. **Web app deployments are versioned and do not auto-update.** After any code change intended for the web app, go to **Deploy → Manage deployments → edit → Version: New version → Deploy**. The Sheet dialog does not have this problem.

3. **SendGrid template tokens use triple braces** (`{{{alertBody}}}`) not double (`{{alertBody}}`), because `alertBody` contains `<br>` HTML that must render unescaped. `subject` and `firstName` don't strictly need triple braces but are kept consistent. The preview renderer (`renderTemplate`) matches `{2,3}` braces on either side to handle both styles safely.

4. **Template variable names are camelCase**, matching the `{ subject, firstName, alertBody }` shape used by `dynamic_template_data` in the SendGrid payload. Do not reintroduce snake_case (`alert_body`, `firstname`) — this was deliberately changed.

5. **Two separate auth mechanisms, do not conflate:**
   - HubSpot (WhatsApp enrollment only) → `WildernessAppScriptLibrary.getWildernessHubSpotAuthorizationBearer()` — no API key in Script Properties.
   - SendGrid (email + template preview) → `SENDGRID_API_KEY` in Script Properties, needs **both** `mail.send` and `templates.read` scopes. A key with only `mail.send` will 403 on template fetch/preview even though sending still works.

6. **WhatsApp enrollment uses the HubSpot v2 API**, one contact at a time by email (`POST /automation/v2/workflows/{id}/enrollments/contacts/{email}`), not v4. The v4 "flows" endpoint does not support enrollment this way. `HUBSPOT_WHATSAPP_FLOW_ID` must be the **v2 numeric ID** — fetch via `GET /automation/v2/workflows` and match by name if the workflow was created in the newer builder, since the URL-visible ID may be a v4-only ID that 404s against v2.

7. **No caching on `getTemplateHtml()`.** Caching was tried and removed — it caused the preview to show stale template content right after a template edit, which is worse than the minor API call overhead. Do not reintroduce caching here without an explicit invalidation mechanism.

8. **Daily lock and approved-sender checks are enforced server-side**, not just by hiding UI. `triggerWeatherAlert()` independently checks `APPROVED_SENDERS` and `alreadySentToday()` regardless of what the client sends — this is intentional defence in depth, not redundant.

## Script Properties reference

| Property | Required | Notes |
|---|---|---|
| `HUBSPOT_WHATSAPP_FLOW_ID` | Yes | v2 numeric ID, see gotcha #6 |
| `SENDGRID_API_KEY` | Yes | needs `mail.send` + `templates.read` |
| `SENDGRID_TEMPLATE_ID` | Yes | starts with `d-` |
| `FROM_EMAIL` | Yes | must be a SendGrid verified sender |
| `FROM_NAME` | No | display name |
| `TEST_MODE` | No | `"true"` restricts sends to `@wilderness.co.nz` |
| `APPROVED_SENDERS` | Yes | comma-separated, gates menu + web app + server-side send |
| `OVERRIDE_EMAILS` | No | comma-separated, can reset daily lock |
| `CONFIRMATION_CC` | No | comma-separated, CC'd on post-send summary |
| `BCC_EMAIL` | No | comma-separated, BCC'd on real sends only (never test sends) |

## Things deliberately NOT done (don't re-add without discussion)

- No localStorage/sessionStorage anywhere — not supported in this context, and not needed since Apps Script properties + sheet state cover persistence.
- No rich text editor for the alert body — plain textarea with `\n` → `<br>` conversion is intentional, keeps it simple for the team leader.
- Test sends (`sendTestEmail`) never touch the daily lock, audit log, or BCC list — this is intentional isolation, not an oversight.
- `previewEmail` never sends anything — it renders the live template locally via `renderTemplate()` against fetched HTML, no SendGrid send call involved.

## Coding conventions for this project

- Arrow functions + `const`/`let`, template literals, optional chaining, destructuring — modern syntax throughout, no `var`, no `function` declarations inside the constructor (only at module/global level where Apps Script requires it).
- One isolated, evidence-backed change at a time. Confirm via the Apps Script execution log or a test send before stacking further changes.
- Full file output after every change — no partial diffs.
- JS in `.html` files is validated with `acorn --ecma2020` after every edit before considering a change complete.

## Debug functions (left in intentionally, not dead code)

- `debugConfirmationEmail()` — isolates MailApp send issues from template/data issues.
- `debugSendGridTemplate()` — checks actual granted scopes via `/v3/scopes`, tests the template fetch directly, and lists all templates visible to the key. Use this first for any SendGrid 403.

Run these directly from the Apps Script editor (function dropdown → select → Run), then check **Execution log** or **View → Executions**.