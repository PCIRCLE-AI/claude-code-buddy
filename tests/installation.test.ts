import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Plain JS build helper with no type declarations — the same derivation the
// build's chmod step and the packaged-artifact smoke test use.
const { hookCommands, binTargets } = require('../scripts/lib/executable-targets.mjs') as {
  hookCommands: (packageDir: string) => string[];
  binTargets: (packageDir: string) => string[];
};

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
      // Each value in hooks.hooks is an ARRAY of matcher objects, so the cast
      // needs both levels — the previous one-level version described the
      // element type and made `for (const entry of arr)` a type error.
      const matcherGroups = Object.values(hooks.hooks) as Array<
        Array<{ hooks?: Array<{ command?: string }> }>
      >;
      for (const arr of matcherGroups) {
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
    // Derived from hooks/hooks.json, not written out here. The hand-written
    // version of this list said five while the project shipped seven, and
    // ci.yml documents that exact drift as a past incident that "went
    // unnoticed for a full release cycle". A list that has to be updated by
    // hand when a hook is added is a list that will be wrong.
    const hookFiles = hookCommands(process.cwd());

    it('covers every hook the plugin manifest declares', () => {
      // Guards the derivation itself: if the shape of hooks.json changes and
      // the parse silently yields nothing, every case below would vacuously
      // pass by iterating an empty list.
      expect(hookFiles.length).toBeGreaterThanOrEqual(6);
    });

    it.each(hookFiles)('%s should exist and be executable', (hookPath) => {
      expect(fs.existsSync(hookPath)).toBe(true);
      if (process.platform !== 'win32') {
        const stat = fs.statSync(hookPath);
        expect(stat.mode & 0o111).toBeTruthy();
      }
    });
  });

  describe('Declared commands', () => {
    // package.json `bin` is the other manifest the executable-bit list is
    // derived from. `dist/transports/cli/cli.js` — the `memesh` command — and
    // `dist/transports/http/server.js` were both committed at mode 100644
    // because the hand-written chmod list had drifted from `bin` in both
    // directions.
    const commands = binTargets(process.cwd());

    it.each(commands)('%s should exist and be executable', (binPath) => {
      expect(fs.existsSync(binPath)).toBe(true);
      if (process.platform !== 'win32') {
        const stat = fs.statSync(binPath);
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
    it('should have exactly the 3 supported bin entries', () => {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const bins = Object.keys(pkg.bin);
      // memesh-view was retired: it was a third dashboard implementation
      // (static snapshot) alongside view-live.ts and the Preact dashboard,
      // and every dashboard change was a three-place edit.
      expect(bins.sort()).toEqual(['memesh', 'memesh-http', 'memesh-mcp']);
    });
  });

  describe('Dashboard', () => {
    it('should have dashboard build output', () => {
      expect(fs.existsSync('dashboard/dist/index.html')).toBe(true);
    });
  });
});
