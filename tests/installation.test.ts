import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { execSync } from 'child_process';

describe('Installation Verification', () => {
  describe('Prerequisites', () => {
    it('should have Node.js 20+ installed', () => {
      const version = execSync('node -v').toString().trim();
      const major = parseInt(version.slice(1).split('.')[0]);
      expect(major).toBeGreaterThanOrEqual(20);
    });
  });

  describe('Configuration Files', () => {
    it('should have package.json with correct name', () => {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      expect(pkg.name).toBe('@pcircle/memesh');
    });

    it('should have plugin.json', () => {
      expect(fs.existsSync('plugin.json')).toBe(true);
    });

    it('should have .mcp.json', () => {
      expect(fs.existsSync('.mcp.json')).toBe(true);
    });

    it('should have hooks.json with 4 hooks', () => {
      const hooks = JSON.parse(fs.readFileSync('hooks/hooks.json', 'utf8'));
      const hookTypes = Object.keys(hooks.hooks);
      expect(hookTypes).toHaveLength(4);
      expect(hookTypes).toContain('SessionStart');
      expect(hookTypes).toContain('PostToolUse');
      expect(hookTypes).toContain('Stop');
      expect(hookTypes).toContain('PreCompact');
    });
  });

  describe('Hook Scripts', () => {
    const hookFiles = [
      'scripts/hooks/session-start.js',
      'scripts/hooks/post-commit.js',
      'scripts/hooks/session-summary.js',
      'scripts/hooks/pre-compact.js',
    ];

    it.each(hookFiles)('%s should exist and be executable', (hookPath) => {
      expect(fs.existsSync(hookPath)).toBe(true);
      if (process.platform !== 'win32') {
        const stat = fs.statSync(hookPath);
        expect(stat.mode & 0o111).toBeTruthy();
      }
    });
  });
});
