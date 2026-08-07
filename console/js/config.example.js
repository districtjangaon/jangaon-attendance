'use strict';
/**
 * Console configuration. Copy to config.js (gitignored — carries the
 * deployment URL, never committed).
 *  - ENDPOINT: deployed Apps Script web app URL (.../exec)
 *  - SUMMARY_BASE: where summary/*.json lives relative to this page.
 *    On GitHub Pages the summariser commits into the repo root, and the
 *    console is served from /console/, so '../' is right.
 *  - DEMO: true = built-in fixture data, no server needed. Sign in with any
 *    10-digit number and pick Demo Admin or Demo Supervisor.
 */
window.CONSOLE_CONFIG = {
  ENDPOINT: 'PASTE_APPS_SCRIPT_WEB_APP_URL_HERE',
  SUMMARY_BASE: '../',
  DEMO: true,
  VERSION: '1.0.0'
};
