/**
 * Postinstall Library - Core Functions
 *
 * Implements plugin installation logic with backward compatibility
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, copyFileSync, lstatSync, realpathSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
// ============================================================================
// Environment Detection
// ============================================================================
/**
 * Detect install mode (global vs local dev)
 */
export function detectInstallMode(installPath) {
    // Check if path contains 'node_modules' - indicates global install
    if (installPath.includes('node_modules')) {
        return 'global';
    }
    // Check if in project root (has package.json, src/, etc.)
    const hasPackageJson = existsSync(join(installPath, 'package.json'));
    const hasSrcDir = existsSync(join(installPath, 'src'));
    if (hasPackageJson && hasSrcDir) {
        return 'local';
    }
    // Default to global
    return 'global';
}
/**
 * Get plugin install path based on mode
 * @param mode Install mode ('global' or 'local')
 * @param scriptDir Directory where this script is located (for global mode)
 */
export function getPluginInstallPath(mode, scriptDir) {
    if (mode === 'local') {
        // Local dev: current working directory
        return process.cwd();
    }
    // Global: use provided scriptDir or fallback to cwd
    // For postinstall script, scriptDir will be the scripts/ directory
    if (scriptDir) {
        return dirname(scriptDir); // Parent of scripts/ directory
    }
    // Fallback: assume we're in the package root
    return process.cwd();
}
// ============================================================================
// File Utilities
// ============================================================================
/**
 * Ensure directory exists
 */
export function ensureDirectory(path) {
    if (!existsSync(path)) {
        mkdirSync(path, { recursive: true });
    }
}
/**
 * Read JSON file safely
 */
export function readJSONFile(path) {
    try {
        if (!existsSync(path)) {
            return null;
        }
        const content = readFileSync(path, 'utf-8').trim();
        if (!content) {
            return null;
        }
        return JSON.parse(content);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[readJSONFile] Failed to parse ${path}: ${msg}\n`);
        return null;
    }
}
/**
 * Write JSON file
 */
export function writeJSONFile(path, data) {
    ensureDirectory(dirname(path));
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}
/**
 * Backup file with timestamp
 */
export function backupFile(path) {
    if (!existsSync(path)) {
        return null;
    }
    const backupPath = `${path}.backup-${Date.now()}`;
    try {
        copyFileSync(path, backupPath);
        return backupPath;
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[backupFile] Failed to backup ${path}: ${msg}\n`);
        return null;
    }
}
// ============================================================================
// Marketplace Registration
// ============================================================================
/**
 * Ensure marketplace is registered in known_marketplaces.json
 */
export async function ensureMarketplaceRegistered(installPath, claudeDir = join(homedir(), '.claude')) {
    const marketplacesFile = join(claudeDir, 'plugins', 'known_marketplaces.json');
    const marketplacesDir = join(claudeDir, 'plugins', 'marketplaces');
    const symlinkPath = join(marketplacesDir, 'pcircle-ai');
    // Ensure directories exist
    ensureDirectory(join(claudeDir, 'plugins'));
    // Read existing marketplaces or create new
    let marketplaces = readJSONFile(marketplacesFile) || {};
    // If file exists but parse failed, backup and start fresh
    if (existsSync(marketplacesFile) && marketplaces === null) {
        backupFile(marketplacesFile);
        marketplaces = {};
    }
    // Register or update pcircle-ai entry
    marketplaces['pcircle-ai'] = {
        source: {
            source: 'directory',
            path: installPath
        },
        installLocation: symlinkPath,
        lastUpdated: new Date().toISOString()
    };
    // Write back
    writeJSONFile(marketplacesFile, marketplaces);
}
// ============================================================================
// Symlink Management
// ============================================================================
/**
 * Ensure symlink exists and points to correct location
 */
export async function ensureSymlinkExists(installPath, marketplacesDir) {
    const symlinkPath = join(marketplacesDir, 'pcircle-ai');
    // Ensure marketplaces directory exists
    ensureDirectory(marketplacesDir);
    // Check if symlink exists
    if (existsSync(symlinkPath)) {
        try {
            // Check if it's a symlink
            const stats = lstatSync(symlinkPath);
            if (stats.isSymbolicLink()) {
                // Check if it points to the correct location
                const target = realpathSync(symlinkPath);
                const expectedTarget = realpathSync(installPath);
                if (target === expectedTarget) {
                    // Symlink correct, nothing to do
                    return;
                }
                // Points to wrong location, remove and recreate
                unlinkSync(symlinkPath);
            }
            else {
                // Not a symlink, remove it
                unlinkSync(symlinkPath);
            }
        }
        catch (error) {
            // Error reading symlink, try to remove and recreate
            try {
                unlinkSync(symlinkPath);
            }
            catch {
                // Ignore errors
            }
        }
    }
    // Create symlink
    try {
        symlinkSync(installPath, symlinkPath, 'dir');
    }
    catch (error) {
        throw new Error(`Failed to create symlink: ${error.message}`);
    }
}
// ============================================================================
// Plugin Enablement
// ============================================================================
/**
 * Ensure plugin is enabled in settings.json
 */
export async function ensurePluginEnabled(claudeDir = join(homedir(), '.claude')) {
    const settingsFile = join(claudeDir, 'settings.json');
    // Read existing settings or create new
    let settings = readJSONFile(settingsFile) || {};
    // Ensure enabledPlugins object exists
    if (!settings.enabledPlugins) {
        settings.enabledPlugins = {};
    }
    // Enable memesh plugin
    settings.enabledPlugins['memesh@pcircle-ai'] = true;
    // Write back
    writeJSONFile(settingsFile, settings);
}
// ============================================================================
// Backward Compatibility
// ============================================================================
/**
 * Detect and fix legacy installations.
 * Only fixes marketplace, symlink, and plugin enablement.
 * MCP and hooks are handled by the plugin system via .mcp.json and hooks/hooks.json.
 */
export async function detectAndFixLegacyInstall(installPath, claudeDir = join(homedir(), '.claude')) {
    const marketplacesFile = join(claudeDir, 'plugins', 'known_marketplaces.json');
    const symlinkPath = join(claudeDir, 'plugins', 'marketplaces', 'pcircle-ai');
    // Check if marketplace registered
    const marketplaces = readJSONFile(marketplacesFile);
    const hasMarketplace = marketplaces && marketplaces['pcircle-ai'];
    // Check if symlink exists
    const hasSymlink = existsSync(symlinkPath);
    // If everything is correct, return ok
    if (hasMarketplace && hasSymlink) {
        return 'ok';
    }
    // Legacy installation detected - fix it
    // Fix marketplace
    if (!hasMarketplace) {
        await ensureMarketplaceRegistered(installPath, claudeDir);
    }
    // Fix symlink
    if (!hasSymlink) {
        await ensureSymlinkExists(installPath, join(claudeDir, 'plugins', 'marketplaces'));
    }
    // Fix plugin enablement
    await ensurePluginEnabled(claudeDir);
    // Clean up legacy MCP config if it exists (plugin system handles MCP now)
    const mcpSettingsFile = join(claudeDir, 'mcp_settings.json');
    const mcpSettings = readJSONFile(mcpSettingsFile);
    if (mcpSettings?.mcpServers?.memesh || mcpSettings?.mcpServers?.['claude-code-buddy']) {
        delete mcpSettings.mcpServers.memesh;
        delete mcpSettings.mcpServers['claude-code-buddy'];
        writeJSONFile(mcpSettingsFile, mcpSettings);
    }
    return 'fixed';
}
