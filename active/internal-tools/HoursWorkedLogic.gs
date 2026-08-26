/**
 * @fileoverview Hours Worked — shows each team member's actual hours logged
 * for the current PayHero pay-cycle fortnight, across the four operational
 * teams (Adventure Support, Parts & Warranty, Detailing, Workshop).
 *
 * Reads three tabs from the "PayHero Hours Worked" spreadsheet
 * (SHEET_IDS.HOURS_WORKED in Config.gs) — "Linked - Employees", "Linked -
 * PayHero Time" and "Linked - Operations Pay Cycle" — never writes to it.
 * That spreadsheet (created 2026-08-27, a dedicated copy of the same
 * three tabs "PayHero Visibility" already had, without its other unused
 * tabs) is itself fed by IMPORTRANGE from a separate "PayHero Integration"
 * spreadsheet, which is populated by an existing scripts@wilderness.co.nz-
 * owned Apps Script pulling from the PayHero API on its own schedule —
 * that upstream pipeline is left untouched, same "leave trigger jobs on
 * the original project" pattern as every other tool here (see README
 * "Still open / deferred" #1). This tool only ever reads the `duration`
 * column of the time tab — never `external_pay_rate` or any other payroll
 * field, which is present in the same sheet but deliberately never
 * selected — satisfying the no-payroll-data requirement structurally
 * rather than by filtering it out downstream.
 *
 * Ported from the original "PayHero Visibility" spreadsheet's "Hours
 * Worked" tab (a VLOOKUP
 * against a "Report" tab's per-employee SUMIFS matrix), including its
 * rostered-days/rostered-hours target comparison (kept per Mark's
 * explicit request — an earlier pass had dropped it, then restored it
 * exactly as original). Rostered days (9 or 10) and rostered hours are
 * independent manual entries in the original — not derived from each
 * other, and not tied to any real roster data — so this server only ever
 * computes and returns *actual* hours (days/hours worked, per-day
 * breakdown). The two rostered inputs and every field derived from them
 * (Rostered hours/day, Days left, Hours/day remaining, Total hours
 * remaining) are pure client-side arithmetic in HoursWorked.html, same as
 * the original spreadsheet's own live formula recalculation — see that
 * file's recomputeRostered(). Defaults to 10 rostered days (not persisted
 * server-side; each page load starts fresh, unlike the original's sticky
 * spreadsheet cell).
 *
 * Team membership: PayHero's own `team_name` field splits Adventure
 * Support, Detailing and Workshop by site (AK/CC prefix) but keeps Parts &
 * Warranty as one combined team — confirmed against the live "Linked -
 * Employees" data, not guessed. HOURS_WORKED_TEAMS_ merges each pair of
 * site teams under one selectable team, matching the original tool's own
 * `contains 'Adventure Support Team'` substring match (which already
 * merged AK+CC for that one team) and the ticket's four named teams.
 *
 * Pay-cycle boundaries: read directly from "Linked - Operations Pay
 * Cycle" — the exact same source the original "Hours Worked" tab's
 * `VLOOKUP(1, ...)` used — rather than computed from an anchor date, so
 * this stays authoritative if that sheet's cycle definition ever changes.
 * Every cycle is a 14-day window with exactly one row flagged "Current
 * Cycle" = 1 at any time (confirmed against live data).
 *
 * Performance: "Linked - PayHero Time"/"Linked - Employees"/"Linked -
 * Operations Pay Cycle" are all IMPORTRANGE-fed — some two hops removed
 * from their real source — so Google Sheets has to resolve/recalculate
 * those formulas fresh on every read, which is slow (seconds, not
 * milliseconds) regardless of how little of the sheet Apps Script asks
 * for. Two mitigations, both added 2026-08-28:
 * (1) `readTimeRows_()` reads only the 3 columns actually used
 *     (employee_key/time_date/duration) off the ~2,200+-row, 27-column
 *     Time tab via individual `getRange()` calls instead of
 *     `getDataRange()` pulling all 27 — cuts the data Apps Script has to
 *     marshal back, though it doesn't touch the IMPORTRANGE recalc cost
 *     itself, which is the larger share.
 * (2) `getTeamsAndMembers()` (the page-load call that populates both
 *     dropdowns) is now cached via `CacheService` for
 *     HOURS_WORKED_CACHE_TTL_SECONDS_ (15 min), with
 *     `refreshHoursWorkedTeamsCache()` as a time-driven-trigger target
 *     that recomputes and re-caches proactively every 10 minutes — so a
 *     live page load only ever waits on the slow read if the trigger
 *     isn't installed or hasn't run yet, not as routine behavior. The
 *     trigger itself is NOT installed automatically — run
 *     `installHoursWorkedRefreshTrigger()` once from the Apps Script
 *     editor (Run menu) to set it up; it no-ops safely if already
 *     installed. `getFortnight()` (the per-member detail view) is
 *     deliberately NOT cached — it's a one-off lookup per click, not a
 *     shared page-load cost, and staleness there would be more visible
 *     to whoever's specifically checking that one person's hours.
 *
 * Access: gated for the moment behind HOURS_WORKED_ALLOWLIST (comma-
 * separated emails, same pattern as Weather Alert's
 * WEATHER_ALERT_APPROVED_SENDERS) — added 2026-08-28 at Mark's request,
 * ahead of a longer-term access-model decision. Until that property is
 * set, the allowlist is empty and nobody passes isHoursWorkedApproved(),
 * including Mark himself — set it before expecting anyone to get in.
 *
 * Script Properties: HOURS_WORKED_ALLOWLIST (see "Access" above).
 */

