import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { npmSync } from './lib/npm-bin.mjs';

const repoRoot = process.cwd();
const smokeDir = path.join(repoRoot, 'tmp', 'dashboard-e2e-smoke');
const npmCacheDir = process.env.MEMESH_NPM_CACHE ?? path.join(os.tmpdir(), 'memesh-npm-cache');

const pageErrors = [];
const consoleErrors = [];

function getChromeExecutablePath() {
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
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/snap/bin/chromium',
        ];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function launchBrowser() {
  const chromeExecutable = getChromeExecutablePath();
  if (chromeExecutable) {
    return chromium.launch({
      executablePath: chromeExecutable,
      headless: true,
    });
  }

  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `No browser available for dashboard e2e smoke. Install Playwright Chromium (for CI: "npx playwright install --with-deps chromium") or set CHROME_PATH. Original error: ${reason}`,
      { cause: error }
    );
  }
}

async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate local port'));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`Dashboard server exited early with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server not ready yet.
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function runNode(scriptPath, args, env) {
  execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
}

function cleanupDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

/**
 * Build the environment the packaged runtime spawns under: a test-owned
 * HOME/USERPROFILE/MEMESH_DIR/MEMESH_DB_PATH, provider auto-detection turned
 * off, and every provider credential/endpoint variable that could turn it
 * back on stripped from what would otherwise be a full `...baseEnv` spread.
 *
 * Pure and side-effect-free on purpose — `tests/release-scripts-safety.test.ts`
 * imports it directly and calls it with a deliberately polluted `baseEnv` to
 * pin this isolation as a regression test, without spawning `npm pack`,
 * installing a tarball, or launching a browser.
 *
 * The stripped names are exactly what `src/core/config.ts`'s `detectFromEnv`
 * reads (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_HOST`) plus
 * `MEMESH_AUTO_DETECT_LLM` itself. Keeping the two lists in lockstep is the
 * point: a name added to one without the other is exactly the gap GitHub
 * issue #271 found.
 */
export function buildIsolatedRuntimeEnv(baseEnv, { runtimeHome, memeshDir, dbPath }) {
  const isolatedEnv = {
    ...baseEnv,
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
    MEMESH_DIR: memeshDir,
    MEMESH_DB_PATH: dbPath,
    MEMESH_AUTO_DETECT_LLM: '0',
  };
  delete isolatedEnv.ANTHROPIC_API_KEY;
  delete isolatedEnv.OPENAI_API_KEY;
  delete isolatedEnv.OLLAMA_HOST;
  return isolatedEnv;
}

