---
name: gas-ui
description: >
  Design system and UI patterns for Google Apps Script (GAS) web apps. Use this skill
  whenever the user asks to build, create, update, or add features to a Google Apps Script
  web app, HTML frontend, or any UI served via doGet(). Also use when the user mentions
  GAS, Apps Script, Index.html for a script project, or wants a web interface connected
  to Google Sheets or any external API. Always use this skill for any new GAS UI work —
  it defines the house style, component patterns, backend conventions, and data-passing
  rules that must be consistent across all projects.
---

# GAS UI Design System — Wilderness Brand

This skill defines the standard UI, backend patterns, and data-passing rules used across
all Google Apps Script web app projects for Wilderness Motorhomes. Follow every section
exactly unless the user explicitly overrides a specific item.

---

## Visual Design System

### Fonts
```html
<link href="https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@300;400;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
```
- **Body / UI:** `Nunito Sans` — weights 300, 400, 600, 700 (closest match to brand's custom Averta font)
- **Code / labels / badges / monospaced data:** `IBM Plex Mono` — weights 400, 500

### Colour Palette (CSS variables — always declare in `:root`)
```css
:root {
  /* Wilderness exact brand palette */
  --bg:        #faf7f2;   /* warm off-white — their exact page background */
  --surface:   #ffffff;
  --surface2:  #f0ede8;   /* hover/table rows */
  --border:    #ddd9d0;   /* primary borders */
  --border2:   #ccc8be;   /* secondary/input borders */
  --accent:    #006388;   /* primary brand blue */
  --accent2:   #0088bb;   /* accent hover */
  --accent3:   #e8f3f7;   /* light blue tint for badges/backgrounds */
  --green:     #67b65b;   /* CTA green — used for primary buttons */
  --green2:    #509a44;   /* green hover */
  --navy:      #263450;   /* dark navy — sidebar, modal headers, table headers */
  --danger:    #c0392b;
  --danger2:   #e74c3c;
  --success:   #67b65b;   /* same as --green */
  --warn:      #d68910;
  --paused:    #7d6ca0;
  --text:      #323232;   /* their exact body text colour */
  --muted:     #5b5b5b;   /* secondary text */
  --light:     #909090;   /* tertiary text, timestamps */
  --mono:      'IBM Plex Mono', monospace;
  --sans:      'Nunito Sans', sans-serif;
}
```

### Key Colour Rules
- **`--accent` (`#006388`)** — links, focus rings, badges, form section titles, log issue keys
- **`--green` (`#67b65b`)** — ALL primary action buttons (`btn-primary`), success toasts, active status chips, trigger dot
- **`--navy` (`#263450`)** — sidebar background, table `thead`, modal headers, drawer headers
- **`--bg` (`#faf7f2`)** — page background, form inputs, log entry cards
- Never use the dark theme palette from previous projects

### Layout
- Two-column shell: `270px sidebar | 1fr main`
- Sidebar is sticky, full viewport height, `overflow: hidden`, background `var(--navy)`
- Main has a sticky topbar + scrollable content area with `padding: 32px 36px`
- Grid: `display: grid; grid-template-columns: 270px 1fr; min-height: 100vh`

### Sidebar Structure
```
Brand block (label + icon + title + sub)
Nav items (icon + label buttons)
Footer (trigger/status badge)
```
- Sidebar background: `var(--navy)`
- Nav item active state: `background: var(--accent)` with white text
- Nav item hover: `rgba(255,255,255,.08)` background
- All sidebar text: white or `rgba(255,255,255,.6)` for inactive items

### Topbar
Sticky, `background: var(--surface)`, `border-bottom: 1px solid var(--border)`, `box-shadow: 0 1px 4px rgba(0,0,0,.06)`.
Contains page title (left) and primary action button (right).

---

## Component Patterns

### Buttons
| Class | Use |
|---|---|
| `.btn.btn-primary` | Primary action — `var(--green)` background, `2px solid var(--green)` border, white text, uppercase |
| `.btn.btn-ghost` | Secondary — transparent, `var(--accent)` text and border; hover fills accent |
| `.btn-icon` | Icon-only table actions — transparent, hover shows surface2 |
| `.btn-icon.danger` | Destructive — red on hover |
| `.btn-icon.warn` | Warning (e.g. pause) — amber on hover |
| `.btn-icon.success` | Positive (e.g. resume, run now) — green on hover |

All `.btn` share:
```css
.btn {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 10px 20px; border-radius: 4px; border: none;
  font-family: var(--sans); font-size: 13px; font-weight: 700;
  cursor: pointer; transition: all .15s;
  text-transform: uppercase; letter-spacing: .25px;
}
```

Primary button hover: `background: var(--green2)`, `transform: translateY(-1px)`, green box shadow.

### Forms
- `.form-card`: white surface, 1px border, 6px radius, `padding: 30px 34px`, `max-width: 680px`, subtle box-shadow
- `.form-section-title`: mono font, 10px, uppercase, `var(--accent)` colour, border-bottom separator
- `.field label`: 12px, 700 weight, uppercase, `var(--muted)` colour
- Inputs/selects: `background: var(--bg)`, `border: 2px solid #ccc`, 4px radius; focus shows `border-color: var(--green)`
- `.inline-pair`: `grid-template-columns: 100px 1fr` for number + unit combos

### Tables
- Wrapped in `.table-wrap`: white surface, 1px border, 6px radius, `overflow:hidden`, box-shadow
- `thead` uses `var(--navy)` background with `rgba(255,255,255,.65)` text
- `th`: mono font, 10px, uppercase, letter-spacing
- `td`: 13-14px sans, `border-bottom: 1px solid var(--border)`, last row has no border
- Row hover: `rgba(0,99,136,.03)` background on `td`
- Paused/inactive rows: `opacity: 0.55` via `.paused-row` class on `<tr>`

### Badges & Chips
- `.badge`: pill, mono 11px, `var(--accent3)` bg, `var(--accent)` text, accent border — for counts
- `.dept-chip`: inline-block, surface2 bg, border, mono 11px, muted text — for category tags
- `.status-chip.active`: green pill — `rgba(103,182,91,.1)` bg, `var(--green2)` text
- `.status-chip.paused`: purple pill — `rgba(125,108,160,.1)` bg, `var(--paused)` text

### Status indicators
```javascript
function nextDueClass(val, paused) {
  if (paused) return 'paused';           // --paused (purple)
  if (!val) return '';
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = (new Date(val) - today) / 86400000;
  if (diff < 0)  return 'overdue';      // --danger
  if (diff <= 7) return 'soon';         // --warn
  return 'ok';                          // --green
}
```

### Toast Notifications
Fixed bottom-right, stacked, `z-index: 9999`. Types: default (`var(--accent)` left border), `success` (green), `error` (red).
Auto-dismiss after 4.5 seconds. Animate in with `slideIn` keyframe.
Background: `var(--surface)`, border: `1px solid var(--border)`.

### Confirm Modal (ALWAYS use instead of browser alert/confirm)
Never use `window.confirm()` or `alert()`. Always use the custom confirm modal.

```javascript
showConfirm({
  title: 'Action Title',
  message: 'Descriptive explanation of what will happen.',
  okLabel: 'Confirm',
  type: 'danger'  // 'danger' | 'warn' | 'success'
}, function() {
  // callback — runs only if user clicks confirm
});
```

Types map to colours:
- `danger` — red icon + button
- `warn` — amber icon + button
- `success` — green (`var(--green)`) icon + button

Modal footer background: `var(--surface2)`. Confirm button is auto-focused.

### Edit Modal
- `.modal-backdrop`: fixed inset, `rgba(38,52,80,.55)` overlay (navy-tinted), flex centre
- `.modal`: white surface, 6px radius, max 560px wide, navy modal header
- `.modal-header`: `background: var(--navy)`, white title text, white × close button
- `.modal-footer`: `background: var(--surface2)`
- Close on backdrop click, × button, and Escape key

### Drawer (for history/detail side panels)
- Slides in from the right: `position:fixed; right:-640px` → `right:0` on `.open`
- `width: 620px`, full viewport height, `transition: right .25s cubic-bezier(.4,0,.2,1)`
- `.drawer-header`: `background: var(--navy)`, white text, navy-tinted backdrop
- `.drawer-body`: scrollable, `padding: 20px 24px`
- Log entries: `.log-entry` cards, `background: var(--bg)` (warm off-white), 5px radius
- Log issue keys: `var(--accent)` colour, bold, linked to Jira

### Loading States
```html
<div class="spinner"></div>
```
```css
.spinner {
  width: 16px; height: 16px;
  border: 2px solid rgba(0,99,136,.2);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin .7s linear infinite;
}
```

### Empty States
```html
<div class="empty-state">
  <div class="icon">📋</div>
  <p>Descriptive message</p>
  <small>Helper hint.</small>
</div>
```
Centred, `var(--light)` text, emoji icon, padding 64px.

### Inline Editing
For fields that can be edited in-place (e.g. next run date):
- Show value with small ✎ button next to it
- Clicking toggles `.next-run-edit` div `display:none` → `display:flex`
- Contains: date input (accent border on focus) + Save link + Cancel link
- Never open a full modal for single-field overrides

---

## Google Apps Script Backend Conventions

### File Structure
Every project has exactly three files:
| File | Purpose |
|---|---|
| `Code.gs` | All server-side logic: doGet, CRUD, API calls, triggers |
| `Config.gs` | All environment variables and constants in a single `CONFIG` object |
| `Index.html` | Single-file frontend — HTML + `<style>` + `<script>` |

`Config.gs` is always in `.gitignore`. A `Config.example.gs` with placeholder values is committed instead.

### Config Pattern
```javascript
const CONFIG = {
  SHEET_ID: 'YOUR_SHEET_ID',
  // ... all other config
};
```
All magic strings and credentials live here. Never hardcode them in `Code.gs`.

### doGet
```javascript
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('App Title')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
```

### Google Sheets as Database
- Use a named sheet (e.g. `'Schedules'`)
- Auto-create the sheet with headers on first run inside `getSheet_()`
- Row 1 = headers (frozen, bold)
- Private helper functions use trailing underscore: `getSheet_()`, `rowToObject_()`
- Soft-delete pattern: set an `Active` column to `'FALSE'` rather than deleting rows
- Pause pattern: set `Active` to `'PAUSED'` — distinct from `'TRUE'` (active) and `'FALSE'` (deleted)

### Record States (Active column)
| Value | Meaning |
|---|---|
| `'TRUE'` | Active — processed by triggers |
| `'PAUSED'` | Paused — skipped by triggers, resumable |
| `'FALSE'` | Deleted — hidden from UI, never processed |

Always check for both string and boolean in trigger loops:
```javascript
if (row[10] !== 'TRUE' && row[10] !== true) continue; // skip non-active
```

### CRITICAL — Data Passing via google.script.run
`google.script.run` **cannot serialise Date objects**. If any Date object reaches the
return value, GAS silently returns `null` to the frontend with no error.

**Always convert dates to strings before returning from any server function:**
```javascript
function toStr(val) {
  if (!val || val === '') return '';
  if (val instanceof Date) return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(val);
}
```
Apply `toStr()` to every field in `rowToObject_()`. Cast numeric fields with `Number()`.

### Logging Convention
Every function logs entry with its name and key parameters:
```javascript
Logger.log('[functionName] Descriptive message: %s', value);
```
Errors always log the full message:
```javascript
Logger.log('[functionName] ERROR: %s', e.message);
```

### Time-Based Triggers
Install/uninstall via named functions (`installDailyTrigger`, `uninstallDailyTrigger`).
Always remove existing triggers for the same handler before creating a new one.
Show trigger status in the sidebar footer with a green pulsing dot when active.

### Creation Log Sheet
All automated or manual actions that create external records should be logged to a
`Creation Log` sheet with columns:
`Timestamp | Issue/Record Key | URL | Name | Department | Due Date | Schedule ID | Recurs Every | Triggered By`

`Triggered By` values: `'Daily Trigger'` or `'Manual Run'` — shown with different colours in the UI.

---

## Frontend JS Conventions

### Initialisation
```javascript
document.getElementById('startDate').valueAsDate = new Date();
loadData();
loadDepartments();
loadTriggerStatus();
```

### google.script.run Pattern
Always use `.withSuccessHandler` + `.withFailureHandler`. Show spinner on button during
async calls. Re-enable button in both handlers.
```javascript
const btn = document.getElementById('saveBtn');
btn.disabled = true;
btn.innerHTML = '<div class="spinner"></div> Saving…';

google.script.run
  .withSuccessHandler(function(result) {
    btn.disabled = false;
    btn.textContent = 'Save';
    if (result && result.error) { toast(result.error, 'error'); return; }
    toast('Saved successfully.', 'success');
  })
  .withFailureHandler(function(e) {
    btn.disabled = false;
    btn.textContent = 'Save';
    toast('Failed: ' + e.message, 'error');
  })
  .serverFunction(payload);
```

### Confirm Before Destructive Actions
Always wrap destructive or significant actions in `showConfirm()` before calling the server.
Disable the triggering button immediately so it can't be double-clicked.

```javascript
function deleteItem(id, btn) {
  btn.disabled = true;
  showConfirm({
    title: 'Delete Item',
    message: 'This cannot be undone.',
    okLabel: 'Delete',
    type: 'danger'
  }, function() {
    google.script.run
      .withSuccessHandler(...)
      .withFailureHandler(...)
      .deleteItem(id);
  });
}
```

### HTML Escaping
Always escape user-generated content before inserting into innerHTML:
```javascript
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
```

### Panel Navigation
Panels are `display:none` / `display:block` toggled by a `showPanel(name)` function.
Nav items and panels share the same name key. Active state managed by adding/removing `.active` class.

### Date Formatting
```javascript
function formatDate(val) {
  if (!val) return '—';
  const d = new Date(val);
  if (isNaN(d)) return val;
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(val) {
  if (!val) return '—';
  const d = new Date(val);
  if (isNaN(d)) return val;
  return d.toLocaleString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
```
Always use `en-NZ` locale.

### Escape Key Handler
Always close all overlays on Escape:
```javascript
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeDrawer();
    closeConfirm();
    document.getElementById('editModalBackdrop').classList.remove('open');
  }
});
```

---

## Responsive
- Below 700px: hide sidebar, single column layout, reduce content padding
- Drawers go full-width on mobile

---

## What to Reuse vs What to Adapt

**Always reuse exactly:**
- CSS variables / full colour palette
- Font choices (Nunito Sans + IBM Plex Mono)
- Button classes, styles and uppercase convention
- Form field styles (2px borders, green focus, warm bg)
- Table structure with navy thead
- Navy sidebar and navy modal/drawer headers
- Toast system
- Confirm modal (never use browser `confirm()`)
- Spinner (accent-coloured border-top)
- `escHtml`, `formatDate`, `formatDateTime`, `nextDueClass` utilities
- `google.script.run` async pattern
- `toStr()` / Date serialisation pattern
- Logger conventions
- Record state pattern (TRUE / PAUSED / FALSE)

**Adapt per project:**
- Number and names of nav items
- Panels / page sections
- Which modals or drawers are needed
- Sheet column structure
- Config keys
- Specific API integrations
- Creation log column names