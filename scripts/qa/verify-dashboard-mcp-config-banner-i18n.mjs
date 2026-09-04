// Real-browser verification that the doctor banner behaves correctly across
// every dashboard locale — not just that the translation strings exist in
// i18n.ts (tests/dashboard/doctor-banner-i18n.test.tsx already covers that),
// but that a real bundle in a real browser renders the right thing per
// locale for the two states this PR's own doctor.ts/DoctorBanner.tsx changes
// affect:
//   1. mcp-config.placeholder-unresolved must NOT banner (QUIET_WARN_CODES)
//      — a false banner here would alarm every npm/source install user for a
//      state the code's own comment calls "not broken".
//   2. mcp-config.missing DOES banner, translated per locale — not the
//      English fallback, not the raw i18n key.
//
// role="alert" is DoctorBanner's own marker (distinct from OnboardingBanner's
// role="region"), so detection is language-agnostic — grepping for English
// banner text made every non-English locale look broken the first time this
// was written, when the real bug was in the check, not the dashboard.
//
// Starts the real HTTP server against an isolated, throwaway HOME (never
// touches ~/.memesh) and intercepts GET /v1/doctor so the dashboard renders
// against controlled payloads.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCALES = ['en', 'zh-TW', 'zh-CN', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'hi'];

export function getChromeExecutablePath() {
  const envPath = process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      ]
    : process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium'];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

export async function launchBrowser() {
  const chromeExecutable = getChromeExecutablePath();
  if (chromeExecutable) return chromium.launch({ executablePath: chromeExecutable, headless: true });
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `No browser available. Install Playwright Chromium ("npx playwright install --with-deps chromium") or set CHROME_PATH. Original error: ${reason}`,
      { cause: error },
    );
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not come up at ${url} within ${timeoutMs}ms`);
}

function envelopeOf(data) {
  return JSON.stringify({ success: true, data });
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-dashboard-verify-'));
  const port = await findFreePort();
  const failures = [];

  const server = spawn('node', ['dist/transports/http/server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, MEMESH_HTTP_PORT: String(port), MEMESH_AUTO_CAPTURE: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (d) => { serverOutput += d.toString(); });
  server.stderr.on('data', (d) => { serverOutput += d.toString(); });

  const browser = await launchBrowser();
  try {
    await waitForServer(`http://127.0.0.1:${port}/dashboard`);
    const page = await browser.newPage();

    // --- Scenario 1: quiet code must not banner, in every locale ---
    await page.route('**/v1/doctor', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: envelopeOf({
          status: 'PASS_WITH_CONCERNS',
          checks: [{
            id: 'mcp-config',
            status: 'warn',
            summary: 'placeholder unresolved',
            fix: 'Verify it the way the plugin runtime would.',
            code: 'mcp-config.placeholder-unresolved',
          }],
        }),
      }),
    );

    for (const locale of LOCALES) {
      await page.goto(`http://127.0.0.1:${port}/dashboard`);
      await page.evaluate((l) => localStorage.setItem('memesh-locale', l), locale);
      await page.reload();
      await page.waitForTimeout(400);
      const alertPresent = await page.evaluate(() => document.querySelector('[role="alert"]') !== null);
      if (alertPresent) {
        failures.push(`[${locale}] quiet code mcp-config.placeholder-unresolved BANNERED — QUIET_WARN_CODES entry did not suppress it in the real browser`);
      }
    }

    // --- Scenario 2: a real user-facing code DOES banner, translated, per locale ---
    await page.unroute('**/v1/doctor');
    await page.route('**/v1/doctor', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: envelopeOf({
          status: 'FAIL',
          checks: [{
            id: 'mcp-config',
            status: 'fail',
            summary: '.claude-plugin/mcp.json is missing.',
            fix: 'Reinstall MeMesh so the plugin manifest and the MCP manifest it names are both restored.',
            code: 'mcp-config.missing',
          }],
        }),
      }),
    );

    for (const locale of LOCALES) {
      await page.goto(`http://127.0.0.1:${port}/dashboard`);
      await page.evaluate((l) => localStorage.setItem('memesh-locale', l), locale);
      await page.reload();
      await page.waitForTimeout(400);
      const alertText = await page.evaluate(() => document.querySelector('[role="alert"]')?.innerText ?? null);
      if (alertText === null) {
        failures.push(`[${locale}] no [role="alert"] element rendered — DoctorBanner did not mount for the FAIL check`);
        continue;
      }
      if (alertText.includes('doctor.msg.mcp-config.missing') || alertText.includes('mcp-config.missing')) {
        failures.push(`[${locale}] rendered the RAW i18n key/code instead of a translated string: ${JSON.stringify(alertText)}`);
      }
      if (locale !== 'en') {
        const enText = await (async () => {
          await page.evaluate(() => localStorage.setItem('memesh-locale', 'en'));
          await page.reload();
          await page.waitForTimeout(400);
          const t = await page.evaluate(() => document.querySelector('[role="alert"]')?.innerText ?? null);
          await page.evaluate((l) => localStorage.setItem('memesh-locale', l), locale);
          await page.reload();
          await page.waitForTimeout(400);
          return t;
        })();
        if (alertText === enText) {
          failures.push(`[${locale}] rendered text is byte-identical to English — likely silent fallback, not a real catalogue entry`);
        }
      }
    }
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error('FAIL: dashboard doctor-banner i18n real-browser verification');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('--- server output ---');
    console.error(serverOutput.slice(-2000));
    process.exit(1);
  }
  console.log(`PASS: all ${LOCALES.length} locales verified in real Chromium — quiet code suppressed, user-facing code translated and distinct per locale, no raw keys leaked.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL: script error:', err);
  process.exit(1);
});