const HOURS_WORKED_SHEET_KEY = 'HOURS_WORKED';
const HOURS_WORKED_EMP_TAB   = 'Linked - Employees';
const HOURS_WORKED_TIME_TAB  = 'Linked - PayHero Time';
const HOURS_WORKED_CYCLE_TAB = 'Linked - Operations Pay Cycle';

const HOURS_WORKED_TEAMS_ = [
  { id: 'adventure-support', label: 'Adventure Support', teamNames: ['AK Adventure Support Team', 'CC Adventure Support Team'] },
  { id: 'parts-warranty',    label: 'Parts & Warranty',   teamNames: ['Parts & Warranty'] },
  { id: 'detailing',         label: 'Detailing',          teamNames: ['AK Detailing', 'CC Detailing'] },
  { id: 'workshop',          label: 'Workshop',           teamNames: ['AK Workshop Team', 'CC Workshop Team'] },
];

const HOURS_WORKED_CYCLE_DAYS_ = 14;

// employee_key 334888 is "LOGIN STATION" in "Linked - Employees" — a shared
// kiosk/login account, not a real person (confirmed against live data,
// 2026-08-27). The original tool's own team-roster QUERY excluded this
// same ID by hand for the same reason; this port does too.
const HOURS_WORKED_EXCLUDED_KEYS_ = ['334888'];

const HOURS_WORKED_CACHE_KEY_          = 'HOURS_WORKED_TEAMS_CACHE';
const HOURS_WORKED_CACHE_TTL_SECONDS_  = 900; // 15 min — longer than the 10-min refresh trigger, so a slightly-late trigger run doesn't let the cache go cold

/**
 * Used by ContentLoader.gs to gate this tool's content behind
 * HOURS_WORKED_ALLOWLIST before the sidebar-shared shell renders it —
 * same pattern as isWeatherAlertApproved().
 * @returns {boolean}
 */
function isHoursWorkedApproved() {
  const email = Session.getActiveUser().getEmail()?.toLowerCase() || '';
  const props = PropertiesService.getScriptProperties();
  const approved = (props.getProperty('HOURS_WORKED_ALLOWLIST') ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return approved.includes(email);
}

// ── Entry points — the only things exposed to google.script.run ────────────
// getTeamsAndMembers() is a single read-only lookup with no side effect
// (same convention as Weather Alert's getGuestPreview()) — not logged; it
// returns every team's member list in one call so the client never needs a
// round trip just to switch the team dropdown. Viewing a member's
// fortnight is this tool's one primary action, logged on both the success
// and error path.

function getHoursWorkedTeamsAndMembers() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(HOURS_WORKED_CACHE_KEY_);
  if (cached) return JSON.parse(cached);

  const result = new HoursWorked().getTeamsAndMembers();
  cache.put(HOURS_WORKED_CACHE_KEY_, JSON.stringify(result), HOURS_WORKED_CACHE_TTL_SECONDS_);
  return result;
}

