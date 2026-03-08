#!/usr/bin/env node

/**
 * MeMesh Plugin Health Check
 *
 * Fast, non-invasive validation of plugin installation.
 * Supports both npm global install and local dev install.
 *
 * Exit codes:
 *   0 - All healthy
 *   1 - Repairable issues found
 *   2 - Fatal error (requires manual intervention)
 */

import { existsSync, readFileSync, lstatSync, realpathSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Parse CLI flags
const silent = process.argv.includes('--silent');
const verbose = process.argv.includes('--verbose');
const json = process.argv.includes('--json');

/**
 * Detect installation mode based on directory structure.
 * - 'npm-global': installed via npm install -g (dist/ is in package root)
 * - 'dev': running from project source (needs .claude-plugin/memesh/dist/)
 * - 'plugin': installed via /plugin marketplace add (managed by Claude Code)
 */
function detectInstallMode() {
  // If dist/mcp/server-bootstrap.js exists at package root, it's npm or plugin install
  if (existsSync(join(projectRoot, 'dist', 'mcp', 'server-bootstrap.js'))) {
    // Check if we're inside node_modules (npm global)
    if (projectRoot.includes('node_modules')) {
      return 'npm-global';
    }
    // Check if src/ exists (dev environment)
    if (existsSync(join(projectRoot, 'src'))) {
      return 'dev';
    }
    return 'plugin';
  }
  // Fallback: dev mode without build
  return 'dev';
}

const installMode = detectInstallMode();

/**
 * Health check result structure
 */
const result = {
  healthy: true,
  installMode,
  issues: [],
  timestamp: new Date().toISOString(),
  checks: {
    dist: false,
    pluginJson: false,
    mcpJson: false,
    hooks: false,
    marketplace: false,
    symlink: false,
    settings: false,
  }
};

/**
 * Add an issue to the result
 */
function addIssue(path, severity, message, repairable = true) {
  result.issues.push({ path, severity, message, repairable });
  result.healthy = false;
  if (!silent && !json) {
    const icon = severity === 'error' ? '❌' : '⚠️';
    console.error(`   ${icon} ${path}: ${message}`);
  }
}

/**
 * Log success message
 */
function logSuccess(message) {
  if (!silent && !json) {
    if (verbose) {
      console.log(`   ✅ ${message}`);
    }
  }
}

// ============================================================================
// Start
// ============================================================================

if (!silent && !json) {
  console.log('🔍 Checking MeMesh Plugin installation...\n');
  console.log(`   Mode: ${installMode}`);
  console.log(`   Path: ${projectRoot}\n`);
}

// ============================================================================
// Check 1: Server bootstrap exists
// ============================================================================

const serverPath = installMode === 'dev'
  ? join(projectRoot, '.claude-plugin', 'memesh', 'dist', 'mcp', 'server-bootstrap.js')
  : join(projectRoot, 'dist', 'mcp', 'server-bootstrap.js');

if (!existsSync(serverPath)) {
  const hint = installMode === 'dev' ? 'Run: npm run build' : 'Reinstall: npm install -g @pcircle/memesh';
  addIssue('dist', 'error', `server-bootstrap.js not found at ${serverPath}`, false);

  if (!silent && !json) {
    console.error(`\n❌ Plugin not built. ${hint}\n`);
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  }

  process.exit(2);
} else {
  result.checks.dist = true;
  logSuccess('server-bootstrap.js exists');
}

// ============================================================================
// Check 2: plugin.json exists and is valid
// ============================================================================

const pluginJsonPath = join(projectRoot, 'plugin.json');

try {
  if (!existsSync(pluginJsonPath)) {
    addIssue('pluginJson', 'error', 'plugin.json not found');
  } else {
    const plugin = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    if (!plugin.name || !plugin.version) {
      addIssue('pluginJson', 'error', 'plugin.json missing name or version');
    } else {
      result.checks.pluginJson = true;
      logSuccess(`plugin.json valid (${plugin.name} v${plugin.version})`);
    }
  }
} catch (error) {
  addIssue('pluginJson', 'error', `Failed to parse plugin.json: ${error.message}`);
}

// ============================================================================
// Check 3: .mcp.json exists and is valid
// ============================================================================

const mcpJsonPath = join(projectRoot, '.mcp.json');

try {
  if (!existsSync(mcpJsonPath)) {
    addIssue('mcpJson', 'error', '.mcp.json not found');
  } else {
    const mcp = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    if (!mcp.mcpServers?.memesh) {
      addIssue('mcpJson', 'error', '.mcp.json missing memesh server definition');
    } else {
      result.checks.mcpJson = true;
      logSuccess('.mcp.json valid');
    }
  }
} catch (error) {
  addIssue('mcpJson', 'error', `Failed to parse .mcp.json: ${error.message}`);
}

// ============================================================================
// Check 4: hooks/hooks.json exists and scripts are present
// ============================================================================

const hooksJsonPath = join(projectRoot, 'hooks', 'hooks.json');

try {
  if (!existsSync(hooksJsonPath)) {
    addIssue('hooks', 'error', 'hooks/hooks.json not found');
  } else {
    const hooksConfig = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    const events = Object.keys(hooksConfig.hooks || {});

    if (events.length === 0) {
      addIssue('hooks', 'warning', 'No hook events defined');
    } else {
      let allScriptsExist = true;
      for (const event of events) {
        for (const entry of hooksConfig.hooks[event]) {
          for (const hook of entry.hooks) {
            const scriptPath = hook.command.replace('${CLAUDE_PLUGIN_ROOT}', projectRoot);
            if (!existsSync(scriptPath)) {
              addIssue('hooks', 'error', `Hook script missing: ${scriptPath}`);
              allScriptsExist = false;
            }
          }
        }
      }
      if (allScriptsExist) {
        result.checks.hooks = true;
        logSuccess(`hooks valid (${events.length} events)`);
      }
    }
  }
} catch (error) {
  addIssue('hooks', 'error', `Failed to parse hooks.json: ${error.message}`);
}

// ============================================================================
// Check 5: Marketplace registration (npm-global and dev modes)
// ============================================================================

const knownMarketplacesPath = join(homedir(), '.claude', 'plugins', 'known_marketplaces.json');

try {
  if (!existsSync(knownMarketplacesPath)) {
    addIssue('marketplace', 'warning', 'known_marketplaces.json not found (plugin may be installed via /plugin command)');
  } else {
    const content = readFileSync(knownMarketplacesPath, 'utf-8');
    const marketplaces = JSON.parse(content);

    if (marketplaces['pcircle-ai']) {
      result.checks.marketplace = true;
      logSuccess('Marketplace registered');
    } else {
      addIssue('marketplace', 'warning', 'pcircle-ai not in known_marketplaces.json (may be installed via /plugin command)');
    }
  }
} catch (error) {
  addIssue('marketplace', 'error', `Failed to check marketplace: ${error.message}`);
}

// ============================================================================
// Check 6: Symlink or plugin discovery
// ============================================================================

const symlinkPath = join(homedir(), '.claude', 'plugins', 'marketplaces', 'pcircle-ai');

try {
  if (!existsSync(symlinkPath)) {
    addIssue('symlink', 'warning', 'Marketplace symlink not found (may be installed via /plugin command)');
  } else {
    const stats = lstatSync(symlinkPath);

    if (stats.isSymbolicLink()) {
      const target = realpathSync(symlinkPath);
      if (!existsSync(target)) {
        addIssue('symlink', 'error', 'Symlink target does not exist (broken symlink)');
      } else {
        result.checks.symlink = true;
        logSuccess(`Symlink valid → ${target}`);
      }
    } else if (stats.isDirectory()) {
      // Could be a direct clone (plugin marketplace install)
      result.checks.symlink = true;
      logSuccess('Plugin directory exists (marketplace install)');
    } else {
      addIssue('symlink', 'error', 'Marketplace path is not a symlink or directory');
    }
  }
} catch (error) {
  addIssue('symlink', 'error', `Failed to check symlink: ${error.message}`);
}

// ============================================================================
// Check 7: Plugin enabled in settings
// ============================================================================

const settingsPath = join(homedir(), '.claude', 'settings.json');

try {
  if (!existsSync(settingsPath)) {
    addIssue('settings', 'warning', 'settings.json not found');
  } else {
    const content = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    if (!settings.enabledPlugins) {
      addIssue('settings', 'warning', 'enabledPlugins not found in settings.json');
    } else if (!settings.enabledPlugins['memesh@pcircle-ai']) {
      addIssue('settings', 'warning', 'memesh@pcircle-ai not enabled (may need to enable via /plugin command)');
    } else if (settings.enabledPlugins['memesh@pcircle-ai'] !== true) {
      addIssue('settings', 'warning', 'memesh@pcircle-ai is disabled');
    } else {
      result.checks.settings = true;
      logSuccess('Plugin enabled in settings');
    }
  }
} catch (error) {
  addIssue('settings', 'error', `Failed to check settings: ${error.message}`);
}

// ============================================================================
// Summary
// ============================================================================

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else if (!silent) {
  console.log('\n' + '═'.repeat(60));

  if (result.healthy) {
    console.log('✅ All checks passed - plugin installation healthy');
    console.log('═'.repeat(60));
  } else {
    const errors = result.issues.filter(i => i.severity === 'error');
    const warnings = result.issues.filter(i => i.severity === 'warning');

    if (errors.length > 0) {
      console.log(`❌ Found ${errors.length} error(s), ${warnings.length} warning(s)`);
    } else {
      console.log(`⚠️  Found ${warnings.length} warning(s) (non-critical)`);
    }
    console.log('═'.repeat(60));

    if (errors.length > 0) {
      const hint = installMode === 'dev' ? 'npm run build' : 'npm install -g @pcircle/memesh';
      console.log(`\n🔧 Fix errors first. Try: ${hint}\n`);
    }
  }
}

// Exit: errors → 1 or 2, warnings only → 0
const hasErrors = result.issues.some(i => i.severity === 'error');
const hasUnrepairableErrors = result.issues.some(i => i.severity === 'error' && !i.repairable);
process.exit(hasErrors ? (hasUnrepairableErrors ? 2 : 1) : 0);
