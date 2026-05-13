import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { detectCapabilities, getConfigPath } from './config.js';
import { openDatabase, closeDatabase, getPendingReindexInfo, isDatabaseOpen } from '../db.js';
import { getUpdateCheck } from './version-check.js';
import { getCurrentInstallChannel, getInstallChannelSupport } from './install-channel.js';
import { getInstallRecord } from './install-id.js';
import { getDbPath, memeshDir } from './paths.js';
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
function defaultNativeBindingProbe(packageRoot) {
    if (process.env.VITEST === 'true')
        return { ok: true };
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
function inspectNativeBinding(packageRoot, existsSyncImpl, probeImpl = defaultNativeBindingProbe) {
    const pkgDir = path.join(packageRoot, 'node_modules', 'better-sqlite3');
    if (!existsSyncImpl(pkgDir)) {
        return createCheck('native-binding', 'Native SQLite binding', 'fail', `better-sqlite3 is not installed in ${pkgDir}.`, `Run: cd "${packageRoot}" && npm install --omit=dev`);
    }
    const result = probeImpl(packageRoot);
    if (result.ok) {
        return createCheck('native-binding', 'Native SQLite binding', 'pass', 'better-sqlite3 native binding loads cleanly (Database probe succeeded).');
    }
    const isMissingBinding = /bindings file|locate the bindings/i.test(result.message);
    if (isMissingBinding) {
        return createCheck('native-binding', 'Native SQLite binding', 'fail', 'better-sqlite3 is installed but the native binding (.node file) is missing. '
            + 'Hooks will silently skip-and-exit, and auto-capture will NOT write any entities. '
            + 'This is the plugin-marketplace silent-dropout class of bug.', `Run: cd "${packageRoot}" && npm rebuild better-sqlite3   (or "npm install --omit=dev" for a clean reinstall)`);
    }
    return createCheck('native-binding', 'Native SQLite binding', 'fail', `better-sqlite3 failed to load: ${result.message}`, `Run: cd "${packageRoot}" && npm rebuild better-sqlite3`);
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
function summarizeOverallStatus(checks) {
    if (checks.some((check) => check.status === 'fail'))
        return 'FAIL';
    if (checks.some((check) => check.status === 'warn'))
        return 'PASS_WITH_CONCERNS';
    return 'PASS';
}
export async function runDoctor(options) {
    const { packageRoot, packageVersion, probeHttp = false, httpBaseUrl = 'http://127.0.0.1:3737', platform = process.platform, openDatabaseImpl = openDatabase, closeDatabaseImpl = closeDatabase, isDatabaseOpenImpl = isDatabaseOpen, detectCapabilitiesImpl = detectCapabilities, getConfigPathImpl = getConfigPath, getUpdateCheckImpl = getUpdateCheck, getCurrentInstallChannelImpl = getCurrentInstallChannel, getInstallChannelSupportImpl = getInstallChannelSupport, existsSyncImpl = fs.existsSync, readFileSyncImpl = fs.readFileSync, statSyncImpl = fs.statSync, fetchImpl = fetch, nativeBindingProbeImpl, } = options;
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
    try {
        const db = openDatabaseImpl(databasePath);
        const count = db.prepare('SELECT COUNT(*) as c FROM entities').get().c ?? 0;
        checks.push(createCheck('database', 'Database', 'pass', `Database opened successfully at ${databasePath} (${count} entities).`));
        const pendingReindex = getPendingReindexInfo();
        if (pendingReindex) {
            checks.push(createCheck('vector_index', 'Vector Index', 'warn', `Search index needs rebuilding (embedding configuration changed)`, `Run 'memesh reindex' to fix. This will restore full search functionality.`));
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
        checks.push(createCheck('database', 'Database', 'fail', diagnosis, fix));
    }
    finally {
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
    checks.push(verifySkillsManifest(packageRoot, existsSyncImpl, readFileSyncImpl));
    const capabilities = detectCapabilitiesImpl();
    checks.push(createCheck('capabilities', 'Capabilities', 'pass', `Search level ${capabilities.searchLevel} (${capabilities.searchLevel === 1 ? 'Smart Mode' : 'Core'}); embeddings: ${capabilities.embeddings}; LLM: ${capabilities.llm ? `${capabilities.llm.provider} (${capabilities.llm.model ?? 'default'})` : 'not configured'}.`));
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
        lines.push(`[${iconForStatus(check.status)}] ${check.label}`);
        lines.push(`  ${check.summary}`);
        if (check.fix) {
            lines.push(`  Fix: ${check.fix}`);
        }
    }
    return lines;
}
//# sourceMappingURL=doctor.js.map