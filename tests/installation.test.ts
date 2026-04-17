import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { execFileSync } from 'child_process';

describe('Installation Verification', () => {
  describe('Prerequisites', () => {
    it('should have Node.js 20+ installed', () => {
      const version = execFileSync('node', ['-v'], { encoding: 'utf8' }).trim();
      const major = parseInt(version.slice(1).split('.')[0]);
      expect(major).toBeGreaterThanOrEqual(20);
    });
  });

  describe('Configuration Files', () => {
    it('should have package.json with correct name', () => {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      expect(pkg.name).toBe('@pcircle/memesh');
    });

    it('should have plugin.json with matching version', () => {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const plugin = JSON.parse(fs.readFileSync('plugin.json', 'utf8'));
      expect(plugin.version).toBe(pkg.version);
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

    it('should have plugin.json with skills reference', () => {
      const plugin = JSON.parse(fs.readFileSync('plugin.json', 'utf8'));
      expect(plugin.skills).toBeDefined();
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

  describe('Skills', () => {
    it('should have memesh skill', () => {
      expect(fs.existsSync('skills/memesh/SKILL.md')).toBe(true);
    });

    it('should have memesh-review skill', () => {
      expect(fs.existsSync('skills/memesh-review/SKILL.md')).toBe(true);
    });
  });

  describe('Bin Entries', () => {
    it('should have 4 bin entries', () => {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const bins = Object.keys(pkg.bin);
      expect(bins).toContain('memesh');
      expect(bins).toContain('memesh-mcp');
      expect(bins).toContain('memesh-http');
      expect(bins).toContain('memesh-view');
    });
  });

  describe('Dashboard', () => {
    it('should have dashboard build output', () => {
      expect(fs.existsSync('dashboard/dist/index.html')).toBe(true);
    });
  });
});
