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

    it('should have .claude-plugin/plugin.json with matching version', () => {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const plugin = JSON.parse(fs.readFileSync('.claude-plugin/plugin.json', 'utf8'));
      expect(plugin.version).toBe(pkg.version);
    });

    it('should have .mcp.json', () => {
      expect(fs.existsSync('.mcp.json')).toBe(true);
    });

    it('hooks.json declares the canonical Claude Code hook event types and references real script files', () => {
      // Asserts shape and integrity, NOT a hardcoded count. Hardcoded
      // counts drift silently when a new hook is added (this test
      // previously required N=5 but the project shipped N=6 for an
      // entire release cycle without anyone noticing — only a
      // pre-release verify caught it). New hooks now extend this
      // assertion automatically as long as they reference a real script.
      const hooks = JSON.parse(fs.readFileSync('hooks/hooks.json', 'utf8'));
      const hookTypes = Object.keys(hooks.hooks);

      // 1. Must be non-empty and a subset of Claude Code's known event types.
      const ALLOWED_HOOK_EVENTS = [
        'PreToolUse', 'PostToolUse',
        'SessionStart', 'SessionEnd',
        'Stop', 'SubagentStop',
        'PreCompact',
        'UserPromptSubmit',
        'Notification',
      ];
      expect(hookTypes.length).toBeGreaterThan(0);
      for (const event of hookTypes) {
        expect(ALLOWED_HOOK_EVENTS).toContain(event);
      }

      // 2. Every declared hook must reference a script file that exists
      //    on disk under scripts/hooks/. This catches the inverse drift
      //    (hooks.json grows but the script never lands in the package).
      const declaredScripts = new Set<string>();
      for (const arr of Object.values(hooks.hooks) as Array<{ hooks?: Array<{ command?: string }> }>) {
        for (const entry of arr ?? []) {
          for (const h of entry.hooks ?? []) {
            if (typeof h.command === 'string') {
              const m = h.command.match(/scripts\/hooks\/([\w-]+\.js)/);
              if (m) declaredScripts.add(m[1]);
            }
          }
        }
      }
      expect(declaredScripts.size).toBeGreaterThan(0);
      for (const script of declaredScripts) {
        expect(fs.existsSync(`scripts/hooks/${script}`)).toBe(true);
      }
    });

    it('ships skills via the default-discovery `skills/` directory', () => {
      // The new Claude Code plugin schema auto-discovers components from
      // default locations; explicit refs in plugin.json are only needed
      // for non-default paths. So this asserts the directory itself
      // exists rather than checking plugin.json for an explicit `skills`
      // field (which we deliberately omit so the manifest stays minimal).
      expect(fs.existsSync('skills')).toBe(true);
      expect(fs.statSync('skills').isDirectory()).toBe(true);
    });
  });

  describe('Hook Scripts', () => {
    const hookFiles = [
      'scripts/hooks/session-start.js',
      'scripts/hooks/post-commit.js',
      'scripts/hooks/session-summary.js',
      'scripts/hooks/pre-compact.js',
      'scripts/hooks/pre-edit-recall.js',
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
