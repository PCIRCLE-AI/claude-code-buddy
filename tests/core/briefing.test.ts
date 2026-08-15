/**
 * The cross-vendor read path (A1c): an MCP client that runs no hooks must get
 * the ASSEMBLED topology, not the parts.
 *
 * The load-bearing test here is the last one: it runs the real session-start
 * hook and the real briefing assembler against the SAME database and asserts
 * they say the same thing. The hook and the tool deliberately own separate
 * database access (the A1a design — hooks cannot import core), so nothing
 * structural forces their outputs to agree; this test is what does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { handleTool } from '../../src/mcp/tools.js';
import { assembleBriefing } from '../../src/core/briefing.js';
import { setTaskState } from '../../src/core/task-state-store.js';
import { remember } from '../../src/core/operations.js';
import { getProjectName } from '../../src/core/paths.js';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-briefing-'));
  dbPath = path.join(tmpDir, 'test.db');
  openDatabase(dbPath);
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// The assembler resolves the current project from cwd when none is given;
// tests always pass one explicitly so they cannot be polluted by (or pollute)
// whatever repository the suite happens to run in.
const PROJECT = 'briefing-fixture';

function seed() {
  remember({
    name: 'oauth-pkce-decision', type: 'decision', title: 'Use PKCE for the CLI',
    observations: ['The CLI cannot hold a client secret.'], tags: [`project:${PROJECT}`],
  });
  remember({
    name: 'lesson-timeout', type: 'lesson_learned', title: 'Raising the timeout hid a deadlock',
    observations: ['Fix the deadlock, not the clock.'], tags: [`project:${PROJECT}`],
  });
  remember({
    name: 'commit-abc1234', type: 'commit', title: 'fix: repair the parser',
    observations: ['fix: repair the parser'], tags: [`project:${PROJECT}`],
  });
}

describe('assembleBriefing', () => {
  it('assembles the topology: task state first, then sections, in one fenced block', () => {
    seed();
    setTaskState({ project: PROJECT, patch: { goal: 'Ship A1c', next: 'Open the PR' } });

    const result = assembleBriefing(PROJECT);
    expect(result.hasTaskState).toBe(true);
    expect(result.entityCount).toBeGreaterThanOrEqual(3);

    const t = result.text;
    // The stated line leads; ranked sections follow; the machine keys never appear.
    expect(t.indexOf('was left off')).toBeGreaterThan(-1);
    expect(t.indexOf('was left off')).toBeLessThan(t.indexOf('Decisions and direction'));
    expect(t).toContain('Ship A1c');
    expect(t).toContain('Use PKCE for the CLI');
    expect(t).toContain('do not repeat these');
    expect(t).not.toContain('oauth-pkce-decision');

    // One fenced block with the untrusted-data preamble — the same trust
    // framing on every injection path.
    expect(t.startsWith('MeMesh reference memory.')).toBe(true);
    expect(t.trimEnd().endsWith('```')).toBe(true);
  });

  it('returns empty text, not an empty fence, when there is nothing to say', () => {
    const result = assembleBriefing('no-such-project');
    expect(result.text).toBe('');
    expect(result.entityCount).toBe(0);
    expect(result.hasTaskState).toBe(false);
  });

  it('excludes what the auto-injection gate blocks, same as the hook', () => {
    seed();
    // An imported memory: reachable by explicit recall, never auto-injected.
    remember({
      name: 'imported-note', type: 'fact', title: 'Imported wisdom',
      observations: ['From someone else’s graph.'], tags: [`project:${PROJECT}`],
      provenanceOverride: { source: 'import' },
    });

    const t = assembleBriefing(PROJECT).text;
    expect(t).not.toContain('Imported wisdom');
    expect(t).toContain('Use PKCE for the CLI');
  });

  it('is reachable as the briefing MCP tool', async () => {
    seed();
    const result = await handleTool('briefing', { project: PROJECT });
    const data = JSON.parse(result.content[0].text);
    expect(data.project).toBe(PROJECT);
    expect(data.text).toContain('Use PKCE for the CLI');
  });

  it('says the same thing the session-start hook injects, from the same database', () => {
    // THE acceptance test. Hook and tool own separate selection code on
    // purpose; only this pin keeps "the same block" true. Compared at the
    // level that matters — which memories, which sections, which order —
    // not byte-for-byte, because the two sides may legitimately differ in
    // budget tail behaviour.
    const cwd = path.join(tmpDir, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    const project = getProjectName(cwd);

    remember({
      name: 'decision-x', type: 'decision', title: 'Ship FTS5 as the baseline',
      observations: ['Vector search is a supplement.'], tags: [`project:${project}`],
    });
    remember({
      name: 'lesson-y', type: 'lesson_learned', title: 'Do not trust a green suite alone',
      observations: ['Revert the fix and confirm red.'], tags: [`project:${project}`],
    });
    setTaskState({ project, patch: { goal: 'Prove the parity', next: 'Run both paths' } });
    closeDatabase(); // the hook opens its own handle; release the write lock
    // Re-open for the assembler after the hook has run (below).

    const hookOut = execFileSync('node', [path.resolve('scripts/hooks/session-start.js')], {
      input: JSON.stringify({ cwd }),
      env: { ...process.env, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 15000,
    });
    const injected: string =
      JSON.parse(hookOut.trim().split('\n').filter(Boolean).at(-1)!)
        .hookSpecificOutput.additionalContext;

    openDatabase(dbPath);
    const briefing = assembleBriefing(project).text;

    const contentLines = (block: string) =>
      block.split('\n').filter((l) => l.startsWith('- ') || l.endsWith(':'));

    // Every content line the hook injected, the briefing carries — and the
    // reverse — in the same order.
    expect(contentLines(briefing)).toEqual(contentLines(injected));
    expect(briefing).toContain('Prove the parity');
  });
});
