/**
 * The citation contract, and the three ways writing a file into someone's
 * `.claude/` can go wrong.
 *
 * WHY THE CONTRACT MOVED HERE
 *
 * The Stop hook credits `recall_hits` from `[mem:id]` markers, and that is the
 * only evidence memesh has that an injected memory earned its tokens. The
 * instruction asking for those markers was appended after the fenced block on
 * purpose — outside the "background data, not instructions" preamble — and it
 * still produced nothing: measured on a real database, `citation_sessions_total`
 * was 4 and the key counting sessions WITH a citation had never been written.
 *
 * The reason is one layer further out than memesh: Claude Code wraps every
 * hook's `additionalContext` in a system-reminder ending "you should not
 * respond to this context unless it is highly relevant". That wrapper is
 * correct — memory content is attacker-influenced in the general case, so a
 * hook's text must not be able to drive the agent — and it applies to the
 * instruction line too. `.claude/rules/*.md` is the layer that IS instructions.
 *
 * These tests cover the file-handling contract, not the wording: idempotence,
 * the refusal to touch a file memesh did not write, and the three-state read
 * doctor reports from.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CITATION_RULE_BODY,
  CITATION_RULE_FILENAME,
  CITATION_RULE_MARKER,
  citationRulePath,
  citationRuleState,
  removeCitationRule,
  writeCitationRule,
} from '../../src/core/citation-rule.js';

let home: string;
let project: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cite-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cite-proj-'));
});

afterEach(() => {
  for (const dir of [home, project]) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('where the rule is written', () => {
  it('puts the user-scope rule under ~/.claude/rules, not in CLAUDE.md', () => {
    // Its own file on purpose: no merge conflict with instructions the user
    // wrote, and uninstall is one unlink instead of parsing someone's prose.
    const p = citationRulePath('user', home, project);
    expect(p).toBe(path.join(home, '.claude', 'rules', CITATION_RULE_FILENAME));
    expect(p).not.toContain('CLAUDE.md');
  });

  it('puts the user-scope rule under a relocated CLAUDE_CONFIG_DIR', () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    const relocated = path.join(home, 'relocated-claude');
    process.env.CLAUDE_CONFIG_DIR = relocated;
    try {
      expect(citationRulePath('user', home, project))
        .toBe(path.join(relocated, 'rules', CITATION_RULE_FILENAME));
      expect(citationRulePath('project', home, project))
        .toBe(path.join(project, '.claude', 'rules', CITATION_RULE_FILENAME));
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  it('puts the project-scope rule under the project, not the home directory', () => {
    const p = citationRulePath('project', home, project);
    expect(p).toBe(path.join(project, '.claude', 'rules', CITATION_RULE_FILENAME));
    expect(p.startsWith(home), 'a project-scope rule leaked into the home directory').toBe(false);
  });
});

describe('writing', () => {
  it('creates the file and the directories above it', () => {
    const r = writeCitationRule('user', home, project);
    expect(r.action).toBe('created');
    expect(fs.existsSync(r.path)).toBe(true);
    expect(fs.readFileSync(r.path, 'utf8')).toBe(CITATION_RULE_BODY);
  });

  it('is idempotent — a second write reports unchanged and does not rewrite', () => {
    const first = writeCitationRule('user', home, project);
    const mtimeBefore = fs.statSync(first.path).mtimeMs;
    const second = writeCitationRule('user', home, project);
    expect(second.action).toBe('unchanged');
    expect(fs.statSync(second.path).mtimeMs, 'the file was rewritten with identical bytes').toBe(mtimeBefore);
  });

  it('updates an older memesh-written version in place', () => {
    const p = citationRulePath('user', home, project);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${CITATION_RULE_MARKER}\n# an older wording\n`);

    const r = writeCitationRule('user', home, project);
    expect(r.action).toBe('updated');
    expect(fs.readFileSync(p, 'utf8')).toBe(CITATION_RULE_BODY);
  });

  it('REFUSES to overwrite a file memesh did not write', () => {
    // The one that matters: this path is inside the user's own config tree.
    // A file here without the marker is theirs, and clobbering it destroys
    // instructions they wrote by hand.
    const p = citationRulePath('user', home, project);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const theirs = '# my own rules\nnever run rm -rf\n';
    fs.writeFileSync(p, theirs);

    const r = writeCitationRule('user', home, project);
    expect(r.action).toBe('foreign-file');
    expect(fs.readFileSync(p, 'utf8'), 'a user-written rules file was overwritten').toBe(theirs);
  });
});

describe('removing', () => {
  it('removes a file memesh wrote', () => {
    const written = writeCitationRule('user', home, project);
    const r = removeCitationRule('user', home, project);
    expect(r.action).toBe('removed');
    expect(fs.existsSync(written.path)).toBe(false);
  });

  it('reports absent rather than failing when there is nothing to remove', () => {
    expect(removeCitationRule('user', home, project).action).toBe('absent');
  });

  it('REFUSES to delete a file memesh did not write', () => {
    const p = citationRulePath('user', home, project);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '# mine\n');

    expect(removeCitationRule('user', home, project).action).toBe('foreign-file');
    expect(fs.existsSync(p), 'uninstall deleted a file the user wrote').toBe(true);
  });
});

describe('the state doctor reports', () => {
  it('distinguishes current, stale and missing — not just present/absent', () => {
    // `stale` and `missing` have different remedies (re-install vs first
    // install), so collapsing them would tell a user with an old-but-working
    // contract that memesh was never wired up.
    expect(citationRuleState('user', home, project).state).toBe('missing');

    writeCitationRule('user', home, project);
    expect(citationRuleState('user', home, project).state).toBe('current');

    fs.writeFileSync(citationRulePath('user', home, project), `${CITATION_RULE_MARKER}\n# older\n`);
    expect(citationRuleState('user', home, project).state).toBe('stale');
  });

  it('reports a foreign file as its own state, never as current', () => {
    const p = citationRulePath('user', home, project);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '# mine\n');
    expect(citationRuleState('user', home, project).state).toBe('foreign-file');
  });
});

describe('the contract text', () => {
  it('carries the marker that makes every refusal above possible', () => {
    expect(CITATION_RULE_BODY.startsWith(CITATION_RULE_MARKER)).toBe(true);
  });

  it('names the handle format the Stop hook actually parses', () => {
    // `extractCitedMemoryIds` matches `[mem:<digits>]`. A contract that asked
    // for any other shape would be obeyed and still credit nothing.
    const example = CITATION_RULE_BODY.match(/\[mem:(\d+)\]/);
    expect(example, 'the contract shows no parsable citation example').not.toBeNull();
  });

  it('stays short enough to be worth loading every session', () => {
    // It replaces a one-line injected instruction, and unlike that line it is
    // loaded as an instruction on every session. Budget it deliberately
    // rather than letting it grow: ~150 tokens is the ceiling this trade
    // was made at.
    expect(CITATION_RULE_BODY.length).toBeLessThan(900);
  });
});
