#!/usr/bin/env node
/**
 * Post-install script for MeMesh (v2.8.5+)
 *
 * Complete plugin installation with backward compatibility
 *
 * Installation flow:
 * 1. Detect install mode (global/local)
 * 2. Register marketplace
 * 3. Create symlink
 * 4. Enable plugin
 * 5. Configure MCP
 * 6. Fix legacy installations
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import chalk from 'chalk';
import boxen from 'boxen';

// Get directory path in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import functions from postinstall-lib.js (compiled from postinstall-lib.ts)
import {
  detectInstallMode,
  getPluginInstallPath,
  ensureMarketplaceRegistered,
  ensureSymlinkExists,
  ensurePluginEnabled,
  ensureMCPConfigured,
  ensureHooksInstalled,
  detectAndFixLegacyInstall
} from './postinstall-lib.js';

// ============================================================================
// Bundled Skills Installation
// ============================================================================

/**
 * Install bundled skills to ~/.claude/skills/sa:<name>/
 * Skills are shipped in scripts/skills/<name>/SKILL.md
 * Only installs if skill doesn't exist or bundled version is newer.
 *
 * @param {string} claudeDir - Path to ~/.claude
 * @returns {{ installed: string[], skipped: string[], errors: string[] }}
 */
function installBundledSkills(claudeDir) {
  const result = { installed: [], skipped: [], errors: [] };
  const bundledDir = join(__dirname, 'skills');
  const skillsDir = join(claudeDir, 'skills');

  if (!existsSync(bundledDir)) {
    return result;
  }

  // Ensure skills directory exists
  mkdirSync(skillsDir, { recursive: true });

  // Read all bundled skills
  let entries;
  try {
    entries = readdirSync(bundledDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillName = entry.name;
    const prefixedName = `sa:${skillName}`;
    const sourceFile = join(bundledDir, skillName, 'SKILL.md');
    const targetDir = join(skillsDir, prefixedName);
    const targetFile = join(targetDir, 'SKILL.md');

    try {
      // Read source first — if it doesn't exist, skip (no TOCTOU with existsSync)
      let content;
      let sourceStat;
      try {
        content = readFileSync(sourceFile, 'utf-8');
        sourceStat = statSync(sourceFile);
      } catch {
        continue; // source doesn't exist, skip
      }

      // Skip if target exists and is newer than source
      try {
        const targetStat = statSync(targetFile);
        if (targetStat.mtimeMs >= sourceStat.mtimeMs) {
          result.skipped.push(skillName);
          continue;
        }
      } catch {
        // target doesn't exist yet, proceed to install
      }

      // Install: create dir + write SKILL.md
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(targetFile, content, 'utf-8');
      result.installed.push(skillName);
    } catch (error) {
      result.errors.push(`${skillName}: ${error.message}`);
    }
  }

  return result;
}

// ============================================================================
// Main Installation Flow
// ============================================================================

async function main() {
  console.log(chalk.cyan('\n🚀 MeMesh Plugin Installation Starting...\n'));

  const results = {
    mode: null,
    installPath: null,
    marketplace: false,
    symlink: false,
    pluginEnabled: false,
    mcpConfigured: false,
    legacyFixed: null,
    errors: []
  };

  try {
    // Step 1: Detect install mode
    // Pass __dirname to getPluginInstallPath for global mode detection
    const installPath = getPluginInstallPath('global', __dirname);
    const mode = detectInstallMode(installPath);
    results.mode = mode;
    results.installPath = installPath;

    console.log(chalk.dim(`  Mode: ${mode}`));
    console.log(chalk.dim(`  Path: ${installPath}\n`));

    const claudeDir = join(homedir(), '.claude');
    const marketplacesDir = join(claudeDir, 'plugins', 'marketplaces');

    // Step 2: Marketplace Registration
    try {
      await ensureMarketplaceRegistered(installPath, claudeDir);
      results.marketplace = true;
      console.log(chalk.green('  ✅ Marketplace registered'));
    } catch (error) {
      results.errors.push(`Marketplace: ${error.message}`);
      console.log(chalk.yellow(`  ⚠️  Marketplace registration failed (non-fatal)`));
    }

    // Step 3: Symlink Creation
    try {
      await ensureSymlinkExists(installPath, marketplacesDir);
      results.symlink = true;
      console.log(chalk.green('  ✅ Symlink created'));
    } catch (error) {
      results.errors.push(`Symlink: ${error.message}`);
      console.log(chalk.yellow(`  ⚠️  Symlink creation failed (non-fatal)`));
    }

    // Step 4: Plugin Enablement
    try {
      await ensurePluginEnabled(claudeDir);
      results.pluginEnabled = true;
      console.log(chalk.green('  ✅ Plugin enabled'));
    } catch (error) {
      results.errors.push(`Plugin Enable: ${error.message}`);
      console.log(chalk.yellow(`  ⚠️  Plugin enablement failed (non-fatal)`));
    }

    // Step 5: MCP Configuration
    // IMPORTANT: Skip MCP config for local dev to prevent path pollution
    // (see v2.9.0 Issue 2: Local Development Path Pollution)
    if (mode === 'local') {
      console.log(chalk.yellow('  ⚠️  Skipping MCP configuration (local development mode)'));
      console.log(chalk.gray('     This prevents writing local dev paths to ~/.claude/mcp_settings.json'));
      results.mcpConfigured = false;
    } else {
      try {
        await ensureMCPConfigured(installPath, mode, claudeDir);
        results.mcpConfigured = true;
        console.log(chalk.green('  ✅ MCP configured'));
      } catch (error) {
        results.errors.push(`MCP: ${error.message}`);
        console.log(chalk.yellow(`  ⚠️  MCP configuration failed (non-fatal)`));
      }
    }

    // Step 6: Hook Installation
    try {
      const hookResult = ensureHooksInstalled(installPath, claudeDir);
      results.hooksInstalled = hookResult.installed;
      results.hooksSkipped = hookResult.skipped;

      if (hookResult.installed.length > 0) {
        console.log(chalk.green(`  ✅ Hooks installed: ${hookResult.installed.join(', ')}`));
      } else if (hookResult.skipped.length > 0) {
        console.log(chalk.dim(`  ℹ️  Hooks already configured (${hookResult.skipped.length} existing)`));
      }

      if (hookResult.errors.length > 0) {
        results.errors.push(`Hooks: ${hookResult.errors.join('; ')}`);
        console.log(chalk.yellow(`  ⚠️  Some hooks failed: ${hookResult.errors.join(', ')}`));
      }
    } catch (error) {
      results.errors.push(`Hooks: ${error.message}`);
      console.log(chalk.yellow(`  ⚠️  Hook installation failed (non-fatal)`));
    }

    // Step 7: Legacy Installation Fix (renumbered)
    try {
      const legacyStatus = await detectAndFixLegacyInstall(installPath, claudeDir);
      results.legacyFixed = legacyStatus;

      if (legacyStatus === 'fixed') {
        console.log(chalk.green('  ✅ Legacy installation upgraded'));
      } else if (legacyStatus === 'ok') {
        console.log(chalk.dim('  ℹ️  No legacy issues detected'));
      }
    } catch (error) {
      console.log(chalk.dim('  ℹ️  Legacy check skipped'));
    }

    // Step 8: Install Bundled Skills
    try {
      const skillResult = installBundledSkills(claudeDir);
      results.skillsInstalled = skillResult.installed;
      results.skillsSkipped = skillResult.skipped;

      if (skillResult.installed.length > 0) {
        console.log(chalk.green(`  ✅ Skills installed: ${skillResult.installed.join(', ')}`));
      } else if (skillResult.skipped.length > 0) {
        console.log(chalk.dim(`  ℹ️  Skills up to date (${skillResult.skipped.length} already installed)`));
      }

      if (skillResult.errors.length > 0) {
        results.errors.push(`Skills: ${skillResult.errors.join('; ')}`);
      }
    } catch (error) {
      console.log(chalk.dim('  ℹ️  Skills installation skipped'));
    }

  } catch (error) {
    console.error(chalk.red('\n❌ Installation failed:'), error.message);
    console.error(chalk.yellow('\n💡 You can configure manually (see instructions below)\n'));
  }

  // ============================================================================
  // Display Installation Summary
  // ============================================================================

  const allSuccess = results.marketplace && results.symlink &&
                     results.pluginEnabled && results.mcpConfigured;

  const statusIcon = allSuccess ? '✅' : (results.errors.length > 0 ? '⚠️' : '✅');
  const statusText = allSuccess
    ? chalk.green('Installation Complete!')
    : chalk.yellow('Installation completed with warnings');

  const message = `
${chalk.bold(statusIcon + '  ' + statusText)}

${chalk.bold('Installation Summary:')}
  ${results.marketplace ? '✅' : '⚠️'}  Marketplace: ${results.marketplace ? 'Registered' : 'Failed'}
  ${results.symlink ? '✅' : '⚠️'}  Symlink: ${results.symlink ? 'Created' : 'Failed'}
  ${results.pluginEnabled ? '✅' : '⚠️'}  Plugin: ${results.pluginEnabled ? 'Enabled' : 'Failed'}
  ${results.mcpConfigured ? '✅' : '⚠️'}  MCP: ${results.mcpConfigured ? 'Configured' : 'Failed'}

${chalk.bold('What You Got:')}
  ${chalk.cyan('•')} 8 MCP tools (persistent memory, semantic search, task routing)
  ${chalk.cyan('•')} Auto-memory hooks (session recall, work tracking, smart routing)
  ${chalk.cyan('•')} Vector semantic search with ONNX embeddings (runs 100% locally)
  ${chalk.cyan('•')} Auto-relation inference in knowledge graph
  ${chalk.cyan('•')} Local-first architecture (all data stored locally)

${chalk.bold('Next Steps:')}
  ${chalk.yellow('1.')} ${chalk.bold('Restart Claude Code')}
     Completely quit and reopen to load the plugin

  ${chalk.yellow('2.')} ${chalk.bold('Verify Installation')}
     Run: ${chalk.cyan('node scripts/health-check.js')}

  ${chalk.yellow('3.')} ${chalk.bold('Test MeMesh Tools')}
     Ask Claude: ${chalk.italic('"List available MeMesh tools"')}

${chalk.bold('Documentation:')}
  ${chalk.cyan('•')} User Guide: ${chalk.underline('https://github.com/PCIRCLE-AI/claude-code-buddy/blob/main/docs/USER_GUIDE.md')}
  ${chalk.cyan('•')} Commands: ${chalk.underline('https://github.com/PCIRCLE-AI/claude-code-buddy/blob/main/docs/COMMANDS.md')}

${results.errors.length > 0 ? chalk.yellow('\n⚠️  Warnings:\n  ' + results.errors.join('\n  ')) : ''}

${chalk.dim('Need help? Open an issue: https://github.com/PCIRCLE-AI/claude-code-buddy/issues')}
`;

  console.log(
    boxen(message, {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: allSuccess ? 'green' : 'yellow',
    })
  );

  // Exit with appropriate code
  // Critical failures (MCP config, plugin registration) → exit 1
  // Non-critical failures (skills, symlink already exists) → exit 0
  const hasCriticalFailure = !results.mcpConfigured && results.mode !== 'local';
  const hasPluginFailure = !results.pluginEnabled;
  if (hasCriticalFailure || hasPluginFailure) {
    process.exit(1);
  }
  process.exit(0);
}

// ============================================================================
// Execute
// ============================================================================

main().catch((error) => {
  console.error(chalk.red('\n💥 Fatal error during installation:'));
  console.error(error);
  process.exit(1);
});
