import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const repoRoot = process.cwd();
const smokeDir = path.join(repoRoot, 'tmp', 'dashboard-e2e-smoke');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
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

async function main() {
  cleanupDir(smokeDir);
  fs.mkdirSync(smokeDir, { recursive: true });

  const packJson = execFileSync(
    npmCommand,
    ['pack', '--json', '--pack-destination', smokeDir],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
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
  const packagedNodeModules = path.join(packageRoot, 'node_modules');
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), packagedNodeModules, 'junction');
  const cliEntry = path.join(packageRoot, 'dist', 'transports', 'cli', 'cli.js');
  const dbPath = path.join(smokeDir, 'knowledge-graph.db');
  const commonEnv = {
    ...process.env,
    MEMESH_DB_PATH: dbPath,
  };

  runNode(cliEntry, [
    'remember',
    '--name', 'dashboard-e2e-memory',
    '--type', 'note',
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

  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

  try {
    await waitForServer(healthUrl, server);

    const chromeExecutable = getChromeExecutablePath();
    assert.ok(chromeExecutable, 'Google Chrome executable not found. Set CHROME_PATH to run dashboard e2e smoke.');

    const browser = await chromium.launch({
      executablePath: chromeExecutable,
      headless: true,
    });

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

      await page.goto(dashboardUrl, { waitUntil: 'networkidle' });
      await expectVisible(page, 'All Memories');
      await expectVisible(page, 'dashboard-e2e-memory');

      await page.getByRole('navigation').getByRole('button', { name: 'Search' }).click();
      await page.getByPlaceholder(/Search your memories/i).fill('dashboard-e2e-memory');
      await page.locator('.search-bar').getByRole('button', { name: 'Search' }).click();
      await expectVisible(page, 'dashboard-e2e-memory');

      await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click();
      await page.waitForSelector('select');

      await page.evaluate(() => {
        window.__memeshSmokeMarker = 'persist';
      });
      await page.selectOption('select', 'zh-TW');
      await expectVisible(page, '語言');
      assert.equal(
        await page.evaluate(() => window.__memeshSmokeMarker),
        'persist',
        'Locale switch triggered a full reload'
      );

      await page.selectOption('select', 'en');
      await expectVisible(page, 'Language');
      assert.equal(
        await page.evaluate(() => window.__memeshSmokeMarker),
        'persist',
        'Locale switch back to English triggered a full reload'
      );

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

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
