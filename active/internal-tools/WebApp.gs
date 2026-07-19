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

/**
 * Session.getActiveUser() only exposes an email address, not a real name —
 * this derives a display name and initials from the org's firstname.lastname@
 * email convention. Falls back to the first 2 characters of the email if
 * that convention doesn't hold (e.g. a single-word local part).
 * @returns {{email: string, displayName: string, initials: string}}
 */
function getSidebarUserInfo() {
  const email = Session.getActiveUser().getEmail() || '';
  const localPart = email.split('@')[0] || '';
  const parts = localPart.split('.').filter(Boolean);

  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const displayName = parts.length ? parts.map(capitalize).join(' ') : email;
  const initials = parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : (email.substring(0, 2) || '??').toUpperCase();

  return { email, displayName, initials };
}