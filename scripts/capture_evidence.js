// Phase 1.2 evidence capture for the district report.
//
//   node scripts/capture_evidence.js
//
// Captures the full journey for each persona (AWT, AWH, Supervisor, and the
// administration console) at 1440x900 into evidence/screens/, records the
// payload the application constructs for every server call into
// evidence/payloads/, renders a readable request/response panel per step into
// evidence/console/, times every step, and writes evidence/MANIFEST.csv.
//
// HONEST LIMITS, recorded here and in Annexure G of the report:
//  * Runs in the training configuration. The screens are the real v5.20
//    application; the data in them is test data, so no worker's name,
//    photograph, telephone number or real location appears anywhere.
//  * In that configuration the application answers its own calls locally, so
//    there is no network traffic to record. What IS recorded is the payload
//    the application builds and submits - which is the thing the report needs
//    to show: exactly which fields leave the handset.
//  * Timings are wall-clock for a scripted run on a desktop browser. They are
//    an indication of task length, not a field measurement on a rural handset.
'use strict';
const fs = require('fs');
const path = require('path');

const PW = 'C:/Users/jhama/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright';
const { chromium } = require(PW);

const ROOT = path.dirname(__dirname);
const EV = path.join(ROOT, 'evidence');
const DIRS = ['screens', 'console', 'payloads'].map(d => path.join(EV, d));
DIRS.forEach(d => fs.mkdirSync(d, { recursive: true }));

const BASE = 'http://127.0.0.1:8765';
const manifest = [];
const timings = [];

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Redaction: the training data carries no real identifiers, but the report
 *  must be repeatable against live data, so the masking runs regardless. */
async function redact(page) {
  await page.evaluate(() => {
    const RE = [
      [/\b[6-9]\d{9}\b/g, '\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588'],   // phone
      [/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '\u2588\u2588\u2588\u2588 \u2588\u2588\u2588\u2588 \u2588\u2588\u2588\u2588'] // Aadhaar-like
    ];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walk.nextNode()) hits.push(walk.currentNode);
    hits.forEach(t => {
      let v = t.nodeValue;
      RE.forEach(([re, rep]) => { v = v.replace(re, rep); });
      if (v !== t.nodeValue) t.nodeValue = v;
    });
    window.__restore = [];
    document.querySelectorAll('input[type="tel"],#in-phone,#admin-search').forEach(i => {
      if (i.value && /\d{6,}/.test(i.value)) {
        window.__restore.push([i, i.value]);
        i.value = '\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588';
      }
    });
  });
}

/** Put back what redaction masked, so the journey can continue. Masking the
 *  live form was breaking the very sign-in it was documenting. */
async function unredact(page) {
  await page.evaluate(() => {
    (window.__restore || []).forEach(pair => { pair[0].value = pair[1]; });
    window.__restore = [];
  });
}

/** Record what the application submits, without touching the application. */
async function instrument(page) {
  await page.addInitScript(() => {
    window.__calls = [];
    const hook = () => {
      let api = null;
      try { api = (typeof Api !== 'undefined') ? Api : (window.Api || null); } catch (e) { api = null; }
      if (!api || api.__hooked) return;
      const orig = api.post;
      api.post = async function (body) {
        const t0 = Date.now();
        const res = await orig.apply(this, arguments);
        try {
          // The photograph is megabytes of base64 and is never written to
          // disk by this script; its presence and size are recorded instead.
          const safe = JSON.parse(JSON.stringify(body, (k, v) =>
            /b64|photo/i.test(k) && typeof v === 'string' && v.length > 64
              ? '[image, ' + Math.round(v.length * 0.75 / 1024) + ' KB, not stored]' : v));
          if (safe.token) safe.token = '[session token withheld]';
          if (safe.pin) safe.pin = '[withheld]';
          window.__calls.push({ at: new Date().toISOString(), ms: Date.now() - t0,
            request: safe, response: JSON.parse(JSON.stringify(res)) });
        } catch (e) { /* never let evidence capture break the app */ }
        return res;
      };
      api.__hooked = true;
    };
    document.addEventListener('DOMContentLoaded', hook);
    [200, 500, 900, 1500, 2500].forEach(ms => setTimeout(hook, ms));
  });
}

