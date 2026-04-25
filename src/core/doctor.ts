import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectCapabilities, getConfigPath } from './config.js';
import { openDatabase, closeDatabase } from '../db.js';
import { getUpdateCheck } from './version-check.js';
import { getCurrentInstallChannel, getInstallChannelSupport } from './install-channel.js';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';
export type DoctorOverallStatus = 'PASS' | 'PASS_WITH_CONCERNS' | 'FAIL';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  summary: string;
  fix?: string;
}

export interface DoctorResult {
  status: DoctorOverallStatus;
  checks: DoctorCheck[];
}

interface JsonObject {
  [key: string]: unknown;
}

interface DatabaseLike {
  prepare: (sql: string) => { get: () => { c?: number } };
}

interface DoctorOptions {
  packageRoot: string;
  packageVersion: string;
  probeHttp?: boolean;
  httpBaseUrl?: string;
  platform?: NodeJS.Platform;
  openDatabaseImpl?: typeof openDatabase;
  closeDatabaseImpl?: typeof closeDatabase;
  detectCapabilitiesImpl?: typeof detectCapabilities;
  getConfigPathImpl?: typeof getConfigPath;
  getUpdateCheckImpl?: typeof getUpdateCheck;
  getCurrentInstallChannelImpl?: typeof getCurrentInstallChannel;
  getInstallChannelSupportImpl?: typeof getInstallChannelSupport;
  existsSyncImpl?: typeof fs.existsSync;
  readFileSyncImpl?: typeof fs.readFileSync;
  statSyncImpl?: typeof fs.statSync;
  fetchImpl?: typeof fetch;
}

const EXPECTED_HOOK_TYPES = ['PreToolUse', 'SessionStart', 'PostToolUse', 'Stop', 'PreCompact'];

function resolveDatabasePath(): string {
  return process.env.MEMESH_DB_PATH ?? path.join(os.homedir(), '.memesh', 'knowledge-graph.db');
}

function createCheck(
  id: string,
  label: string,
  status: DoctorCheckStatus,
  summary: string,
  fix?: string,
): DoctorCheck {
  return { id, label, status, summary, fix };
}

function parseJsonFile(
  filePath: string,
  readFileSyncImpl: typeof fs.readFileSync,
): { ok: true; value: JsonObject } | { ok: false; error: string } {
  try {
    const raw = readFileSyncImpl(filePath, 'utf8');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') {
      return { ok: false, error: 'JSON root must be an object.' };
    }
    return { ok: true, value: value as JsonObject };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'unknown parse error',
    };
  }
}

function inspectConfigFile(
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
  getConfigPathImpl: typeof getConfigPath,
): DoctorCheck {
  const configPath = getConfigPathImpl();
  if (!existsSyncImpl(configPath)) {
    return createCheck(
      'config',
      'Config',
      'pass',
      `No config file yet (${configPath}). MeMesh will run in Core mode until you configure Smart Mode.`,
      'Optional: run `memesh config list` or set an LLM with `memesh config set llm.provider anthropic`.',
    );
  }

  const parsed = parseJsonFile(configPath, readFileSyncImpl);
  if (!parsed.ok) {
    return createCheck(
      'config',
      'Config',
      'fail',
      `Config file is invalid JSON at ${configPath}.`,
      `Fix or remove ${configPath}, then run \`memesh config list\` to confirm it loads cleanly.`,
    );
  }

  return createCheck(
    'config',
    'Config',
    'pass',
    `Config file is readable at ${configPath}.`,
  );
}

