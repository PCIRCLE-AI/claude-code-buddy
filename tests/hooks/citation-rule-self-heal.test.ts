/**
 * The SessionStart hook writes the citation contract into the scope memesh was
 * actually installed with.
 *
 * Found by an independent cross-model review, not by this suite: the first
 * version of the self-heal passed `'user'` as a literal. On a
 * `--scope project` install that writes `~/.claude/rules/memesh-citations.md`
 * on every session — leaking a project-only install into every OTHER project
 * on the machine, and leaving the global file behind after
 * `uninstall-hooks --scope project`, which only knows about the project path.
 *
 * The scope is not guessable from the hook's arguments. It comes from the
 * install marker `~/.memesh/install-hooks.json`, which `installHooks` writes
 * and which carries `scope`. No marker means a plugin install — user-level by
 * construction, and the majority case.
 *
 * These spawn the real hook. The bug was a literal argument, so a unit test of
 * `writeCitationRule` (which takes scope as a parameter and has always honoured
 * it) could not have caught it: the defect was entirely in the call site.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'session-start.js');
const RULE = 'memesh-citations.md';

let home: string;
let project: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-heal-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-heal-proj-'));
  fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
});

afterEach(() => {
  for (const d of [home, project]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function writeMarker(scope: 'user' | 'project'): void {
  fs.writeFileSync(
    path.join(home, '.memesh', 'install-hooks.json'),
    JSON.stringify({
      installed_at: '2026-08-24T00:00:00.000Z',
      version: '4.6.2',
      plugin_root: project,
      scope,
      settings_path: path.join(scope === 'user' ? home : project, '.claude', 'settings.json'),
    }),
  );
}

/** Run the hook the way Claude Code 2.1.241 runs it. */
function runHook(): number {
  const transcript = path.join(home, 't.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const payload = JSON.stringify({
    session_id: 's1',
    transcript_path: transcript,
    cwd: project,
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  try {
    execFileSync('node', [HOOK], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: project },
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

const userRule = () => path.join(home, '.claude', 'rules', RULE);
const projectRule = () => path.join(project, '.claude', 'rules', RULE);

describe('the self-heal honours the installed scope', () => {
  it('writes into the PROJECT and never touches the home directory on a project install', () => {
    // The leak. Both halves are asserted: writing the right file is not enough
    // if the wrong one is written too.
    writeMarker('project');

    expect(runHook(), 'the hook failed outright').toBe(0);

    expect(fs.existsSync(projectRule()), 'a project install did not get the contract').toBe(true);
    expect(fs.existsSync(userRule()), 'a project install leaked the contract into ~/.claude/rules').toBe(false);

    // Existence is not content: an empty file satisfies existsSync and
    // teaches the agent nothing. Assert the contract actually says what the
    // Stop hook parses.
    const written = fs.readFileSync(projectRule(), 'utf8');
    expect(written.length, 'the contract was written empty').toBeGreaterThan(200);
    expect(written, 'the contract does not show the handle format the Stop hook parses').toMatch(/\[mem:\d+\]/);
  });

  it('writes into the home directory on a user install', () => {
    writeMarker('user');

    expect(runHook()).toBe(0);

    expect(fs.existsSync(userRule()), 'a user install did not get the contract').toBe(true);
    expect(fs.existsSync(projectRule()), 'a user install wrote into the project tree').toBe(false);
  });

  it('treats a missing marker as a user install — that is what a plugin install looks like', () => {
    // No marker written. Plugin installs never run `install-hooks`, so they
    // never produce one, and they are the majority of installs.
    expect(runHook()).toBe(0);

    expect(fs.existsSync(userRule()), 'a plugin install got no contract at all').toBe(true);
    expect(fs.existsSync(projectRule())).toBe(false);
  });

  it('falls back to user scope when the marker is corrupt, rather than failing the session', () => {
    // An unreadable marker is not a reason to break session start. It is a
    // reason to take the safe default.
    fs.writeFileSync(path.join(home, '.memesh', 'install-hooks.json'), '{ not json');

    expect(runHook(), 'a corrupt marker broke the SessionStart hook').toBe(0);
    expect(fs.existsSync(userRule())).toBe(true);
  });

  it('is idempotent across sessions — the second run leaves the file alone', () => {
    writeMarker('user');
    expect(runHook()).toBe(0);
    const first = fs.statSync(userRule()).mtimeMs;

    expect(runHook()).toBe(0);
    expect(fs.statSync(userRule()).mtimeMs, 'every session rewrote the rule file').toBe(first);
  });

  it('does not overwrite a file the user wrote at that path', () => {
    writeMarker('user');
    fs.mkdirSync(path.dirname(userRule()), { recursive: true });
    const theirs = '# my own rules\n';
    fs.writeFileSync(userRule(), theirs);

    expect(runHook(), 'the hook failed on a foreign rules file').toBe(0);
    expect(fs.readFileSync(userRule(), 'utf8'), 'the hook overwrote a user-written rules file').toBe(theirs);
  });
});