function getHoursWorkedFortnight(teamId, employeeKey) {
  const r = new HoursWorked().getFortnight(teamId, employeeKey);
  logEvent_('Hours Worked: View', r.error
    ? `error=${r.error}`
    : `team=${teamId} | employeeKey=${employeeKey} | member=${r.memberName} | hoursWorked=${r.hoursWorked}`);
  return r;
}

/**
 * Time-driven-trigger target — recomputes the teams/members cache ahead
 * of time so live page loads (getHoursWorkedTeamsAndMembers()) almost
 * always find a warm cache instead of waiting on the slow IMPORTRANGE-
 * backed read. Install via installHoursWorkedRefreshTrigger() (run once
 * from the Apps Script editor); safe to also run manually any time.
 */
function refreshHoursWorkedTeamsCache() {
  const result = new HoursWorked().getTeamsAndMembers();
  CacheService.getScriptCache().put(HOURS_WORKED_CACHE_KEY_, JSON.stringify(result), HOURS_WORKED_CACHE_TTL_SECONDS_);
  const totalMembers = Object.values(result.membersByTeam).reduce((n, arr) => n + arr.length, 0);
  Logger.log(`[refreshHoursWorkedTeamsCache] Refreshed | teams=${result.teams.length} | totalMembers=${totalMembers}`);
}

/**
 * One-time setup — select this function and click Run in the Apps Script
 * editor to install the 10-minute refresh trigger. Checks for an existing
 * trigger on the same handler first, so re-running is safe and won't
 * create a duplicate (unlike Recurring Tasks' daily trigger — see that
 * tool's README notes on why a duplicate trigger there was a real risk).
 */
function installHoursWorkedRefreshTrigger() {
  const already = ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === 'refreshHoursWorkedTeamsCache');
  if (already) {
    Logger.log('[installHoursWorkedRefreshTrigger] Already installed — skipping.');
    return;
  }
  ScriptApp.newTrigger('refreshHoursWorkedTeamsCache').timeBased().everyMinutes(10).create();
  Logger.log('[installHoursWorkedRefreshTrigger] Installed — refreshHoursWorkedTeamsCache will run every 10 minutes.');
}

