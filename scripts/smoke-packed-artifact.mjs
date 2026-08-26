import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { binTargets, hookCommands, mcpEntry } from './lib/executable-targets.mjs';
import { npmSync } from './lib/npm-bin.mjs';

const repoRoot = process.cwd();

// OUTSIDE the repository, deliberately.
//
// This used to extract into `<repoRoot>/tmp/pack-smoke`, so when the import
// check below loaded the packaged `dist/index.js`, every bare specifier
// resolved by walking UP into the repo's own `node_modules` — devDependencies
// included. Verified: `sqlite-vec` resolved to the repo tree. The gate
// therefore could not see a missing runtime dependency. It also printed
// "installs" for an install that never happened.
//
// In os.tmpdir() nothing resolves upward, so the install below is the only
// thing that can satisfy the import — which is what makes the check mean
// something.
const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pack-smoke-'));
const npmCacheDir = process.env.MEMESH_NPM_CACHE ?? path.join(os.tmpdir(), 'memesh-npm-cache');
// A release gate must fail boundedly when registry/cache resolution is
// unavailable. Without this timeout npm can sleep forever before any of the
// installed-artifact assertions run, which turns a network problem into a
// wedged pre-release review.
const consumerInstallTimeoutMs = 180_000;

const packJson = npmSync(['pack', '--json', '--pack-destination', smokeDir], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    npm_config_cache: npmCacheDir,
  },
});

const [{ filename }] = JSON.parse(packJson);
const tarballPath = path.join(smokeDir, filename);
const extractDir = path.join(smokeDir, 'extract');

fs.mkdirSync(extractDir, { recursive: true });

// Use platform-aware tar extraction.
// Windows 10+ (required by Node 20+) ships tar.exe, but locate it
// explicitly via ComSpec fallback to handle PATH edge cases.
const tarCommand = process.platform === 'win32' ? 'tar.exe' : 'tar';
try {
  execFileSync(tarCommand, ['-xf', tarballPath, '-C', extractDir], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(
      `Error: '${tarCommand}' not found. ` +
      'Install tar or upgrade to Windows 10 1803+ (which bundles tar.exe).'
    );
    process.exit(1);
  }
  throw err;
}

const packageDir = path.join(extractDir, 'package');

const requiredFiles = [
  // Core
  'package.json',
  '.claude-plugin/plugin.json',
  '.mcp.json',
  'hooks/hooks.json',
  // Dist — core engine
  'dist/index.js',
  'dist/db.js',
  'dist/knowledge-graph.js',
  'dist/core/operations.js',
  'dist/core/types.js',
  'dist/core/config.js',
  'dist/core/scoring.js',
  'dist/core/failure-analyzer.js',
  'dist/core/lesson-engine.js',
  'dist/core/serializer.js',
  'dist/core/patterns.js',
  'dist/core/embedder.js',
  'dist/core/product-improvements.js',
  'dist/core/agent-messaging.js',
  'dist/core/agent-router.js',
  // Dist — transports
  'dist/transports/schemas.js',
  'dist/transports/agent-messaging.js',
  'dist/mcp/server.js',
  'dist/transports/mcp/handlers.js',
  'dist/transports/http/server.js',
  'dist/transports/cli/cli.js',
  // Host-native delivery is a separately installed runtime surface. The
  // router binary alone is not enough: its private client/config helpers and
  // each supported host runner must make the tarball too.
  'dist/host-runtime/router.js',
  'dist/host-runtime/router-client.js',
  'dist/host-runtime/config.js',
  'dist/host-runtime/codex.js',
  'dist/host-runtime/claude.js',
  'dist/host-runtime/acp.js',
  // Dist — dashboard assets
  'dist/cli/assets/d3.v7.min.js',
  // Hook support: hooks cannot import from dist/, so these are the whole of
  // their dependency surface. Missing, every hook throws on first require.
  // The hooks themselves are not listed here — they are derived from
  // hooks/hooks.json below, so adding one cannot silently go unchecked.
  'scripts/hooks/_shared.js',
  'scripts/hooks/_generated/core-paths.js',
  'scripts/hooks/_generated/fts-index.js',
  // Skills (2)
  'skills/memesh/SKILL.md',
  'skills/memesh-review/SKILL.md',
  // Dashboard build
  'dashboard/dist/index.html',
];

for (const relativePath of requiredFiles) {
  assert.ok(
    fs.existsSync(path.join(packageDir, relativePath)),
    `Missing packaged file: ${relativePath}`
  );
}

