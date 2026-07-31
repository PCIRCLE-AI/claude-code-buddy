import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { detectCapabilities, getConfigPath } from './config.js';
import { embedText, isOnnxModelCached } from './embedder.js';
import { probeProvider } from './llm-validator.js';
import { openDatabase, closeDatabase, getPendingReindexInfo, isDatabaseOpen } from '../db.js';
import { getUpdateCheck } from './version-check.js';
import { getCurrentInstallChannel, getInstallChannelSupport } from './install-channel.js';
import { getInstallRecord } from './install-id.js';
import { getDbPath, memeshDir } from './paths.js';
import { UNSPACED_SCRIPT_GLOB_PREFIX } from '../storage/fts-index.js';
const EMBEDDING_PROBE_TIMEOUT_MS = 15000;
const EXPECTED_HOOK_TYPES = ['PreToolUse', 'SessionStart', 'PostToolUse', 'Stop', 'PreCompact'];
const LOCALE_README_FILES = [
    'README.de.md',
    'README.es.md',
    'README.fr.md',
    'README.ja.md',
    'README.ko.md',
    'README.pt.md',
    'README.th.md',
    'README.vi.md',
    'README.zh-CN.md',
    'README.zh-TW.md',
];
const LOCALE_H2_TOLERANCE = 1;
function countH2Headings(content) {
    let n = 0;
    let inFence = false;
    for (const line of content.split('\n')) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
            inFence = !inFence;
            continue;
        }
        if (inFence)
            continue;
        if (line.startsWith('## '))
            n++;
    }
    return n;
}
function inspectLocaleReadmeParity(packageRoot, existsSyncImpl, readFileSyncImpl) {
    const englishPath = path.join(packageRoot, 'README.md');
    if (!existsSyncImpl(englishPath)) {
        return createCheck('readme_locale_parity', 'README locale parity', 'pass', 'README.md not present in this install (likely a packaged tarball without docs); locale-parity check skipped.');
    }
    let englishCount;
    try {
        englishCount = countH2Headings(readFileSyncImpl(englishPath, 'utf8'));
    }
    catch (err) {
        return createCheck('readme_locale_parity', 'README locale parity', 'warn', `Could not read README.md: ${err instanceof Error ? err.message : String(err)}`);
    }
    const missing = [];
    const drift = [];
    for (const filename of LOCALE_README_FILES) {
        const localePath = path.join(packageRoot, filename);
        if (!existsSyncImpl(localePath)) {
            missing.push(filename);
            continue;
        }
        try {
            const count = countH2Headings(readFileSyncImpl(localePath, 'utf8'));
            if (Math.abs(count - englishCount) > LOCALE_H2_TOLERANCE) {
                drift.push({ name: filename, count });
            }
        }
        catch {
            drift.push({ name: filename, count: -1 });
        }
    }
    if (missing.length === 0 && drift.length === 0) {
        return createCheck('readme_locale_parity', 'README locale parity', 'pass', `All ${LOCALE_README_FILES.length} locale READMEs match English H2 count (${englishCount}).`);
    }
    const parts = [];
    if (missing.length > 0) {
        parts.push(`missing: ${missing.join(', ')}`);
    }
    if (drift.length > 0) {
        const driftDetail = drift
            .map((d) => `${d.name}=${d.count === -1 ? 'unreadable' : d.count}`)
            .join(', ');
        parts.push(`H2 count drift (English=${englishCount}): ${driftDetail}`);
    }
    return createCheck('readme_locale_parity', 'README locale parity', 'warn', parts.join('; '), `Re-sync the listed READMEs against README.md so section structure matches (±${LOCALE_H2_TOLERANCE} H2 tolerated to absorb translation collapse).`);
}
function resolveDatabasePath() {
    return getDbPath();
}
function createCheck(id, label, status, summary, fix) {
    return { id, label, status, summary, fix };
}
function createInfo(id, label, summary, fix) {
    return { id, label, status: 'pass', summary, fix, informational: true };
}
function parseJsonFile(filePath, readFileSyncImpl) {
    try {
        const raw = readFileSyncImpl(filePath, 'utf8');
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object') {
            return { ok: false, error: 'JSON root must be an object.' };
        }
        return { ok: true, value: value };
    }
    catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : 'unknown parse error',
        };
    }
}
function inspectConfigFile(existsSyncImpl, readFileSyncImpl, getConfigPathImpl) {
    const configPath = getConfigPathImpl();
    if (!existsSyncImpl(configPath)) {
        return createCheck('config', 'Config', 'pass', `No config file yet (${configPath}). MeMesh will run in Core mode until you configure Smart Mode.`, 'Optional: run `memesh config list` or set an LLM with `memesh config set llm.provider anthropic`.');
    }
    const parsed = parseJsonFile(configPath, readFileSyncImpl);
    if (!parsed.ok) {
        return createCheck('config', 'Config', 'fail', `Config file is invalid JSON at ${configPath}.`, `Fix or remove ${configPath}, then run \`memesh config list\` to confirm it loads cleanly.`);
    }
    return createCheck('config', 'Config', 'pass', `Config file is readable at ${configPath}.`);
}
function inspectMcpConfig(packageRoot, existsSyncImpl, readFileSyncImpl) {
    const mcpPath = path.join(packageRoot, '.mcp.json');
    if (!existsSyncImpl(mcpPath)) {
        return createCheck('mcp-config', 'MCP config', 'fail', '.mcp.json is missing.', 'Restore `.mcp.json` from the package or reinstall MeMesh.');
    }
    const parsed = parseJsonFile(mcpPath, readFileSyncImpl);
    if (!parsed.ok) {
        return createCheck('mcp-config', 'MCP config', 'fail', '.mcp.json is not valid JSON.', `Fix ${mcpPath} so Claude Code can read the MCP server definition.`);
    }
    const server = parsed.value.mcpServers?.memesh;
    if (!server || typeof server.command !== 'string') {
        return createCheck('mcp-config', 'MCP config', 'fail', '.mcp.json does not define a usable `memesh` MCP server entry.', 'Reinstall MeMesh or restore the `mcpServers.memesh` entry in `.mcp.json`.');
    }
    return createCheck('mcp-config', 'MCP config', 'pass', '.mcp.json is present and defines the memesh MCP server.');
}
function extractHookScriptPaths(hooksConfig, packageRoot) {
    const hooks = hooksConfig.hooks;
    if (!hooks)
        return [];
    const scripts = new Set();
    for (const entries of Object.values(hooks)) {
        for (const entry of entries ?? []) {
            for (const hook of entry.hooks ?? []) {
                if (typeof hook.command !== 'string')
                    continue;
                const command = hook.command.replace('${CLAUDE_PLUGIN_ROOT}/', '');
                scripts.add(path.join(packageRoot, command));
            }
        }
    }
    return Array.from(scripts).sort();
}
function inspectHooksConfig(packageRoot, platform, existsSyncImpl, readFileSyncImpl, statSyncImpl) {
    const hooksPath = path.join(packageRoot, 'hooks', 'hooks.json');
    if (!existsSyncImpl(hooksPath)) {
        return [
            createCheck('hooks-config', 'Hooks config', 'fail', 'hooks/hooks.json is missing.', 'Restore `hooks/hooks.json` from the package or reinstall MeMesh.'),
        ];
    }
    const parsed = parseJsonFile(hooksPath, readFileSyncImpl);
    if (!parsed.ok) {
        return [
            createCheck('hooks-config', 'Hooks config', 'fail', 'hooks/hooks.json is not valid JSON.', `Fix ${hooksPath} so Claude Code can load the hook definitions.`),
        ];
    }
    const hookTypes = Object.keys(parsed.value.hooks ?? {});
    const missingTypes = EXPECTED_HOOK_TYPES.filter((type) => !hookTypes.includes(type));
    const configCheck = missingTypes.length > 0
        ? createCheck('hooks-config', 'Hooks config', 'fail', `hooks/hooks.json is missing expected hook types: ${missingTypes.join(', ')}.`, 'Restore the shipped hook configuration or reinstall MeMesh.')
        : createCheck('hooks-config', 'Hooks config', 'pass', `hooks/hooks.json is present with ${hookTypes.length} hook types configured.`);
    const scriptPaths = extractHookScriptPaths(parsed.value, packageRoot);
    const missingScripts = scriptPaths.filter((scriptPath) => !existsSyncImpl(scriptPath));
    if (missingScripts.length > 0) {
        return [
            configCheck,
            createCheck('hook-scripts', 'Hook scripts', 'fail', `Missing hook scripts: ${missingScripts.map((entry) => path.relative(packageRoot, entry)).join(', ')}.`, 'Restore the missing files from the package or reinstall MeMesh.'),
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
                createCheck('hook-scripts', 'Hook scripts', 'fail', `Hook scripts are not executable: ${nonExecutable.map((entry) => path.relative(packageRoot, entry)).join(', ')}.`, 'Run `npm run build` from the repo checkout or `chmod +x scripts/hooks/*.js` for a local repair.'),
            ];
        }
    }
    return [
        configCheck,
        createCheck('hook-scripts', 'Hook scripts', 'pass', `All ${scriptPaths.length} hook scripts are present${platform === 'win32' ? '' : ' and executable'}.`),
    ];
}
function inspectHookWiring(existsSyncImpl, readFileSyncImpl, memeshDir, packageRoot) {
    const markerPath = path.join(memeshDir, 'install-hooks.json');
    if (!existsSyncImpl(markerPath)) {
        if (packageRoot) {
            const pluginManifest = path.join(packageRoot, '.claude-plugin', 'plugin.json');
            if (existsSyncImpl(pluginManifest)) {
                return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'pass', 'Wired via Claude Code plugin runtime (.claude-plugin/plugin.json present). The install-hooks marker is not used on this install path.');
            }
        }
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'warn', 'No install-hooks marker found. memesh\'s session-summary, pre-edit-recall, and other hooks may not be firing for Claude Code sessions — the auto-capture / lesson-generation flow is silent without them.', 'Run `memesh install-hooks` to wire memesh into ~/.claude/settings.json (one-time setup). Then `memesh doctor` to confirm.');
    }
    const parsed = parseJsonFile(markerPath, readFileSyncImpl);
    if (!parsed.ok) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'warn', `install-hooks marker at ${markerPath} is unreadable.`, 'Re-run `memesh install-hooks` to refresh the marker.');
    }
    const marker = parsed.value;
    if (typeof marker.settings_path !== 'string') {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'warn', 'install-hooks marker is malformed (missing settings_path).', 'Re-run `memesh install-hooks`.');
    }
    if (!existsSyncImpl(marker.settings_path)) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'fail', `Marker recorded settings at ${marker.settings_path} but the file no longer exists. Hooks are not wired.`, 'Re-run `memesh install-hooks`.');
    }
    const settingsParsed = parseJsonFile(marker.settings_path, readFileSyncImpl);
    if (!settingsParsed.ok) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'fail', `${marker.settings_path} is no longer valid JSON.`, 'Restore from your ~/.claude backups or re-create with `memesh install-hooks`.');
    }
    const hooks = settingsParsed.value.hooks;
    let hasMemeshHook = false;
    if (hooks && typeof hooks === 'object') {
        for (const entries of Object.values(hooks)) {
            if (!Array.isArray(entries))
                continue;
            for (const entry of entries) {
                const cmds = entry.hooks;
                if (!Array.isArray(cmds))
                    continue;
                if (cmds.some((c) => c._memesh === true)) {
                    hasMemeshHook = true;
                    break;
                }
            }
            if (hasMemeshHook)
                break;
        }
    }
    if (!hasMemeshHook) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'fail', `Marker recorded a memesh install at ${marker.settings_path}, but no _memesh:true hook entries are present anymore. Settings drifted (manual edit?) or memesh was uninstalled out-of-band.`, 'Re-run `memesh install-hooks` to re-wire.');
    }
    if (typeof marker.plugin_root === 'string' && !existsSyncImpl(marker.plugin_root)) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'fail', `Hook commands point at ${marker.plugin_root}, which no longer exists (likely after an npm-global path change).`, 'Re-run `memesh install-hooks` to refresh paths.');
    }
    return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'pass', `Wired in ${marker.settings_path} (scope: ${marker.scope ?? 'user'}, version: ${marker.version ?? 'unknown'}).`);
}
function inspectHookActivity(openDatabaseImpl, closeDatabaseImpl, existsSyncImpl = fs.existsSync, statSyncImpl = fs.statSync) {
    let db = null;
    try {
        db = openDatabaseImpl();
        const row = db.prepare(`SELECT COUNT(*) as c FROM entities
       WHERE type IN ('session-insight', 'session-summary', 'commit', 'lesson_learned')
         AND created_at > datetime('now', '-24 hours')`).get();
        const count = row?.c ?? 0;
        if (count === 0) {
            const markerPath = path.join(memeshDir(), 'install-hooks.json');
            if (existsSyncImpl(markerPath)) {
                try {
                    const ageMs = Date.now() - statSyncImpl(markerPath).mtimeMs;
                    if (ageMs < 24 * 60 * 60 * 1000) {
                        return createCheck('hook-activity', 'Hook activity (last 24h)', 'pass', 'Hooks wired recently — no captureable sessions yet (this is normal for a fresh install).');
                    }
                }
                catch { }
            }
            return createCheck('hook-activity', 'Hook activity (last 24h)', 'warn', 'No memesh-attributed entities (session-insight, session-summary, commit, lesson_learned) in the past 24 hours. Hooks may be wired but not firing — likely a Claude Code restart is needed, or the agentic-loop guard is filtering all sessions.', 'Open a Claude Code session that uses ≥3 tools and ends naturally (not user_interrupt), or commit something. Then run `memesh doctor` again.');
        }
        return createCheck('hook-activity', 'Hook activity (last 24h)', 'pass', `${count} memesh-attributed entit${count === 1 ? 'y' : 'ies'} captured in the past 24h — auto-capture loop is alive.`);
    }
    catch (err) {
        return createCheck('hook-activity', 'Hook activity (last 24h)', 'warn', `Could not query the database: ${err instanceof Error ? err.message : String(err)}`);
    }
    finally {
        try {
            if (db)
                closeDatabaseImpl();
        }
        catch { }
    }
}
function defaultResolveShellMemesh() {
    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const localRequire = createRequire(import.meta.url);
        const { execFileSync } = localRequire('child_process');
        const out = execFileSync(cmd, ['memesh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const first = String(out).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        return first || null;
    }
    catch {
        return null;
    }
}
function defaultNativeBindingProbe(packageRoot) {
    try {
        const localRequire = createRequire(pathToFileURL(path.join(packageRoot, 'package.json')).href);
        const Database = localRequire('better-sqlite3');
        const probe = new Database(':memory:');
        probe.close();
        return { ok: true };
    }
    catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
}
function inspectNativeBinding(packageRoot, _existsSyncImpl, probeImpl = defaultNativeBindingProbe) {
    const result = probeImpl(packageRoot);
    if (result.ok) {
        return createCheck('native-binding', 'Native SQLite binding', 'pass', 'better-sqlite3 native binding loads cleanly (Database probe succeeded).');
    }
    const isMissingBinding = /bindings file|locate the bindings/i.test(result.message);
    const isMissingPackage = /MODULE_NOT_FOUND|Cannot find module/i.test(result.message);
    if (isMissingPackage) {
        return createCheck('native-binding', 'Native SQLite binding', 'fail', 'better-sqlite3 is not installed (Node could not resolve the module from any '
            + 'parent node_modules). Memesh hooks and database operations will not work.', `Run: npm install   (in the directory that depends on @pcircle/memesh)`);
    }
    if (isMissingBinding) {
        return createCheck('native-binding', 'Native SQLite binding', 'fail', 'better-sqlite3 is installed but the native binding (.node file) is missing. '
            + 'Hooks will silently skip-and-exit, and auto-capture will NOT write any entities. '
            + 'This is the plugin-marketplace silent-dropout class of bug.', `Run: cd "${packageRoot}" && npm rebuild better-sqlite3   (or "npm install --omit=dev" for a clean reinstall)`);
    }
    return createCheck('native-binding', 'Native SQLite binding', 'fail', `better-sqlite3 failed to load: ${result.message}`, `Run: cd "${packageRoot}" && npm rebuild better-sqlite3`);
}
function inspectShellCli(installChannel, packageRoot, resolveShellMemeshImpl) {
    const shellPath = resolveShellMemeshImpl();
    const isSameAsCurrent = shellPath ? path.resolve(shellPath).startsWith(path.resolve(packageRoot)) : false;
    const hasDistinctShellCli = !!shellPath && !isSameAsCurrent;
    if (installChannel === 'npm-global') {
        return createCheck('shell-cli', 'Shell CLI on PATH', 'pass', shellPath
            ? `\`memesh\` resolves to ${shellPath} (npm-global install — terminals across the machine pick it up).`
            : 'Running from npm-global install — shell access available in this terminal.');
    }
    if (hasDistinctShellCli) {
        return createCheck('shell-cli', 'Shell CLI on PATH', 'pass', `\`memesh\` resolves to ${shellPath} (separate from this install at ${packageRoot}). Both paths coexist and share the same DB.`);
    }
    if (installChannel === 'plugin-marketplace') {
        return createCheck('shell-cli', 'Shell CLI on PATH', 'warn', 'Plugin is installed but `memesh` is not on the shell PATH. Typing `memesh` in a regular terminal will report `command not found`. '
            + 'Claude Code MCP / hooks / `/memesh` skill still work — this only affects standalone shell usage and other MCP clients (Cursor, Cline, etc.).', 'Run `npm install -g @pcircle/memesh` to add the shell CLI. Both paths coexist; they share the same `~/.memesh/knowledge-graph.db`.');
    }
    return createCheck('shell-cli', 'Shell CLI on PATH', 'pass', shellPath
        ? `\`memesh\` resolves to ${shellPath}.`
        : `No shell-PATH \`memesh\` detected. If you want terminal access, run \`npm install -g @pcircle/memesh\` (this install is a ${installChannel}, so the check is informational only).`);
}
function inspectDashboardArtifact(packageRoot, existsSyncImpl) {
    const dashboardPath = path.join(packageRoot, 'dashboard', 'dist', 'index.html');
    if (!existsSyncImpl(dashboardPath)) {
        return createCheck('dashboard', 'Dashboard artifact', 'fail', 'dashboard/dist/index.html is missing.', 'Build the dashboard with `cd dashboard && npm install && npm run build`, then run `npm run build` at the repo root if needed.');
    }
    return createCheck('dashboard', 'Dashboard artifact', 'pass', 'dashboard/dist/index.html is present.');
}
async function inspectUpdateStatus(packageVersion, getUpdateCheckImpl, installSupport) {
    const update = await getUpdateCheckImpl(packageVersion, { preferFresh: false });
    if (!update) {
        return createCheck('update-status', 'Update status', 'warn', 'No successful cached npm update check is available yet.', 'Run `memesh status` once while online to populate update status.');
    }
    if (update.currentVersionDeprecated && update.deprecationMessage) {
        const target = update.latestVersion && update.latestVersion !== packageVersion
            ? ` -> ${update.latestVersion}`
            : '';
        const hasUpgradeTarget = update.latestVersion
            && update.latestVersion !== packageVersion;
        let fix;
        if (installSupport?.canSelfUpdate) {
            fix = hasUpgradeTarget
                ? `Run \`memesh update\`${target}.`
                : 'Run `memesh update` to refresh the registry lookup and apply any newly-published fix.';
        }
        else if (installSupport?.guidance) {
            fix = installSupport.guidance + (hasUpgradeTarget
                ? ` Upgrade target: ${update.latestVersion}.`
                : ' Upgrade target uncertain — re-check `memesh status` while online.');
        }
        else {
            fix = `Upgrade via your install method (see \`memesh status\`).`;
        }
        return createCheck('update-status', 'Update status', 'fail', `Installed version ${packageVersion} is DEPRECATED by maintainers: ${update.deprecationMessage}`, fix);
    }
    if (update.freshness === 'unavailable') {
        return createCheck('update-status', 'Update status', 'warn', 'No successful cached npm update check is available yet.', 'Run `memesh status` once while online to populate update status.');
    }
    if (update.checkSucceeded && update.lastError) {
        const hasUpdate = Boolean(update.updateAvailable && update.latestVersion);
        const summary = hasUpdate
            ? `Deprecation status unknown for ${packageVersion}: ${update.lastError}. Update ${update.latestVersion} is available.`
            : `Deprecation status unknown for ${packageVersion}: ${update.lastError}.`;
        let upgradeHint;
        if (hasUpdate) {
            if (installSupport?.canSelfUpdate) {
                upgradeHint = `, or \`memesh update\` to apply ${update.latestVersion}`;
            }
            else if (installSupport?.guidance) {
                upgradeHint = `. Upgrade target ${update.latestVersion} via your install method: ${installSupport.guidance}`;
            }
            else {
                upgradeHint = `. Upgrade target: ${update.latestVersion}.`;
            }
        }
        else {
            upgradeHint = '';
        }
        const fix = `Run \`memesh status\` while online to retry the deprecation lookup${upgradeHint}.`;
        return createCheck('update-status', 'Update status', 'warn', summary, fix);
    }
    if (update.updateAvailable && update.latestVersion) {
        if (packageVersion < update.latestVersion) {
            return createCheck('update-status', 'Update status', 'warn', `Update available: ${update.latestVersion} (current: ${packageVersion})`, `Run 'memesh update' to upgrade`);
        }
        else {
            return createCheck('update-status', 'Update status', 'pass', `Running pre-release version (${packageVersion}), npm latest is ${update.latestVersion}`);
        }
    }
    return createCheck('update-status', 'Update status', update.freshness === 'stale' ? 'warn' : 'pass', `Version ${packageVersion} is current${update.freshness === 'stale' ? ', but cached update data is stale.' : '.'}`, update.freshness === 'stale'
        ? 'Run `memesh status` while online to refresh cached update metadata.'
        : undefined);
}
async function inspectHttpProbe(httpBaseUrl, fetchImpl) {
    try {
        const response = await fetchImpl(`${httpBaseUrl.replace(/\/$/, '')}/v1/health`);
        if (!response.ok) {
            return createCheck('http-probe', 'HTTP probe', 'warn', `HTTP server responded with ${response.status} at ${httpBaseUrl}.`, 'Run `memesh serve` and check the logs, then retry `memesh doctor --probe-http`.');
        }
        return createCheck('http-probe', 'HTTP probe', 'pass', `HTTP server is reachable at ${httpBaseUrl}.`);
    }
    catch {
        return createCheck('http-probe', 'HTTP probe', 'warn', `No running HTTP server detected at ${httpBaseUrl}.`, 'Start the local server with `memesh serve` if you want dashboard and HTTP API verification.');
    }
}
function verifySkillsManifest(packageRoot, existsSyncImpl, readFileSyncImpl) {
    const manifestPath = path.join(packageRoot, 'dist', 'skills-manifest.json');
    if (!existsSyncImpl(manifestPath)) {
        return createCheck('skills-manifest', 'Skills + hooks integrity', 'warn', 'No skills-manifest.json found. This is normal for source checkouts — packaged installs ship the manifest.', 'Run `npm run build` to regenerate, or reinstall via `npm install -g @pcircle/memesh`.');
    }
    let manifest;
    try {
        manifest = JSON.parse(readFileSyncImpl(manifestPath, 'utf8'));
    }
    catch (err) {
        return createCheck('skills-manifest', 'Skills + hooks integrity', 'fail', `skills-manifest.json is unreadable (${err instanceof Error ? err.message : 'parse error'}).`, 'Reinstall the package: `npm install -g @pcircle/memesh`. If the problem persists open an issue.');
    }
    const entries = manifest.entries ?? [];
    if (entries.length === 0) {
        return createCheck('skills-manifest', 'Skills + hooks integrity', 'fail', 'skills-manifest.json contains zero entries.', 'Reinstall the package: `npm install -g @pcircle/memesh`.');
    }
    const mismatches = [];
    const missing = [];
    for (const entry of entries) {
        const full = path.join(packageRoot, entry.path);
        if (!existsSyncImpl(full)) {
            missing.push(entry.path);
            continue;
        }
        let actualHash;
        try {
            const buf = readFileSyncImpl(full);
            actualHash = createHash('sha256').update(buf).digest('hex');
        }
        catch (err) {
            mismatches.push(`${entry.path} (read error: ${err instanceof Error ? err.message : 'unknown'})`);
            continue;
        }
        if (actualHash !== entry.sha256)
            mismatches.push(entry.path);
    }
    if (missing.length === 0 && mismatches.length === 0) {
        return createCheck('skills-manifest', 'Skills + hooks integrity', 'pass', `${entries.length} skill / hook files match the published manifest (SHA-256 verified).`);
    }
    const detail = [
        missing.length > 0 ? `${missing.length} missing: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ''}` : null,
        mismatches.length > 0 ? `${mismatches.length} tampered: ${mismatches.slice(0, 3).join(', ')}${mismatches.length > 3 ? ` (+${mismatches.length - 3} more)` : ''}` : null,
    ].filter(Boolean).join('; ');
    return createCheck('skills-manifest', 'Skills + hooks integrity', 'fail', `Manifest verification failed: ${detail}.`, 'Reinstall the package: `npm install -g @pcircle/memesh`. If the problem reproduces on a fresh install, open a security issue at https://github.com/PCIRCLE-AI/memesh-llm-memory/security.');
}
async function inspectConfigParse(getConfigPathImpl, existsSyncImpl, readFileSyncImpl) {
    const configPath = getConfigPathImpl();
    if (!existsSyncImpl(configPath)) {
        return createCheck('config_parse', 'Config parses', 'pass', 'No config file yet — defaults apply. This is normal for a fresh install.');
    }
    try {
        const raw = readFileSyncImpl(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return createCheck('config_parse', 'Config parses', 'fail', `${configPath} parsed but is not a JSON object — every setting is being ignored.`, `Fix or remove ${configPath}, then re-run memesh doctor.`);
        }
        return createCheck('config_parse', 'Config parses', 'pass', `${configPath} is valid JSON and its settings are in effect.`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return createCheck('config_parse', 'Config parses', 'fail', `${configPath} could not be read or parsed (${msg}). Every setting in it — LLM provider, fallbacks, embedder — is being silently ignored right now.`, `Fix the JSON or remove the file to fall back to defaults: mv ${configPath} ${configPath}.bak`);
    }
}
async function inspectEmbeddingProbe(capabilities, probeCapabilities, embedTextImpl) {
    if (capabilities.embeddings === 'tfidf') {
        return createInfo('embeddings_probe', 'Embeddings work', 'No neural embedder configured — recall runs on FTS5 keyword search alone. That is a supported mode, not a fault.');
    }
    if (!probeCapabilities) {
        const isLocal = capabilities.embeddings === 'onnx';
        if (!isLocal) {
            return createInfo('embeddings_probe', 'Embeddings work', `NOT VERIFIED. Config names "${capabilities.embeddings}", but generating a test embedding is a network call (billed on hosted providers) so it was not made — a revoked key or an unreachable host would look identical to a healthy setup here.`, 'Run: memesh doctor --probe   (generates one test embedding to confirm)');
        }
        if (!isOnnxModelCached()) {
            return createInfo('embeddings_probe', 'Embeddings work', `NOT VERIFIED. Config names "onnx" but the model is not in the local cache yet, and probing would download ~90 MB — which a diagnostic command must not do on its own.`, 'Run: memesh doctor --probe   (downloads the model once, then verifies)');
        }
    }
    let timer;
    try {
        const vector = await Promise.race([
            embedTextImpl('memesh doctor embedding probe'),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`no response within ${EMBEDDING_PROBE_TIMEOUT_MS / 1000}s`)), EMBEDDING_PROBE_TIMEOUT_MS);
            }),
        ]);
        if (!vector || vector.length === 0) {
            return createCheck('embeddings_probe', 'Embeddings work', 'warn', `Config selects "${capabilities.embeddings}" but generating a test embedding returned nothing. Semantic recall is degraded to FTS5-only; keyword search still works.`, 'Run: memesh doctor --probe for detail, or check network access to the embedding provider.');
        }
        return createCheck('embeddings_probe', 'Embeddings work', 'pass', `Generated a ${vector.length}-dim test embedding via "${capabilities.embeddings}".`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return createCheck('embeddings_probe', 'Embeddings work', 'warn', `Config selects "${capabilities.embeddings}" but the embedder threw (${msg}). Semantic recall is degraded to FTS5-only.`, 'Check the embedding provider is reachable, or set: memesh config set embedder.provider onnx');
    }
    finally {
        clearTimeout(timer);
    }
}
async function inspectLlmProbe(capabilities, probeCapabilities, probeProviderImpl) {
    const llm = capabilities.llm;
    if (!llm) {
        return createInfo('llm_probe', 'LLM reachable', 'No LLM configured — Core Mode. Write-side features (consolidate, lessons, auto-tag, dream) are off by design.');
    }
    if (!probeCapabilities) {
        return createInfo('llm_probe', 'LLM reachable', `NOT VERIFIED. Config names ${llm.provider} (${llm.model ?? 'default'}), but no live call was made — an expired key or an unreachable host would look identical to a healthy setup here.`, 'Run: memesh doctor --probe   (makes one small live call to confirm)');
    }
    try {
        const result = await probeProviderImpl(llm.provider, llm.apiKey);
        if (result.valid) {
            return createCheck('llm_probe', 'LLM reachable', 'pass', `${llm.provider} answered a live probe.`);
        }
        return createCheck('llm_probe', 'LLM reachable', 'fail', `${llm.provider} is configured but did not answer: ${result.error ?? 'unknown error'}. Every LLM-backed feature is silently doing nothing.`, 'Check the API key / host, then re-run: memesh doctor --probe');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return createCheck('llm_probe', 'LLM reachable', 'fail', `${llm.provider} probe threw: ${msg}. Every LLM-backed feature is silently doing nothing.`, 'Check the API key / host, then re-run: memesh doctor --probe');
    }
}
function summarizeOverallStatus(checks) {
    const assertions = checks.filter((check) => !check.informational);
    if (assertions.some((check) => check.status === 'fail'))
        return 'FAIL';
    if (assertions.some((check) => check.status === 'warn'))
        return 'PASS_WITH_CONCERNS';
    return 'PASS';
}
export async function runDoctor(options) {
    const { packageRoot, packageVersion, probeHttp = false, probeCapabilities = false, embedTextImpl = embedText, probeProviderImpl = probeProvider, httpBaseUrl = 'http://127.0.0.1:3737', platform = process.platform, openDatabaseImpl = openDatabase, closeDatabaseImpl = closeDatabase, isDatabaseOpenImpl = isDatabaseOpen, detectCapabilitiesImpl = detectCapabilities, getConfigPathImpl = getConfigPath, getUpdateCheckImpl = getUpdateCheck, getCurrentInstallChannelImpl = getCurrentInstallChannel, getInstallChannelSupportImpl = getInstallChannelSupport, existsSyncImpl = fs.existsSync, readFileSyncImpl = fs.readFileSync, statSyncImpl = fs.statSync, fetchImpl = fetch, nativeBindingProbeImpl, resolveShellMemeshImpl = defaultResolveShellMemesh, } = options;
    const wasDbOpenBeforeUs = isDatabaseOpenImpl();
    const safeCloseDatabaseImpl = wasDbOpenBeforeUs
        ? () => undefined
        : closeDatabaseImpl;
    const checks = [];
    const install = getCurrentInstallChannelImpl({ packageRoot });
    const installSupport = getInstallChannelSupportImpl(install);
    checks.push(createCheck('install-channel', 'Install method', install === 'unknown' ? 'warn' : 'pass', `Install method detected: ${installSupport.label}.`, install === 'unknown'
        ? 'If this is a source checkout, run MeMesh from the repo root. If this is a packaged install, reinstall with `npm install -g @pcircle/memesh`.'
        : undefined));
    const databasePath = resolveDatabasePath();
    const dbChecks = [];
    try {
        const db = openDatabaseImpl(databasePath);
        const count = db.prepare('SELECT COUNT(*) as c FROM entities').get()?.c ?? 0;
        dbChecks.push(createCheck('database', 'Database', 'pass', `Database opened successfully at ${databasePath} (${count} entities).`));
        const hasVocab = db
            .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'fts_vocab'`)
            .get();
        if (hasVocab?.present) {
            const unsegmented = db
                .prepare(`SELECT term FROM fts_vocab
            WHERE length(term) > 2
              AND term GLOB ?
            LIMIT 1`)
                .get(UNSPACED_SCRIPT_GLOB_PREFIX);
            if (unsegmented?.term) {
                dbChecks.push(createCheck('fts_segmentation', 'Keyword index segmentation', 'warn', `The keyword index holds unsegmented terms (e.g. "${unsegmented.term}"), so some memories ` +
                    `are only findable by their exact full text. This happens when an older build wrote to a ` +
                    `database that a newer one had already migrated — the version marker only moves forward, ` +
                    `so the automatic rebuild cannot notice.`, `Run 'memesh reindex --fts' to rebuild the keyword index.`));
            }
        }
        const pendingReindex = getPendingReindexInfo();
        if (pendingReindex) {
            dbChecks.push(createCheck('vector_index', 'Vector Index', 'warn', `Search index needs rebuilding (embedding configuration changed)`, `Run 'memesh reindex' to fix. This will restore full search functionality.`));
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'unknown database error';
        let diagnosis;
        let fix;
        if (existsSyncImpl(databasePath)) {
            try {
                const stat = statSyncImpl(databasePath);
                const canRead = !!(stat.mode & 0o400);
                const canWrite = !!(stat.mode & 0o200);
                if (!canRead || !canWrite) {
                    diagnosis = `Database file exists but has insufficient permissions (${(stat.mode & 0o777).toString(8)})`;
                    fix = `Fix permissions: chmod 600 "${databasePath}"`;
                }
                else if (stat.size === 0) {
                    diagnosis = 'Database file is empty (0 bytes) — likely corrupted';
                    fix = `Delete and recreate: rm "${databasePath}" && memesh recall (will create fresh DB)`;
                }
                else {
                    diagnosis = `Database file exists (${stat.size} bytes) but cannot be opened: ${message}`;
                    fix = `Backup and reset: mv "${databasePath}" "${databasePath}.backup" && memesh recall`;
                }
            }
            catch {
                diagnosis = `Database file exists at ${databasePath} but stat() failed: ${message}`;
                fix = `Check file system integrity and permissions`;
            }
        }
        else {
            const dir = path.dirname(databasePath);
            if (!existsSyncImpl(dir)) {
                diagnosis = `Database directory does not exist: ${dir}`;
                fix = `Create directory: mkdir -p "${dir}" && memesh recall (will create fresh DB)`;
            }
            else {
                try {
                    const dirStat = statSyncImpl(dir);
                    const canWrite = !!(dirStat.mode & 0o200);
                    if (!canWrite) {
                        diagnosis = `Cannot create database — directory is not writable: ${dir}`;
                        fix = `Fix directory permissions: chmod 700 "${dir}"`;
                    }
                    else {
                        diagnosis = `Database file missing at ${databasePath}, but directory exists and is writable`;
                        fix = `Run any memesh command (e.g., memesh recall) to create a fresh database`;
                    }
                }
                catch {
                    diagnosis = `Database directory exists but cannot be accessed: ${dir}`;
                    fix = `Check directory permissions and ownership`;
                }
            }
        }
        dbChecks.length = 0;
        dbChecks.push(createCheck('database', 'Database', 'fail', diagnosis, fix));
    }
    finally {
        checks.push(...dbChecks);
        try {
            safeCloseDatabaseImpl();
        }
        catch {
        }
    }
    checks.push(inspectConfigFile(existsSyncImpl, readFileSyncImpl, getConfigPathImpl));
    checks.push(inspectMcpConfig(packageRoot, existsSyncImpl, readFileSyncImpl));
    checks.push(...inspectHooksConfig(packageRoot, platform, existsSyncImpl, readFileSyncImpl, statSyncImpl));
    checks.push(inspectHookWiring(existsSyncImpl, readFileSyncImpl, memeshDir(), packageRoot));
    checks.push(inspectHookActivity(openDatabaseImpl, safeCloseDatabaseImpl, existsSyncImpl, statSyncImpl));
    checks.push(inspectDashboardArtifact(packageRoot, existsSyncImpl));
    checks.push(inspectNativeBinding(packageRoot, existsSyncImpl, nativeBindingProbeImpl));
    checks.push(inspectShellCli(install, packageRoot, resolveShellMemeshImpl));
    checks.push(verifySkillsManifest(packageRoot, existsSyncImpl, readFileSyncImpl));
    const capabilities = detectCapabilitiesImpl();
    checks.push(createInfo('capabilities', 'Capabilities (configured)', `Search level ${capabilities.searchLevel} (${capabilities.searchLevel === 1 ? 'Smart Mode' : 'Core'}); embeddings: ${capabilities.embeddings}; LLM: ${capabilities.llm ? `${capabilities.llm.provider} (${capabilities.llm.model ?? 'default'})` : 'not configured'}. Configured values only — see the probe rows below for what actually works.`));
    checks.push(await inspectConfigParse(getConfigPathImpl, existsSyncImpl, readFileSyncImpl));
    checks.push(await inspectEmbeddingProbe(capabilities, probeCapabilities, embedTextImpl));
    checks.push(await inspectLlmProbe(capabilities, probeCapabilities, probeProviderImpl));
    checks.push(await inspectUpdateStatus(packageVersion, getUpdateCheckImpl, installSupport));
    try {
        const record = getInstallRecord();
        checks.push(createCheck('install_id', 'Install ID', 'pass', `Anonymous install ID: ${record.install_id} (created ${record.created_at}). Stored locally at ~/.memesh/install.json. Never transmitted automatically; included only in feedback issues you submit with the "Include system info" checkbox on.`));
    }
    catch {
    }
    checks.push(inspectLocaleReadmeParity(packageRoot, existsSyncImpl, readFileSyncImpl));
    if (probeHttp) {
        checks.push(await inspectHttpProbe(httpBaseUrl, fetchImpl));
    }
    return {
        status: summarizeOverallStatus(checks),
        checks,
    };
}
function iconForStatus(status) {
    switch (status) {
        case 'pass':
            return 'PASS';
        case 'warn':
            return 'WARN';
        default:
            return 'FAIL';
    }
}
export function formatDoctorReport(result, packageVersion) {
    const lines = [`MeMesh doctor v${packageVersion}`, `Overall: ${result.status}`];
    for (const check of result.checks) {
        lines.push('');
        lines.push(`[${check.informational ? 'INFO' : iconForStatus(check.status)}] ${check.label}`);
        lines.push(`  ${check.summary}`);
        if (check.fix) {
            lines.push(`  Fix: ${check.fix}`);
        }
    }
    return lines;
}
//# sourceMappingURL=doctor.js.map