/**
 * Test utilities and setup for postinstall tests
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, readlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Test environment for isolated postinstall testing
 */
export class TestEnvironment {
  public testDir: string;
  public claudeDir: string;
  public pluginsDir: string;
  public marketplacesDir: string;
  public installPath: string;

  constructor(name: string) {
    // Create isolated test directory with unpredictable name (secure temp)
    this.testDir = mkdtempSync(join(tmpdir(), `memesh-test-${name}-`));
    this.claudeDir = join(this.testDir, '.claude');
    this.pluginsDir = join(this.claudeDir, 'plugins');
    this.marketplacesDir = join(this.pluginsDir, 'marketplaces');
    this.installPath = join(this.testDir, 'node_modules', '@pcircle', 'memesh');
  }

  /**
   * Setup test environment with necessary directories
   */
  setup(): void {
    mkdirSync(this.testDir, { recursive: true });
    mkdirSync(this.claudeDir, { recursive: true });
    mkdirSync(this.pluginsDir, { recursive: true });
    mkdirSync(this.marketplacesDir, { recursive: true });
    mkdirSync(this.installPath, { recursive: true });

    // Create mock plugin structure
    this.createMockPlugin();
  }

  /**
   * Create mock plugin files in install path
   */
  private createMockPlugin(): void {
    // Create dist directory with server-bootstrap.js
    const distDir = join(this.installPath, 'dist', 'mcp');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, 'server-bootstrap.js'),
      '#!/usr/bin/env node\nconsole.log("Mock MCP server");'
    );

    // Create plugin.json
    writeFileSync(
      join(this.installPath, 'plugin.json'),
      JSON.stringify({
        name: 'memesh',
        version: '2.8.5',
        description: 'Test plugin'
      }, null, 2)
    );

    // Create .mcp.json
    writeFileSync(
      join(this.installPath, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          memesh: {
            command: 'node',
            args: ['dist/mcp/server-bootstrap.js']
          }
        }
      }, null, 2)
    );
  }

  /**
   * Cleanup test environment
   */
  cleanup(): void {
    if (existsSync(this.testDir)) {
      rmSync(this.testDir, { recursive: true, force: true });
    }
  }

  /**
   * Create a file with content
   */
  createFile(relativePath: string, content: string): void {
    const fullPath = join(this.claudeDir, relativePath);
    const dir = join(fullPath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, content, 'utf-8');
  }

  /**
   * Read file content
   */
  readFile(relativePath: string): string {
    return readFileSync(join(this.claudeDir, relativePath), 'utf-8');
  }

  /**
   * Check if file exists
   */
  fileExists(relativePath: string): boolean {
    return existsSync(join(this.claudeDir, relativePath));
  }

  /**
   * Create symlink
   */
  createSymlink(target: string, linkPath: string): void {
    symlinkSync(target, linkPath, 'dir');
  }

  /**
   * Setup v2.8.4 legacy installation (MCP configured, no marketplace)
   */
  setupLegacyV284(): void {
    // Only create mcp_settings.json (no marketplace registration)
    this.createFile('mcp_settings.json', JSON.stringify({
      mcpServers: {
        memesh: {
          command: 'node',
          args: [join(this.installPath, 'dist/mcp/server-bootstrap.js')]
        }
      }
    }, null, 2));
  }

  /**
   * Setup v2.8.3 legacy installation
   */
  setupLegacyV283(): void {
    // Similar to v2.8.4 but with older config
    this.setupLegacyV284();
  }

  /**
   * Setup correct v2.8.5 installation
   */
  setupCorrectV285(): void {
    // Marketplace registered
    this.createFile('plugins/known_marketplaces.json', JSON.stringify({
      'pcircle-ai': {
        source: {
          source: 'local',
          path: this.installPath
        },
        installLocation: join(this.marketplacesDir, 'pcircle-ai'),
        lastUpdated: new Date().toISOString()
      }
    }, null, 2));

    // Symlink created
    this.createSymlink(this.installPath, join(this.marketplacesDir, 'pcircle-ai'));

    // Plugin enabled
    this.createFile('settings.json', JSON.stringify({
      enabledPlugins: {
        'memesh@pcircle-ai': true
      }
    }, null, 2));

    // MCP configured
    this.createFile('mcp_settings.json', JSON.stringify({
      mcpServers: {
        memesh: {
          command: 'node',
          args: [join(this.installPath, 'dist/mcp/server-bootstrap.js')]
        }
      }
    }, null, 2));
  }
}

/**
 * Assert helpers
 */
export const assert = {
  fileExists(path: string, message?: string): void {
    if (!existsSync(path)) {
      throw new Error(message || `Expected file to exist: ${path}`);
    }
  },

  fileNotExists(path: string, message?: string): void {
    if (existsSync(path)) {
      throw new Error(message || `Expected file not to exist: ${path}`);
    }
  },

  jsonContains(filePath: string, key: string, expectedValue?: unknown): void {
    const content = readFileSync(filePath, 'utf-8');
    const json = JSON.parse(content);

    if (!(key in json)) {
      throw new Error(`Expected JSON to contain key: ${key}`);
    }

    if (expectedValue !== undefined && json[key] !== expectedValue) {
      throw new Error(`Expected ${key} to be ${expectedValue}, got ${json[key]}`);
    }
  },

  symlinkPointsTo(linkPath: string, expectedTarget: string): void {
    if (!existsSync(linkPath)) {
      throw new Error(`Symlink does not exist: ${linkPath}`);
    }

    const actual = readlinkSync(linkPath);
    if (actual !== expectedTarget) {
      throw new Error(`Expected symlink to point to ${expectedTarget}, got ${actual}`);
    }
  }
};