// Every hook the plugin manifest can invoke, and every command package.json
// declares, has to be in the tarball AND be runnable. Both lists are derived
// from their manifests (see scripts/lib/executable-targets.mjs) because both
// hand-written copies had drifted.
//
// Present-but-not-executable is the failure this checks for beyond existence:
// Claude Code exec()s hook commands directly, so a hook packed without its +x
// bit is a silent total dropout — the tarball looks complete and the hook
// never runs.
const declaredExecutables = [
  ...binTargets(packageDir).map((p) => ({ relativePath: p, kind: 'bin (package.json)' })),
  ...hookCommands(packageDir).map((p) => ({ relativePath: p, kind: 'hook (hooks/hooks.json)' })),
];

for (const { relativePath, kind } of declaredExecutables) {
  const full = path.join(packageDir, relativePath);
  assert.ok(fs.existsSync(full), `Missing packaged ${kind}: ${relativePath}`);

  if (process.platform !== 'win32') {
    assert.ok(
      fs.statSync(full).mode & 0o111,
      `Packaged ${kind} is not executable: ${relativePath} — it would be present but unrunnable`
    );
  }
}

// The script `.mcp.json` starts, derived from the manifest rather than from a
// hand-written path. A `/plugin install` user reaches memesh ONLY through this
// entry; when it named a file that had been renamed away, every MCP tool died
// with `-32000 failed to reconnect` and no gate said a word.
const mcpTarget = mcpEntry(packageDir);
assert.ok(
  fs.existsSync(path.join(packageDir, mcpTarget)),
  `.mcp.json starts ${mcpTarget}, which is not in the tarball — every MCP tool would fail to start`
);

const packagedJson = JSON.parse(
  fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')
);
assert.equal(packagedJson.name, '@pcircle/memesh');
assert.equal(packagedJson.version, JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version);

// Install the way a consumer does — production deps only, scripts ON so the
// native bindings actually build — into a project that has no relationship to
// this repo's node_modules. Without this the import below has nothing to
// resolve against, which is the point: it now proves the declared runtime
// dependencies are sufficient, rather than proving the dev tree exists.
const consumerDir = path.join(smokeDir, 'consumer');
fs.mkdirSync(consumerDir, { recursive: true });
npmSync(['init', '-y'], { cwd: consumerDir, stdio: 'ignore' });
npmSync(['install', '--omit=dev', tarballPath], {
  cwd: consumerDir,
  stdio: 'inherit',
  env: { ...process.env, npm_config_cache: npmCacheDir },
  timeout: consumerInstallTimeoutMs,
  killSignal: 'SIGTERM',
});

const installedRoot = path.join(consumerDir, 'node_modules', '@pcircle', 'memesh');
assert.ok(
  fs.existsSync(path.join(installedRoot, 'package.json')),
  'the packed tarball did not install — nothing was imported'
);

execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import * as pkg from ${JSON.stringify(path.join(installedRoot, 'dist', 'index.js'))};
if (typeof pkg.openDatabase !== 'function') {
  throw new Error('Packaged module missing openDatabase export');
}
if (typeof pkg.KnowledgeGraph !== 'function') {
  throw new Error('Packaged module missing KnowledgeGraph export');
}
// Exercise the runtime path, not just the export shape: opening a database
// loads sqlite-vec, which is where a dependency that was
// moved out of \`dependencies\` actually bites.
const db = pkg.openDatabase(${JSON.stringify(path.join(smokeDir, 'smoke.db'))});
if (!db) throw new Error('openDatabase returned nothing');
`,
  ],
  {
    cwd: consumerDir,
    stdio: 'inherit',
  }
);

// Exercise the actual MCP wire contract from the installed consumer tree.
// Importing handlers directly would miss the stdio initialize handshake,
// tool-list schema, and the server lifecycle that every host depends on.
const protocolHome = path.join(smokeDir, 'protocol-home');
fs.mkdirSync(protocolHome, { recursive: true });
const protocolServer = path.join(installedRoot, 'dist', 'mcp', 'server.js');
execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [${JSON.stringify(protocolServer)}],
  env: { ...process.env, HOME: ${JSON.stringify(protocolHome)}, MEMESH_AUTO_CAPTURE: 'false' },
});
const client = new Client({ name: 'memesh-packaged-smoke', version: '1.0.0' });
try {
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(
    names,
    ['briefing', 'export', 'forget', 'import', 'improvement', 'learn', 'message', 'recall', 'remember', 'task_state', 'user_patterns'],
    'installed MCP server exposed an unexpected tool surface'
  );

  const remembered = await client.callTool({
    name: 'remember',
    arguments: {
      name: 'packaged-protocol-smoke',
      type: 'fact',
      observations: ['The installed MCP protocol path is alive.'],
      tags: ['smoke'],
    },
  });
  assert.notEqual(remembered.isError, true, 'remember returned an MCP tool error');

  const recalled = await client.callTool({
    name: 'recall',
    arguments: { query: 'packaged-protocol-smoke', limit: 5 },
  });
  assert.notEqual(recalled.isError, true, 'recall returned an MCP tool error');
  assert.match(
    JSON.stringify(recalled),
    /packaged-protocol-smoke/,
    'recall did not return the memory written through MCP'
  );

  const sentMessage = await client.callTool({
    name: 'message',
    arguments: {
      action: 'send',
      project: 'packaged-protocol-smoke',
      sender: 'packaged-smoke-sender',
      recipient: 'packaged-smoke-recipient',
      idempotency_key: 'packaged-message-1',
      payload: { marker: 'packaged-payload-marker' },
      content_type: 'application/json',
    },
  });
  assert.notEqual(
    sentMessage.isError,
    true,
    'message send returned an MCP tool error: ' + JSON.stringify(sentMessage.content)
  );
  const sentMessageData = JSON.parse(sentMessage.content[0].text);

  const polledMessage = await client.callTool({
    name: 'message',
    arguments: {
      action: 'poll',
      project: 'packaged-protocol-smoke',
      recipient: 'packaged-smoke-recipient',
      wait_ms: 0,
    },
  });
  assert.notEqual(polledMessage.isError, true, 'message poll returned an MCP tool error');
  const polledMessageData = JSON.parse(polledMessage.content[0].text);
  assert.equal(polledMessageData.events[0].message_id, sentMessageData.message_id);
  assert.doesNotMatch(JSON.stringify(polledMessageData.events[0]), /packaged-payload-marker/);

  const fetchedMessage = await client.callTool({
    name: 'message',
    arguments: {
      action: 'fetch',
      project: 'packaged-protocol-smoke',
      recipient: 'packaged-smoke-recipient',
      message_id: sentMessageData.message_id,
    },
  });
  assert.notEqual(fetchedMessage.isError, true, 'message fetch returned an MCP tool error');
  assert.equal(JSON.parse(fetchedMessage.content[0].text).payload.marker, 'packaged-payload-marker');

  const intake = await client.callTool({ name: 'message', arguments: {
    action: 'intake', project: 'packaged-protocol-smoke', recipient: 'packaged-smoke-recipient',
    message_id: sentMessageData.message_id, idempotency_key: 'packaged-intake-1', intake_state: 'ingested',
  }});
  assert.notEqual(intake.isError, true, 'message intake returned an MCP tool error');
  const ack = await client.callTool({ name: 'message', arguments: {
    action: 'ack', project: 'packaged-protocol-smoke', recipient: 'packaged-smoke-recipient',
    message_id: sentMessageData.message_id, idempotency_key: 'packaged-ack-1',
  }});
  assert.notEqual(ack.isError, true, 'message ack returned an MCP tool error');
  const disposition = await client.callTool({ name: 'message', arguments: {
    action: 'disposition', project: 'packaged-protocol-smoke', recipient: 'packaged-smoke-recipient',
    message_id: sentMessageData.message_id, idempotency_key: 'packaged-disposition-1', disposition: 'accepted',
  }});
  assert.notEqual(disposition.isError, true, 'message disposition returned an MCP tool error');
  const activation = await client.callTool({ name: 'message', arguments: {
    action: 'activation', project: 'packaged-protocol-smoke', recipient: 'packaged-smoke-recipient',
    message_id: sentMessageData.message_id, idempotency_key: 'packaged-activation-1', activation: 'manual_resume_required',
  }});
  assert.notEqual(activation.isError, true, 'message activation returned an MCP tool error');
  const receipts = await client.callTool({ name: 'message', arguments: {
    action: 'receipts', project: 'packaged-protocol-smoke', recipient: 'packaged-smoke-recipient', message_id: sentMessageData.message_id,
  }});
  assert.notEqual(receipts.isError, true, 'message receipts returned an MCP tool error');
  assert.equal(JSON.parse(receipts.content[0].text).length, 4, 'receipt lifecycle was not persisted');

  const replay = await client.callTool({ name: 'message', arguments: {
    action: 'send', project: 'packaged-protocol-smoke', sender: 'packaged-smoke-sender', recipient: 'packaged-smoke-recipient',
    idempotency_key: 'packaged-message-1', payload: { marker: 'packaged-payload-marker' }, content_type: 'application/json',
  }});
  assert.notEqual(replay.isError, true, 'idempotent replay returned an MCP tool error');
  assert.equal(JSON.parse(replay.content[0].text).message_id, sentMessageData.message_id, 'idempotent replay created a second message');
  const conflict = await client.callTool({ name: 'message', arguments: {
    action: 'send', project: 'packaged-protocol-smoke', sender: 'packaged-smoke-sender', recipient: 'packaged-smoke-recipient',
    idempotency_key: 'packaged-message-1', payload: { marker: 'conflict' }, content_type: 'application/json',
  }});
  assert.equal(conflict.isError, true, 'conflicting idempotency replay was accepted');
  const deniedFetch = await client.callTool({ name: 'message', arguments: {
    action: 'fetch', project: 'packaged-protocol-smoke', recipient: 'other-recipient', message_id: sentMessageData.message_id,
  }});
  assert.equal(deniedFetch.isError, true, 'cross-recipient fetch was accepted');
} finally {
  await client.close();
}
`,
  ],
  {
    cwd: consumerDir,
    stdio: 'inherit',
    env: { ...process.env, HOME: protocolHome },
  }
);

