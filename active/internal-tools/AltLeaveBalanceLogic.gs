/**
 * @fileoverview Alt Leave Balance — lets team leaders explore each team
 * member's current alternative leave balance (days), filtered by team, with
 * a per-person history of the dated accruals that make up that balance.
 *
 * Reads two tabs of the "PayHero Leave" spreadsheet (SHEET_IDS.ALT_LEAVE in
 * Config.gs) and never writes to it:
 *   - "Linked - Alternative Leave Summary": one row per active employee,
 *     with PayHero's own `alternate_leave_due_days` as "PayHero Balance
 *     (Days)". This is the authoritative balance every figure here shows.
 *   - "Linked - Alternative Leave Accruals": one row per employee per pay
 *     period end, with "In Balance (Days)" saying how much of that accrual
 *     is still part of today's balance.
 * Both are produced upstream by the PayHero Integration project's
 * populateAlternativeLeaveAccruals() on its own schedule. That pipeline
 * nets reversals per period and allocates the balance to accruals newest
 * first (i.e. it assumes leave is used oldest-first), reconciled against
 * PayHero's "AA: Alternative Leave Awarded" report. This tool deliberately
 * doesn't redo any of that: it only displays the result.
 *
 * Leave history = the accruals with In Balance > 0, dated by Period End.
 * Period End (not Pay Date) is used because it's the date PayHero's own
 * report shows; Pay Date can trail it by up to ~3 weeks when payroll adds
 * public-holiday accruals in a later pay. Any part of the balance the
 * upstream script couldn't trace to an accrual inside its 5-year window
 * ("Unexplained (Days)") is shown as a separate undated line, so the
 * history always totals the balance shown in the table.
 *
 * Only employees with a balance > 0 are listed, and only teams with at
 * least one such employee get a pill, so the page shows who's owed leave
 * rather than the whole staff list.
 *
 * Performance: both tabs are "Linked -" (IMPORTRANGE-fed), so a live read
 * takes seconds. The result is cached in CacheService for
 * ALT_LEAVE_CACHE_TTL_SECONDS_. The upstream data only refreshes daily, so
 * a 30-minute cache costs nothing in freshness and needs no refresh
 * trigger, unlike Hours Worked.
 *
 * Access: open to all staff, no gate. Because webapp.executeAs is
 * USER_ACCESSING, every visiting user still needs their own read access to
 * the source spreadsheet.
 *
 * Script Properties: none.
 */

const ALT_LEAVE_SHEET_KEY    = 'ALT_LEAVE';
const ALT_LEAVE_SUMMARY_TAB  = 'Linked - Alternative Leave Summary';
const ALT_LEAVE_ACCRUALS_TAB = 'Linked - Alternative Leave Accruals';

// "LOGIN STATION", a shared kiosk account, not a person (same exclusion as
// HOURS_WORKED_EXCLUDED_KEYS_).
const ALT_LEAVE_EXCLUDED_KEYS_ = ['334888'];

// Bump the version whenever the returned shape changes, so a page load
// never gets a cached payload missing the new fields.
const ALT_LEAVE_CACHE_KEY_         = 'ALT_LEAVE_BALANCES_CACHE_V2';
const ALT_LEAVE_CACHE_TTL_SECONDS_ = 1800;

// ── Entry point: the only thing exposed to google.script.run ───────────────
// A single read-only lookup with no side effect, so it isn't action-logged
// (same convention as getHoursWorkedTeamsAndMembers()). Opening the tool is
// already logged as a view by getToolContent(), and expanding a row is
// client-side only, using data this call already returned.

/**
 * @returns {{total: number, teams: Array<Object>, members: Array<Object>, lastRefreshed: string}}
 */
function getAltLeaveBalances() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(ALT_LEAVE_CACHE_KEY_);
  if (cached) return JSON.parse(cached);

  const result = new AltLeaveBalance().getBalances();
  cache.put(ALT_LEAVE_CACHE_KEY_, JSON.stringify(result), ALT_LEAVE_CACHE_TTL_SECONDS_);
  Logger.log(`[getAltLeaveBalances] Loaded | members=${result.members.length} | teams=${result.teams.length} | total=${result.total}`);
  return result;
}

/**
 * Clears the cache so the next page load reads the sheet again. Run it from
 * the editor after re-running the upstream accruals script by hand.
 */
function clearAltLeaveBalanceCache() {
  CacheService.getScriptCache().remove(ALT_LEAVE_CACHE_KEY_);
  Logger.log('[clearAltLeaveBalanceCache] Cleared');
}

