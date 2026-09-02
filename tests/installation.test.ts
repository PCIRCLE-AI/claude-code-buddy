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
    it('runs on the published Node 22.13+ floor', () => {
      const version = execFileSync('node', ['-v'], { encoding: 'utf8' }).trim();
      const [major, minor] = version.slice(1).split('.').map(Number);
      expect(major > 22 || (major === 22 && minor >= 13)).toBe(true);
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      expect(pkg.engines.node).toBe('>=22.13.0');
      expect(fs.readFileSync('llms-install.md', 'utf8')).toContain('v22.13.0');
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

    it('declares the Claude MCP manifest on a path Claude Code does NOT auto-discover as a project config', () => {
      // The root `.mcp.json` this replaced was auto-discovered TWICE: by the
      // plugin loader, where `${CLAUDE_PLUGIN_ROOT}` resolves, and as a
      // project-scoped config for anyone who merely opened this repository,
      // where it does not — `claude mcp list` reported "Missing environment
      // variables: CLAUDE_PLUGIN_ROOT" and the server died with `-32000
      // Connection closed`. The old test here asserted `.mcp.json` EXISTS,
      // so it held the defect in place for three and a half months.
      //
      // Custom component paths SUPPLEMENT the defaults rather than replacing
      // them, so declaring a path is only half of it: the root file has to be
      // gone, or both still load.
      const plugin = JSON.parse(fs.readFileSync('.claude-plugin/plugin.json', 'utf8'));
      expect(plugin.mcpServers).toBe('./.claude-plugin/mcp.json');
      expect(fs.existsSync('.mcp.json')).toBe(false);

      const mcp = JSON.parse(fs.readFileSync('.claude-plugin/mcp.json', 'utf8'));
      expect(mcp.mcpServers.memesh).toEqual({
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js'],
      });
    });

    it('should have a native Codex plugin manifest for the packaged MCP server', () => {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const plugin = JSON.parse(fs.readFileSync('.codex-plugin/plugin.json', 'utf8'));
      const mcp = JSON.parse(fs.readFileSync('.codex-plugin/mcp.json', 'utf8'));
      expect(plugin.version).toBe(pkg.version);
      expect(plugin.mcpServers).toBe('./.codex-plugin/mcp.json');
      expect(mcp.memesh).toEqual({
        command: 'node',
        args: ['./dist/mcp/server.js'],
        cwd: '.',
      });
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

    it('teaches durable message delivery without claiming stopped-session wakeup', () => {
      const skill = fs.readFileSync('skills/memesh/SKILL.md', 'utf8');
      expect(skill).toContain('active compatible managed host');
      expect(skill).toContain('removes polling');
      expect(skill).toContain('stopped, missing, or replaced session');
    });

    it('documents owner-private reusable setup for every installed managed Local host', () => {
      const install = fs.readFileSync('llms-install.md', 'utf8');
      const guide = fs.readFileSync('docs/platforms/agent-messaging.md', 'utf8');
      for (const command of ['memesh-router', 'memesh-host-codex', 'memesh-host-claude']) {
        expect(install).toContain(command);
        expect(guide).toContain(command);
      }
      expect(install).toContain('memesh agent setup codex');
      expect(install).toContain('memesh agent setup claude');
      expect(install).not.toContain('memesh agent setup gemini');
      expect(guide).toContain('Experimental ACP runner (not release-gated)');
      expect(guide).toContain('owner-private');
      expect(guide).toContain('presence-only/inbound-unavailable');
      expect(guide).toContain('stopped, missing, disconnected, or replaced');
    });
  });

  describe('Bin Entries', () => {
    it('should have exactly the supported user, server, router, and host-adapter bin entries', () => {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const bins = Object.keys(pkg.bin);
      // memesh-view was retired: it was a third dashboard implementation
      // (static snapshot) alongside view-live.ts and the Preact dashboard,
      // and every dashboard change was a three-place edit.
      expect(bins.sort()).toEqual([
        'memesh',
        'memesh-http',
        'memesh-mcp',
        'memesh-router',
        'memesh-host-claude',
        'memesh-host-codex',
        'memesh-host-codex-session',
        'memesh-host-acp',
      ].sort());
    });
  });

  describe('Dashboard', () => {
    it('should have dashboard build output', () => {
      expect(fs.existsSync('dashboard/dist/index.html')).toBe(true);
    });
  });
});
