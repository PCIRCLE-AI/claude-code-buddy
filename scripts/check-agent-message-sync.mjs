#!/usr/bin/env node
/**
 * Release gate for the durable-message surface.
 *
 * This is deliberately a source-and-artifact inventory, not a manifest hash
 * check. A skills manifest can be internally consistent while an installed
 * MCP has an old tool schema or no host adapter at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ACTIONS = ['send', 'poll', 'fetch', 'intake', 'ack', 'disposition', 'activation', 'receipts'];
const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, '..');
const option = process.argv.indexOf('--root');
const root = option === -1 ? defaultRoot : path.resolve(process.argv[option + 1] ?? '');

const missing = [];
const read = (relative) => {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) {
    missing.push(`${relative} (missing)`);
    return '';
  }
  return fs.readFileSync(full, 'utf8');
};
const requireText = (relative, needles) => {
  const text = read(relative);
  for (const needle of needles) {
    if (!text.includes(needle)) missing.push(`${relative} (missing ${JSON.stringify(needle)})`);
  }
};
const requirePattern = (relative, pattern, description) => {
  const text = read(relative);
  if (!pattern.test(text)) missing.push(`${relative} (missing ${description})`);
};
const requirePackageBin = (name, target) => {
  const packageJson = JSON.parse(read('package.json'));
  if (packageJson.bin?.[name] !== target) {
    missing.push(`package.json (bin ${JSON.stringify(name)} must map to ${JSON.stringify(target)})`);
  }
};

// One authoritative action list must reach every public transport.
requireText('src/transports/schemas.ts', ACTIONS.map((action) => `action: z.literal('${action}')`));
requireText('src/transports/mcp/handlers.ts', ["name === 'message'", 'MessageSchema', 'executeAgentMessageAction']);
requireText('src/transports/http/server.ts', ['executeAgentMessageAction', "transport: 'http'"]);
const CLI_ACTIONS = {
  send: 'send',
  poll: 'watch',
  fetch: 'fetch',
  intake: 'intake',
  ack: 'ack',
  disposition: 'disposition',
  activation: 'activation',
  receipts: 'receipts',
};
for (const [action, command] of Object.entries(CLI_ACTIONS)) {
  // Do not let an unrelated action literal make a command look wired. In
  // particular, the durable protocol calls this action `poll`, while the CLI
  // deliberately exposes it as the friendlier `watch` command.
  requirePattern(
    'src/transports/cli/cli.ts',
    new RegExp(`\\.command\\('${command}'\\)[\\s\\S]{0,2400}?action:\\s*'${action}'`),
    `CLI command ${JSON.stringify(command)} mapped to action ${JSON.stringify(action)}`,
  );
  requirePattern(
    'dist/transports/cli/cli.js',
    new RegExp(`\\.command\\('${command}'\\)[\\s\\S]{0,2400}?action:\\s*'${action}'`),
    `installed CLI command ${JSON.stringify(command)} mapped to action ${JSON.stringify(action)}`,
  );
}
requireText('src/transports/cli/cli.ts', ['--payload-stdin', 'never argv', 'readCliMessagePayloadFromStdin']);
requireText('src/transports/schemas.ts', ['target_kind', "z.enum(['principal', 'session'])"]);
requireText('dist/transports/schemas.js', ['target_kind', "z.enum(['principal', 'session'])"]);
requireText('src/transports/agent-messaging.ts', ['target_kind: input.target_kind']);
requireText('dist/transports/agent-messaging.js', ['target_kind: input.target_kind']);
requireText('src/transports/cli/cli.ts', ['messageStorageCmd', 'storage', 'report', 'prune', 'automatic_pruning']);
requireText('dist/transports/cli/cli.js', ['messageStorageCmd', 'storage', 'report', 'prune', 'automatic_pruning']);
requireText('src/core/agent-message-storage.ts', ['protected_unresolved_message_count', 'terminal_prunable_message_count', 'storage_quota_exceeded']);
requireText('dist/core/agent-message-storage.js', ['protected_unresolved_message_count', 'terminal_prunable_message_count', 'storage_quota_exceeded']);

// Router/session semantics are a separate lifecycle from durable receipts.
requireText('src/core/agent-router.ts', ['principal', 'session', 'generation']);
requireText('dist/core/agent-router.js', ['AgentRouter', 'host_accept']);
for (const adapter of ['codex-app-server.ts', 'claude-channel.ts', 'acp-client.ts']) {
  requireText(`src/host-adapters/${adapter}`, ['adapter']);
}
requireText('src/host-adapters/codex-app-server.ts', [
  'experimentalApi: true', 'thread/queue/add', 'ws://localhost/rpc', 'perMessageDeflate: false',
]);
requireText('dist/host-adapters/codex-app-server.js', [
  'experimentalApi: true', 'thread/queue/add', 'ws://localhost/rpc', 'perMessageDeflate: false',
]);
requireText('src/host-runtime/acp.ts', ['session_update_file', 'O_NOFOLLOW']);
requireText('dist/host-runtime/acp.js', ['session_update_file', 'O_NOFOLLOW']);

// The Local last mile is not installed by the normal `memesh` CLI alone.
// Every host-runtime source has a runnable JavaScript artifact plus its
// declaration/map siblings, and the public bin map must point at the three
// host runners and router that npm consumers actually execute.
const hostRuntimeDir = path.join(root, 'src/host-runtime');
if (!fs.existsSync(hostRuntimeDir)) {
  missing.push('src/host-runtime (missing)');
} else {
  for (const source of fs.readdirSync(hostRuntimeDir).filter((entry) => entry.endsWith('.ts')).sort()) {
    const stem = source.slice(0, -3);
    for (const extension of ['.js', '.js.map', '.d.ts', '.d.ts.map']) {
      read(`dist/host-runtime/${stem}${extension}`);
    }
  }
}
for (const [name, target] of Object.entries({
  'memesh-router': 'dist/host-runtime/router.js',
  'memesh-host-codex': 'dist/host-runtime/codex.js',
  'memesh-host-claude': 'dist/host-runtime/claude.js',
  'memesh-host-acp': 'dist/host-runtime/acp.js',
})) requirePackageBin(name, target);

// A source-only adapter is not installable. These paths are what npm users run.
for (const artifact of [
  'dist/mcp/server.js',
  'dist/transports/mcp/handlers.js',
  'dist/transports/http/server.js',
  'dist/transports/cli/cli.js',
  'dist/transports/agent-messaging.js',
  'dist/host-adapters/codex-app-server.js',
  'dist/host-adapters/claude-channel.js',
  'dist/host-adapters/acp-client.js',
]) read(artifact);
requireText('dist/transports/mcp/handlers.js', ["name === 'message'", 'MessageSchema', 'executeAgentMessageAction']);
requireText('dist/transports/http/server.js', ['MessageBody', 'executeAgentMessageAction']);
requireText('dist/transports/agent-messaging.js', ['executeAgentMessageAction']);

requireText('docs/api/API_REFERENCE.md', [...ACTIONS, 'principal', 'session', 'generation', 'Local', 'Cloud', 'message storage', 'storage_quota_exceeded']);
requireText('docs/platforms/agent-messaging.md', ['principal', 'session', 'generation', 'exact-session', 'principal target', 'Local', 'Cloud', 'Bounded storage and audit retention']);
requireText('skills/memesh/SKILL.md', ['message', 'polling', 'active compatible managed host', 'stopped, missing, or replaced session', 'message storage report']);
requireText('.mcp.json', ['memesh', '${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js']);
requireText('.claude-plugin/plugin.json', ['"name": "memesh"', '"version"']);
requireText('.claude-plugin/marketplace.json', ['"name": "pcircle-memesh"', '"version"']);
requireText('hooks/hooks.json', [
  'session-start.js', 'session-summary.js', 'pre-compact.js',
  'user-prompt-intent.js', 'pre-edit-recall.js', 'guard-check.js', 'post-commit.js',
]);
requireText('llms-install.md', [
  '22.13.0', 'memesh doctor', 'message', 'memesh-router',
  'memesh-host-codex', 'memesh-host-claude', 'memesh-host-acp', '--config', 'message storage report',
]);
requireText('README.md', ['message', 'active supported managed host', 'stopped session', 'message storage report']);
requireText('README.zh-TW.md', ['message', '活動中 managed host', '停止', 'message storage report']);
const packageJsonText = read('package.json');
for (const token of ['">=22.13.0"', 'check-agent-message-sync.mjs', 'test:packaged']) {
  if (!packageJsonText.includes(token)) missing.push(`package.json (missing ${JSON.stringify(token)})`);
}

if (missing.length > 0) {
  process.stderr.write(`agent-message-sync: FAIL (${missing.length} drift item(s))\n`);
  for (const item of missing) process.stderr.write(`  - ${item}\n`);
  process.exit(1);
}
process.stdout.write(`agent-message-sync: PASS (${ACTIONS.length} actions, router/session lifecycle, host-runtime artifacts, and installed bin mappings)\n`);