var HoursWorked = function () {

  // ── Sheet access ───────────────────────────────────────────────────────

  const findTeam_ = (teamId) => HOURS_WORKED_TEAMS_.find((t) => t.id === teamId);

  // Trimmed match — "Linked - Operations Pay Cycle"'s own "Start " header
  // has a trailing space (confirmed against the live sheet), and trimming
  // defensively here costs nothing for the other tabs' clean headers.
  const colIndex_ = (headers, name) => {
    const idx = headers.findIndex((h) => String(h).trim() === name);
    if (idx === -1) throw new Error(`[HoursWorked] Expected column "${name}" not found — sheet headers may have changed.`);
    return idx;
  };

  const readTab_ = (tabName) => {
    const sheet = getSpreadsheet_(HOURS_WORKED_SHEET_KEY).getSheetByName(tabName);
    if (!sheet) throw new Error(`[HoursWorked] Tab "${tabName}" not found.`);
    const values = sheet.getDataRange().getValues();
    return { headers: values[0], rows: values.slice(1) };
  };

  const isActive_ = (value) => value === true || String(value).trim().toLowerCase() === 'true';
  const isRealEmployee_ = (key) => !HOURS_WORKED_EXCLUDED_KEYS_.includes(String(key));
  const round2_   = (n) => Math.round(n * 100) / 100;

  // ── Calendar-day arithmetic ──────────────────────────────────────────────

  const daysSinceEpoch_ = (year, month, day) => Math.floor(Date.UTC(year, month - 1, day) / 86400000);

  const DAY_NAMES_   = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed']; // epoch day 0 (1970-01-01) was a Thursday
  const MONTH_NAMES_ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const formatDayLabel_ = (epochDay) => {
    const d = new Date(epochDay * 86400000);
    const dow = DAY_NAMES_[((epochDay % 7) + 7) % 7];
    return `${dow} ${d.getUTCDate()} ${MONTH_NAMES_[d.getUTCMonth()]}`;
  };

  // A sheet date cell (time_date, or the pay-cycle Start/End) is a real
  // moment-in-time, so converting it via Utilities.formatDate with an
  // explicit NZ timezone is the correct way to read back the calendar day
  // it actually falls on in NZ time — see gotcha #5 (CLAUDE.md) on why a
  // *locally-constructed* "today" needs the opposite care.
  const sheetDateToEpochDay_ = (value) => {
    if (!(value instanceof Date)) return null;
    const [year, month, day] = Utilities.formatDate(value, 'Pacific/Auckland', 'yyyy-MM-dd').split('-').map(Number);
    return daysSinceEpoch_(year, month, day);
  };

  // "Linked - PayHero Time" is ~2,200+ rows × 27 columns but only 3 are
  // ever used — reads just those via individual getRange() calls (after
  // one cheap header-row read to find their positions) instead of
  // getDataRange() pulling all 27, to cut what Apps Script has to marshal
  // back for the tab's biggest, slowest read. Returns pre-resolved
  // {employeeKey, epochDay, duration} tuples rather than raw rows, so
  // callers don't need column indices at all.
  const readTimeRows_ = () => {
    const sheet = getSpreadsheet_(HOURS_WORKED_SHEET_KEY).getSheetByName(HOURS_WORKED_TIME_TAB);
    if (!sheet) throw new Error(`[HoursWorked] Tab "${HOURS_WORKED_TIME_TAB}" not found.`);

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const headers   = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const iKey      = colIndex_(headers, 'employee_key');
    const iDate     = colIndex_(headers, 'time_date');
    const iDuration = colIndex_(headers, 'duration'); // hours-worked only — external_pay_rate is never read

    const numRows   = lastRow - 1;
    const keys      = sheet.getRange(2, iKey + 1, numRows, 1).getValues();
    const dates     = sheet.getRange(2, iDate + 1, numRows, 1).getValues();
    const durations = sheet.getRange(2, iDuration + 1, numRows, 1).getValues();

    const rows = [];
    for (let i = 0; i < numRows; i++) {
      rows.push({
        employeeKey: String(keys[i][0]),
        epochDay:    sheetDateToEpochDay_(dates[i][0]),
        duration:    Number(durations[i][0]) || 0,
      });
    }
    return rows;
  };

  // PayHero's /time API has no end_date — it returns everything from a
  // start date onward, including forward-rostered shifts for days that
  // haven't happened yet (confirmed 2026-08-27: several team members had
  // identical repeating shift blocks logged days/weeks in advance). A day
  // that hasn't occurred can't be actual hours worked, so every hours-
  // worked aggregate below excludes entries dated after today — the daily
  // table still shows those days (as 0.00, same as any day with nothing
  // logged), just excluded from the summed/derived figures.
  const todayEpochDay_ = () => {
    const [year, month, day] = Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd').split('-').map(Number);
    return daysSinceEpoch_(year, month, day);
  };

  // Same source and lookup the original "Hours Worked" tab's Report!B2
  // used (`VLOOKUP(1, 'Linked - Operations Pay Cycle'!A2:C, ..., false)`),
  // just read directly instead of through that intermediate tab.
  const getCurrentCycleStartEpochDay_ = () => {
    const { headers, rows } = readTab_(HOURS_WORKED_CYCLE_TAB);
    const iCurrent = colIndex_(headers, 'Current Cycle');
    const iStart   = colIndex_(headers, 'Start');

    const currentRow = rows.find((row) => Number(row[iCurrent]) === 1);
    if (!currentRow) throw new Error(`[HoursWorked] No row in "${HOURS_WORKED_CYCLE_TAB}" has Current Cycle = 1.`);

    const epochDay = sheetDateToEpochDay_(currentRow[iStart]);
    if (epochDay === null) throw new Error(`[HoursWorked] Current pay-cycle row in "${HOURS_WORKED_CYCLE_TAB}" has no valid Start date.`);
    return epochDay;
  };

  // ── Public methods ───────────────────────────────────────────────────────

  this.getTeamsAndMembers = function () {
    const emp = readTab_(HOURS_WORKED_EMP_TAB);
    const iKey        = colIndex_(emp.headers, 'employee_key');
    const iTeamName    = colIndex_(emp.headers, 'team_name');
    const iActive      = colIndex_(emp.headers, 'active');
    const iDisplayName = colIndex_(emp.headers, 'display_name');

    // Current fortnight's total hours per employee, so each member's
    // dropdown option can show it without a separate round trip per person.
    const cycleStartDay = getCurrentCycleStartEpochDay_();
    const cycleEndDay   = cycleStartDay + HOURS_WORKED_CYCLE_DAYS_ - 1;

    const todayDay = todayEpochDay_();
    const hoursByEmployee = {};
    readTimeRows_().forEach((r) => {
      if (r.epochDay === null || r.epochDay < cycleStartDay || r.epochDay > cycleEndDay || r.epochDay > todayDay) return;
      hoursByEmployee[r.employeeKey] = (hoursByEmployee[r.employeeKey] || 0) + r.duration;
    });

    const membersByTeam = {};
    HOURS_WORKED_TEAMS_.forEach((team) => {
      membersByTeam[team.id] = emp.rows
        .filter((row) => team.teamNames.includes(row[iTeamName]) && isActive_(row[iActive]) && isRealEmployee_(row[iKey]))
        .map((row) => ({
          key: row[iKey],
          name: row[iDisplayName],
          hoursWorked: round2_(hoursByEmployee[String(row[iKey])] || 0),
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    });

    return {
      teams: HOURS_WORKED_TEAMS_.map((t) => ({ id: t.id, label: t.label })),
      membersByTeam,
    };
  };

  this.getFortnight = function (teamId, employeeKey) {
    const team = findTeam_(teamId);
    if (!team) return { error: `Unknown team: ${teamId}` };

    const emp = readTab_(HOURS_WORKED_EMP_TAB);
    const eKey         = colIndex_(emp.headers, 'employee_key');
    const eTeamName     = colIndex_(emp.headers, 'team_name');
    const eDisplayName  = colIndex_(emp.headers, 'display_name');

    const employeeRow = emp.rows.find((row) => String(row[eKey]) === String(employeeKey) && team.teamNames.includes(row[eTeamName]) && isRealEmployee_(row[eKey]));
    if (!employeeRow) return { error: 'Team member not found for that team.' };
    const memberName = employeeRow[eDisplayName];

    // ── Current fortnight window ──
    const cycleStartDay = getCurrentCycleStartEpochDay_();

    const hoursByEpochDay = {};
    const days = [];
    for (let i = 0; i < HOURS_WORKED_CYCLE_DAYS_; i++) {
      const epochDay = cycleStartDay + i;
      hoursByEpochDay[epochDay] = 0;
      days.push({ epochDay, label: formatDayLabel_(epochDay) });
    }

    // ── Sum this employee's logged hours per day ──
    const todayDay = todayEpochDay_();
    readTimeRows_().forEach((r) => {
      if (r.employeeKey !== String(employeeKey)) return;
      if (r.epochDay === null || !(r.epochDay in hoursByEpochDay) || r.epochDay > todayDay) return;
      hoursByEpochDay[r.epochDay] += r.duration;
    });

    days.forEach((d) => { d.hours = round2_(hoursByEpochDay[d.epochDay]); });

    const hoursWorked    = round2_(days.reduce((sum, d) => sum + d.hours, 0));
    const daysWorked     = days.filter((d) => d.hours > 0).length;
    const avgHoursPerDay = daysWorked > 0 ? round2_(hoursWorked / daysWorked) : 0;

    return {
      memberName,
      cycleStartLabel: formatDayLabel_(cycleStartDay),
      cycleEndLabel:   formatDayLabel_(cycleStartDay + HOURS_WORKED_CYCLE_DAYS_ - 1),
      days:            days.map((d) => ({ label: d.label, hours: d.hours })),
      daysWorked,
      hoursWorked,
      avgHoursPerDay,
    };
  };
};
