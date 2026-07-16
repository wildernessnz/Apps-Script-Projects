/**
 * @fileoverview Server-side content loader for the client-side router.
 * Each tool's real content partial (e.g. BookingFinder.html) is added in its
 * own build phase — until then, PLACEHOLDER_PARTIALS lets the shell run
 * end-to-end against a "coming soon" stub for tools not yet migrated.
 */

// Flip a tool's entry to true here once its real partial file exists.
const PLACEHOLDER_PARTIALS = {
  BookingFinder: false, // Phase 1
  Interislander: true,  // Phase 2 — not yet built
  ReloRates:     true,  // Phase 3 — not yet built
  WeatherAlert:  true,  // Phase 4 — not yet built
};

/**
 * Called by the router on nav click.
 * @param {string} partialName - matches NAV_CONFIG item.partial
 * @returns {string} rendered HTML for the content area
 */
function getToolContent(partialName) {
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