function inspectMcpConfig(
  packageRoot: string,
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
): DoctorCheck {
  const mcpPath = path.join(packageRoot, '.mcp.json');
  if (!existsSyncImpl(mcpPath)) {
    return createCheck(
      'mcp-config',
      'MCP config',
      'fail',
      '.mcp.json is missing.',
      'Restore `.mcp.json` from the package or reinstall MeMesh.',
    );
  }

  const parsed = parseJsonFile(mcpPath, readFileSyncImpl);
  if (!parsed.ok) {
    return createCheck(
      'mcp-config',
      'MCP config',
      'fail',
      '.mcp.json is not valid JSON.',
      `Fix ${mcpPath} so Claude Code can read the MCP server definition.`,
    );
  }

  const server = (parsed.value.mcpServers as JsonObject | undefined)?.memesh as JsonObject | undefined;
  if (!server || typeof server.command !== 'string') {
    return createCheck(
      'mcp-config',
      'MCP config',
      'fail',
      '.mcp.json does not define a usable `memesh` MCP server entry.',
      'Reinstall MeMesh or restore the `mcpServers.memesh` entry in `.mcp.json`.',
    );
  }

  return createCheck(
    'mcp-config',
    'MCP config',
    'pass',
    '.mcp.json is present and defines the memesh MCP server.',
  );
}

function extractHookScriptPaths(hooksConfig: JsonObject, packageRoot: string): string[] {
  const hooks = hooksConfig.hooks as Record<string, Array<{ hooks?: Array<{ command?: string }> }>> | undefined;
  if (!hooks) return [];

  const scripts = new Set<string>();
  for (const entries of Object.values(hooks)) {
    for (const entry of entries ?? []) {
      for (const hook of entry.hooks ?? []) {
        if (typeof hook.command !== 'string') continue;
        const command = hook.command.replace('${CLAUDE_PLUGIN_ROOT}/', '');
        scripts.add(path.join(packageRoot, command));
      }
    }
  }
  return Array.from(scripts).sort();
}

function inspectHooksConfig(
  packageRoot: string,
  platform: NodeJS.Platform,
  existsSyncImpl: typeof fs.existsSync,
  readFileSyncImpl: typeof fs.readFileSync,
  statSyncImpl: typeof fs.statSync,
): DoctorCheck[] {
  const hooksPath = path.join(packageRoot, 'hooks', 'hooks.json');
  if (!existsSyncImpl(hooksPath)) {
    return [
      createCheck(
        'hooks-config',
        'Hooks config',
        'fail',
        'hooks/hooks.json is missing.',
        'Restore `hooks/hooks.json` from the package or reinstall MeMesh.',
      ),
    ];
  }

  const parsed = parseJsonFile(hooksPath, readFileSyncImpl);
  if (!parsed.ok) {
    return [
      createCheck(
        'hooks-config',
        'Hooks config',
        'fail',
        'hooks/hooks.json is not valid JSON.',
        `Fix ${hooksPath} so Claude Code can load the hook definitions.`,
      ),
    ];
  }

  const hookTypes = Object.keys((parsed.value.hooks as JsonObject | undefined) ?? {});
  const missingTypes = EXPECTED_HOOK_TYPES.filter((type) => !hookTypes.includes(type));
  const configCheck = missingTypes.length > 0
    ? createCheck(
      'hooks-config',
      'Hooks config',
      'fail',
      `hooks/hooks.json is missing expected hook types: ${missingTypes.join(', ')}.`,
      'Restore the shipped hook configuration or reinstall MeMesh.',
    )
    : createCheck(
      'hooks-config',
      'Hooks config',
      'pass',
      `hooks/hooks.json is present with ${hookTypes.length} hook types configured.`,
    );

  const scriptPaths = extractHookScriptPaths(parsed.value, packageRoot);
  const missingScripts = scriptPaths.filter((scriptPath) => !existsSyncImpl(scriptPath));
  if (missingScripts.length > 0) {
    return [
      configCheck,
      createCheck(
        'hook-scripts',
        'Hook scripts',
        'fail',
        `Missing hook scripts: ${missingScripts.map((entry) => path.relative(packageRoot, entry)).join(', ')}.`,
        'Restore the missing files from the package or reinstall MeMesh.',
      ),
    ];
  }

  if (platform !== 'win32') {
    const nonExecutable = scriptPaths.filter((scriptPath) => {
      const mode = statSyncImpl(scriptPath).mode;
      return (mode & 0o111) === 0;
    });
    if (nonExecutable.length > 0) {
      return [
        configCheck,
        createCheck(
          'hook-scripts',
          'Hook scripts',
          'fail',
          `Hook scripts are not executable: ${nonExecutable.map((entry) => path.relative(packageRoot, entry)).join(', ')}.`,
          'Run `npm run build` from the repo checkout or `chmod +x scripts/hooks/*.js` for a local repair.',
        ),
      ];
    }
  }

  return [
    configCheck,
    createCheck(
      'hook-scripts',
      'Hook scripts',
      'pass',
      `All ${scriptPaths.length} hook scripts are present${platform === 'win32' ? '' : ' and executable'}.`,
    ),
  ];
}

