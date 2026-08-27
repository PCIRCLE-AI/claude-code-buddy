import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { npmSync } from './lib/npm-bin.mjs';

// This is deliberately a narrow upgrade proof, not a second copy of
// smoke-packed-artifact.mjs. That script validates a fresh consumer install;
// this one proves that an actual npm-global 4.7.3 install keeps its local
// data when npm replaces it with the exact packed 4.8.0 candidate.
const repoRoot = process.cwd();
const expectedPreviousVersion = '4.7.3';
const expectedCandidateVersion = '4.8.0';
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

function runMcp(serverPath, packageRoot, env, mode) {
  const source = `
    import assert from 'node:assert/strict';
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

    const serverPath = ${JSON.stringify(serverPath)};
    const mode = ${JSON.stringify(mode)};
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
      for (const required of ['remember', 'recall', 'briefing', 'task_state']) {
        assert.ok(names.includes(required), 'installed MCP tool surface is missing ' + required);
      }

      if (mode === 'seed') {
        const saved = await client.callTool({
          name: 'remember',
          arguments: {
            name: 'packed-upgrade-existing-memory',
            type: 'fact',
            observations: ['This marker was written by the installed v4.7.3 MCP server before upgrade.'],
            tags: ['packed-upgrade'],
          },
        });
        assert.notEqual(saved.isError, true, 'v4.7.3 MCP remember failed');
      } else {
        const recalled = await client.callTool({
          name: 'recall',
          arguments: { query: 'packed-upgrade-existing-memory', limit: 5 },
        });
        assert.notEqual(recalled.isError, true, 'candidate MCP recall failed');
        assert.match(JSON.stringify(recalled), /packed-upgrade-existing-memory/,
          'candidate MCP could not read the v4.7.3 memory');
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

try {
  const candidatePackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(candidatePackage.version, expectedCandidateVersion,
    `this acceptance only permits the v${expectedCandidateVersion} candidate, not v${candidatePackage.version}`);

  const home = path.join(upgradeRoot, 'home');
  const memeshDir = path.join(upgradeRoot, 'memesh-data');
  const prefix = path.join(upgradeRoot, 'npm-prefix');
  const cache = path.join(upgradeRoot, 'npm-cache');
  const userconfig = path.join(upgradeRoot, 'npmrc');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(memeshDir, { recursive: true });
  fs.writeFileSync(userconfig, [
    'registry=https://registry.npmjs.org/',
    'audit=false',
    'fund=false',
    'update-notifier=false',
    '',
  ].join('\n'));
  const env = isolatedNpmEnv({ home, memeshDir, prefix, cache, userconfig });

  const packJson = npmSync(['pack', '--json', '--pack-destination', upgradeRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    timeout: processTimeoutMs,
    killSignal: 'SIGTERM',
  });
  const [{ filename }] = JSON.parse(packJson);
  const candidateTarball = path.join(upgradeRoot, filename);
  assert.ok(fs.existsSync(candidateTarball), `npm pack did not create ${candidateTarball}`);
  console.log(`candidate: version=${candidatePackage.version} tarball=${filename} sha256=${sha256(candidateTarball)}`);

  npmGlobalInstall(`@pcircle/memesh@${expectedPreviousVersion}`, prefix, env);
  let installed = readInstalledPackage(prefix, env);
  assert.equal(installed.packageJson.version, expectedPreviousVersion,
    'the isolated baseline is not the public v4.7.3 package');
  const oldCli = installedBin(prefix, 'memesh');
  const oldMcp = installedBin(prefix, 'memesh-mcp');
  assert.ok(fs.existsSync(oldCli), 'v4.7.3 npm-global CLI is missing');
  assert.equal(installed.packageJson.bin?.['memesh-mcp'], 'dist/mcp/server.js',
    'public v4.7.3 package does not declare the expected MCP binary');
  assert.ok(fs.existsSync(oldMcp), 'public v4.7.3 tarball did not install the memesh-mcp binary');
  const oldCliEntry = installedEntry(installed.packageRoot, 'dist/transports/cli/cli.js');
  const oldMcpEntry = installedEntry(installed.packageRoot, 'dist/mcp/server.js');
  assert.equal(run(process.execPath, [oldCliEntry, '--version'], { cwd: installed.packageRoot, env }).trim(), expectedPreviousVersion);
  runMcp(oldMcpEntry, installed.packageRoot, env, 'seed');
  console.log(`baseline: version=${installed.packageJson.version} package=${installed.packageRoot}`);

  npmGlobalInstall(candidateTarball, prefix, env);
  installed = readInstalledPackage(prefix, env);
  assert.equal(installed.packageJson.version, expectedCandidateVersion,
    'npm did not replace the isolated global install with v4.8.0');
  const candidateCli = installedBin(prefix, 'memesh');
  const candidateMcp = installedBin(prefix, 'memesh-mcp');
  assert.ok(fs.existsSync(candidateCli), 'candidate npm-global CLI is missing');
  assert.ok(fs.existsSync(candidateMcp), 'candidate npm-global MCP binary is missing');
  const candidateCliEntry = installedEntry(installed.packageRoot, 'dist/transports/cli/cli.js');
  const candidateMcpEntry = installedEntry(installed.packageRoot, 'dist/mcp/server.js');
  assert.equal(run(process.execPath, [candidateCliEntry, '--version'], { cwd: installed.packageRoot, env }).trim(), expectedCandidateVersion);
  assert.match(run(process.execPath, [candidateCliEntry, '--help'], { cwd: installed.packageRoot, env }), /remember/,
    'candidate CLI help is not readable');
  const doctor = JSON.parse(run(process.execPath, [candidateCliEntry, 'doctor', '--json'], { cwd: installed.packageRoot, env }));
  assert.ok(Array.isArray(doctor.checks), 'candidate doctor output is not readable JSON diagnostics');

  for (const requiredFile of [
    'package.json',
    '.mcp.json',
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
    'candidate CLI could not read the v4.7.3 memory');
  runMcp(candidateMcpEntry, installed.packageRoot, env, 'verify');
  console.log(`upgrade: version=${installed.packageJson.version} package=${installed.packageRoot} data=${memeshDir}`);

  // Run a real npm failure against the already-upgraded disposable prefix.
  // This is the direct falsification boundary: resolution must fail before
  // npm can replace the usable v4.8.0 install or its v4.7.3-era data.
  npmGlobalInstall(path.join(upgradeRoot, 'not-a-memesh-v4.8.0-candidate.tgz'), prefix, env, true);
  installed = readInstalledPackage(prefix, env);
  assert.equal(installed.packageJson.version, expectedCandidateVersion,
    'failed upgrade changed the existing v4.8.0 package');
  const afterFailure = JSON.parse(run(process.execPath, [candidateCliEntry, 'recall', 'packed-upgrade-existing-memory', '--json'], {
    cwd: installed.packageRoot,
    env,
  }));
  assert.match(JSON.stringify(afterFailure), /packed-upgrade-existing-memory/,
    'failed upgrade made pre-existing data unreadable');
  console.log('failure-path: invalid candidate rejected in the upgraded prefix; v4.8.0 CLI and pre-existing data remain readable');
  console.log('✅ Packaged upgrade smoke passed — public v4.7.3 npm-global data survived an exact local v4.8.0 candidate upgrade.');
} finally {
  fs.rmSync(upgradeRoot, { recursive: true, force: true });
}