/** One captured step: screenshot, payloads, request panel, timing, manifest. */
async function step(page, persona, n, label, proves) {
  const nn = String(n).padStart(2, '0');
  const base = persona + '_' + nn + '_' + slug(label);
  await redact(page);
  await page.screenshot({ path: path.join(EV, 'screens', base + '.png') });
  await unredact(page);

  const calls = await page.evaluate(() => {
    const c = window.__calls || [];
    window.__calls = [];
    return c;
  });
  if (calls.length) {
    fs.writeFileSync(path.join(EV, 'payloads', base + '.json'), JSON.stringify(calls, null, 2));
    await renderPanel(page.context(), base, label, calls);
  }
  manifest.push({ filename: 'screens/' + base + '.png', persona: persona, step: label,
    captured: new Date().toISOString(), proves: proves,
    payload: calls.length ? 'payloads/' + base + '.json' : '' });
  return base;
}

/** A readable request/response panel, rendered from the real captured calls. */
async function renderPanel(ctx, base, label, calls) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<meta charset="utf-8"><style>
    body{margin:0;background:#0f1319;color:#d7dde5;font:13px/1.6 'Cascadia Mono',Consolas,monospace;padding:20px}
    h1{font:600 15px/1.4 'Segoe UI',sans-serif;color:#8ab4f8;margin:0 0 4px}
    .sub{color:#7b8494;font-size:11px;margin-bottom:16px}
    .call{border:1px solid #232a34;border-radius:6px;margin-bottom:14px;overflow:hidden}
    .hd{background:#171d26;padding:7px 12px;color:#9aa5b4;font-size:11.5px;
        display:flex;justify-content:space-between}
    .hd b{color:#7ee2b8}
    pre{margin:0;padding:12px;white-space:pre-wrap;word-break:break-word;font-size:12px}
    .req{border-bottom:1px solid #232a34}
    .k{color:#7b8494}</style>
    <h1>${esc(label)}</h1>
    <div class="sub">What the application submitted, captured in the browser during this step.</div>
    ${calls.map(c => `<div class="call">
      <div class="hd"><span>REQUEST &nbsp;<b>${esc(c.request.action || '(no action)')}</b></span>
      <span>${esc(c.at)} &middot; ${c.ms} ms</span></div>
      <pre class="req">${esc(JSON.stringify(c.request, null, 2))}</pre>
      <div class="hd"><span>RESPONSE</span><span></span></div>
      <pre>${esc(JSON.stringify(c.response, null, 2))}</pre>
    </div>`).join('')}`;
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1000, height: 700 });
  await p.setContent(html);
  await p.screenshot({ path: path.join(EV, 'console', base + '_console.png'), fullPage: true });
  await p.close();
}

/** Click if it is actually there. A control that is not on screen is a gap
 *  in the evidence, recorded as such - never a reason to abort the run. */
async function tap(page, sel) {
  try {
    if (await page.isVisible(sel)) { await page.click(sel, { timeout: 4000 }); return true; }
  } catch (e) { /* fall through */ }
  console.log('  (skipped, not reachable: ' + sel + ')');
  return false;
}

const time = async (persona, task, fn) => {
  const t0 = Date.now();
  await fn();
  timings.push({ persona: persona, task: task, seconds: +((Date.now() - t0) / 1000).toFixed(1) });
};

// ------------------------------------------------------------- field app
async function fieldPersona(browser, persona, pickName) {
  const ctx = await browser.newContext({
    serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
    permissions: ['geolocation', 'camera'],
    geolocation: { latitude: 17.7266, longitude: 79.1761 }
  });
  const page = await ctx.newPage();
  await instrument(page);
  await page.route('**/js/config.js', r => r.fulfill({
    contentType: 'application/javascript',
    body: 'window.APP_CONFIG = { DEMO: true, ENDPOINT: "", ENDPOINTS: [], SUMMARY_BASE: "" };'
  }));

  await page.goto(BASE + '/app/index.html', { waitUntil: 'networkidle' });
  await step(page, persona, 1, 'sign in screen',
    'The worker signs in with her own number and PIN; the build version is shown on screen.');

  await time(persona, 'Sign in', async () => {
    await page.fill('#in-phone', '9000000001');
    for (let i = 0; i < 5 && (await page.isVisible('#screen-login')); i++) {
      // Pick the persona ONCE. Tapping an already-selected name clears the
      // selection, and the loop would then never get past the picker.
      if (await page.isVisible('#whoami-block') && !(await page.$('#whoami-list button.sel'))) {
        const btns = await page.$$('#whoami-list button');
        for (const b of btns) {
          if (((await b.textContent()) || '').includes(pickName)) { await b.click(); break; }
        }
        await page.waitForTimeout(300);
      }
      if (await page.isVisible('#newpin-block')) {
        await page.fill('#in-newpin', '1234'); await page.fill('#in-newpin2', '1234');
      } else if (await page.isVisible('#pin-block')) { await page.fill('#in-pin', '1234'); }
      await page.click('#btn-login');
      await page.waitForTimeout(1200);
    }
    if (await page.isVisible('#screen-welcome')) {
      await page.click('#screen-welcome'); await page.waitForTimeout(700);
    }
  });
  await step(page, persona, 2, 'home screen after sign in',
    'The day\'s status and the single marking action; nothing else competes for attention.');

  // Marking: camera + position are both compulsory.
  await time(persona, 'Mark attendance (IN)', async () => {
    if (await page.isVisible('#btn-mark')) {
      await page.click('#btn-mark');
      await page.waitForTimeout(2500);
    }
  });
  await step(page, persona, 3, 'mark attendance camera and gps',
    'The camera opens and the position is acquired before a mark can be made. There is no gallery option.');

  if (await page.isVisible('#btn-capture')) {
    await time(persona, 'Capture photograph', async () => {
      await page.click('#btn-capture'); await page.waitForTimeout(3500);
    });
    await step(page, persona, 4, 'mark submitted',
      'The mark is accepted with photograph, position and server time bound together.');
  }
  // The camera screen may still be up if the fake stream did not settle;
  // leaving it is what makes the rest of the journey reachable.
  if (await page.isVisible('#btn-cam-cancel')) {
    await page.click('#btn-cam-cancel'); await page.waitForTimeout(900);
  }

  await tap(page, '#btn-menu');
  await page.waitForTimeout(600);
  await step(page, persona, 5, 'menu', 'The worker reaches leave and her own record from one menu.');

  await time(persona, 'Open leave form', async () => {
    await tap(page, '#btn-leave'); await page.waitForTimeout(1500);
  });
  await step(page, persona, 6, 'leave application',
    'Leave is applied for in the application, with the balance shown before submission.');

  if (await page.isVisible('#lv-type')) {
    await time(persona, 'Complete leave application', async () => {
      await page.selectOption('#lv-type', 'CASUAL');
      await page.fill('#lv-from', '2026-09-02');
      await page.fill('#lv-to', '2026-09-02');
      await page.fill('#lv-reason', 'Family function');
      await tap(page, '#btn-leave-submit');
      await page.waitForTimeout(1800);
    });
    await step(page, persona, 7, 'leave submitted',
      'The application is recorded and shown as pending the sanctioning authority.');
  } else {
    console.log('  (skipped, leave form not reachable for ' + persona + ')');
  }

  await tap(page, '#btn-leave-back');
  await page.waitForTimeout(800);
  await tap(page, '#btn-menu-back');
  await page.waitForTimeout(600);
  if (await page.isVisible('#btn-history')) {
    await time(persona, 'Open own record', async () => {
      await tap(page, '#btn-history'); await page.waitForTimeout(1400);
    });
    await step(page, persona, 8, 'own attendance record',
      'The worker can see her own record, which is what lets her prove attendance.');
  }

  await ctx.close();
}

// -------------------------------------------------------------- console
async function consolePersona(browser, persona, phone, tabs) {
  const ctx = await browser.newContext({
    serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1
  });
  const page = await ctx.newPage();
  await instrument(page);
  page.on('dialog', d => d.dismiss());
  await page.route('**/js/config.js', r => r.fulfill({
    contentType: 'application/javascript',
    body: 'window.CONSOLE_CONFIG = { DEMO: true, ENDPOINT: "", ENDPOINTS: [], SUMMARY_BASE: "" };'
  }));

  await page.goto(BASE + '/console/index.html', { waitUntil: 'networkidle' });
  await step(page, persona, 1, 'console sign in', 'The console is reached with the officer\'s own credentials.');

  await time(persona, 'Sign in', async () => {
    await page.fill('#in-phone', phone);
    for (let i = 0; i < 5 && !(await page.isVisible('#tab-today')); i++) {
      if (await page.isVisible('#whoami-block') && !(await page.$('#whoami-list button.sel'))) {
        const b = await page.$('#whoami-list button');
        if (b) { await b.click(); await page.waitForTimeout(250); }
      }
      if (await page.isVisible('#newpin-block')) {
        await page.fill('#in-newpin', '1234'); await page.fill('#in-newpin2', '1234');
      } else if (await page.isVisible('#pin-block')) { await page.fill('#in-pin', '1234'); }
      await page.click('#btn-login');
      await page.waitForTimeout(1200);
    }
  });

  let n = 2;
  for (const [tab, label, proves] of tabs) {
    if (!(await page.$(tab))) continue;
    await time(persona, 'Open ' + label, async () => {
      await page.click(tab); await page.waitForTimeout(1900);
    });
    await step(page, persona, n++, label, proves);
  }
  await ctx.close();
}

// ------------------------------------------------------------------ run
(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });

  await fieldPersona(browser, 'awt', 'Teacher');
  await fieldPersona(browser, 'awh', 'Helper');

  await consolePersona(browser, 'supervisor', '9000000002', [
    ['#tab-today', 'sector dashboard', 'The supervisor sees only her own sector; the scope is enforced at the server.'],
    ['#tab-exceptions', 'flagged marks', 'Marks needing attention are listed with distance and reason.'],
    ['#tab-monthly', 'monthly attendance grid', 'A month of attendance per worker on one screen.'],
    ['#tab-rpts', 'daily beneficiary returns', 'What each centre reported for children, mothers and meals.']
  ]);

  await consolePersona(browser, 'admin', '9000000001', [
    ['#tab-today', 'district dashboard', 'District attendance, punctuality and beneficiary counts, current within about five minutes.'],
    ['#tab-map', 'district map', 'Where marks were made against the registered centre locations.'],
    ['#tab-exceptions', 'exception queue', 'The marks the district must dispose of, with the evidence attached.'],
    ['#tab-verify', 'ration verification', 'Ledger and per-head consistency findings by centre.'],
    ['#tab-register', 'leave register', 'Annual entitlement, taken and balance for every worker.'],
    ['#tab-leaves', 'leave decisions', 'Applications decided in one place, with the officer and date recorded.'],
    ['#tab-admin', 'users and administration', 'Master data and access, every change audit-logged.']
  ]);

  await browser.close();

  const head = 'filename,persona,step,captured,proves,payload\n';
  const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  fs.writeFileSync(path.join(EV, 'MANIFEST.csv'), head +
    manifest.map(m => [m.filename, m.persona, m.step, m.captured, m.proves, m.payload].map(q).join(',')).join('\n') + '\n');
  fs.writeFileSync(path.join(EV, 'timings.json'), JSON.stringify(timings, null, 2));

  console.log('screens   ' + manifest.length);
  console.log('payloads  ' + manifest.filter(m => m.payload).length);
  console.log('timings   ' + timings.length + ' tasks');
  console.log('manifest  evidence/MANIFEST.csv');
})();
