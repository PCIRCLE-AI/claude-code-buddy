// Real-browser verification that the dashboard renders the Vector Index
// WARN's D6 fix correctly, per locale — not just that the translation
// strings exist in i18n.ts (tests/dashboard/doctor-banner-i18n.test.tsx
// already covers that), but that a real bundle in a real browser renders
// the right, DISTINCT fix text for the two states doctor.ts now
// distinguishes:
//   1. 'vector-index.stale-no-embedder' (no embedder configured) must NOT
//      tell the user to run `memesh reindex` — that command exits 1 in this
//      state, so the OLD, still-shared code would have sent every fresh
//      Core-mode install to a command guaranteed to fail (the D6 bug).
//   2. 'vector-index.stale' (embedder already configured) keeps the plain
//      `memesh reindex` fix.
// Two codes exist so the two states can each carry their own catalogue
// entry — this script proves the dashboard actually looks the code up and
// renders per-locale text, not the English fallback or the raw key.
//
// role="alert" is DoctorBanner's own marker, so detection is
// language-agnostic. Starts the real HTTP server against an isolated,
// throwaway HOME (never touches ~/.memesh) and intercepts GET /v1/doctor so
// the dashboard renders against controlled payloads.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCALES = ['en', 'zh-TW', 'zh-CN', 'ja', 'ko', 'pt', 'fr', 'de', 'vi', 'es', 'th'];

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

function doctorPayload(code, summary, fix) {
  return envelopeOf({
    status: 'PASS_WITH_CONCERNS',
    checks: [{ id: 'vector_index', status: 'warn', summary, fix, code, params: { missing: 3 } }],
  });
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

    // --- Scenario 1: no-embedder code must NOT tell the user to reindex ---
    await page.route('**/v1/doctor', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: doctorPayload(
          'vector-index.stale-no-embedder',
          '3 memories have no search vector',
          `No embedder is configured, so reindex has nothing to embed with — run 'memesh config set embedder.provider ollama' (or 'openai') first, then 'memesh reindex'.`,
        ),
      }),
    );

    // The FIX text specifically — not the whole alert blob — is what the D6
    // bug was about, and the summary's own wording ("no embedder is
    // configured") can accidentally satisfy a check written against the
    // combined text even when the fix itself is broken. Debugged into
    // existence: an earlier version of this script checked innerText of the
    // whole alert and missed a deliberately reintroduced D6 regression
    // because the summary alone contained "embedder".
    const fixTextOf = () => document.querySelector('[role="alert"] em')?.textContent ?? null;

    const seenFixTexts = {};
    for (const locale of LOCALES) {
      await page.goto(`http://127.0.0.1:${port}/dashboard`);
      await page.evaluate((l) => localStorage.setItem('memesh-locale', l), locale);
      await page.reload();
      await page.waitForTimeout(400);
      const fixText = await page.evaluate(fixTextOf);
      if (fixText === null) {
        failures.push(`[${locale}] no-embedder: no fix text rendered — DoctorBanner did not mount or has no fix`);
        continue;
      }
      if (fixText.includes('doctor.msg.vector-index.stale-no-embedder') || fixText.includes('vector-index.stale-no-embedder')) {
        failures.push(`[${locale}] no-embedder: rendered the RAW i18n key/code instead of a translated string: ${JSON.stringify(fixText)}`);
      }
      if (/reindex/i.test(fixText) && !/embedder|embedding|ollama|openai/i.test(fixText)) {
        failures.push(`[${locale}] no-embedder: fix text mentions reindex without naming the embedder prerequisite — the D6 bug: ${JSON.stringify(fixText)}`);
      }
      seenFixTexts[locale] = fixText;
      if (locale !== 'en' && fixText === seenFixTexts.en) {
        failures.push(`[${locale}] no-embedder: fix text is byte-identical to English — likely silent fallback, not a real catalogue entry`);
      }
    }

    // --- Scenario 2: embedder-configured code keeps the plain reindex fix,
    // and is DISTINCT from scenario 1 in every locale (two codes, two texts)
    await page.unroute('**/v1/doctor');
    await page.route('**/v1/doctor', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: doctorPayload(
          'vector-index.stale',
          '3 memories have no search vector',
          `Run 'memesh reindex' to fix. This will restore full search functionality.`,
        ),
      }),
    );

    for (const locale of LOCALES) {
      await page.goto(`http://127.0.0.1:${port}/dashboard`);
      await page.evaluate((l) => localStorage.setItem('memesh-locale', l), locale);
      await page.reload();
      await page.waitForTimeout(400);
      const fixText = await page.evaluate(fixTextOf);
      if (fixText === null) {
        failures.push(`[${locale}] stale: no fix text rendered — DoctorBanner did not mount or has no fix`);
        continue;
      }
      if (fixText.includes('doctor.msg.vector-index.stale.') || (fixText.includes('vector-index.stale') && !fixText.includes('stale-no-embedder'))) {
        failures.push(`[${locale}] stale: rendered the RAW i18n key/code instead of a translated string: ${JSON.stringify(fixText)}`);
      }
      if (fixText === seenFixTexts[locale]) {
        failures.push(`[${locale}] stale: fix text IDENTICAL to the no-embedder scenario — the two codes share one catalogue entry, so one branch always shows the other's message (the D6 bug this PR fixes)`);
      }
    }
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error('FAIL: dashboard vector-index i18n real-browser verification');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('--- server output ---');
    console.error(serverOutput.slice(-2000));
    process.exit(1);
  }
  console.log(`PASS: all ${LOCALES.length} locales verified in real Chromium — no-embedder fix names the prerequisite, stale fix stays plain, the two codes render distinct translated text.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL: script error:', err);
  process.exit(1);
});
