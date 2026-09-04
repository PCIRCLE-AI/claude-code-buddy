import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { npmSync } from './lib/npm-bin.mjs';
import { assertEveryPathProven, fetchPackument, selectUpgradePaths } from './lib/upgrade-matrix.mjs';

// This is deliberately a narrow upgrade proof, not a second copy of
// smoke-packed-artifact.mjs. That script validates a fresh consumer install;
// this one proves that a real npm-global install of a published version keeps
// its local data when npm replaces it with the exact packed candidate.
//
// Which versions it starts from is derived, not written down here: see
// `scripts/lib/upgrade-matrix.mjs` for why a hand-written pin goes on passing
// for a path nobody upgrades along.
const packageName = '@pcircle/memesh';
const repoRoot = process.cwd();
const npmTimeoutMs = 180_000;
const processTimeoutMs = 45_000;
const upgradeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-packed-upgrade-'));

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(binary, args, options = {}) {
  return execFileSync(binary, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: processTimeoutMs,
    killSignal: 'SIGTERM',
    ...options,
  });
}

function installedBin(prefix, name) {
  const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  return path.join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
}

function installedEntry(packageRoot, relativePath) {
  const entry = path.join(packageRoot, relativePath);
  assert.ok(fs.existsSync(entry), `installed package entry is missing: ${relativePath}`);
  // Invoke installed JavaScript through this Node runtime instead of executing
  // npm's Windows .cmd shim. The shim is still asserted above, while this is
  // portable and ensures the process always loads the global package tree.
  return entry;
}

function isolatedNpmEnv({ home, memeshDir, prefix, cache, userconfig }) {
  // HOME alone is insufficient: an exported MEMESH_DB_PATH would otherwise
  // route this acceptance test back to a maintainer's real database.
  const env = {
    ...process.env,
    HOME: home,
    MEMESH_DIR: memeshDir,
    MEMESH_AUTO_CAPTURE: 'false',
    MEMESH_AUTO_DETECT_LLM: '0',
    npm_config_prefix: prefix,
    npm_config_cache: cache,
    npm_config_userconfig: userconfig,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
  delete env.MEMESH_DB_PATH;
  return env;
}

function globalPackageRoot(prefix, env) {
  return String(npmSync(['root', '--global', '--prefix', prefix], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    timeout: processTimeoutMs,
    killSignal: 'SIGTERM',
  })).trim();
}

function readInstalledPackage(prefix, env) {
  const packageRoot = path.join(globalPackageRoot(prefix, env), '@pcircle', 'memesh');
  const packageJson = path.join(packageRoot, 'package.json');
  assert.ok(fs.existsSync(packageJson), `npm global install did not create ${packageJson}`);
  return { packageRoot, packageJson: JSON.parse(fs.readFileSync(packageJson, 'utf8')) };
}

function npmGlobalInstall(specifier, prefix, env, mustFail = false) {
  let failure;
  try {
    npmSync(['install', '--global', '--prefix', prefix, '--cache', env.npm_config_cache, '--userconfig', env.npm_config_userconfig, specifier], {
      cwd: repoRoot,
      stdio: 'inherit',
      env,
      timeout: npmTimeoutMs,
      killSignal: 'SIGTERM',
    });
  } catch (error) {
    failure = error;
  }

  if (mustFail) {
    assert.ok(failure, `invalid candidate unexpectedly installed: ${specifier}`);
    assert.equal(failure.signal, null, 'invalid candidate npm install timed out instead of rejecting it');
    assert.notEqual(failure.status, 0, 'invalid candidate npm install did not return a failing exit status');
    return;
  }
  if (failure) throw failure;
}

function runCandidateAutoUpdate({ candidateTarball, candidateVersion, env, rowRoot }) {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli && path.isAbsolute(npmCli) && fs.existsSync(npmCli),
    'npm_execpath must identify the npm CLI running this release gate');
  const stage = path.join(rowRoot, 'candidate-stage');
  const shimDir = path.join(rowRoot, 'npm-shim');
  const calls = path.join(rowRoot, 'auto-update-npm-calls.log');
  fs.mkdirSync(shimDir, { recursive: true });
  npmSync(['install', '--prefix', stage, '--omit=dev', '--cache', env.npm_config_cache,
    '--userconfig', env.npm_config_userconfig, candidateTarball], {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
    timeout: npmTimeoutMs,
    killSignal: 'SIGTERM',
  });
  const runner = path.join(stage, 'node_modules', '@pcircle', 'memesh', 'scripts', 'hooks', 'auto-update-runner.mjs');
  assert.ok(fs.existsSync(runner), 'packed candidate is missing its auto-update runner');

  const shim = path.join(shimDir, 'npm');
  fs.writeFileSync(shim, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MEMESH_UPGRADE_NPM_CALLS, args.join(' ') + '\\n');