var AltLeaveBalance = function () {

  // ── Sheet access ───────────────────────────────────────────────────────

  /**
   * @param {Array} headers
   * @param {string} name
   * @returns {number} 0-based column index
   */
  const colIndex_ = (headers, name) => {
    const idx = headers.findIndex((h) => String(h).trim() === name);
    if (idx === -1) throw new Error(`[AltLeaveBalance] Expected column "${name}" not found — sheet headers may have changed.`);
    return idx;
  };

  /**
   * @param {string} tabName
   * @returns {{headers: Array, rows: Array<Array>}}
   */
  const readTab_ = (tabName) => {
    const sheet = getSpreadsheet_(ALT_LEAVE_SHEET_KEY).getSheetByName(tabName);
    if (!sheet) throw new Error(`[AltLeaveBalance] Tab "${tabName}" not found.`);
    const values = sheet.getDataRange().getValues();
    return { headers: values[0], rows: values.slice(1) };
  };

  /** @param {number} n @returns {number} */
  const round2_ = (n) => Math.round(n * 100) / 100;

  /**
   * PayHero team names carry a " Team" suffix on some teams only ("AK
   * Workshop Team" vs "AK Detailing"). It's dropped for display so the
   * pills read consistently.
   * @param {string} teamName
   * @returns {string}
   */
  const teamLabel_ = (teamName) => String(teamName).replace(/\s+Team$/i, '').trim();

  /**
   * A sheet date cell is a real instant, so it's formatted in NZ time to get
   * back the calendar day it falls on (see README gotcha #5).
   * @param {*} value
   * @returns {{label: string, sortKey: number}}
   */
  const readDate_ = (value) => {
    if (value instanceof Date) {
      return { label: Utilities.formatDate(value, 'Pacific/Auckland', 'd MMM yyyy'), sortKey: value.getTime() };
    }
    return { label: String(value || ''), sortKey: 0 };
  };

  // ── Public methods ───────────────────────────────────────────────────────

  /**
   * @returns {{total: number, teams: Array<Object>, members: Array<Object>, lastRefreshed: string}}
   */
  this.getBalances = function () {
    const summary = readTab_(ALT_LEAVE_SUMMARY_TAB);
    const sKey         = colIndex_(summary.headers, 'Employee Key');
    const sName        = colIndex_(summary.headers, 'Employee');
    const sTeam        = colIndex_(summary.headers, 'Team');
    const sBalance     = colIndex_(summary.headers, 'PayHero Balance (Days)');
    const sUnexplained = colIndex_(summary.headers, 'Unexplained (Days)');
    const sRefreshed   = colIndex_(summary.headers, 'Last Refreshed');
    const sDataFrom    = colIndex_(summary.headers, 'Data From');

    const accruals = readTab_(ALT_LEAVE_ACCRUALS_TAB);
    const aKey       = colIndex_(accruals.headers, 'Employee Key');
    const aPeriodEnd = colIndex_(accruals.headers, 'Period End');
    const aAccrued   = colIndex_(accruals.headers, 'Accrued (Days)');
    const aInBalance = colIndex_(accruals.headers, 'In Balance (Days)');

    const historyByKey = {};
    accruals.rows.forEach((row) => {
      const inBalance = round2_(Number(row[aInBalance]) || 0);
      if (inBalance <= 0) return;
      const key = String(row[aKey]);
      const date = readDate_(row[aPeriodEnd]);
      const accrued = round2_(Number(row[aAccrued]) || 0);
      (historyByKey[key] = historyByKey[key] || []).push({
        date: date.label,
        sortKey: date.sortKey,
        days: inBalance,
        // Partly in balance: some of this accrual is assumed already taken.
        accrued: accrued > inBalance ? accrued : null,
      });
    });

    // Taken across every row, not just listed members, so it's still set
    // when nobody currently has a balance.
    let lastRefreshedMs = 0;
    summary.rows.forEach((row) => {
      if (row[sRefreshed] instanceof Date) lastRefreshedMs = Math.max(lastRefreshedMs, row[sRefreshed].getTime());
    });

    const members = [];
    summary.rows.forEach((row) => {
      const key = String(row[sKey]);
      if (!key || ALT_LEAVE_EXCLUDED_KEYS_.includes(key)) return;
      const balance = round2_(Number(row[sBalance]) || 0);
      if (balance <= 0) return;

      const history = (historyByKey[key] || [])
        .sort((a, b) => b.sortKey - a.sortKey)
        .map(({ date, days, accrued }) => ({ date, days, accrued }));

      // Owed since = the oldest day still in the balance. Balance that
      // couldn't be traced to an accrual predates the upstream window, so
      // its true date is unknown, only that it's before the window start.
      const unexplained = round2_(Math.max(0, Number(row[sUnexplained]) || 0));
      let owedSince = history.length ? history[history.length - 1].date : '';
      if (unexplained > 0) {
        const dataFrom = readDate_(row[sDataFrom]).label;
        owedSince = dataFrom ? `Before ${dataFrom}` : '';
      }

      members.push({
        key,
        name: String(row[sName]),
        team: String(row[sTeam]),
        teamLabel: teamLabel_(row[sTeam]),
        balance,
        history,
        unexplained,
        owedSince,
      });
    });

    members.sort((a, b) => a.teamLabel.localeCompare(b.teamLabel) || a.name.localeCompare(b.name));

    const teamTotals = {};
    members.forEach((m) => { teamTotals[m.team] = (teamTotals[m.team] || 0) + m.balance; });
    const teams = Object.keys(teamTotals)
      .map((team) => ({ team, label: teamLabel_(team), balance: round2_(teamTotals[team]) }))
      .sort((a, b) => a.label.localeCompare(b.label));

    return {
      total: round2_(members.reduce((sum, m) => sum + m.balance, 0)),
      teams,
      members,
      lastRefreshed: lastRefreshedMs ? Utilities.formatDate(new Date(lastRefreshedMs), 'Pacific/Auckland', 'd MMM yyyy, h:mm a') : '',
    };
  };
};
