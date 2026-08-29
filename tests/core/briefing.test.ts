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
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { handleTool } from '../../src/mcp/tools.js';
import { assembleBriefing } from '../../src/core/briefing.js';
import { setTaskState } from '../../src/core/task-state-store.js';
import { remember } from '../../src/core/operations.js';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { TOPOLOGY_CANDIDATE_CAP } from '../../src/core/work-topology.js';
import { getProjectName } from '../../src/core/paths.js';
import { removeTempDir } from '../helpers/temp-dir.js';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-briefing-'));
  dbPath = path.join(tmpDir, 'test.db');
  openDatabase(dbPath);
});

afterEach(() => {
  closeDatabase();
  removeTempDir(tmpDir);
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
    // The heading attributes rather than asserts: every field under it is
    // something a person SAID and nothing revisits it when the work moves on.
    // It read `Where "<project>" was left off` until 2026-08-24, when it opened
    // a session with "Just finished: v4.6.0" against 38 merged PRs.
    expect(t.indexOf('Stated about')).toBeGreaterThan(-1);
    expect(t, 'the heading claims to describe the project rather than quote someone')
      .not.toContain('was left off');
    expect(t.indexOf('Stated about')).toBeLessThan(t.indexOf('Decisions and direction'));
    expect(t).toContain('Ship A1c');
    expect(t).toContain('Use PKCE for the CLI');
    expect(t).toContain('do not repeat these');
    expect(t).not.toContain('oauth-pkce-decision');

    // One fenced block with the untrusted-data preamble — the same trust
    // framing on every injection path.
    expect(t.startsWith('MeMesh reference memory.')).toBe(true);
    expect(t.trimEnd().endsWith('```')).toBe(true);
  });

  it('names an unread delivery beside the stated lines, with the fetch instruction', async () => {
    seed();
    setTaskState({ project: PROJECT, patch: { goal: 'Ship A1c' } });
    // A real send: one message, one delivery, no intake receipt yet.
    await executeAgentMessageAction(getDatabase(), {
      action: 'send', project: PROJECT, sender: 'codex-reviewer', recipient: 'claude-implementer',
      idempotency_key: 'briefing-unread-1', payload: { text: 'review is done' }, content_type: 'application/json',
    }, { transport: 'mcp', sourceHost: 'test-host' });

    const t = assembleBriefing(PROJECT).text;
    expect(t).toContain(`1 message waiting for "${PROJECT}"`);
    expect(t).toContain('fetch them with the message tool');
    // Beside the stated line, before the ranked sections.
    expect(t.indexOf('message waiting')).toBeGreaterThan(t.indexOf('Stated about'));
    expect(t.indexOf('message waiting')).toBeLessThan(t.indexOf('Decisions and direction'));
  });

  it('says nothing about messages once the delivery has an intake receipt, or when there are none', async () => {
    seed();
    const sent = await executeAgentMessageAction(getDatabase(), {
      action: 'send', project: PROJECT, sender: 'codex-reviewer', recipient: 'claude-implementer',
      idempotency_key: 'briefing-unread-2', payload: { text: 'x' }, content_type: 'application/json',
    }, { transport: 'mcp', sourceHost: 'test-host' }) as { message_id: string };
    expect(assembleBriefing(PROJECT).text).toContain('1 message waiting');

    await executeAgentMessageAction(getDatabase(), {
      action: 'intake', project: PROJECT, recipient: 'claude-implementer', message_id: sent.message_id,
      intake_state: 'fetched', idempotency_key: 'briefing-intake-2',
    }, { transport: 'mcp', sourceHost: 'test-host' });
    expect(assembleBriefing(PROJECT).text).not.toContain('message waiting');

    expect(assembleBriefing('project-with-no-inbox').text).not.toContain('message waiting');
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

  it('the candidate window keeps the newest entities when a project exceeds the cap (M-19)', () => {
    // Latent — the largest real project measured is 177, well under
    // TOPOLOGY_CANDIDATE_CAP (400) — but the SQL `LIMIT ?` selecting a
    // project's candidates had no `ORDER BY`. Below the cap this is
    // invisible; above it, SQLite's DISTINCT dedup (not necessarily
    // newest-first) decides which candidates ever reach ranking at all —
    // measured: it returns ascending by id, oldest-first, with no
    // `ORDER BY` present.
    //
    // Every entity below is identical in every ranking factor (type,
    // confidence, access_count all default), so rankEntities' scores tie
    // and Array.prototype.sort's stability preserves the SQL's row
    // order — which is exactly what isolates this defect from ranking
    // behaviour: whichever candidate survives the SQL-level LIMIT is
    // whichever the briefing can possibly mention.
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const total = TOPOLOGY_CANDIDATE_CAP + 20;
    for (let i = 0; i < total; i++) {
      kg.createEntity(`cap-entity-${String(i).padStart(4, '0')}`, 'note', {
        title: `cap entity number ${i}`,
        observations: ['filler observation'],
        tags: [`project:${PROJECT}`],
      });
    }
    // The "recent across all projects" pool (recentRows) is ALREADY
    // ordered newest-first and would independently surface this
    // project's newest entities regardless of whether the project-scoped
    // query is fixed — masking the very defect this test exists to catch.
    // A batch of newer, differently-tagged entities pushes every
    // `cap-entity-*` id out of that global top-5, so anything the
    // assembled text says about them can only have come through the
    // project-scoped query under test.
    for (let i = 0; i < 10; i++) {
      kg.createEntity(`noise-entity-${String(i).padStart(3, '0')}`, 'note', {
        title: `unrelated noise ${i}`,
        observations: ['filler observation'],
        tags: ['project:noise-unrelated'],
      });
    }

    const text = assembleBriefing(PROJECT).text;
    // The newest entity created (highest id) must have survived the
    // SQL-level window to be eligible for ranking at all.
    expect(text, 'the newest candidate never reached ranking — the SQL window dropped it')
      .toContain(`cap entity number ${total - 1}`);
    // Anti-vacuity: the oldest entity, created before the 400-row cap
    // even started mattering, must NOT be the one occupying a ranking
    // slot — if it is, the window kept the wrong end.
    expect(text, 'the oldest candidate is still winning a ranking slot over the newest')
      .not.toContain('cap entity number 0\n');
  }, 30_000);
});
