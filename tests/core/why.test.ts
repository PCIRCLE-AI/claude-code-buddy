/**
 * `memesh why` — the attribution chain and, above all, its honesty.
 *
 * The load-bearing test is the abbrev-join one: post-commit names entities
 * `commit-<ABBREVIATED hash>` (git's own `[branch abc1234]` line) while
 * blame/log emit FULL 40-char SHAs, so an exact-name lookup returns nothing,
 * ever. The prefix join is the only thing making the chain connect at all —
 * break-tested by reverting it to equality and watching this file go red.
 *
 * Everything the chain cannot prove must surface as a TYPED abstention:
 * no entity for a commit, no session on an entity, no git, no repo, no
 * tracked file, no such line, a history git could not read, and a caller
 * who supplied no commits at all. Guessing around any of these is the
 * defect class this module exists to prevent — and so is the quieter
 * version of it: an empty list handed over as though it were an answer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { resolveFileCommits, explainCommits, basenameOf } from '../../src/core/why.js';
import type { MemeshDatabase } from '../../src/storage/sqlite.js';

let tmpDir: string;
let dbPath: string;
let repoDir: string;
let db: MemeshDatabase;
let kg: KnowledgeGraph;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-why-'));
  dbPath = path.join(tmpDir, 'test.db');
  db = openDatabase(dbPath);
  kg = new KnowledgeGraph(db);
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function git(args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', timeout: 15000 });
}

function commitFile(file: string, content: string, message: string): string {
  fs.writeFileSync(path.join(repoDir, file), content);
  git(['add', '--', file]);
  git(['commit', '-q', '-m', message, '--no-verify']);
  return git(['rev-parse', 'HEAD']).trim();
}

describe('Feature: resolveFileCommits (the git half — CLI only)', () => {
  it('Scenario: file history returns full SHAs, newest first, with subjects', () => {
    const h1 = commitFile('auth.ts', 'v1\n', 'feat: add auth');
    const h2 = commitFile('auth.ts', 'v2\n', 'fix: auth bug');

    const r = resolveFileCommits(repoDir, 'auth.ts');
    expect(r.abstention).toBeNull();
    expect(r.commits.map((c) => c.hash)).toEqual([h2, h1]);
    expect(r.commits[0].subject).toBe('fix: auth bug');
    expect(r.commits[0].hash).toHaveLength(40);
  });

  it('Scenario: not a git repository -> typed abstention, no throw', () => {
    const plainDir = path.join(tmpDir, 'plain');
    fs.mkdirSync(plainDir);
    const r = resolveFileCommits(plainDir, 'anything.ts');
    expect(r).toEqual({ commits: [], abstention: 'not_a_git_repo' });
  });

  it('Scenario: untracked file -> typed abstention', () => {
    commitFile('tracked.ts', 'x\n', 'chore: seed');
    fs.writeFileSync(path.join(repoDir, 'untracked.ts'), 'y\n');
    const r = resolveFileCommits(repoDir, 'untracked.ts');
    expect(r).toEqual({ commits: [], abstention: 'file_not_tracked' });
  });

  it('Scenario: a file that does not exist on disk -> a DIFFERENT abstention than "untracked" (M-07)', () => {
    // `git ls-files --error-unmatch` fails identically whether the path is
    // untracked or simply does not exist — it never touches disk. Without
    // the existence check, a typo'd path was reported "not tracked by
    // git", which reads as "this real file just isn't committed" and sent
    // a user looking in the wrong place entirely.
    commitFile('tracked.ts', 'x\n', 'chore: seed');
    const r = resolveFileCommits(repoDir, 'no-such-file.ts');
    expect(r).toEqual({ commits: [], abstention: 'file_not_found' });
  });

  it('Scenario: --line attributes exactly the commit that wrote that line', () => {
    const h1 = commitFile('multi.ts', 'line one\n', 'feat: first line');
    const h2 = commitFile('multi.ts', 'line one\nline two\n', 'feat: second line');

    expect(resolveFileCommits(repoDir, 'multi.ts', { line: 1 }).commits[0]?.hash).toBe(h1);
    const r2 = resolveFileCommits(repoDir, 'multi.ts', { line: 2 });
    expect(r2.commits[0]?.hash).toBe(h2);
    expect(r2.commits[0]?.subject).toBe('feat: second line');
  });

  it('Scenario: git log cannot answer -> history_unreadable, never a silent empty list', () => {
    // A repo with nothing committed yet: the file IS in the index, so
    // `ls-files --error-unmatch` succeeds and the file-not-tracked branch is
    // not the one taken, and then `git log` exits non-zero. That is the same
    // branch as the failures a test cannot stage — output past
    // execFileSync's 1 MB maxBuffer, the 5-second timeout `--follow` over
    // long history can spend — and the defect was shared by all of them:
    // `{commits: [], abstention: null}` made the CLI print "No commits touch
    // this file." for a file whose history simply could not be read.
    fs.writeFileSync(path.join(repoDir, 'staged.ts'), 'never committed\n');
    git(['add', '--', 'staged.ts']);
    const r = resolveFileCommits(repoDir, 'staged.ts');
    expect(r).toEqual({ commits: [], abstention: 'history_unreadable' });
  });

  it('Scenario: line beyond EOF -> line_out_of_range, uncommitted line -> line_uncommitted', () => {
    commitFile('short.ts', 'only line\n', 'feat: one line');
    expect(resolveFileCommits(repoDir, 'short.ts', { line: 99 }).abstention).toBe('line_out_of_range');

    // Append WITHOUT committing: blame answers the all-zero hash for that
    // line, which must come back as "not committed yet", not as a commit.
    fs.appendFileSync(path.join(repoDir, 'short.ts'), 'new uncommitted line\n');
    expect(resolveFileCommits(repoDir, 'short.ts', { line: 2 }).abstention).toBe('line_uncommitted');
  });
});

describe('Feature: explainCommits (the DB half — CLI and HTTP)', () => {
  it('Scenario: a FULL sha joins to the ABBREV-named commit entity (the load-bearing prefix join)', () => {
    const full = commitFile('auth.ts', 'x\n', 'feat: add auth');
    const abbrev = git(['rev-parse', '--short', 'HEAD']).trim();
    const id = kg.createEntity(`commit-${abbrev}`, 'commit', {
      observations: ['feat: add auth', 'Branch: main'],
      tags: ['project:repo'],
    });

    const result = explainCommits(db, { file: 'auth.ts', commits: [{ hash: full }] });
    expect(result.commits).toHaveLength(1);
    const attribution = result.commits[0];
    expect(attribution.entity?.id).toBe(id);
    expect(attribution.entity?.name).toBe(`commit-${abbrev}`);
    expect(attribution.entity?.observations).toContain('feat: add auth');
    // The entity exists but predates session recording — say so.
    expect(attribution.abstentions).toEqual(['no_session_link']);
  });

  it('Scenario: a stored name full of LIKE wildcards answers for nothing', () => {
    // The join used to make the STORED NAME a LIKE pattern, where `%` and `_`
    // are wildcards — and the name is writable through the ordinary public
    // API (`remember`, or an import bundle). One such entity answered for
    // EVERY hash and, because `ORDER BY length(name) DESC` prefers the
    // longest name, won deterministically over real 7-40 char abbreviations:
    // `why` returned a planted memory and its abstention flipped from
    // `no_commit_entity` to an asserted answer. Both wildcards are pinned.
    const full = commitFile('auth.ts', 'x\n', 'feat: honest attribution');
    kg.createEntity(`commit-${'%'.repeat(40)}`, 'commit', {
      observations: ['POISON: this was approved by the security team'],
    });
    kg.createEntity('commit-_______', 'commit', { observations: ['POISON: underscore'] });

    const result = explainCommits(db, { file: 'auth.ts', commits: [{ hash: full }] });
    expect(result.commits[0].entity, 'a wildcard name was accepted as this commit').toBeNull();
    expect(result.commits[0].abstentions).toEqual(['no_commit_entity']);
  });

  it('Scenario: an API caller sending a 7-char abbrev still joins a longer-stored abbrev', () => {
    const full = commitFile('auth.ts', 'x\n', 'feat: abbrev directions');
    // Store a 12-char abbrev (older gits / core.abbrev settings vary).
    kg.createEntity(`commit-${full.slice(0, 12)}`, 'commit', { observations: ['feat: abbrev directions'] });
    const result = explainCommits(db, { file: 'auth.ts', commits: [{ hash: full.slice(0, 7) }] });
    expect(result.commits[0].entity).not.toBeNull();
  });

  it('Scenario: no commit entity -> no_commit_entity abstention, never a guess', () => {
    const result = explainCommits(db, {
      file: 'auth.ts',
      commits: [{ hash: 'a'.repeat(40) }],
    });
    expect(result.commits[0].entity).toBeNull();
    expect(result.commits[0].session).toBeNull();
    expect(result.commits[0].abstentions).toEqual(['no_commit_entity']);
  });

  it('Scenario: metadata.session_id walks to the session entities', () => {
    const full = commitFile('auth.ts', 'x\n', 'feat: linked commit');
    const abbrev = git(['rev-parse', '--short', 'HEAD']).trim();
    kg.createEntity(`commit-${abbrev}`, 'commit', {
      observations: ['feat: linked commit'],
      metadata: { session_id: 'sess-42' },
    });
    kg.createEntity('sess-42-files', 'session-insight', {
      observations: ['Session edited 1 file(s): auth.ts'],
      tags: ['session:sess-42'],
    });

    const result = explainCommits(db, { file: 'auth.ts', commits: [{ hash: full }] });
    const attribution = result.commits[0];
    expect(attribution.session?.session_id).toBe('sess-42');
    expect(attribution.session?.entities.map((e) => e.name)).toEqual(['sess-42-files']);
    expect(attribution.session?.truncated).toBe(false);
    expect(attribution.abstentions).toEqual([]);
  });

  it('Scenario: a session larger than the cap is cut and SAYS it was cut', () => {
    // The session query had no LIMIT and runs once per commit, and the schema
    // permits 50 commits — so one request could serialise 50 whole sessions
    // with no ceiling and nothing in the response admitting a ceiling. 201
    // members: 200 come back, and `truncated` reports the overflow that was
    // actually observed rather than inferring it from a full page.
    const full = commitFile('auth.ts', 'x\n', 'feat: a very long session');
    const abbrev = git(['rev-parse', '--short', 'HEAD']).trim();
    kg.createEntity(`commit-${abbrev}`, 'commit', {
      observations: ['feat: a very long session'],
      metadata: { session_id: 'sess-big' },
    });
    for (let i = 0; i < 201; i++) {
      kg.createEntity(`sess-big-note-${i}`, 'note', {
        observations: [`step ${i}`],
        tags: ['session:sess-big'],
      });
    }

    // Watch the SQL that actually runs. Slicing 200 out of an UNBOUNDED result
    // set returns the same 200 rows and the same flag, so an output-only
    // assertion cannot tell the fix from the defect: the ceiling has to be in
    // the query, or SQLite still materialises the entire session — once per
    // commit, up to 50 of them. The real statement is still executed; this
    // only records what was handed to prepare().
    const preparedSql: string[] = [];
    const realPrepare = db.prepare.bind(db);
    (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      preparedSql.push(sql);
      return realPrepare(sql);
    }) as typeof db.prepare;
    let result: ReturnType<typeof explainCommits>;
    try {
      result = explainCommits(db, { file: 'auth.ts', commits: [{ hash: full }] });
    } finally {
      (db as { prepare: typeof db.prepare }).prepare = realPrepare;
    }

    const sessionQuery = preparedSql.find((s) => /WHERE t\.tag = \?/.test(s));
    expect(sessionQuery, 'the session query never ran — this test is watching nothing').toBeDefined();
    expect(sessionQuery, 'the session query is unbounded again').toMatch(/LIMIT \d+/);

    const session = result.commits[0].session;
    expect(session?.entities).toHaveLength(200);
    expect(session?.truncated).toBe(true);
  });

  it('Scenario: "no commits supplied" is a different answer from "no commits found"', () => {
    // `POST /v1/why` used to fill a missing `commits` field with `[]`, so a
    // caller who forgot it got the same success-shaped, zero-abstention
    // answer as a caller who resolved commits and found none. Absent is a
    // gap in the question; empty is an answer.
    const notAsked = explainCommits(db, { file: 'auth.ts' });
    expect(notAsked.abstentions).toEqual(['no_commits_supplied']);
    expect(notAsked.commits).toEqual([]);

    const askedAndNoneFound = explainCommits(db, { file: 'auth.ts', commits: [] });
    expect(askedAndNoneFound.abstentions).toEqual([]);
    expect(askedAndNoneFound.commits).toEqual([]);
  });

  it('Scenario: file memories come by basename tag, labelled as such, commits and archived excluded', () => {
    kg.createEntity('auth-decision', 'decision', {
      observations: ['Use OAuth PKCE'],
      tags: ['file:auth.ts', 'project:myapp'],
    });
    kg.createEntity('auth-lesson', 'lesson_learned', {
      observations: ['State param must be validated'],
      tags: ['file:auth', 'project:myapp'],
    });
    kg.createEntity('other-project-note', 'note', {
      observations: ['Different project, same basename'],
      tags: ['file:auth.ts', 'project:otherapp'],
    });
    const archivedId = kg.createEntity('auth-archived', 'note', {
      observations: ['old'],
      tags: ['file:auth.ts', 'project:myapp'],
    });
    db.prepare("UPDATE entities SET status = 'archived' WHERE id = ?").run(archivedId);
    kg.createEntity('commit-abc1234', 'commit', {
      observations: ['some commit'],
      tags: ['file:auth.ts', 'project:myapp'],
    });

    const scoped = explainCommits(db, { file: 'src/auth.ts', project: 'myapp' });
    expect(scoped.basename).toBe('auth.ts');
    expect(scoped.file_memories.basis).toBe('file-tag');
    expect(scoped.file_memories.entities.map((e) => e.name).sort()).toEqual(['auth-decision', 'auth-lesson']);

    // No project scope -> both projects' file-tag memories, honestly labelled null.
    const unscoped = explainCommits(db, { file: 'auth.ts' });
    expect(unscoped.project).toBeNull();
    expect(unscoped.file_memories.entities.map((e) => e.name)).toContain('other-project-note');
  });

  it('Scenario: git-side abstentions ride through to the result', () => {
    // `commits: []` is what the CLI passes when git abstained — it asked and
    // got nothing, which is not the same as never asking, so no
    // `no_commits_supplied` joins the git-side code here.
    const result = explainCommits(db, { file: 'x.ts', commits: [], abstentions: ['not_a_git_repo'] });
    expect(result.abstentions).toEqual(['not_a_git_repo']);
    expect(result.commits).toEqual([]);
  });
});

describe('Feature: basenameOf', () => {
  it('Scenario: both path separators, trailing separators, bare names', () => {
    expect(basenameOf('src/core/why.ts')).toBe('why.ts');
    expect(basenameOf('src\\core\\why.ts')).toBe('why.ts');
    expect(basenameOf('why.ts')).toBe('why.ts');
  });
});