if (args[0] === 'install' && process.env.MEMESH_UPGRADE_FORCE_FAILURE === '1') process.exit(42);
const target = args.indexOf(process.env.MEMESH_UPGRADE_SPECIFIER);
if (target >= 0) args[target] = process.env.MEMESH_UPGRADE_TARBALL;
const child = spawnSync(process.execPath, [process.env.MEMESH_UPGRADE_NPM_CLI, ...args], {
  stdio: 'inherit', env: process.env,
});
if (child.error) throw child.error;
process.exit(child.status ?? 1);
`, { mode: 0o700 });

  const specifier = `${packageName}@${candidateVersion}`;
  const runnerEnv = {
    ...env,
    PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
    MEMESH_UPGRADE_NPM_CALLS: calls,
    MEMESH_UPGRADE_NPM_CLI: npmCli,
    MEMESH_UPGRADE_TARBALL: candidateTarball,
    MEMESH_UPGRADE_SPECIFIER: specifier,
  };
  const lockPath = path.join(rowRoot, 'auto-update.lock');
  const success = spawnSync(process.execPath, [runner, candidateVersion, lockPath], {
    cwd: stage,
    env: runnerEnv,
    encoding: 'utf8',
    timeout: npmTimeoutMs,
    killSignal: 'SIGTERM',
  });
  assert.equal(success.status, 0, success.stderr || success.stdout);
  assert.ok(success.stdout.includes(`START target=${candidateVersion}`),
    `auto-update runner did not announce the candidate: ${success.stdout}`);
  assert.ok(success.stdout.includes(`SUCCESS target=${candidateVersion} installed=${candidateVersion}`),
    `auto-update runner did not read back the candidate it installed: ${success.stdout}`);
  assert.doesNotMatch(success.stderr, /FAILED/);
  assert.equal(fs.existsSync(lockPath), false, 'successful auto-update left its lock behind');
  const callLines = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.ok(callLines.includes(`install -g ${specifier}`), 'runner did not request the exact candidate version');
  assert.ok(callLines.some(line => line.startsWith(`ls -g ${packageName}`)), 'runner did not read back the installed version');
  return { runner, runnerEnv, lockPath };
}

/**
 * Speak MCP to an installed server.
 *
 * `requiredTools` is per call rather than one shared list: the seed runs
 * against a published version that predates the candidate, and asserting the
 * candidate's tool surface there would make an old row red for tools its
 * release never claimed to have. The seed needs `remember`; the readback needs
 * the tools this candidate ships.
 */
function runMcp(serverPath, packageRoot, env, mode, requiredTools) {
  const source = `
    import assert from 'node:assert/strict';
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

    const serverPath = ${JSON.stringify(serverPath)};
    const mode = ${JSON.stringify(mode)};
    const requiredTools = ${JSON.stringify(requiredTools)};
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: process.env,
    });
    const client = new Client({ name: 'memesh-packed-upgrade', version: '1.0.0' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      for (const required of requiredTools) {
        assert.ok(names.includes(required), 'installed MCP tool surface is missing ' + required);
      }

      if (mode === 'seed') {
        const saved = await client.callTool({
          name: 'remember',
          arguments: {
            name: 'packed-upgrade-existing-memory',
            type: 'fact',
            observations: ['This marker was written by the installed baseline MCP server before upgrade.'],
            tags: ['packed-upgrade'],
          },
        });
        assert.notEqual(saved.isError, true, 'baseline MCP remember failed');
      } else {
        const recalled = await client.callTool({
          name: 'recall',
          arguments: { query: 'packed-upgrade-existing-memory', limit: 5 },
        });
        assert.notEqual(recalled.isError, true, 'candidate MCP recall failed');
        assert.match(JSON.stringify(recalled), /packed-upgrade-existing-memory/,
          'candidate MCP could not read the baseline memory');
      }
    } finally {
      await client.close();
    }
  `;
  run(process.execPath, ['--input-type=module', '-e', source], {
    cwd: packageRoot,
    env,
  });
}

/**
 * One row of the matrix: install `fromVersion` from the registry, write a
 * memory through it, upgrade it to the packed candidate, and require the
 * memory, the binaries and the version readback to survive — then force the
 * upgrade's child-process boundary to fail and require it to say so.
 */
function proveUpgradePath({ fromVersion, candidateVersion, candidateTarball, cache, userconfig }) {
  const rowRoot = path.join(upgradeRoot, `from-${fromVersion}`);
  const home = path.join(rowRoot, 'home');
  const memeshDir = path.join(rowRoot, 'memesh-data');
  const prefix = path.join(rowRoot, 'npm-prefix');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(memeshDir, { recursive: true });
  const env = isolatedNpmEnv({ home, memeshDir, prefix, cache, userconfig });

  npmGlobalInstall(`${packageName}@${fromVersion}`, prefix, env);
  let installed = readInstalledPackage(prefix, env);
  assert.equal(installed.packageJson.version, fromVersion,
    `the isolated baseline is not the public v${fromVersion} package`);
  const oldCli = installedBin(prefix, 'memesh');
  const oldMcp = installedBin(prefix, 'memesh-mcp');
  assert.ok(fs.existsSync(oldCli), `v${fromVersion} npm-global CLI is missing`);
  assert.equal(installed.packageJson.bin?.['memesh-mcp'], 'dist/mcp/server.js',
    `public v${fromVersion} package does not declare the expected MCP binary`);
  assert.ok(fs.existsSync(oldMcp), `public v${fromVersion} tarball did not install the memesh-mcp binary`);
  const oldCliEntry = installedEntry(installed.packageRoot, 'dist/transports/cli/cli.js');
  const oldMcpEntry = installedEntry(installed.packageRoot, 'dist/mcp/server.js');
  assert.equal(run(process.execPath, [oldCliEntry, '--version'], { cwd: installed.packageRoot, env }).trim(), fromVersion);
  runMcp(oldMcpEntry, installed.packageRoot, env, 'seed', ['remember', 'recall']);
  console.log(`baseline: version=${installed.packageJson.version} package=${installed.packageRoot}`);

  const autoUpdate = process.platform === 'win32'
    ? (npmGlobalInstall(candidateTarball, prefix, env), null)
    : runCandidateAutoUpdate({ candidateTarball, candidateVersion, env, rowRoot });
  installed = readInstalledPackage(prefix, env);
  assert.equal(installed.packageJson.version, candidateVersion,
    `npm did not replace the isolated global install with v${candidateVersion}`);
  const candidateCli = installedBin(prefix, 'memesh');
  const candidateMcp = installedBin(prefix, 'memesh-mcp');
  assert.ok(fs.existsSync(candidateCli), 'candidate npm-global CLI is missing');
  assert.ok(fs.existsSync(candidateMcp), 'candidate npm-global MCP binary is missing');
  const candidateCliEntry = installedEntry(installed.packageRoot, 'dist/transports/cli/cli.js');
  const candidateMcpEntry = installedEntry(installed.packageRoot, 'dist/mcp/server.js');
  assert.equal(run(process.execPath, [candidateCliEntry, '--version'], { cwd: installed.packageRoot, env }).trim(), candidateVersion);
  assert.match(run(process.execPath, [candidateCliEntry, '--help'], { cwd: installed.packageRoot, env }), /remember/,
    'candidate CLI help is not readable');
  const doctor = JSON.parse(run(process.execPath, [candidateCliEntry, 'doctor', '--json'], { cwd: installed.packageRoot, env }));
  assert.ok(Array.isArray(doctor.checks), 'candidate doctor output is not readable JSON diagnostics');

  for (const requiredFile of [
    'package.json',
    '.claude-plugin/mcp.json',
    'dist/transports/cli/cli.js',
    'dist/mcp/server.js',
    'dist/core/doctor.js',
    'dist/core/install-channel.js',
  ]) {
    assert.ok(fs.existsSync(path.join(installed.packageRoot, requiredFile)),
      `candidate package is missing ${requiredFile}`);
  }
  const recalledByCli = JSON.parse(run(process.execPath, [candidateCliEntry, 'recall', 'packed-upgrade-existing-memory', '--json'], {
    cwd: installed.packageRoot,
    env,
  }));
  assert.match(JSON.stringify(recalledByCli), /packed-upgrade-existing-memory/,
    `candidate CLI could not read the v${fromVersion} memory`);
  runMcp(candidateMcpEntry, installed.packageRoot, env, 'verify', ['remember', 'recall', 'briefing', 'task_state']);
  console.log(`upgrade: from=${fromVersion} version=${installed.packageJson.version} package=${installed.packageRoot} data=${memeshDir}`);

  // Force the same installed runner's real child-process boundary to fail.
  // It must not print SUCCESS, retain a lock, replace the usable package, or
  // make the pre-upgrade data unreadable.
  if (autoUpdate) {
    const failed = spawnSync(process.execPath, [
      autoUpdate.runner, candidateVersion, autoUpdate.lockPath,
    ], {
      cwd: path.dirname(autoUpdate.runner),
      env: { ...autoUpdate.runnerEnv, MEMESH_UPGRADE_FORCE_FAILURE: '1' },
      encoding: 'utf8',
      timeout: processTimeoutMs,
      killSignal: 'SIGTERM',
    });
    assert.equal(failed.status, 1, failed.stderr || failed.stdout);
    assert.doesNotMatch(failed.stdout, /SUCCESS/);
    assert.ok(failed.stderr.includes(`FAILED target=${candidateVersion} stage=install-or-readback`),
      `failed auto-update did not name the stage it failed at: ${failed.stderr}`);
    assert.equal(fs.existsSync(autoUpdate.lockPath), false, 'failed auto-update left its lock behind');
  } else {
    npmGlobalInstall(path.join(rowRoot, `not-a-memesh-v${candidateVersion}-candidate.tgz`), prefix, env, true);
  }
  installed = readInstalledPackage(prefix, env);
  assert.equal(installed.packageJson.version, candidateVersion,
    `failed upgrade changed the existing v${candidateVersion} package`);
  const afterFailure = JSON.parse(run(process.execPath, [candidateCliEntry, 'recall', 'packed-upgrade-existing-memory', '--json'], {
    cwd: installed.packageRoot,
    env,
  }));
  assert.match(JSON.stringify(afterFailure), /packed-upgrade-existing-memory/,
    'failed upgrade made pre-existing data unreadable');
  console.log(`failure-path: from=${fromVersion} the auto-update install failure was reported without SUCCESS; the candidate CLI and pre-existing data remain readable`);
}

try {
  const candidatePackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const candidateVersion = candidatePackage.version;
  const cache = path.join(upgradeRoot, 'npm-cache');
  const userconfig = path.join(upgradeRoot, 'npmrc');
  // One registry answers both questions. The versions used to be derived from
  // `npm config get registry` while every install was pinned to
  // registry.npmjs.org, so on a machine behind a mirror the matrix could name
  // versions the installs could not fetch — or worse, agree by accident.
  const registry = String(npmSync(['config', 'get', 'registry'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: processTimeoutMs,
    killSignal: 'SIGTERM',
  })).trim();
  fs.writeFileSync(userconfig, [
    `registry=${registry}`,
    'audit=false',
    'fund=false',
    'update-notifier=false',
    '',
  ].join('\n'));
  const packument = await fetchPackument(packageName, registry);
  const upgradePaths = selectUpgradePaths(packument, candidateVersion);
  console.log(`matrix: candidate=${candidateVersion} registry=${registry} from=${upgradePaths.join(', ')}`);

  const packEnv = isolatedNpmEnv({
    home: path.join(upgradeRoot, 'pack-home'),
    memeshDir: path.join(upgradeRoot, 'pack-data'),
    prefix: path.join(upgradeRoot, 'pack-prefix'),
    cache,
    userconfig,
  });
  const packJson = npmSync(['pack', '--json', '--pack-destination', upgradeRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: packEnv,
    timeout: processTimeoutMs,
    killSignal: 'SIGTERM',
  });
  const [{ filename }] = JSON.parse(packJson);
  const candidateTarball = path.join(upgradeRoot, filename);
  assert.ok(fs.existsSync(candidateTarball), `npm pack did not create ${candidateTarball}`);
  console.log(`candidate: version=${candidateVersion} tarball=${filename} sha256=${sha256(candidateTarball)}`);

  const proven = [];
  for (const fromVersion of upgradePaths) {
    console.log(`--- upgrade path: ${fromVersion} -> ${candidateVersion}`);
    proveUpgradePath({ fromVersion, candidateVersion, candidateTarball, cache, userconfig });
    proven.push(fromVersion);
  }
  assertEveryPathProven(upgradePaths, proven);

  console.log(`✅ Packaged upgrade smoke passed — ${proven.length} upgrade path(s) proved: `
    + proven.map((from) => `${from} -> ${candidateVersion}`).join(', '));
} finally {
  fs.rmSync(upgradeRoot, { recursive: true, force: true });
}
