'use strict';
/**
 * App configuration. Copy this file to config.js (config.js is gitignored —
 * it carries the deployment URL, which must never be committed).
 *  - ENDPOINT: the deployed Apps Script web app URL (.../exec).
 *  - DEMO: true = fully offline fake backend for testing the app end-to-end
 *    without any server. Login with any 10-digit number: a two-user picker
 *    appears (shared centre phone); each demo user sets a PIN on first login.
 */
window.APP_CONFIG = {
  ENDPOINT: 'PASTE_APPS_SCRIPT_WEB_APP_URL_HERE',
  DEMO: true,
  VERSION: '1.0.0'
};
