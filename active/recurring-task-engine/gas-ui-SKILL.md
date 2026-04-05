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

# GAS UI Design System

This skill defines the standard UI, backend patterns, and data-passing rules used across
all Google Apps Script web app projects. Follow every section exactly unless the user
explicitly overrides a specific item.

---

## Visual Design System

### Fonts
```html
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
```
- **Body / UI:** `IBM Plex Sans` — weights 300, 400, 500, 600
- **Code / labels / badges / monospaced data:** `IBM Plex Mono` — weights 400, 500, 600

### Colour Palette (CSS variables — always declare in `:root`)
```css
:root {
  --bg:        #0d0f12;   /* page background */
  --surface:   #151820;   /* cards, sidebar, topbar */
  --surface2:  #1c2030;   /* table headers, hover states, nested surfaces */
  --border:    #272d3d;   /* primary borders */
  --border2:   #333b52;   /* secondary/input borders */
  --accent:    #4f7fff;   /* primary interactive colour */
  --accent2:   #7ba3ff;   /* hover / lighter accent */
  --danger:    #ff4d4d;
  --danger2:   #ff7070;   /* danger hover */
  --success:   #2ecc71;
  --warn:      #f0a500;
  --paused:    #9b6dff;   /* paused/suspended state */
  --text:      #dce3f0;   /* primary text */
  --muted:     #6b7896;   /* secondary text, labels */
  --mono:      'IBM Plex Mono', monospace;
  --sans:      'IBM Plex Sans', sans-serif;
}
```

### Layout
- Two-column shell: `260px sidebar | 1fr main`
- Sidebar is sticky, full viewport height, `overflow: hidden`
- Main has a sticky topbar + scrollable content area with `padding: 32px`
- Grid: `display: grid; grid-template-columns: 260px 1fr; min-height: 100vh`

### Sidebar Structure
```
Brand block (logo label + title)
Nav items (icon + label buttons)
Footer (trigger/status badge)
```
Nav items use `rgba(79,127,255,.12)` background + `var(--accent2)` text when active.

### Topbar
Sticky, `background: var(--surface)`, `border-bottom: 1px solid var(--border)`.
Contains page title on the left, primary action button on the right.

---

## Component Patterns

### Buttons
| Class | Use |
|---|---|
| `.btn.btn-primary` | Primary action — accent background |
| `.btn.btn-ghost` | Secondary / cancel — transparent with border |
| `.btn-icon` | Icon-only table actions — transparent, hover shows background |
| `.btn-icon.danger` | Destructive icon action — red on hover |
| `.btn-icon.warn` | Warning action (e.g. pause) — amber on hover |
| `.btn-icon.success` | Positive action (e.g. resume, run now) — green on hover |

All `.btn` share: `display:inline-flex; align-items:center; gap:7px; border-radius:6px; font-family:var(--sans); font-weight:500; transition:all .15s`

### Forms
- `.form-card`: surface background, 1px border, 10px radius, `padding: 28px 32px`, `max-width: 680px`
- `.form-section-title`: mono font, 10px, uppercase, accent colour, border-bottom separator
- `.field`: flex column with 7px gap; label is 12px muted
- Inputs/selects: `background: var(--bg)`, border2 border, 6px radius, focus shows accent border + shadow
- `.inline-pair`: `grid-template-columns: 100px 1fr` for number + unit combos

### Tables
- Wrapped in `.table-wrap`: surface bg, 1px border, 10px radius, `overflow:hidden`
- `thead` uses `var(--surface2)` background
- `th`: mono font, 10px, uppercase, letter-spacing, muted colour
- `td`: 13-14px sans, `border-bottom: 1px solid var(--border)`, last row has no border
- Row hover: `rgba(255,255,255,.018)` background on `td`
- Paused/inactive rows: `opacity: 0.55` via `.paused-row` class on `<tr>`

### Badges & Chips
- `.badge`: pill shape, mono 11px, `rgba(79,127,255,.1)` bg, accent2 text — for counts
- `.dept-chip`: inline-block, surface2 bg, border2 border, mono 11px, muted text — for category tags
- `.status-chip.active`: green pill — `rgba(46,204,113,.1)` bg, success text
- `.status-chip.paused`: purple pill — `rgba(155,109,255,.1)` bg, paused text

### Status indicators
```javascript
function nextDueClass(val, paused) {
  if (paused) return 'paused';           // --paused (purple)
  if (!val) return '';
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = (new Date(val) - today) / 86400000;
  if (diff < 0)  return 'overdue';      // --danger2
  if (diff <= 7) return 'soon';         // --warn
  return 'ok';                          // --success
}
```

### Toast Notifications
Fixed bottom-right, stacked, `z-index: 9999`. Types: default (accent left border), `success`, `error`.
Auto-dismiss after 4.5 seconds. Animate in with `slideIn` keyframe.

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
- `danger` — red icon + button (deletes, irreversible actions)
- `warn` — amber icon + button (pause, caution actions)
- `success` — green icon + button (run now, positive actions)

Modal structure: centred icon → title → message → Cancel + Confirm buttons.
Closes on Cancel, Escape key, or Confirm. Confirm button is auto-focused.

### Edit Modal (for editing records)
- `.modal-backdrop`: fixed inset, `rgba(0,0,0,.65)` overlay, flex centre, `z-index: 100`
- `.modal`: surface bg, 12px radius, max 560px wide, scrollable, `modalIn` animation
- Structure: `.modal-header` | `.modal-body` | `.modal-footer`
- Close on backdrop click (check `e.target === backdrop`), × button, and Escape key

### Drawer (for history/detail side panels)
- Slides in from the right: `position:fixed; right:-640px` → `right:0` on `.open`
- `width: 620px`, full viewport height, `transition: right .25s cubic-bezier(.4,0,.2,1)`
- Separate `.drawer-backdrop` div handles the overlay click-to-close
- Structure: `.drawer-header` (title + sub + close) | `.drawer-body` (scrollable)
- Log entries use `.log-entry` cards with grid layout: content left, date right, timestamp full-width below

### Loading States
```html
<div class="spinner"></div>
```
```css
.spinner { width:16px; height:16px; border:2px solid rgba(255,255,255,.2); border-top-color:#fff; border-radius:50%; animation:spin .7s linear infinite; }
```
Use inline in buttons when saving, and in table `<td>` while fetching data.

### Empty States
```html
<div class="empty-state">
  <div class="icon">📋</div>
  <p>Descriptive message</p>
  <small>Helper hint.</small>
</div>
```
Centred, muted text, emoji icon, padding 60px.

### Inline Editing
For fields that can be edited in-place (e.g. a date field in a table row):
- Show the value with a small ✎ icon button next to it
- Clicking toggles a `.next-run-edit` div with `display:none` → `display:flex`
- Contains: date input + Save link + Cancel link
- Save calls the server function, Cancel hides the editor
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
Private/internal functions (trailing `_`) also log but can be terser.

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
Disable the triggering button immediately (before the confirm) so it can't be double-clicked.

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
- CSS variables / colour palette (including `--paused`)
- Font choices (IBM Plex Sans + Mono)
- Button classes and styles
- Form field styles
- Table structure and styles
- Toast system
- Confirm modal (never use browser `confirm()`)
- Spinner
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
