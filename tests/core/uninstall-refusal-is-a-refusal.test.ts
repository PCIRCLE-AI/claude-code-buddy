/**
 * Two properties of `install-hooks.ts` that nothing pinned, both of which
 * were broken.
 *
 * 1. A REFUSAL MUST NOT MODIFY. `uninstallHooks` deleted the citation rule
 *    file, and only then read `settings.json`. `readSettings` throws
 *    "refusing to modify" on unparseable JSON, so the CLI printed that
 *    refusal and exited 1 with `.claude/rules/` already emptied. The user's
 *    documented remedy — repair the JSON, run it again — then ran against a
 *    state the failed run had silently changed.
 *
 * 2. THE PRUNE KEY SEPARATOR. The `(event, matcher)` key that decides which
 *    live hook entries get pruned joins on U+0000, because that is the one
 *    code point neither half can contain. Nothing said so, and nothing
 *    tested it: with a printable separator, ("PostToolUse Bash", "*") and
 *    ("PostToolUse", "Bash *") produce the same key and a hook the manifest
 *    still declares is deleted from the user's settings.
 *
 *    The separator was also written as a LITERAL NUL byte, which makes the
 *    whole 485-line file binary to `grep` and `rg` — both suppress every
 *    match and exit exactly as they do for a clean file. That is how a file
 *    that edits `~/.claude/settings.json` returned "no matches" to every
 *    pattern a grep-based reviewer ran against it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('install-hooks: a refusal is a refusal', () => {
  let tmpDir: string;
  let home: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-uninstall-refuse-'));
    home = path.join(tmpDir, 'home');
    fs.mkdirSync(home, { recursive: true });
    saved.MEMESH_DIR = process.env.MEMESH_DIR;
    saved.HOME = process.env.HOME;
    saved.USERPROFILE = process.env.USERPROFILE;
    process.env.MEMESH_DIR = path.join(tmpDir, 'memesh-state');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of ['MEMESH_DIR', 'HOME', 'USERPROFILE']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function mod() {
    return import('../../src/core/install-hooks.js');
  }

  function writeSettings(text: string): string {
    const p = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  }

  async function writeRule(): Promise<string> {
    const { writeCitationRule } = await import('../../src/core/citation-rule.js');
    return writeCitationRule('user', home, tmpDir).path;
  }

  it('leaves the citation rule on disk when settings.json cannot be parsed', async () => {
    writeSettings('{ this is not json');
    const rulePath = await writeRule();
    // Fixture: the thing we claim survives has to exist first, or the
    // assertion below is vacuous.
    expect(fs.existsSync(rulePath), 'fixture: the rule file was never written').toBe(true);

    const { uninstallHooks } = await mod();
    expect(() => uninstallHooks({ scope: 'user', cwd: tmpDir })).toThrow(/refusing to modify/);

    expect(
      fs.existsSync(rulePath),
      'the run refused to modify anything and deleted the rule file anyway',
    ).toBe(true);
  });

  it('still removes the rule when there is no settings.json at all', async () => {
    // The both-exits property the ordering must not cost. A plugin install
    // never writes settings.json but does get the rule file, so an uninstall
    // that returned early here would strand the contract on exactly the
    // install shape that owns it.
    const rulePath = await writeRule();
    expect(fs.existsSync(rulePath)).toBe(true);

    const { uninstallHooks } = await mod();
    const result = uninstallHooks({ scope: 'user', cwd: tmpDir });

    expect(result.citationRule.action).toBe('removed');
    expect(fs.existsSync(rulePath), 'the rule outlived an uninstall').toBe(false);
  });

  it('removes the rule on the ordinary path too — the anti-vacuity half', async () => {
    // Without this, an uninstallHooks that never removed anything would
    // satisfy the first test perfectly.
    writeSettings(JSON.stringify({ hooks: {} }, null, 2));
    const rulePath = await writeRule();

    const { uninstallHooks } = await mod();
    const result = uninstallHooks({ scope: 'user', cwd: tmpDir });

    expect(result.citationRule.action).toBe('removed');
    expect(fs.existsSync(rulePath)).toBe(false);
  });

  it('dry-run touches neither the rule file nor settings.json', async () => {
    const settingsPath = writeSettings(JSON.stringify({ hooks: {} }, null, 2));
    const before = fs.readFileSync(settingsPath, 'utf8');
    const rulePath = await writeRule();

    const { uninstallHooks } = await mod();
    uninstallHooks({ scope: 'user', cwd: tmpDir, dryRun: true });

    expect(fs.existsSync(rulePath)).toBe(true);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });
});

describe('install-hooks: the prune key cannot be forged', () => {
  let tmpDir: string;
  let home: string;
  let pluginDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-prunekey-'));
    home = path.join(tmpDir, 'home');
    pluginDir = path.join(tmpDir, 'plugin');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
    saved.MEMESH_DIR = process.env.MEMESH_DIR;
    saved.HOME = process.env.HOME;
    saved.USERPROFILE = process.env.USERPROFILE;
    process.env.MEMESH_DIR = path.join(tmpDir, 'memesh-state');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of ['MEMESH_DIR', 'HOME', 'USERPROFILE']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** A manifest whose one declared entry has a SPACE inside its matcher. */
  function writeManifest(): void {
    fs.writeFileSync(
      path.join(pluginDir, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: 'Bash *',
              hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-summary.js' }],
            },
          ],
        },
      }),
    );
  }

  it('does not prune a declared entry that a space-joined key would collide with', async () => {
    writeManifest();

    // A memesh entry already in the user's settings under a DIFFERENT
    // (event, matcher) pair that joins to the same string when the
    // separator is a space:
    //   declared : "PostToolUse"      + "Bash *" -> "PostToolUse Bash *"
    //   installed: "PostToolUse Bash" + "*"      -> "PostToolUse Bash *"
    // With a space the installed entry looks declared and survives; with
    // U+0000 the two keys differ and it is pruned, which is correct — the
    // manifest does not declare it.
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        'PostToolUse Bash': [
          { matcher: '*', _memesh: true, hooks: [{ type: 'command', command: '/gone/old-hook.js', _memesh: true }] },
        ],
      },
    }, null, 2));

    const { installHooks } = await import('../../src/core/install-hooks.js');
    const result = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.6.3', scope: 'user' });

    expect(result.pruned, 'the stale entry was not pruned — the key collided').toBe(1);

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(after.hooks['PostToolUse Bash'], 'a hook pointing at a deleted script survived').toBeUndefined();
    expect(after.hooks.PostToolUse[0].matcher, 'the declared entry was not installed').toBe('Bash *');
  });

  it('keeps an entry the manifest still declares — the anti-vacuity half', async () => {
    // A prune loop that deleted everything would pass the test above.
    writeManifest();

    const { installHooks } = await import('../../src/core/install-hooks.js');
    installHooks({ pluginRoot: pluginDir, pluginVersion: '4.6.3', scope: 'user' });
    const second = installHooks({ pluginRoot: pluginDir, pluginVersion: '4.6.3', scope: 'user' });

    expect(second.pruned, 'a re-install pruned its own entry').toBe(0);
    expect(second.skipped).toBe(1);
  });
});

describe('install-hooks.ts is a text file', () => {
  it('carries no literal NUL byte', () => {
    // The defect this pins is invisible in every text view of the file, and
    // it disables `grep`/`rg` for the whole file rather than for one line.
    const bytes = fs.readFileSync(new URL('../../src/core/install-hooks.ts', import.meta.url));
    expect(bytes.includes(0), 'a literal NUL makes the file binary to grep and rg').toBe(false);
    // Fixture: prove we read the real file and not an empty buffer.
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
