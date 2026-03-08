import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { execSync } from 'child_process';

describe('Installation Verification', () => {
  describe('Prerequisites', () => {
    it('should have Node.js 18+ installed', () => {
      const version = execSync('node -v').toString().trim();
      const major = parseInt(version.slice(1).split('.')[0]);
      expect(major).toBeGreaterThanOrEqual(18);
    });

    it('should have npm installed', () => {
      const version = execSync('npm -v').toString().trim();
      expect(version).toBeTruthy();
    });
  });

  describe('Build Artifacts', () => {
    it('should have dist directory', () => {
      expect(fs.existsSync('dist')).toBe(true);
    });

    it('should have MCP server built', () => {
      expect(fs.existsSync('dist/mcp/server-bootstrap.js')).toBe(true);
    });

    it('should have main entry point', () => {
      expect(fs.existsSync('dist/index.js')).toBe(true);
    });
  });

  describe('Configuration Files', () => {
    it('should have package.json', () => {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      expect(pkg.name).toBe('@pcircle/memesh');
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should have plugin.json', () => {
      expect(fs.existsSync('plugin.json')).toBe(true);
    });
  });

  describe('MCP Configuration', () => {
    it('should have valid MCP server export', async () => {
      // Import the MCP server module to verify it exports correctly
      const serverModule = await import('../dist/mcp/server-bootstrap.js');
      expect(serverModule).toBeDefined();
    });
  });

  describe('Installation Scripts', () => {
    it('should have install.sh', () => {
      expect(fs.existsSync('scripts/install.sh')).toBe(true);
      const stat = fs.statSync('scripts/install.sh');
      expect(stat.mode & 0o111).toBeTruthy(); // Executable
    });

    it('should have install-helpers.js', () => {
      expect(fs.existsSync('scripts/install-helpers.js')).toBe(true);
    });
  });
});