async function main() {
  cleanupDir(smokeDir);
  fs.mkdirSync(smokeDir, { recursive: true });
  const runtimeHome = path.join(smokeDir, 'runtime-home');
  const memeshDir = path.join(runtimeHome, '.memesh');
  const dbPath = path.join(memeshDir, 'knowledge-graph.db');
  fs.mkdirSync(memeshDir, { recursive: true });
  const isolatedEnv = buildIsolatedRuntimeEnv(process.env, { runtimeHome, memeshDir, dbPath });

  const packJson = npmSync(
    ['pack', '--json', '--pack-destination', smokeDir],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...isolatedEnv,
        npm_config_cache: npmCacheDir,
      },
    }
  );

  const [{ filename }] = JSON.parse(packJson);
  const tarballPath = path.join(smokeDir, filename);
  const extractDir = path.join(smokeDir, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });

  const tarCommand = process.platform === 'win32' ? 'tar.exe' : 'tar';
  execFileSync(tarCommand, ['-xf', tarballPath, '-C', extractDir], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  const packageRoot = path.join(extractDir, 'package');

  // Install the tarball's PRODUCTION dependencies, rather than symlinking
  // this repo's `node_modules` in.
  //
  // The symlink handed the packaged CLI the whole dev tree — vitest, the
  // TypeScript compiler, every transitive dev dependency — so an import that
  // resolved here would also resolve for a user only if that package
  // happened to be a runtime dependency too. A `dependencies` entry moved to
  // `devDependencies`, or forgotten entirely, passed this smoke test and
  // broke on the first real install. `smoke-packed-artifact.mjs` already
  // makes this distinction and says why in its own comment; this one
  // borrowed the dev tree instead.
  npmSync(['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: packageRoot,
    stdio: 'inherit',
    env: { ...isolatedEnv, npm_config_cache: npmCacheDir },
  });
  const cliEntry = path.join(packageRoot, 'dist', 'transports', 'cli', 'cli.js');
  const commonEnv = {
    ...isolatedEnv,
    // This spawns the REAL CLI serve, which opts into the background npm
    // update-check. CI must not depend on the npm registry here.
    MEMESH_SKIP_UPDATE_CHECK: '1',
  };

  // Use a work-layer type (lesson_learned) instead of 'note'. The
  // Memories tab defaults to Signal Mode = ON, which scopes the list to
  // the work layer (WORK_LAYER_TYPES in src/core/work-topology.ts).
  // 'note' sits outside that layer and gets hidden under the default;
  // lesson_learned is work-layer and is visible without the user
  // toggling Signal Mode off.
  //
  // UX-1 change: dashboard now shows entity.title (or best observation) as
  // the primary display text, not entity.name. Set title explicitly so the
  // test can find it by the expected text. Without title, displayTitle()
  // falls back to the observation, which would be "Dashboard smoke test memory".
  runNode(cliEntry, [
    'remember',
    '--name', 'dashboard-e2e-memory',
    '--type', 'lesson_learned',
    '--title', 'dashboard-e2e-memory',
    '--obs', 'Dashboard smoke test memory',
    '--tags', 'project:dashboard-e2e',
  ], commonEnv);

  const port = await getAvailablePort();
  const healthUrl = `http://127.0.0.1:${port}/v1/health`;
  const dashboardUrl = `http://127.0.0.1:${port}/dashboard`;

  const server = spawn(process.execPath, [cliEntry, 'serve', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: packageRoot,
    env: commonEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Pipe server stdout/stderr through to ours so CI logs include them
  // when the smoke fails. Previously buffered into an unused string.
  server.stdout.on('data', (chunk) => { process.stdout.write(`[server] ${chunk.toString()}`); });
  server.stderr.on('data', (chunk) => { process.stderr.write(`[server] ${chunk.toString()}`); });

  try {
    await waitForServer(healthUrl, server);
    const configResponse = await fetch(`http://127.0.0.1:${port}/v1/config`);
    assert.equal(configResponse.status, 200, 'isolated config readback should succeed');
    const configPayload = await configResponse.json();
    assert.equal(configPayload.success, true, 'isolated config readback should return success');
    assert.equal(configPayload.data.capabilities.llm, null, 'Dashboard E2E must not inherit an owner LLM provider');
    assert.equal(configPayload.data.capabilities.llmSource, 'none', 'Dashboard E2E provider source must stay isolated');
    const browser = await launchBrowser();

    try {
      const context = await browser.newContext();
      await context.addInitScript(() => {
        localStorage.setItem('memesh-locale', 'en');
      });

      const page = await context.newPage();
      page.on('pageerror', (error) => {
        pageErrors.push(error.message);
      });
      page.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push(message.text());
        }
      });

      // Open the dashboard with ?tab=Memories to land on the "All Memories"
      // library view directly. Default tab is "Home" (the 8→5 tab merge),
      // which leads with insights, not the entity list this smoke seeds.
      await page.goto(`${dashboardUrl}?tab=Memories`, { waitUntil: 'networkidle' });
      await expectVisible(page, 'All Memories');
      await expectVisible(page, 'dashboard-e2e-memory');

      // The ranked server search lives inside the Memories tab now: typing
      // filters client-side, the Search button (inside .search-bar) POSTs
      // /v1/recall. "ranked by relevance" only renders in recall mode, so
      // its presence proves the server search answered — the row alone
      // would, since UX-2, already be visible from the browsing list.
      await page.getByPlaceholder(/Filter as you type/i).fill('dashboard-e2e-memory');
      await page.locator('.search-bar').getByRole('button', { name: 'Search' }).click();
      await expectVisible(page, 'ranked by relevance');
      await expectVisible(page, 'dashboard-e2e-memory');

      // Tab switching on a real browser: the nav is a WAI-ARIA tablist
      // (tabs are role=tab, not plain buttons). The Project tab derives its
      // project list from the seeded `project:dashboard-e2e` tag and
      // auto-selects the only project. Scope the assertion to the Project
      // panel — the Memories panel stays mounted (hidden) after the switch
      // and also contains the project name.
      await page.getByRole('navigation').getByRole('tab', { name: 'Project' }).click();
      await page.locator('#panel-Project').getByText('dashboard-e2e', { exact: false }).first()
        .waitFor({ state: 'visible', timeout: 10000 });

      await page.getByRole('navigation').getByRole('tab', { name: 'Settings' }).click();
      // Target the language <select> specifically — Settings has multiple
      // <select> elements (model picker, auto-update policy, locale), so
      // a bare `select` selector is ambiguous. Find the one that contains
      // the zh-TW option, which only the language select does.
      const languageSelect = page.locator('select:has(option[value="zh-TW"])');
      await languageSelect.waitFor({ state: 'visible', timeout: 10000 });

      await page.evaluate(() => {
        window.__memeshSmokeMarker = 'persist';
      });
      await languageSelect.selectOption('zh-TW');
      await expectVisible(page, '語言');
      assert.equal(
        await page.evaluate(() => window.__memeshSmokeMarker),
        'persist',
        'Locale switch triggered a full reload'
      );

      await languageSelect.selectOption('en');
      await expectVisible(page, 'Language');
      assert.equal(
        await page.evaluate(() => window.__memeshSmokeMarker),
        'persist',
        'Locale switch back to English triggered a full reload'
      );

      // Reproduce the compatible Dream path against the packaged dashboard.
      // Keep the provider and proposal lifecycle deterministic while leaving
      // every other request (including health) on the real server.
      const dreamPage = await context.newPage();
      const dreamPageErrors = [];
      const dreamConsoleErrors = [];
      const proposal = {
        id: 1,
        project: 'dashboard-e2e',
        cluster_key: 'dashboard-e2e-cluster',
        source_count: 1,
        digest_name: 'dashboard-e2e-dream-proposal',
        digest_observations_preview: 'Dashboard Dream smoke proposal',
        status: 'pending',
        created_at: '2026-08-31 00:00:00',
        kind: 'digest',
      };
      let dreamRuns = 0;
      let proposalReads = 0;
      dreamPage.on('pageerror', (error) => dreamPageErrors.push(error.message));
      dreamPage.on('console', (message) => {
        if (message.type() === 'error') dreamConsoleErrors.push(message.text());
      });
      await dreamPage.route('**/v1/config', (route) => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { capabilities: { llm: { provider: 'openai' } } } }),
      }));
      await dreamPage.route('**/v1/dream/run', async (route) => {
        assert.equal(route.request().method(), 'POST');
        dreamRuns += 1;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { proposalsCreated: 1, llmCalls: 1, skipped: [] },
          }),
        });
      });
      await dreamPage.route(/\/v1\/dream\/proposals(?:\?.*)?$/, async (route) => {
        assert.equal(route.request().method(), 'GET');
        proposalReads += 1;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: dreamRuns === 1 ? [proposal] : [] }),
        });
      });
      await dreamPage.goto(`${dashboardUrl}?tab=Home`, { waitUntil: 'networkidle' });
      assert.equal(
        await dreamPage.getByText('dashboard-e2e-dream-proposal', { exact: true }).count(),
        0,
        'Dream proposal must not be visible before the run succeeds',
      );
      await dreamPage.getByRole('button', { name: 'Run weekly recap', exact: true }).click();
      await expectVisible(dreamPage, 'dashboard-e2e-dream-proposal');
      assert.equal(dreamRuns, 1, 'Dream run should POST exactly once');
      assert.ok(proposalReads >= 2, `Dream proposals should be read at least twice (got ${proposalReads})`);
      assert.deepEqual(dreamPageErrors, [], `Dream page errors detected:\n${dreamPageErrors.join('\n')}`);
      assert.deepEqual(dreamConsoleErrors, [], `Dream console errors detected:\n${dreamConsoleErrors.join('\n')}`);

      assert.deepEqual(pageErrors, [], `Dashboard page errors detected:\n${pageErrors.join('\n')}`);
      assert.deepEqual(consoleErrors, [], `Dashboard console errors detected:\n${consoleErrors.join('\n')}`);
    } finally {
      await browser.close();
    }
  } finally {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await onceExit(server);
    }
    fs.rmSync(smokeDir, { recursive: true, force: true });
  }

  console.log('Dashboard packaged e2e smoke passed');
}

async function expectVisible(page, text) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 10000 });
}

async function onceExit(child) {
  await new Promise((resolve) => {
    child.once('exit', () => resolve());
  });
}

// Guard so importing this module (the regression test in
// tests/release-scripts-safety.test.ts imports buildIsolatedRuntimeEnv above)
// does not also run the smoke. Matches the idiom already used in
// scripts/hooks/auto-update-runner.mjs — realpathSync + pathToFileURL rather
// than `new URL(import.meta.url).pathname`, which
// tests/release-scripts-safety.test.ts's "resolves module paths with
// fileURLToPath" gate forbids repo-wide (it breaks on Windows drive paths).
const invokedPath = process.argv[1]
  ? pathToFileURL(fs.realpathSync(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