function inspectDashboardArtifact(
  packageRoot: string,
  existsSyncImpl: typeof fs.existsSync,
): DoctorCheck {
  const dashboardPath = path.join(packageRoot, 'dashboard', 'dist', 'index.html');
  if (!existsSyncImpl(dashboardPath)) {
    return createCheck(
      'dashboard',
      'Dashboard artifact',
      'fail',
      'dashboard/dist/index.html is missing.',
      'Build the dashboard with `cd dashboard && npm install && npm run build`, then run `npm run build` at the repo root if needed.',
    );
  }

  return createCheck(
    'dashboard',
    'Dashboard artifact',
    'pass',
    'dashboard/dist/index.html is present.',
  );
}

async function inspectUpdateStatus(
  packageVersion: string,
  getUpdateCheckImpl: typeof getUpdateCheck,
): Promise<DoctorCheck> {
  const update = await getUpdateCheckImpl(packageVersion, { preferFresh: false });
  if (!update || update.freshness === 'unavailable') {
    return createCheck(
      'update-status',
      'Update status',
      'warn',
      'No successful cached npm update check is available yet.',
      'Run `memesh status` once while online to populate update status.',
    );
  }

  if (update.updateAvailable && update.latestVersion) {
    return createCheck(
      'update-status',
      'Update status',
      'warn',
      `Update available: ${packageVersion} -> ${update.latestVersion} (${update.freshness}).`,
      'Run `memesh update` for npm-global installs, or follow the install-method guidance from `memesh status`.',
    );
  }

  return createCheck(
    'update-status',
    'Update status',
    update.freshness === 'stale' ? 'warn' : 'pass',
    `Version ${packageVersion} is current${update.freshness === 'stale' ? ', but cached update data is stale.' : '.'}`,
    update.freshness === 'stale'
      ? 'Run `memesh status` while online to refresh cached update metadata.'
      : undefined,
  );
}

async function inspectHttpProbe(
  httpBaseUrl: string,
  fetchImpl: typeof fetch,
): Promise<DoctorCheck> {
  try {
    const response = await fetchImpl(`${httpBaseUrl.replace(/\/$/, '')}/v1/health`);
    if (!response.ok) {
      return createCheck(
        'http-probe',
        'HTTP probe',
        'warn',
        `HTTP server responded with ${response.status} at ${httpBaseUrl}.`,
        'Run `memesh serve` and check the logs, then retry `memesh doctor --probe-http`.',
      );
    }

    return createCheck(
      'http-probe',
      'HTTP probe',
      'pass',
      `HTTP server is reachable at ${httpBaseUrl}.`,
    );
  } catch {
    return createCheck(
      'http-probe',
      'HTTP probe',
      'warn',
      `No running HTTP server detected at ${httpBaseUrl}.`,
      'Start the local server with `memesh serve` if you want dashboard and HTTP API verification.',
    );
  }
}

