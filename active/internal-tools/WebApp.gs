/**
 * @fileoverview Web app entry point for the consolidated Internal Tools shell.
 */

function doGet(e) {
  return HtmlService.createTemplateFromFile('Shell')
    .evaluate()
    .setTitle('Wilderness Internal Tools')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Used by <?!= include('X'); ?> templating to stitch partials together.
 * @param {string} filename
 * @returns {string}
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
