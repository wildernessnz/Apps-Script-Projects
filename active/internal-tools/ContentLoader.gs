/**
 * @fileoverview Server-side content loader for the client-side router.
 * Each tool's real content partial (e.g. BookingFinder.html) is added in its
 * own build phase — until then, PLACEHOLDER_PARTIALS lets the shell run
 * end-to-end against a "coming soon" stub for tools not yet migrated.
 *
 * ACCESS_GATES lets a tool restrict its own content independently of the
 * others — needed because the original Weather Alert gated its whole page
 * at doGet(); here it shares a page with 3 other tools, so the gate has to
 * apply only to its own content slot. Add an entry here if a future tool
 * needs the same pattern.
 */

// Flip a tool's entry to true here once its real partial file exists.
const PLACEHOLDER_PARTIALS = {
  BookingFinder: false, // Phase 1 — done
  Interislander: false, // Phase 2 — done
  ReloRates:     false, // Phase 3 — done
  WeatherAlert:  false, // Phase 4 — done
};

// Maps a partial name to a function that returns true/false for whether the
// current user may see that tool's content. Stored as direct references
// (not strings + dynamic lookup) — top-level `this` isn't reliably the
// global object in Apps Script's V8 runtime, so string-based dispatch here
// would be fragile.
const ACCESS_GATES = {
  WeatherAlert: () => isWeatherAlertApproved(),
};

/**
 * Called by the router on nav click.
 * @param {string} partialName - matches NAV_CONFIG item.partial
 * @returns {string} rendered HTML for the content area
 */
function getToolContent(partialName) {
  const gateCheck = ACCESS_GATES[partialName];
  if (gateCheck && !gateCheck()) {
    return HtmlService.createHtmlOutput(
      '<div class="it-placeholder">' +
      '<div class="it-placeholder-icon">🔒</div>' +
      '<h2>Access Denied</h2>' +
      '<p>You don\'t have permission to use this tool. Contact Digital Experience to request access.</p>' +
      '</div>'
    ).getContent();
  }

  if (PLACEHOLDER_PARTIALS[partialName]) {
    return HtmlService.createTemplateFromFile('Placeholder')
      .evaluate()
      .getContent()
      .replace('{{TOOL_NAME}}', partialName);
  }
  return HtmlService.createHtmlOutputFromFile(partialName).getContent();
}

/**
 * Called once on initial page load to resolve the default-active nav item
 * to its partial name, so Router.html doesn't need to duplicate NAV_CONFIG.
 * @param {string} navId - matches NAV_CONFIG item.id
 * @returns {string} rendered HTML for the content area
 */
function getToolContentForNavId(navId) {
  for (const section of NAV_CONFIG) {
    const match = section.items.find(function (item) { return item.id === navId; });
    if (match) return getToolContent(match.partial);
  }
  throw new Error(`[getToolContentForNavId] Unknown nav id: ${navId}`);
}
