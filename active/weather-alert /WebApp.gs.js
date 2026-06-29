/**
 * Weather Alert — Web App entry point
 *
 * Deploy as a Web App (Execute as: Me, Who has access: Anyone in Wilderness org)
 * The URL is then shared with approved senders only.
 *
 * All business logic is in WeatherAlert.gs — this file only handles doGet()
 * and the web app access guard.
 */

function doGet() {
  const currentUser     = Session.getActiveUser().getEmail()?.toLowerCase() || '';
  const props           = PropertiesService.getScriptProperties();
  const approvedRaw     = props.getProperty('APPROVED_SENDERS') ?? '';
  const approvedSenders = approvedRaw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

  if (!approvedSenders.includes(currentUser)) {
    return HtmlService.createHtmlOutput(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link href="https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
        <style>
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: 'Nunito Sans', sans-serif; background: #faf7f2; display: flex; align-items: center; justify-content: center; min-height: 100vh; color: #323232; }
          .card { background: #fff; border: 1px solid #ddd9d0; border-radius: 8px; padding: 48px 40px; max-width: 400px; text-align: center; box-shadow: 0 4px 20px rgba(38,52,80,.08); }
          .icon { font-size: 40px; margin-bottom: 16px; }
          h1 { font-size: 18px; font-weight: 700; margin-bottom: 8px; color: #263450; }
          p { font-size: 13px; color: #5b5b5b; line-height: 1.6; }
          .email { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #909090; margin-top: 12px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">🔒</div>
          <h1>Access Denied</h1>
          <p>You don't have permission to use the Weather Alert tool. Contact Digital Experience to request access.</p>
          <div class="email">${currentUser}</div>
        </div>
      </body>
      </html>
    `).setTitle('Access Denied');
  }

  return HtmlService
    .createHtmlOutputFromFile('WebApp')
    .setTitle('Weather Alert — Wilderness')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}