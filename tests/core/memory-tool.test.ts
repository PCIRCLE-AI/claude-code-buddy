/**
 * The Anthropic memory tool, backed by the knowledge graph.
 *
 * Three groups, in the order they matter:
 *
 *   1. Path validation. Anthropic puts traversal protection on the implementer
 *      in a warning box, and this handler is driven by a MODEL — the input is
 *      untrusted by construction. Nothing here touches a filesystem, so a `..`
 *      cannot escape to `secrets.env`; what it CAN do is resolve to a different
 *      namespace or a different memory than the one named, which is a silent
 *      wrong-write rather than an error.
 *
 *   2. The line-order invariant. `view` and the edit that follows are separate
 *      turns. If the order the model saw came from a score, a hook writing one
 *      observation in between would make the line numbers it read address
 *      different content by the time it sent them back. Insertion order is the
 *      only order that cannot move.
 *
 *   3. The six commands, each against the database rather than against a
 *      return value.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import {
  handleMemoryCommand,
  MEMORY_TOOL_DEFINITION,
  MEMORY_ROOT,
} from '../../src/core/memory-tool.js';

describe('Feature: memory_20250818 over the knowledge graph', () => {
  let dir: string;
  let savedMemeshDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-memtool-'));
    savedMemeshDir = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = dir;
    try { closeDatabase(); } catch { /* none open */ }
    openDatabase(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    if (savedMemeshDir === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = savedMemeshDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(name: string, observations: string[], namespace = 'personal'): void {
    new KnowledgeGraph(getDatabase()).createEntity(name, 'note', { observations, namespace });
  }

  function observationsOf(name: string): string[] {
    return new KnowledgeGraph(getDatabase()).getEntity(name)?.observations ?? [];
  }

  const file = (name: string, ns = 'personal') => `${MEMORY_ROOT}/${ns}/${name}.md`;

  // --- 1. Path validation ---------------------------------------------------

  describe('refuses paths outside the memory root', () => {
    // Each case names the check that must refuse it, not just "an error".
    //
    // This started as `expect(isError).toBe(true)` and a mutation sweep showed
    // why that is not enough: with the traversal branch deleted outright, every
    // one of these still came back an error — the depth check or the namespace
    // check caught it instead — and all eight assertions stayed green. A
    // security test that passes with the security check removed is the same
    // defect as the code it is guarding against. Three mutants survived; they
    // die against the reason.
    const refused: Array<[path: string, becauseOf: string]> = [
      ['/etc/passwd', 'outside it'],
      ['/memories/../../secrets.env', 'traversal or empty segment'],
      ['/memories/personal/../team/theirs.md', 'traversal or empty segment'],
      ['/memories/./personal/note.md', 'traversal or empty segment'],
      ['/memories//x.md', 'traversal or empty segment'],
      // startsWith('/memories') is TRUE for this one — the check has to be
      // "the root exactly, or the root followed by a separator".
      ['/memories-of-you/note.md', 'outside it'],
      ['/memories/personal/%2e%2e/note.md', 'traversal sequence'],
      // These two are the isolating cases: two segments, a valid namespace, a
      // .md suffix. Nothing else in the parser objects to them, so only the
      // encoded-traversal branch can refuse them — which is what makes them
      // able to notice its absence.
      ['/memories/personal/a%2e%2eb.md', 'traversal sequence'],
      ['/memories/personal/a\\b.md', 'traversal sequence'],
      ['/memories/personal/sub/deep/note.md', 'two levels deep'],
      ['', 'must be a non-empty string'],
    ];

    for (const [p, becauseOf] of refused) {
      it(`refuses ${JSON.stringify(p)} — ${becauseOf}`, () => {
        const result = handleMemoryCommand({ command: 'view', path: p });
        expect(result.isError, `${p} was accepted`).toBe(true);
        expect(
          result.content,
          `${p} was refused, but by a different check than the one under test`
        ).toContain(becauseOf);
      });
    }

    it('refuses a NUL byte', () => {
      const result = handleMemoryCommand({ command: 'view', path: '/memories/personal/a\0b.md' });
      expect(result.isError).toBe(true);
    });

    it('a refused path writes nothing', () => {
      // The assertion that matters. A refusal that still wrote would be the
      // defect this whole check exists to prevent, and the return value alone
      // cannot show it.
      seed('mine', ['a private memory'], 'personal');
      const before = observationsOf('mine');

      handleMemoryCommand({
        command: 'create',
        path: '/memories/personal/../../../etc/passwd',
        file_text: 'pwned',
      });
      handleMemoryCommand({
        command: 'str_replace',
        path: '/memories/team/../personal/mine.md',
        old_str: 'a private memory',
        new_str: 'tampered',
      });

      expect(observationsOf('mine')).toEqual(before);
    });

    it('refuses a namespace that is not one of ours', () => {
      const result = handleMemoryCommand({ command: 'view', path: '/memories/secrets/x.md' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('personal, team, global');
    });
  });

  // --- 2. The line-order invariant ------------------------------------------

  describe('line numbers address the same content on the next turn', () => {
    it('orders by insertion, so a write between view and edit cannot move a line', () => {
      // The scenario, exactly: the model views the file, something else writes
      // to the same entity, and only THEN does the model's edit arrive. This
      // is the normal case — seven hooks write to this database.
      seed('project', ['first thing', 'second thing', 'third thing']);

      const viewed = handleMemoryCommand({ command: 'view', path: file('project') });
      expect(viewed.content).toContain('     2\tsecond thing');

      // A hook appends while the model is thinking, and access tracking moves
      // any score-based ordering.
      new KnowledgeGraph(getDatabase()).createEntity('project', 'note', {
        observations: ['a hook wrote this'],
        namespace: 'personal',
      });
      new KnowledgeGraph(getDatabase()).trackAccess([
        new KnowledgeGraph(getDatabase()).getEntity('project')!.id!,
      ]);

      // The model now sends the edit it decided on from what it read.
      const edited = handleMemoryCommand({
        command: 'insert',
        path: file('project'),
        insert_line: 2,
        insert_text: 'inserted after the second',
      });
      expect(edited.isError).toBe(false);

      expect(observationsOf('project')).toEqual([
        'first thing',
        'second thing',
        'inserted after the second', // still after the line the model READ
        'third thing',
        'a hook wrote this',
      ]);
    });

    it('an observation spanning several lines still maps to one memory', () => {
      // Line -> observation is computed from the rendered text rather than
      // assumed one-to-one, because an observation may contain newlines. With
      // a naive mapping `insert_line: 2` would land inside the first memory.
      seed('multi', ['line one\nline two', 'a second memory']);

      const viewed = handleMemoryCommand({ command: 'view', path: file('multi') });
      expect(viewed.content).toContain('     3\ta second memory');

      handleMemoryCommand({
        command: 'insert',
        path: file('multi'),
        insert_line: 2, // the SECOND line, which belongs to the FIRST memory
        insert_text: 'inserted',
      });

      expect(observationsOf('multi'), 'a memory was split in half at a line boundary')
        .toEqual(['line one\nline two', 'inserted', 'a second memory']);
    });
  });

  // --- 3. The six commands ---------------------------------------------------

  describe('a view is a read', () => {
    it('does not touch access_count or last_accessed_at', () => {
      // The API injects "ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING
      // ANYTHING ELSE" into the system prompt, so a directory view is the
      // FIRST call of EVERY conversation. The obvious implementation went
      // through `KnowledgeGraph.listRecent()`, which calls `trackAccess()` and
      // runs `UPDATE entities SET access_count = access_count + 1,
      // last_accessed_at = ?` over every row — so every conversation bumped
      // every memory in the database. Measured before the fix: five untouched
      // memories reached access_count 4 apiece after three root views and one
      // namespace view.
      //
      // That is not just a write on a read. `frequency` is 0.18 of the ranking
      // score and `last_accessed_at` feeds `recency` at 0.25, so it flattened
      // both signals uniformly and defeated auto-decay: nothing can look stale
      // if everything is touched every session.
      for (let i = 0; i < 3; i++) seed(`note-${i}`, [`memory ${i}`]);

      const snapshot = () =>
        getDatabase()
          .prepare('SELECT name, access_count, last_accessed_at FROM entities ORDER BY name')
          .all();
      const before = snapshot();

      handleMemoryCommand({ command: 'view', path: MEMORY_ROOT });
      handleMemoryCommand({ command: 'view', path: `${MEMORY_ROOT}/personal` });
      handleMemoryCommand({ command: 'view', path: file('note-1') });

      expect(snapshot(), 'a read-only view mutated ranking state').toEqual(before);
    });
  });

  describe('view', () => {
    it('lists namespaces at the root', () => {
      seed('a', ['x'], 'personal');
      seed('b', ['y'], 'team');
      const result = handleMemoryCommand({ command: 'view', path: MEMORY_ROOT });
      expect(result.isError).toBe(false);
      for (const ns of ['personal', 'team', 'global']) {
        expect(result.content).toContain(`${MEMORY_ROOT}/${ns}`);
      }
    });

    it('lists memories in a namespace, and only that namespace', () => {
      seed('mine', ['x'], 'personal');
      seed('theirs', ['y'], 'team');
      const result = handleMemoryCommand({ command: 'view', path: `${MEMORY_ROOT}/personal` });
      expect(result.content).toContain('mine.md');
      expect(result.content, "another namespace's memory leaked into the listing")
        .not.toContain('theirs.md');
    });

    it('numbers lines the way the contract specifies', () => {
      seed('note', ['alpha', 'beta']);
      const result = handleMemoryCommand({ command: 'view', path: file('note') });
      expect(result.content).toBe(
        `Here's the content of ${file('note')} with line numbers:\n` +
          '     1\talpha\n' +
          '     2\tbeta'
      );
    });

    it('honours view_range, including the open-ended form', () => {
      seed('long', ['one', 'two', 'three', 'four']);
      const middle = handleMemoryCommand({
        command: 'view', path: file('long'), view_range: [2, 3],
      });
      expect(middle.content).toContain('     2\ttwo');
      expect(middle.content).toContain('     3\tthree');
      expect(middle.content).not.toContain('four');

      const toEnd = handleMemoryCommand({
        command: 'view', path: file('long'), view_range: [3, -1],
      });
      expect(toEnd.content).toContain('three');
      expect(toEnd.content).toContain('four');
      expect(toEnd.content).not.toContain('     1\tone');
    });

    it('says so for a memory that does not exist', () => {
      const result = handleMemoryCommand({ command: 'view', path: file('nothing') });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('does not exist');
    });

    it('does not list an archived memory', () => {
      seed('gone', ['x']);
      handleMemoryCommand({ command: 'delete', path: file('gone') });
      const listing = handleMemoryCommand({ command: 'view', path: `${MEMORY_ROOT}/personal` });
      expect(listing.content).not.toContain('gone.md');
    });
  });

  describe('create', () => {
    it('creates a memory whose lines are its observations', () => {
      const result = handleMemoryCommand({
        command: 'create',
        path: file('fresh'),
        file_text: 'first\nsecond',
      });
      expect(result.isError).toBe(false);
      expect(observationsOf('fresh')).toEqual(['first', 'second']);
    });

    it('overwrites rather than refusing, and keeps the tags', () => {
      // The contract's tool description tells Claude create "creates or
      // overwrites", so refusing would leave it unable to correct a memory it
      // has just decided is wrong. Tags are not the model's to lose on a
      // rewrite — they are how the rest of MeMesh finds this entity.
      new KnowledgeGraph(getDatabase()).createEntity('notes', 'note', {
        observations: ['old'],
        tags: ['project:memesh'],
        namespace: 'personal',
      });

      handleMemoryCommand({ command: 'create', path: file('notes'), file_text: 'new' });

      expect(observationsOf('notes')).toEqual(['new']);
      expect(new KnowledgeGraph(getDatabase()).getEntity('notes')?.tags)
        .toContain('project:memesh');
    });

    it('refuses a write past the size cap, and writes nothing', () => {
      // The contract puts a size cap on the implementer. Without one a model
      // in a loop grows a single memory without bound — and because every
      // `insert` rewrites the whole entity, the cost is quadratic in the
      // number of appends, with the FTS index and the embedding pipeline
      // behind it.
      seed('bounded', ['a small memory']);
      const huge = 'x'.repeat(300 * 1024);

      const result = handleMemoryCommand({
        command: 'create', path: file('bounded'), file_text: huge,
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('limit for one memory');
      expect(observationsOf('bounded'), 'the oversize write landed anyway')
        .toEqual(['a small memory']);
    });

    it('refuses to write to a directory', () => {
      const result = handleMemoryCommand({
        command: 'create', path: `${MEMORY_ROOT}/personal`, file_text: 'x',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('str_replace', () => {
    it('edits the memory containing the text', () => {
      seed('prefs', ['Favorite color: blue', 'Timezone: CST']);
      const result = handleMemoryCommand({
        command: 'str_replace',
        path: file('prefs'),
        old_str: 'Favorite color: blue',
        new_str: 'Favorite color: green',
      });
      expect(result.isError).toBe(false);
      expect(observationsOf('prefs')).toEqual(['Favorite color: green', 'Timezone: CST']);
    });

    it('deletes when new_str is omitted', () => {
      seed('prefs', ['keep this', 'drop this']);
      handleMemoryCommand({
        command: 'str_replace', path: file('prefs'), old_str: '\ndrop this',
      });
      expect(observationsOf('prefs')).toEqual(['keep this']);
    });

    it('refuses an ambiguous old_str instead of picking one', () => {
      // A write, and the wrong one is silent. The contract asks for the line
      // numbers so the model can widen the match rather than guess.
      seed('dup', ['status: draft', 'other', 'status: draft']);
      const before = observationsOf('dup');

      const result = handleMemoryCommand({
        command: 'str_replace', path: file('dup'), old_str: 'status: draft', new_str: 'status: done',
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Multiple occurrences');
      expect(result.content).toContain('1, 3');
      expect(observationsOf('dup'), 'an ambiguous edit was applied anyway').toEqual(before);
    });

    it('says so when the text is not there, and changes nothing', () => {
      seed('note', ['a']);
      const result = handleMemoryCommand({
        command: 'str_replace', path: file('note'), old_str: 'not present', new_str: 'x',
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('did not appear verbatim');
      expect(observationsOf('note')).toEqual(['a']);
    });
  });

  describe('insert', () => {
    it('inserts at the beginning for line 0', () => {
      seed('list', ['b', 'c']);
      handleMemoryCommand({
        command: 'insert', path: file('list'), insert_line: 0, insert_text: 'a',
      });
      expect(observationsOf('list')).toEqual(['a', 'b', 'c']);
    });

    it('refuses a line number outside the file, and changes nothing', () => {
      seed('list', ['a', 'b']);
      const result = handleMemoryCommand({
        command: 'insert', path: file('list'), insert_line: 9, insert_text: 'x',
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('[0, 2]');
      expect(observationsOf('list')).toEqual(['a', 'b']);
    });
  });

  describe('delete', () => {
    it('archives rather than destroying', () => {
      // The person whose memory it is did not ask for this — a model did. From
      // the model's side the file is gone; from theirs it is restorable.
      seed('regret', ['something worth keeping']);
      const result = handleMemoryCommand({ command: 'delete', path: file('regret') });

      expect(result.isError).toBe(false);
      const entity = new KnowledgeGraph(getDatabase()).getEntity('regret');
      expect(entity, 'the memory was destroyed, not archived').not.toBeNull();
      expect(entity?.archived).toBe(true);
      expect(entity?.observations).toEqual(['something worth keeping']);
    });

    it('refuses to delete the memory root or a namespace', () => {
      seed('keep', ['x']);
      expect(handleMemoryCommand({ command: 'delete', path: MEMORY_ROOT }).isError).toBe(true);
      expect(
        handleMemoryCommand({ command: 'delete', path: `${MEMORY_ROOT}/personal` }).isError
      ).toBe(true);
      expect(observationsOf('keep')).toEqual(['x']);
    });
  });

  describe('rename', () => {
    it('renames and keeps the observations', () => {
      seed('draft', ['content that must survive']);
      const result = handleMemoryCommand({
        command: 'rename', old_path: file('draft'), new_path: file('final'),
      });
      expect(result.isError).toBe(false);
      expect(observationsOf('final')).toEqual(['content that must survive']);
      expect(new KnowledgeGraph(getDatabase()).getEntity('draft')).toBeNull();
    });

    it('the renamed memory is findable under its new name, and NOT the old one', () => {
      // The old-name assertion here used to be
      //   expect(kg.search('oldname').map(e => e.name)).not.toContain('oldname')
      // which asserts the wrong thing: after the rename no entity is CALLED
      // 'oldname', so it is true whether or not the index still matches the
      // old term. It passed while `MATCH kangaroo` still returned the row.
      //
      // `entities_fts` is contentless, so a delete must use the text that was
      // indexed. Renaming the row first and rebuilding after deleted with the
      // NEW name, matched nothing, and layered the new tokens on top of the
      // old ones. A user renaming a memory to get a wrong label off it kept
      // the label. Asserting on the SEARCH RESULT, not on the names in it.
      seed('kangaroo-notes', ['a distinctive phrase about marsupials']);
      handleMemoryCommand({
        command: 'rename',
        old_path: file('kangaroo-notes'),
        new_path: file('wallaby-notes'),
      });

      const kg = new KnowledgeGraph(getDatabase());
      expect(kg.search('wallaby').map((e) => e.name)).toContain('wallaby-notes');
      expect(kg.search('marsupials').map((e) => e.name)).toContain('wallaby-notes');
      expect(
        kg.search('kangaroo').length,
        'the old name is still searchable after the rename'
      ).toBe(0);

      // Contentless FTS5 punishes a delete issued with the wrong text by
      // leaving the index inconsistent, and that damage is invisible until a
      // later query returns nothing. Ask the table directly.
      expect(() =>
        getDatabase().exec("INSERT INTO entities_fts(entities_fts) VALUES('integrity-check')")
      ).not.toThrow();
    });

    it('refuses a destination that exists, in any namespace', () => {
      // Memory names are unique database-wide. Checking only the destination
      // namespace would let the write reach SQLite and fail on the UNIQUE
      // constraint instead of returning the message the contract specifies.
      seed('source', ['x'], 'personal');
      seed('taken', ['y'], 'team');

      const result = handleMemoryCommand({
        command: 'rename', old_path: file('source'), new_path: file('taken', 'personal'),
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('already exists');
      expect(observationsOf('source')).toEqual(['x']);
    });

    it('refuses to rename a namespace', () => {
      const result = handleMemoryCommand({
        command: 'rename', old_path: `${MEMORY_ROOT}/personal`, new_path: `${MEMORY_ROOT}/team`,
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('the envelope', () => {
    it('publishes the exact tool definition', () => {
      // A wrong version string fails as "unknown tool", which names nothing.
      expect(MEMORY_TOOL_DEFINITION).toEqual({ type: 'memory_20250818', name: 'memory' });
    });

    it('refuses input that is not a command', () => {
      expect(handleMemoryCommand(null).isError).toBe(true);
      expect(handleMemoryCommand('view').isError).toBe(true);
      expect(handleMemoryCommand({}).isError).toBe(true);
      expect(handleMemoryCommand({ command: 'sudo' }).isError).toBe(true);
    });

    it('checks argument types rather than trusting the declared shape', () => {
      // Input arrives from a model over the wire; the schema is a description
      // of what should come, not a guarantee of what does.
      seed('note', ['a']);
      expect(handleMemoryCommand({ command: 'create', path: file('note'), file_text: 42 }).isError).toBe(true);
      expect(handleMemoryCommand({ command: 'insert', path: file('note'), insert_line: '1', insert_text: 'x' }).isError).toBe(true);
      expect(handleMemoryCommand({ command: 'str_replace', path: file('note'), old_str: '' }).isError).toBe(true);
      expect(observationsOf('note')).toEqual(['a']);
    });
  });
});
