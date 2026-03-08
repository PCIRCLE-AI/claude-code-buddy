/**
 * Postinstall Library - Core Functions
 *
 * Implements plugin installation logic with backward compatibility
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, copyFileSync, lstatSync, realpathSync, readdirSync, statSync } from 'fs';
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
// MCP Configuration
// ============================================================================
/**
 * Ensure MCP is configured in mcp_settings.json
 */
export async function ensureMCPConfigured(installPath, mode, claudeDir = join(homedir(), '.claude')) {
    const mcpSettingsFile = join(claudeDir, 'mcp_settings.json');

    // Read existing config or create new
    let config = readJSONFile(mcpSettingsFile) || { mcpServers: {} };
    if (!config.mcpServers) {
        config.mcpServers = {};
    }

    // Configure memesh entry based on mode
    if (mode === 'global') {
        // Global install: use npx (always uses latest published version)
        config.mcpServers.memesh = {
            command: 'npx',
            args: ['-y', '@pcircle/memesh'],
            env: { NODE_ENV: 'production' }
        };
    } else {
        // Local dev: use node + absolute path (for testing)
        const serverPath = join(installPath, 'dist', 'mcp', 'server-bootstrap.js');
        config.mcpServers.memesh = {
            command: 'node',
            args: [serverPath]
        };
    }

    // Remove legacy claude-code-buddy entry if exists
    if (config.mcpServers['claude-code-buddy']) {
        delete config.mcpServers['claude-code-buddy'];
    }

    // Write back
    writeJSONFile(mcpSettingsFile, config);
}
// ============================================================================
// Hook Installation
// ============================================================================

/**
 * Hook files to install and their event type mappings.
 * Each hook is copied to ~/.claude/hooks/ and registered in settings.json.
 */
const HOOK_DEFINITIONS = [
  { file: 'session-start.js', event: 'SessionStart', matcher: '*' },
  { file: 'post-tool-use.js', event: 'PostToolUse', matcher: '*' },
  { file: 'post-commit.js', event: 'PostToolUse', matcher: '*' },
  { file: 'stop.js', event: 'Stop', matcher: '*' },
  { file: 'subagent-stop.js', event: 'Stop', matcher: '*' },
  { file: 'pre-tool-use.js', event: 'PreToolUse', matcher: '*' },
];

/**
 * Utility files that hooks depend on (copied but not registered as hooks)
 */
const HOOK_UTILITIES = [
  'hook-utils.js',
  'session-start-recall-utils.js',
  'post-tool-use-recall-utils.js',
];

/**
 * Directories that hooks depend on (copied recursively)
 */
const HOOK_DIRECTORIES = [
  'templates',
];

/**
 * Install MeMesh hooks to ~/.claude/hooks/ and register in settings.json.
 *
 * Strategy:
 * 1. Copy hook files + utilities to ~/.claude/hooks/
 * 2. Register hooks in ~/.claude/settings.json under "hooks" key
 * 3. Skip if user already has a hook for the same event (don't overwrite user config)
 * 4. Track which hooks came from MeMesh via a marker comment in the file
 *
 * @param {string} installPath - Path to the installed package (contains scripts/hooks/)
 * @param {string} claudeDir - Path to ~/.claude
 * @returns {{ installed: string[], skipped: string[], errors: string[] }}
 */
export function ensureHooksInstalled(installPath, claudeDir = join(homedir(), '.claude')) {
  const result = { installed: [], skipped: [], errors: [] };
  const sourceDir = join(installPath, 'scripts', 'hooks');
  const targetDir = join(claudeDir, 'hooks');
  const settingsFile = join(claudeDir, 'settings.json');

  // Ensure hooks directory exists
  ensureDirectory(targetDir);

  // 1. Copy all hook files + utilities
  const allFiles = [...HOOK_DEFINITIONS.map(h => h.file), ...HOOK_UTILITIES];
  for (const fileName of allFiles) {
    const src = join(sourceDir, fileName);
    const dst = join(targetDir, fileName);
    try {
      if (!existsSync(src)) continue;

      // Check if target exists and is newer (user modified it)
      if (existsSync(dst)) {
        const srcContent = readFileSync(src, 'utf-8');
        const dstContent = readFileSync(dst, 'utf-8');
        // Skip if identical
        if (srcContent === dstContent) continue;
        // If target has user modifications (no MeMesh marker), skip
        if (!dstContent.includes('@memesh-managed') && !dstContent.includes('MeMesh')) {
          result.skipped.push(fileName);
          continue;
        }
      }

      copyFileSync(src, dst);
    } catch (error) {
      result.errors.push(`${fileName}: ${error.message}`);
    }
  }

  // 1b. Copy hook directories (e.g., templates/)
  for (const dirName of HOOK_DIRECTORIES) {
    const srcDir = join(sourceDir, dirName);
    const dstDir = join(targetDir, dirName);
    try {
      if (!existsSync(srcDir)) continue;
      ensureDirectory(dstDir);

      // Copy all files in the directory
      const entries = readdirSync(srcDir);
      for (const entry of entries) {
        const srcFile = join(srcDir, entry);
        const dstFile = join(dstDir, entry);
        // Only copy files (not subdirectories)
        if (statSync(srcFile).isFile()) {
          copyFileSync(srcFile, dstFile);
        }
      }
    } catch (error) {
      result.errors.push(`${dirName}/: ${error.message}`);
    }
  }

  // 2. Register hooks in settings.json
  let settings = readJSONFile(settingsFile) || {};
  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const hookDef of HOOK_DEFINITIONS) {
    const { file: hookFile, event, matcher } = hookDef;
    const hookCommand = join('~/.claude/hooks', hookFile);

    // Ensure event array exists
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Check if MeMesh hook is already registered for this event
    const existingEntry = settings.hooks[event].find(entry => {
      if (!entry.hooks) return false;
      return entry.hooks.some(h => h.command && h.command.includes(hookFile));
    });

    if (existingEntry) {
      result.skipped.push(`${event}:${hookFile}`);
      continue;
    }

    // Register the hook
    settings.hooks[event].push({
      matcher,
      hooks: [{
        type: 'command',
        command: hookCommand,
      }],
    });
    result.installed.push(`${event}:${hookFile}`);
  }

  // Write settings back
  writeJSONFile(settingsFile, settings);

  return result;
}

// ============================================================================
// Backward Compatibility
// ============================================================================
/**
 * Detect and fix legacy installations
 */
export async function detectAndFixLegacyInstall(installPath, claudeDir = join(homedir(), '.claude')) {
    const marketplacesFile = join(claudeDir, 'plugins', 'known_marketplaces.json');
    const mcpSettingsFile = join(claudeDir, 'mcp_settings.json');
    const symlinkPath = join(claudeDir, 'plugins', 'marketplaces', 'pcircle-ai');
    // Check if marketplace registered
    const marketplaces = readJSONFile(marketplacesFile);
    const hasMarketplace = marketplaces && marketplaces['pcircle-ai'];
    // Check if MCP configured
    const mcpSettings = readJSONFile(mcpSettingsFile);
    const hasMCP = mcpSettings && mcpSettings.mcpServers && mcpSettings.mcpServers.memesh;
    // Check if symlink exists
    const hasSymlink = existsSync(symlinkPath);
    // If everything is correct, return ok
    if (hasMarketplace && hasMCP && hasSymlink) {
        return 'ok';
    }
    // Legacy installation detected - fix it
    const mode = detectInstallMode(installPath);
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
    // Fix MCP config
    if (!hasMCP) {
        await ensureMCPConfigured(installPath, mode, claudeDir);
    }
    return 'fixed';
}