function summarizeOverallStatus(checks: DoctorCheck[]): DoctorOverallStatus {
  if (checks.some((check) => check.status === 'fail')) return 'FAIL';
  if (checks.some((check) => check.status === 'warn')) return 'PASS_WITH_CONCERNS';
  return 'PASS';
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const {
    packageRoot,
    packageVersion,
    probeHttp = false,
    httpBaseUrl = 'http://127.0.0.1:3737',
    platform = process.platform,
    openDatabaseImpl = openDatabase,
    closeDatabaseImpl = closeDatabase,
    detectCapabilitiesImpl = detectCapabilities,
    getConfigPathImpl = getConfigPath,
    getUpdateCheckImpl = getUpdateCheck,
    getCurrentInstallChannelImpl = getCurrentInstallChannel,
    getInstallChannelSupportImpl = getInstallChannelSupport,
    existsSyncImpl = fs.existsSync,
    readFileSyncImpl = fs.readFileSync,
    statSyncImpl = fs.statSync,
    fetchImpl = fetch,
  } = options;

  const checks: DoctorCheck[] = [];

  const install = getCurrentInstallChannelImpl({ packageRoot });
  const installSupport = getInstallChannelSupportImpl(install);
  checks.push(
    createCheck(
      'install-channel',
      'Install method',
      install === 'unknown' ? 'warn' : 'pass',
      `Install method detected: ${installSupport.label}.`,
      install === 'unknown'
        ? 'If this is a source checkout, run MeMesh from the repo root. If this is a packaged install, reinstall with `npm install -g @pcircle/memesh`.'
        : undefined,
    ),
  );

  const databasePath = resolveDatabasePath();
  try {
    const db = openDatabaseImpl(databasePath) as unknown as DatabaseLike;
    const count = db.prepare('SELECT COUNT(*) as c FROM entities').get().c ?? 0;
    checks.push(
      createCheck(
        'database',
        'Database',
        'pass',
        `Database opened successfully at ${databasePath} (${count} entities).`,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown database error';
    checks.push(
      createCheck(
        'database',
        'Database',
        'fail',
        `Database could not be opened at ${databasePath} (${message}).`,
        `Check MEMESH_DB_PATH permissions and path validity. Under a normal install, MeMesh uses ${databasePath} by default.`,
      ),
    );
  } finally {
    try {
      closeDatabaseImpl();
    } catch {
      // Best-effort cleanup only.
    }
  }

  checks.push(inspectConfigFile(existsSyncImpl, readFileSyncImpl, getConfigPathImpl));
  checks.push(inspectMcpConfig(packageRoot, existsSyncImpl, readFileSyncImpl));
  checks.push(...inspectHooksConfig(packageRoot, platform, existsSyncImpl, readFileSyncImpl, statSyncImpl));
  checks.push(inspectDashboardArtifact(packageRoot, existsSyncImpl));

  const capabilities = detectCapabilitiesImpl();
  checks.push(
    createCheck(
      'capabilities',
      'Capabilities',
      'pass',
      `Search level ${capabilities.searchLevel} (${capabilities.searchLevel === 1 ? 'Smart Mode' : 'Core'}); embeddings: ${capabilities.embeddings}; LLM: ${capabilities.llm ? `${capabilities.llm.provider} (${capabilities.llm.model ?? 'default'})` : 'not configured'}.`,
    ),
  );

  checks.push(await inspectUpdateStatus(packageVersion, getUpdateCheckImpl));

  if (probeHttp) {
    checks.push(await inspectHttpProbe(httpBaseUrl, fetchImpl));
  }

  return {
    status: summarizeOverallStatus(checks),
    checks,
  };
}

function iconForStatus(status: DoctorCheckStatus): string {
  switch (status) {
    case 'pass':
      return 'PASS';
    case 'warn':
      return 'WARN';
    default:
      return 'FAIL';
  }
}

export function formatDoctorReport(result: DoctorResult, packageVersion: string): string[] {
  const lines = [`MeMesh doctor v${packageVersion}`, `Overall: ${result.status}`];

  for (const check of result.checks) {
    lines.push('');
    lines.push(`[${iconForStatus(check.status)}] ${check.label}`);
    lines.push(`  ${check.summary}`);
    if (check.fix) {
      lines.push(`  Fix: ${check.fix}`);
    }
  }

  return lines;
}
