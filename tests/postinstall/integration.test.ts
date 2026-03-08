/**
 * Integration Tests - End-to-End Scenarios
 *
 * Tests plugin installation logic (marketplace, symlink, plugin enablement).
 * MCP and hooks are handled by the Claude Code plugin system via .mcp.json and hooks/hooks.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestEnvironment } from './setup';
import {
  detectInstallMode,
  ensureMarketplaceRegistered,
  ensureSymlinkExists,
  ensurePluginEnabled,
  detectAndFixLegacyInstall
} from '../../scripts/postinstall-lib';

describe('Integration: Plugin Enablement', () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = new TestEnvironment('plugin-enable');
    env.setup();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('should create settings.json and enable plugin', async () => {
    // Given: no settings.json
    expect(env.fileExists('settings.json')).toBe(false);

    // When: ensurePluginEnabled()
    await ensurePluginEnabled(env.claudeDir);

    // Then: settings.json created with memesh enabled
    expect(env.fileExists('settings.json')).toBe(true);
    const settings = JSON.parse(env.readFile('settings.json'));
    expect(settings.enabledPlugins['memesh@pcircle-ai']).toBe(true);
  });

  it('should preserve other plugins when enabling', async () => {
    // Given: settings.json with other plugins
    env.createFile('settings.json', JSON.stringify({
      enabledPlugins: {
        'other-plugin@marketplace': true
      },
      otherSettings: 'value'
    }, null, 2));

    // When: ensurePluginEnabled()
    await ensurePluginEnabled(env.claudeDir);

    // Then: memesh enabled, others preserved
    const settings = JSON.parse(env.readFile('settings.json'));
    expect(settings.enabledPlugins['memesh@pcircle-ai']).toBe(true);
    expect(settings.enabledPlugins['other-plugin@marketplace']).toBe(true);
    expect(settings.otherSettings).toBe('value');
  });
});

describe('Integration: Legacy MCP Cleanup', () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = new TestEnvironment('mcp-cleanup');
    env.setup();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('should clean up legacy MCP config during legacy fix', async () => {
    // Given: legacy MCP config with memesh entry
    env.createFile('mcp_settings.json', JSON.stringify({
      mcpServers: {
        memesh: {
          command: 'npx',
          args: ['-y', '@pcircle/memesh']
        },
        'other-server': {
          command: 'node',
          args: ['/other/path']
        }
      }
    }, null, 2));

    // When: detectAndFixLegacyInstall()
    await detectAndFixLegacyInstall(env.installPath, env.claudeDir);

    // Then: memesh removed from mcp_settings, other servers preserved
    const config = JSON.parse(env.readFile('mcp_settings.json'));
    expect(config.mcpServers.memesh).toBeUndefined();
    expect(config.mcpServers['other-server']).toBeDefined();
  });

  it('should clean up legacy claude-code-buddy MCP entry', async () => {
    // Given: legacy MCP config with claude-code-buddy entry
    env.createFile('mcp_settings.json', JSON.stringify({
      mcpServers: {
        'claude-code-buddy': {
          command: 'node',
          args: ['/old/path']
        }
      }
    }, null, 2));

    // When: detectAndFixLegacyInstall()
    await detectAndFixLegacyInstall(env.installPath, env.claudeDir);

    // Then: legacy entry removed
    const config = JSON.parse(env.readFile('mcp_settings.json'));
    expect(config.mcpServers['claude-code-buddy']).toBeUndefined();
  });
});

describe('Integration: Backward Compatibility', () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = new TestEnvironment('backward-compat');
    env.setup();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('should detect v2.8.4 legacy installation', async () => {
    // Given: v2.8.4 setup (MCP but no marketplace)
    env.setupLegacyV284();

    // When: detectAndFixLegacyInstall()
    const result = await detectAndFixLegacyInstall(env.installPath, env.claudeDir);

    // Then: fixed
    expect(result).toBe('fixed');

    // Verify marketplace registered
    expect(env.fileExists('plugins/known_marketplaces.json')).toBe(true);
    const marketplaces = JSON.parse(env.readFile('plugins/known_marketplaces.json'));
    expect(marketplaces['pcircle-ai']).toBeDefined();
  });

  it('should not modify correct v2.8.5 installation', async () => {
    // Given: correct v2.8.5 setup
    env.setupCorrectV285();

    // When: detectAndFixLegacyInstall()
    const result = await detectAndFixLegacyInstall(env.installPath, env.claudeDir);

    // Then: returns ok, no changes
    expect(result).toBe('ok');
  });
});

describe('Integration: Complete Installation Flow (E2E)', () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = new TestEnvironment('e2e');
    env.setup();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('should complete fresh installation successfully', async () => {
    // Given: clean system (no ~/.claude setup)
    const installPath = env.installPath;

    // When: run complete installation (no MCP config — plugin system handles it)
    await ensureMarketplaceRegistered(installPath, env.claudeDir);
    await ensureSymlinkExists(installPath, env.marketplacesDir);
    await ensurePluginEnabled(env.claudeDir);

    // Then: all components configured correctly
    // 1. Marketplace registered
    const marketplaces = JSON.parse(env.readFile('plugins/known_marketplaces.json'));
    expect(marketplaces['pcircle-ai']).toBeDefined();

    // 2. Symlink created
    const { existsSync } = await import('fs');
    expect(existsSync(`${env.marketplacesDir}/pcircle-ai`)).toBe(true);

    // 3. Plugin enabled
    const settings = JSON.parse(env.readFile('settings.json'));
    expect(settings.enabledPlugins['memesh@pcircle-ai']).toBe(true);
  });

  it('should upgrade from v2.8.4 successfully', async () => {
    // Given: v2.8.4 installation
    env.setupLegacyV284();

    // When: run upgrade (detectAndFix)
    await detectAndFixLegacyInstall(env.installPath, env.claudeDir);

    // Then: all issues fixed
    const marketplaces = JSON.parse(env.readFile('plugins/known_marketplaces.json'));
    expect(marketplaces['pcircle-ai']).toBeDefined();

    const settings = JSON.parse(env.readFile('settings.json'));
    expect(settings.enabledPlugins['memesh@pcircle-ai']).toBe(true);
  });
});