// This is intentionally a process-level installed-artifact check, not a
// source import or a direct AgentRouter test. It starts the `memesh-router`
// binary npm installed for this consumer, connects a controlled host through
// the installed router-client module, and sends through the installed `memesh`
// CLI with a payload on stdin. Neither delivery assertion below uses poll or
// watch: the only readback is the router's persisted host_accept row.
//
// Windows does not provide the owner-private Unix-domain-socket contract this
// Local runner implements, so a Windows package still gets the manifest and
// MCP checks above but cannot truthfully run this POSIX host-native proof.
async function waitFor(condition, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function installedBin(name) {
  return path.join(consumerDir, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
}

function readHostAcceptance(databasePath, deliveryId) {
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(databasePath)}, { readOnly: true });
    try {
      const deliveryId = ${JSON.stringify(deliveryId)};
      const acceptance = db.prepare('SELECT adapter_kind, receipt_json FROM agent_host_accepts WHERE delivery_id = ?').get(deliveryId);
      const attempts = db.prepare('SELECT COUNT(*) AS count FROM agent_dispatch_attempts WHERE delivery_id = ?').get(deliveryId);
      process.stdout.write(JSON.stringify({ acceptance: acceptance ?? null, attempts: attempts?.count ?? 0 }));
    } finally { db.close(); }
  `], { encoding: 'utf8', env: { ...process.env } });
  return JSON.parse(result);
}

if (process.platform !== 'win32') {
  // The router deliberately rejects socket paths over 103 bytes. macOS's
  // per-user temporary root is already long, and nesting this under smokeDir
  // would turn a valid installed router into a false release failure.
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
  const nativeDir = path.join(nativeHome, '.memesh');
  const routerSocket = path.join(nativeDir, 'router.sock');
  const routerToken = path.join(nativeDir, 'router.token');
  const nativeEnv = {
    ...process.env,
    HOME: nativeHome,
    MEMESH_DIR: nativeDir,
    MEMESH_ROUTER_SOCKET: routerSocket,
    MEMESH_ROUTER_TOKEN_FILE: routerToken,
    MEMESH_AUTO_CAPTURE: 'false',
  };
  const router = spawn(installedBin('memesh-router'), [], {
    cwd: consumerDir,
    env: nativeEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let routerStderr = '';
  router.stderr.setEncoding('utf8');
  router.stderr.on('data', (chunk) => { routerStderr += chunk; });
  let routerExit = null;
  router.once('exit', (code, signal) => { routerExit = { code, signal }; });

  let host;
  try {
    await waitFor(
      () => fs.existsSync(routerSocket) || routerExit !== null,
      'the installed memesh-router socket',
    );
    assert.equal(routerExit, null, `installed memesh-router exited before listening: ${routerStderr}`);
    assert.ok(fs.statSync(routerSocket).isSocket(), 'installed memesh-router did not create a socket');
    assert.equal(fs.statSync(routerSocket).mode & 0o077, 0, 'installed router socket is not owner-private');
    await waitFor(() => fs.existsSync(routerToken), 'the installed router token');

    const hostProgram = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { connectRouterHost } from ${JSON.stringify(pathToFileURL(path.join(installedRoot, 'dist', 'host-runtime', 'router-client.js')).href)};
      const token = fs.readFileSync(process.env.MEMESH_ROUTER_TOKEN_FILE, 'utf8').trim();
      const connection = await connectRouterHost({
        socket_path: process.env.MEMESH_ROUTER_SOCKET,
        auth_token: token,
        identity: {
          project: 'packaged-native-smoke',
          principal_id: 'installed-active-host',
          session_instance_id: 'installed-host-session',
          adapter_kind: 'claude-channel',
        },
        async deliver(delivery) {
          assert.equal(delivery.envelope.payload.marker, 'installed-native-stdin');
          process.stdout.write(JSON.stringify({ type: 'native-delivered', message_id: delivery.envelope.message_id, delivery_id: delivery.delivery_id }) + '\\n');
          return { host: 'controlled-installed-stub', status: 'accepted' };
        },
      });
      process.stdout.write(JSON.stringify({ type: 'registered', connection_id: connection.connection_id, generation: connection.generation }) + '\\n');
      const shutdown = async () => { await connection.close(); process.exit(0); };
      process.once('SIGINT', () => { void shutdown(); });
      process.once('SIGTERM', () => { void shutdown(); });
    `;
    host = spawn(process.execPath, ['--input-type=module', '-e', hostProgram], {
      cwd: consumerDir,
      env: nativeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let hostOutput = '';
    let hostStderr = '';
    let hostExit = null;
    host.stdout.setEncoding('utf8');
    host.stderr.setEncoding('utf8');
    host.stdout.on('data', (chunk) => { hostOutput += chunk; });
    host.stderr.on('data', (chunk) => { hostStderr += chunk; });
    host.once('exit', (code, signal) => { hostExit = { code, signal }; });
    await waitFor(
      () => hostOutput.includes('"registered"') || hostExit !== null,
      'the controlled installed host registration',
    );
    assert.equal(hostExit, null, `installed host stub exited before registration: ${hostStderr}`);

    const send = JSON.parse(execFileSync(installedBin('memesh'), [
      'message', 'send',
      '--project', 'packaged-native-smoke',
      '--sender', 'installed-cli-sender',
      '--recipient', 'installed-active-host',
      '--idempotency-key', 'installed-native-delivery-1',
      '--content-type', 'application/json',
      '--payload-stdin',
    ], {
      cwd: consumerDir,
      env: nativeEnv,
      encoding: 'utf8',
      input: JSON.stringify({ marker: 'installed-native-stdin' }),
    }));
    await waitFor(
      () => hostOutput.includes('"native-delivered"') || hostExit !== null,
      'native delivery to the controlled installed host',
    );
    assert.equal(hostExit, null, `installed host stub exited during native delivery: ${hostStderr}`);
    const accepted = readHostAcceptance(path.join(nativeDir, 'knowledge-graph.db'), send.delivery_id);
    assert.equal(accepted.attempts, 1, 'native delivery did not persist exactly one dispatch attempt');
    assert.equal(accepted.acceptance?.adapter_kind, 'claude-channel', 'native delivery did not persist host_accept');
    assert.equal(JSON.parse(accepted.acceptance.receipt_json).host, 'controlled-installed-stub');

    // No host is registered for this principal. The sender still persists the
    // durable message, but the router must neither wake the active unrelated
    // stub nor create a dispatch/host_accept record for a stopped/no-host
    // target. Poll/watch is deliberately absent from this negative path.
    const noHost = JSON.parse(execFileSync(installedBin('memesh'), [
      'message', 'send',
      '--project', 'packaged-native-smoke',
      '--sender', 'installed-cli-sender',
      '--recipient', 'stopped-or-missing-host',
      '--idempotency-key', 'installed-no-host-1',
      '--content-type', 'application/json',
      '--payload-stdin',
    ], {
      cwd: consumerDir,
      env: nativeEnv,
      encoding: 'utf8',
      input: JSON.stringify({ marker: 'no-host-must-not-wake' }),
    }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const absent = readHostAcceptance(path.join(nativeDir, 'knowledge-graph.db'), noHost.delivery_id);
    assert.equal(absent.attempts, 0, 'a stopped/no-host target unexpectedly received a dispatch attempt');
    assert.equal(absent.acceptance, null, 'a stopped/no-host target unexpectedly persisted host_accept');
    assert.equal((hostOutput.match(/"native-delivered"/g) ?? []).length, 1, 'the active host received a message for another principal');
  } finally {
    if (host && !host.killed) host.kill('SIGTERM');
    if (!router.killed) router.kill('SIGTERM');
    fs.rmSync(nativeHome, { recursive: true, force: true });
  }
}

fs.rmSync(smokeDir, { recursive: true, force: true });

// Say something on success. A check that prints nothing when it passes is
// indistinguishable from one that did not run — the exact failure mode this
// repo has spent several releases removing from its own code.
console.log('✅ Packaged artifact smoke test passed — tarball installs outside the repo, completes MCP lifecycle exchanges, and proves installed CLI stdin → router → active installed host → persisted host_accept without poll/watch');
