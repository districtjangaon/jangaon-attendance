// Render docs/report/index.html to a print-ready PDF.
//
//   node tools/report-stats.js --json > docs/report/stats.json
//   node tools/build-report.js
//   node tools/report-pdf.js
//
// Loaded over file:// so it needs no server, and the document embeds every
// chart as inline SVG, so nothing is fetched from the network while printing.
'use strict';
const path = require('path');
const fs = require('fs');

const PW = 'C:/Users/jhama/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright';
const ROOT = path.dirname(__dirname);
const SRC = path.join(ROOT, 'docs', 'report', 'index.html');
const OUT = path.join(ROOT, 'docs', 'report', 'Jangaon-Attendance-Assurance-Report.pdf');

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error('build the report first: node tools/build-report.js');
    process.exit(1);
  }
  const { chromium } = require(PW);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push(e.message));
  page.on('requestfailed', r => problems.push('failed request: ' + r.url()));

  await page.goto('file:///' + SRC.replace(/\\/g, '/'), { waitUntil: 'networkidle' });

  await page.pdf({
    path: OUT,
    format: 'A4',
    printBackground: true,
    margin: { top: '14mm', bottom: '16mm', left: '13mm', right: '13mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="width:100%;font-family:Segoe UI,sans-serif;font-size:8pt;color:#6b7280;' +
      'padding:0 13mm;display:flex;justify-content:space-between">' +
      '<span>Confidential &mdash; for official use only</span>' +
      '<span>Jangaon District &middot; WD&amp;CW</span>' +
      '<span class="pageNumber"></span>/<span class="totalPages"></span></div>'
  });

  await browser.close();
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log('PDF written: ' + OUT + '  (' + kb + ' KB)');
  if (problems.length) console.log('WARNINGS:\n  ' + problems.join('\n  '));
  else console.log('no page errors, no failed requests');
})();
