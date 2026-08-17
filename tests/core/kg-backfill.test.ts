import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import {
  isTopicalTag,
  tokenizeName,
  jaccardSimilarity,
  proposeBackfillCandidates,
  backfillRelations,
} from '../../src/core/kg-backfill.js';


// Contract tests for the heuristic KG relation backfill introduced in
// commit 746d60cf. Two rules are pinned here:
//
//   Rule 1 — tag co-occurrence: two active entities sharing ≥ 2 topical
//   tags get a `related-to` edge.
//
//   Rule 2 — project clustering: orphan consumer-type entities
//   (lesson_learned, decision, bug_fix, …) in a project get a single
//   `belongs-to-project` edge to the most recent anchor-type entity
//   (release, feature, architecture, plan) in that project.
//
// Scenario #10 (system-tag exclusion) is the regression pin for the
// cartesian-explosion bug the maintainer caught manually on the live DB:
// 24 lessons sharing `completed` would have produced 276 bogus edges.

describe('isTopicalTag — strict allow-list semantics', () => {
  // Allow-listed prefixes
  it('should accept topic: prefix tags', () => {
    expect(isTopicalTag('topic:auth')).toBe(true);
  });

  it('should accept tech: prefix tags', () => {
    expect(isTopicalTag('tech:nodejs')).toBe(true);
  });

  // Blocked prefixes (system namespaces)
  it('should reject project: prefix tags — system namespace', () => {
    expect(isTopicalTag('project:memesh')).toBe(false);
  });

  it('should reject week: prefix tags — system namespace', () => {
    expect(isTopicalTag('week:2026-W19')).toBe(false);
  });

  // Date-shaped bare tags
  it('should reject bare YYYY-MM-DD date tags', () => {
    expect(isTopicalTag('2026-05-10')).toBe(false);
  });

  // System literal blocklist
  it('should reject session_end — system literal', () => {
    expect(isTopicalTag('session_end')).toBe(false);
  });

  it('should reject completed — lifecycle status (cartesian-noise fix)', () => {
    expect(isTopicalTag('completed')).toBe(false);
  });

  // Bare content tags pass through
  it('should accept bare content tags like auth-pattern', () => {
    expect(isTopicalTag('auth-pattern')).toBe(true);
  });

  // Defensive edge cases
  it('should reject empty string', () => {
    expect(isTopicalTag('')).toBe(false);
  });

  it('should reject null coerced to empty string via falsy check', () => {
    // The function signature is (tag: string) but callers could pass
    // null/undefined from DB rows. The `!tag` guard covers this.
    expect(isTopicalTag(null as unknown as string)).toBe(false);
    expect(isTopicalTag(undefined as unknown as string)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DB-backed integration tests
// ---------------------------------------------------------------------------

describe('kg-backfill integration', () => {
  let testDir: string;
  let dbPath: string;
  let prevDbPath: string | undefined;
  let db: Database;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-kg-backfill-test-'));
    dbPath = path.join(testDir, 'test.db');
    prevDbPath = process.env.MEMESH_DB_PATH;
    process.env.MEMESH_DB_PATH = dbPath;
    // Open a fresh DB for this test using the singleton
    const { closeDatabase, openDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* nothing open */ }
    openDatabase();
    // Also open a direct better-sqlite3 handle for seeding
    db = new Database(dbPath);
  });

  afterEach(async () => {
    db.close();
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    if (prevDbPath === undefined) delete process.env.MEMESH_DB_PATH;
    else process.env.MEMESH_DB_PATH = prevDbPath;
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function insertEntity(name: string, type: string, status = 'active'): number {
    const r = db.prepare(
      "INSERT INTO entities (name, type, status) VALUES (?, ?, ?)"
    ).run(name, type, status);
    return r.lastInsertRowid as number;
  }

  function insertTag(entityId: number, tag: string): void {
    db.prepare("INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)").run(entityId, tag);
  }

  function insertRelation(fromId: number, toId: number, relType = 'related-to'): void {
    db.prepare(
      "INSERT OR IGNORE INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)"
    ).run(fromId, toId, relType);
  }

  function countRelations(): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM relations").get() as { c: number }).c;
  }

  // ---------------------------------------------------------------------------
  // Scenario 2: Tag co-occurrence — happy path
  // ---------------------------------------------------------------------------

  it('should propose related-to for two orphans sharing ≥ 2 topical tags', () => {
    // Entity A: orphan with 2 topical tags + 1 system tag
    const idA = insertEntity('entity-a', 'knowledge');
    insertTag(idA, 'topic:auth');
    insertTag(idA, 'tech:oauth');
    insertTag(idA, 'project:demo');   // system — excluded

    // Entity B: orphan sharing the 2 topical tags
    const idB = insertEntity('entity-b', 'knowledge');
    insertTag(idB, 'topic:auth');
    insertTag(idB, 'tech:oauth');
    insertTag(idB, 'project:other');  // system — excluded

    // Entity C: orphan with unrelated tags — should not appear
    const idC = insertEntity('entity-c', 'knowledge');
    insertTag(idC, 'topic:ci');
    insertTag(idC, 'tech:docker');

    const { candidates } = proposeBackfillCandidates({ minSharedTags: 2 });

    // A↔B pair must exist (A→B or B→A depending on iteration order)
    const abCandidate = candidates.find(
      c => (c.fromEntityId === idA && c.toEntityId === idB) ||
           (c.fromEntityId === idB && c.toEntityId === idA)
    );
    expect(abCandidate).toBeDefined();
    expect(abCandidate!.relationType).toBe('related-to');
    expect(abCandidate!.strength).toBe(2);

    // C must not appear paired with A or B
    const cInvolved = candidates.filter(
      c => c.fromEntityId === idC || c.toEntityId === idC
    );
    expect(cInvolved).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Orphan-only filter — only orphans propose, not connected peers
  // ---------------------------------------------------------------------------

  it('should only generate candidates FROM orphan entities, not from connected peers', () => {
    const idOrphan = insertEntity('orphan-entity', 'knowledge');
    insertTag(idOrphan, 'topic:auth');
    insertTag(idOrphan, 'tech:oauth');

    const idConnected = insertEntity('connected-entity', 'knowledge');
    insertTag(idConnected, 'topic:auth');
    insertTag(idConnected, 'tech:oauth');
    // Give idConnected an existing relation so it is NOT an orphan
    const idAnchor = insertEntity('some-anchor', 'release');
    insertRelation(idConnected, idAnchor);

    const { candidates } = proposeBackfillCandidates({ minSharedTags: 2 });

    // The connected entity must not appear as fromEntityId
    const connectedAsSource = candidates.filter(c => c.fromEntityId === idConnected);
    expect(connectedAsSource).toHaveLength(0);

    // The orphan SHOULD propose a candidate toward the connected entity
    // (Rule 1 looks up ALL entities as potential peers, not just orphans)
    const orphanToConnected = candidates.find(
      c => c.fromEntityId === idOrphan && c.toEntityId === idConnected
    );
    expect(orphanToConnected).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: maxEdgesPerSource cap
  // ---------------------------------------------------------------------------

  it('should cap candidates per orphan source at maxEdgesPerSource', () => {
    const idOrphan = insertEntity('rich-orphan', 'knowledge');
    insertTag(idOrphan, 'topic:auth');
    insertTag(idOrphan, 'tech:oauth');

    // Create 5 peers each sharing both topical tags with the orphan
    for (let i = 1; i <= 5; i++) {
      const id = insertEntity(`peer-${i}`, 'knowledge');
      insertTag(id, 'topic:auth');
      insertTag(id, 'tech:oauth');
    }

    const { candidates } = proposeBackfillCandidates({ maxEdgesPerSource: 3, minSharedTags: 2 });
    const fromOrphan = candidates.filter(c => c.fromEntityId === idOrphan);
    expect(fromOrphan.length).toBeLessThanOrEqual(3);
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Project clustering — basic happy path
  // ---------------------------------------------------------------------------

  it('should propose belongs-to-project from orphan lesson to release anchor in same project', () => {
    // Anchor: a release in project:demo (NOT an orphan — has a relation)
    const idRelease = insertEntity('v1.0.0-release', 'release');
    insertTag(idRelease, 'project:demo');
    // Give the release an existing relation so it's not an orphan itself
    // (the rule reads ALL entities for anchors, not just orphans)
    const idConnected = insertEntity('dummy-connected', 'knowledge');
    insertRelation(idRelease, idConnected);

    // Orphan consumer: lesson in same project
    const idLesson = insertEntity('bug-fix-auth', 'lesson_learned');
    insertTag(idLesson, 'project:demo');

    const { candidates } = proposeBackfillCandidates();
    const pc = candidates.find(
      c => c.fromEntityId === idLesson && c.toEntityId === idRelease
    );
    expect(pc).toBeDefined();
    expect(pc!.relationType).toBe('belongs-to-project');
  });

  // ---------------------------------------------------------------------------
  // Scenario 6: Project clustering — only one (most recent) anchor per orphan
  // ---------------------------------------------------------------------------

  it('should link orphan to only the most-recent anchor when multiple anchors exist in project', () => {
    // Three releases in project:demo with different timestamps
    const idRelOld = insertEntity('v1.0.0-release', 'release');
    insertTag(idRelOld, 'project:demo');
    db.prepare("UPDATE entities SET created_at = '2025-01-01 00:00:00' WHERE id = ?").run(idRelOld);

    const idRelMid = insertEntity('v2.0.0-release', 'release');
    insertTag(idRelMid, 'project:demo');
    db.prepare("UPDATE entities SET created_at = '2025-06-01 00:00:00' WHERE id = ?").run(idRelMid);

    const idRelNew = insertEntity('v3.0.0-release', 'release');
    insertTag(idRelNew, 'project:demo');
    db.prepare("UPDATE entities SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(idRelNew);

    // Orphan lesson
    const idLesson = insertEntity('critical-bug-fix', 'lesson_learned');
    insertTag(idLesson, 'project:demo');

    const { candidates } = proposeBackfillCandidates();
    const pcCandidates = candidates.filter(
      c => c.fromEntityId === idLesson && c.relationType === 'belongs-to-project'
    );

    // Only one anchor per orphan
    expect(pcCandidates).toHaveLength(1);
    // Must be the most-recent release
    expect(pcCandidates[0].toEntityId).toBe(idRelNew);
  });

  // ---------------------------------------------------------------------------
  // Scenario 7: applyBackfill writes rows + idempotency (INSERT OR IGNORE)
  // ---------------------------------------------------------------------------

  it('should write edges on first call and skip duplicates on re-run', () => {
    const idA = insertEntity('apply-a', 'knowledge');
    insertTag(idA, 'topic:auth');
    insertTag(idA, 'tech:oauth');

    const idB = insertEntity('apply-b', 'knowledge');
    insertTag(idB, 'topic:auth');
    insertTag(idB, 'tech:oauth');

    const before = countRelations();
    const result1 = backfillRelations({ dryRun: false, minSharedTags: 2 });
    const after1 = countRelations();

    // Edges were written
    expect(result1.edgesWritten).toBeGreaterThan(0);
    expect(after1).toBeGreaterThan(before);

    // Second run — INSERT OR IGNORE should fire zero new rows
    const result2 = backfillRelations({ dryRun: false, minSharedTags: 2 });
    const after2 = countRelations();

    expect(result2.edgesWritten).toBe(0);
    expect(after2).toBe(after1);
  });

  // ---------------------------------------------------------------------------
  // Scenario 8: Dry-run does not write, but still proposes candidates
  // ---------------------------------------------------------------------------

  it('should not write any edges when dryRun is true', () => {
    const idA = insertEntity('dry-a', 'knowledge');
    insertTag(idA, 'topic:auth');
    insertTag(idA, 'tech:oauth');

    const idB = insertEntity('dry-b', 'knowledge');
    insertTag(idB, 'topic:auth');
    insertTag(idB, 'tech:oauth');

    const before = countRelations();
    const result = backfillRelations({ dryRun: true, minSharedTags: 2 });
    const after = countRelations();

    expect(result.dryRun).toBe(true);
    expect(result.candidatesProposed).toBeGreaterThan(0);
    expect(result.edgesWritten).toBe(0);
    expect(after).toBe(before);
  });

  // ---------------------------------------------------------------------------
  // Scenario 9: Project filter — only entities from the target project
  // ---------------------------------------------------------------------------

  it('should only propose candidates for the specified project when project option is set', () => {
    // Orphans in project:demo
    const idDemoA = insertEntity('demo-entity-a', 'knowledge');
    insertTag(idDemoA, 'topic:auth');
    insertTag(idDemoA, 'tech:oauth');
    insertTag(idDemoA, 'project:demo');

    const idDemoB = insertEntity('demo-entity-b', 'knowledge');
    insertTag(idDemoB, 'topic:auth');
    insertTag(idDemoB, 'tech:oauth');
    insertTag(idDemoB, 'project:demo');

    // Orphans in project:other — must not appear
    const idOtherA = insertEntity('other-entity-a', 'knowledge');
    insertTag(idOtherA, 'topic:auth');
    insertTag(idOtherA, 'tech:oauth');
    insertTag(idOtherA, 'project:other');

    const idOtherB = insertEntity('other-entity-b', 'knowledge');
    insertTag(idOtherB, 'topic:auth');
    insertTag(idOtherB, 'tech:oauth');
    insertTag(idOtherB, 'project:other');

    const { candidates } = proposeBackfillCandidates({ project: 'demo', minSharedTags: 2 });

    // All candidates must involve only demo entities as the FROM (orphan source)
    const demoEntityIds = new Set([idDemoA, idDemoB]);
    for (const c of candidates) {
      expect(demoEntityIds.has(c.fromEntityId)).toBe(true);
    }

    // other-project entities must not appear as source
    const otherIds = new Set([idOtherA, idOtherB]);
    const otherInvolved = candidates.filter(c => otherIds.has(c.fromEntityId));
    expect(otherInvolved).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Scenario 10: System-tag exclusion — regression for cartesian-explosion fix
  // ---------------------------------------------------------------------------

  it('should produce zero tag-cooccurrence candidates when entities share only system-literal tags', () => {
    // 3 orphan lessons sharing only `completed` + `lesson` — both SYSTEM_TAG_LITERALS.
    // Without the filter these would produce 3 cartesian pairs (3×2/2 = 3 edges).
    // With the filter: zero topical tags => zero candidates from Rule 1.
    for (let i = 1; i <= 3; i++) {
      const id = insertEntity(`system-tag-lesson-${i}`, 'lesson_learned');
      insertTag(id, 'completed');   // SYSTEM_TAG_LITERALS
      insertTag(id, 'lesson');      // SYSTEM_TAG_LITERALS
    }

    const { candidates } = proposeBackfillCandidates({ minSharedTags: 2 });

    // Rule 1 must propose nothing — all shared tags are system-literal noise
    const tagCooc = candidates.filter(c => c.relationType === 'related-to');
    expect(tagCooc).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Rule 3: Session co-occurrence
  // ---------------------------------------------------------------------------

  function setMetadata(entityId: number, meta: Record<string, unknown>): void {
    db.prepare("UPDATE entities SET metadata = ? WHERE id = ?").run(JSON.stringify(meta), entityId);
  }

  it('A1: links two high-signal orphans sharing a session: tag (co-created)', () => {
    const idA = insertEntity('lesson from auth work', 'lesson_learned');
    insertTag(idA, 'session:abc123');
    setMetadata(idA, { signal_score: 1.0 });

    const idB = insertEntity('decision on auth approach', 'decision');
    insertTag(idB, 'session:abc123');
    setMetadata(idB, { signal_score: 0.9 });

    const result = backfillRelations({ includeSessionCooccurrence: true, dryRun: false });
    expect(result.byRule.sessionCooccurrence).toBeGreaterThanOrEqual(1);

    const rel = db.prepare(
      "SELECT * FROM relations WHERE from_entity_id=? AND to_entity_id=? AND relation_type='co-created'"
    ).get(idA, idB);
    expect(rel).toBeTruthy();
  });

  it('A2: excludes low-signal entities (signal_score < 0.6) from session co-occurrence', () => {
    const idC = insertEntity('Duration: 0s noise', 'session_keypoint');
    insertTag(idC, 'session:xyz789');
    setMetadata(idC, { signal_score: 0.0 });

    const idD = insertEntity('real decision', 'decision');
    insertTag(idD, 'session:xyz789');
    setMetadata(idD, { signal_score: 0.9 });

    const result = backfillRelations({ includeSessionCooccurrence: true, dryRun: false });
    // session_keypoint is not in sessionEligibleTypes; also score=0 < 0.6
    expect(result.byRule.sessionCooccurrence).toBe(0);
  });

  it('A3: dry-run proposes co-created edges without writing', () => {
    const idE = insertEntity('lesson X', 'lesson_learned');
    insertTag(idE, 'session:s1');
    setMetadata(idE, { signal_score: 1.0 });

    const idF = insertEntity('decision Y', 'decision');
    insertTag(idF, 'session:s1');
    setMetadata(idF, { signal_score: 0.9 });

    const before = countRelations();
    const result = backfillRelations({ includeSessionCooccurrence: true, dryRun: true });
    const after = countRelations();

    expect(result.candidatesProposed).toBeGreaterThanOrEqual(1);
    expect(result.edgesWritten).toBe(0);
    expect(after).toBe(before);
  });

  it('A7: no duplicate (from,to) candidates when orphan shares multiple session tags with same peer', () => {
    // orphan A and peer B both tagged session:s1 AND session:s2 → should only
    // produce ONE co-created candidate (not two), keeping candidatesProposed honest.
    const idA = insertEntity('lesson alpha', 'lesson_learned');
    insertTag(idA, 'session:s1');
    insertTag(idA, 'session:s2');
    setMetadata(idA, { signal_score: 0.8 });

    const idB = insertEntity('decision beta', 'decision');
    insertTag(idB, 'session:s1');
    insertTag(idB, 'session:s2');
    setMetadata(idB, { signal_score: 0.8 });

    const result = backfillRelations({ includeSessionCooccurrence: true, dryRun: true });
    // One direction A→B (B is already a peer, not an orphan for its own outgoing edges
    // in this minimal seed). Key assertion: candidatesProposed must equal edgesWritten
    // path — i.e. no inflation from the duplicate session tag.
    const abPairs = result.candidatesProposed;
    expect(abPairs).toBeLessThanOrEqual(2); // at most A→B and B→A, never A→B twice
  });

  it('A6: maxEdgesPerSource caps co-created edges from Rule 3', () => {
    const anchor = insertEntity('big lesson', 'lesson_learned');
    insertTag(anchor, 'session:s2');
    setMetadata(anchor, { signal_score: 1.0 });

    for (let i = 0; i < 5; i++) {
      const id = insertEntity(`decision ${i}`, 'decision');
      insertTag(id, 'session:s2');
      setMetadata(id, { signal_score: 0.9 });
    }

    backfillRelations({ includeSessionCooccurrence: true, maxEdgesPerSource: 2, dryRun: false });

    const edges = db.prepare(
      "SELECT COUNT(*) AS n FROM relations WHERE from_entity_id=? AND relation_type='co-created'"
    ).get(anchor) as { n: number };
    expect(edges.n).toBeLessThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------
  // Rule 4: Name token similarity
  // ---------------------------------------------------------------------------

  it('A4: links orphans sharing ≥3 content name tokens (shares-name-tokens)', () => {
    // Shared tokens: {auth, module, session} = 3 ≥ default minSharedNameTokens (3)
    const idG = insertEntity('memesh auth module session config', 'feature');
    setMetadata(idG, { signal_score: 0.65 });

    const idH = insertEntity('auth module session handler', 'bug_fix');
    setMetadata(idH, { signal_score: 0.7 });

    const result = backfillRelations({ includeNameTokenSimilarity: true, dryRun: false });
    expect(result.byRule.nameTokenSimilarity).toBeGreaterThanOrEqual(1);
  });

  it('A5: does NOT link orphans with only stopword name overlap', () => {
    // After removing stopwords: {auth,bug} vs {login,issue} — 0 shared tokens
    insertEntity('fix the auth bug', 'bug_fix');
    insertEntity('fix the login issue', 'bug_fix');

    const result = backfillRelations({ includeNameTokenSimilarity: true, dryRun: false });
    expect(result.byRule.nameTokenSimilarity).toBe(0);
  });

  it('A4-jaccard: qualifies via Jaccard ≥ 0.25 even when shared token count < minSharedNameTokens', () => {
    // tokens: {oauth,service} vs {oauth,module} → intersection=1, union=3 → Jaccard=0.33
    // ("implementation" is a stopword → would leave only 1 token, excluded by size≥2 gate)
    const idI = insertEntity('oauth service', 'feature');
    setMetadata(idI, { signal_score: 0.65 });

    const idJ = insertEntity('oauth module', 'architecture');
    setMetadata(idJ, { signal_score: 0.9 });

    const result = backfillRelations({
      includeNameTokenSimilarity: true,
      minSharedNameTokens: 2,   // shared=1 < 2, but Jaccard=0.33 ≥ 0.25 still qualifies
      minNameJaccard: 0.25,
      dryRun: false,
    });
    expect(result.byRule.nameTokenSimilarity).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // Idempotency cache — persistent "already-attempted" orphan tracking
  // ---------------------------------------------------------------------------
  //
  // The cache stores orphan-ids the backfill has *attempted*, regardless of
  // whether any rule fired. Re-running skips those orphans so a crash in
  // mid-batch doesn't re-tokenise the first 2000 entries on the next run.
  // Reset path (`--reset-idempotency` flag → resetIdempotency: true) clears
  // the cache so users can reconsider every orphan after a schema change.

  it('idempotency: second run skips orphans that were marked attempted in run 1', () => {
    // Two orphans with no peer match — they get inspected but no rule fires.
    const idA = insertEntity('orphan-alpha', 'knowledge');
    insertTag(idA, 'topic:unique-a');
    const idB = insertEntity('orphan-beta', 'knowledge');
    insertTag(idB, 'topic:unique-b');

    const run1 = backfillRelations({ minSharedTags: 2 });
    expect(run1.candidatesProposed).toBe(0);
    expect(run1.orphansMarkedProcessed).toBe(2);
    expect(run1.orphansSkippedIdempotent).toBe(0);

    // Now add a third orphan that DOES match nothing — and re-run.
    // Run 2 should see only the new orphan; A and B were marked.
    const idC = insertEntity('orphan-gamma', 'knowledge');
    insertTag(idC, 'topic:unique-c');

    const run2 = backfillRelations({ minSharedTags: 2 });
    // Exact counts pin behaviour: precisely A and B are skipped (not a
    // monotonically growing "cache size"), and precisely C is newly added.
    expect(run2.orphansSkippedIdempotent).toBe(2);
    expect(run2.orphansMarkedProcessed).toBe(1);
  });

  it('idempotency: orphansSkippedIdempotent reflects THIS run, not cache size', () => {
    // Regression test for a previous bug where orphansSkippedIdempotent
    // was computed from the persistent cache size. That number grows
    // monotonically forever (cache never shrinks), so it would drift away
    // from "orphans actually skipped this run" as entities get edges and
    // stop being orphans.
    //
    // Setup: 3 orphans, mark all as processed via a run.
    const idA = insertEntity('orph-a', 'knowledge');
    insertTag(idA, 'topic:a');
    const idB = insertEntity('orph-b', 'knowledge');
    insertTag(idB, 'topic:b');
    const idC = insertEntity('orph-c', 'knowledge');
    insertTag(idC, 'topic:c');
    backfillRelations({ minSharedTags: 2 }); // marks A, B, C as processed

    // Manually add a relation TO A so A is no longer an orphan
    const peer = insertEntity('peer', 'knowledge');
    insertRelation(peer, idA, 'related-to');

    // New orphan D appears
    const idD = insertEntity('orph-d', 'knowledge');
    insertTag(idD, 'topic:d');

    // Run 2: cache contains {A,B,C}. Actual orphans now: {B,C,D}.
    // We expect skippedIdempotent === 2 (B and C are still orphans AND in cache),
    // not 3 (the raw cache size).
    const run2 = backfillRelations({ minSharedTags: 2 });
    expect(run2.orphansSkippedIdempotent).toBe(2);
    expect(run2.orphansMarkedProcessed).toBe(1); // only D newly added to cache
  });

  it('idempotency: cache size does not monotonically grow across 3 stable runs', () => {
    // After processing the same set of orphans, repeated runs should not
    // keep inflating the cache — the same IDs should be re-added (or kept)
    // without making `orphansSkippedIdempotent` lie. This is a second
    // regression guard for the same bug class.
    const ids = [
      insertEntity('stable-a', 'knowledge'),
      insertEntity('stable-b', 'knowledge'),
      insertEntity('stable-c', 'knowledge'),
    ];
    for (const id of ids) insertTag(id, `topic:${id}`);

    const run1 = backfillRelations({ minSharedTags: 2 });
    const run2 = backfillRelations({ minSharedTags: 2 });
    const run3 = backfillRelations({ minSharedTags: 2 });

    // Run 1: all 3 newly marked, 0 skipped
    expect(run1.orphansMarkedProcessed).toBe(3);
    expect(run1.orphansSkippedIdempotent).toBe(0);
    // Runs 2 and 3: all 3 skipped, 0 newly marked (cache is stable)
    expect(run2.orphansSkippedIdempotent).toBe(3);
    expect(run2.orphansMarkedProcessed).toBe(0);
    expect(run3.orphansSkippedIdempotent).toBe(3);
    expect(run3.orphansMarkedProcessed).toBe(0);
  });

  it('idempotency: dry-run path honours --reset-idempotency (not a silent no-op)', () => {
    // Regression test: a previous bug had the reset logic only inside
    // backfillRelations, so the dry-run path (which calls
    // proposeBackfillCandidates directly) walked through with the stale
    // cache still applied. Result: --dry-run --reset-idempotency was a
    // silent no-op and the user saw a confusingly empty proposal list.
    //
    // Use orphans with non-overlapping topical tags so Rule 1 doesn't
    // create edges (and thus doesn't change their orphan status). The
    // test focuses on whether reset actually clears the cache.
    const idA = insertEntity('dry-reset-a', 'knowledge');
    insertTag(idA, 'topic:unique-dr-a');
    const idB = insertEntity('dry-reset-b', 'knowledge');
    insertTag(idB, 'topic:unique-dr-b');

    // Run 1: marks both as processed (no edges since topics don't overlap)
    backfillRelations({ minSharedTags: 2 });

    // Without reset: proposeBackfillCandidates sees the populated cache
    const withoutReset = proposeBackfillCandidates({ minSharedTags: 2 });
    expect(withoutReset.skippedOrphanIds.length).toBe(2);
    expect(withoutReset.consideredOrphanIds.length).toBe(0);

    // With reset: cache cleared, both A and B reconsidered
    const withReset = proposeBackfillCandidates({ minSharedTags: 2, resetIdempotency: true });
    expect(withReset.skippedOrphanIds.length).toBe(0);
    expect(withReset.consideredOrphanIds.length).toBe(2);
  });

  it('idempotency: --reset-idempotency clears the cache so all orphans are reconsidered', () => {
    const idA = insertEntity('orphan-a', 'knowledge');
    insertTag(idA, 'topic:isolated-a');

    // First run marks A as attempted.
    backfillRelations({ minSharedTags: 2 });

    // Second run with resetIdempotency: cache cleared, A re-attempted.
    const run2 = backfillRelations({ minSharedTags: 2, resetIdempotency: true });
    expect(run2.orphansSkippedIdempotent).toBe(0);
    expect(run2.orphansMarkedProcessed).toBeGreaterThanOrEqual(1);
  });

  it('idempotency: dry-run does NOT update the cache (no persistence side effects)', () => {
    const idA = insertEntity('orphan-dry', 'knowledge');
    insertTag(idA, 'topic:dry-run-test');

    // Dry-run: skipped count should be 0 (fresh cache) and nothing persisted.
    const dry = backfillRelations({ minSharedTags: 2, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.orphansMarkedProcessed).toBe(0);

    // Real run: cache still empty, so A gets marked.
    const real = backfillRelations({ minSharedTags: 2 });
    expect(real.orphansSkippedIdempotent).toBe(0);
    expect(real.orphansMarkedProcessed).toBeGreaterThanOrEqual(1);
  });

  it('idempotency: ignoreIdempotency bypasses the cache entirely (test seam)', () => {
    const idA = insertEntity('orphan-ig', 'knowledge');
    insertTag(idA, 'topic:bypass-test');

    backfillRelations({ minSharedTags: 2 }); // populates cache

    // Without ignoreIdempotency, second run skips A.
    const skipping = backfillRelations({ minSharedTags: 2 });
    expect(skipping.orphansSkippedIdempotent).toBeGreaterThanOrEqual(1);

    // With ignoreIdempotency, A is considered again — and the cache is not
    // updated (no write side effects).
    const bypassed = backfillRelations({ minSharedTags: 2, ignoreIdempotency: true });
    expect(bypassed.orphansSkippedIdempotent).toBe(0);
    expect(bypassed.orphansMarkedProcessed).toBe(0);
  });

  it('idempotency: persists the cache across openDatabase cycles (real metadata table)', async () => {
    const idA = insertEntity('orphan-persist', 'knowledge');
    insertTag(idA, 'topic:persist-test');

    backfillRelations({ minSharedTags: 2 });

    // Close + reopen the managed singleton — simulates a CLI invocation
    // completing and the user re-running the command later.
    const { closeDatabase, openDatabase } = await import('../../src/db.js');
    closeDatabase();
    openDatabase();

    // Verify the persisted cache survives via the public metadata table.
    const row = db.prepare(
      "SELECT value FROM memesh_metadata WHERE key = 'kg_backfill_processed_v1'"
    ).get() as { value: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.value)).toContain(idA);

    // And the next backfillRelations call still skips A.
    const run = backfillRelations({ minSharedTags: 2 });
    expect(run.orphansSkippedIdempotent).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // Rule 5: evidence → work-node linking (default ON)
  // ---------------------------------------------------------------------------
  //
  // The two-layer graph (UX-4) counts incoming `evidences` edges for its
  // badges. Three match paths are pinned: shared session: tag, commit
  // metadata.session_id (post-commit stamps metadata, not tags — see the
  // pre-edit-recall noise rationale in scripts/hooks/post-commit.js), and
  // the temporal project fallback (most recent same-project work node
  // created BEFORE the evidence — never one created after it).

  function setCreatedAt(entityId: number, iso: string): void {
    db.prepare('UPDATE entities SET created_at = ? WHERE id = ?').run(iso, entityId);
  }

  it('R5: links evidence to a work node sharing its session: tag', () => {
    const ev = insertEntity('insight-x', 'session-insight');
    insertTag(ev, 'session:sess-42');
    const work = insertEntity('decision-x', 'decision');
    insertTag(work, 'session:sess-42');

    const result = backfillRelations({});
    expect(result.byRule.evidenceLinks).toBe(1);
    const rel = db.prepare(
      "SELECT * FROM relations WHERE from_entity_id=? AND to_entity_id=? AND relation_type='evidences'"
    ).get(ev, work);
    expect(rel).toBeTruthy();
  });

  it('R5: matches a commit via metadata.session_id against a work node session: tag', () => {
    const ev = insertEntity('commit-abc1234', 'commit');
    setMetadata(ev, { session_id: 'sess-77' });
    const work = insertEntity('lesson-y', 'lesson_learned');
    insertTag(work, 'session:sess-77');

    const result = backfillRelations({});
    expect(result.byRule.evidenceLinks).toBe(1);
    const rel = db.prepare(
      "SELECT * FROM relations WHERE from_entity_id=? AND to_entity_id=? AND relation_type='evidences'"
    ).get(ev, work);
    expect(rel).toBeTruthy();
  });

  it('R5: temporal project fallback links to the newest work node created BEFORE the evidence', () => {
    const older = insertEntity('older-plan', 'plan');
    insertTag(older, 'project:demo');
    setCreatedAt(older, '2026-08-01 10:00:00');
    const newerButAfter = insertEntity('later-decision', 'decision');
    insertTag(newerButAfter, 'project:demo');
    setCreatedAt(newerButAfter, '2026-08-10 10:00:00');

    const ev = insertEntity('commit-mid', 'commit');
    insertTag(ev, 'project:demo');
    setCreatedAt(ev, '2026-08-05 10:00:00');

    backfillRelations({});
    // The evidence sits between the two work nodes in time: it must link to
    // `older-plan` (current at capture time), never to the node created after.
    const toOlder = db.prepare(
      "SELECT * FROM relations WHERE from_entity_id=? AND to_entity_id=? AND relation_type='evidences'"
    ).get(ev, older);
    const toNewer = db.prepare(
      "SELECT * FROM relations WHERE from_entity_id=? AND to_entity_id=? AND relation_type='evidences'"
    ).get(ev, newerButAfter);
    expect(toOlder).toBeTruthy();
    expect(toNewer).toBeFalsy();
  });

  it('R5: session match wins over the project fallback and respects maxEdgesPerSource', () => {
    const ev = insertEntity('insight-cap', 'session-insight');
    insertTag(ev, 'session:sess-cap');
    insertTag(ev, 'project:demo');
    // Four session-matched work nodes; cap is 3.
    for (let i = 0; i < 4; i++) {
      const w = insertEntity(`decision-cap-${i}`, 'decision');
      insertTag(w, 'session:sess-cap');
    }
    // A project-only work node that must NOT be linked (session match exists).
    const fallbackOnly = insertEntity('fallback-plan', 'plan');
    insertTag(fallbackOnly, 'project:demo');
    setCreatedAt(fallbackOnly, '2020-01-01 00:00:00');

    const result = backfillRelations({ maxEdgesPerSource: 3 });
    expect(result.byRule.evidenceLinks).toBe(3);
    const toFallback = db.prepare(
      "SELECT * FROM relations WHERE from_entity_id=? AND to_entity_id=? AND relation_type='evidences'"
    ).get(ev, fallbackOnly);
    expect(toFallback).toBeFalsy();
  });

  it('R5: runs even when there are zero orphans (linked evidence still counts)', () => {
    const ev = insertEntity('insight-linked', 'session-insight');
    insertTag(ev, 'session:sess-orph');
    const work = insertEntity('decision-orph', 'decision');
    insertTag(work, 'session:sess-orph');
    // Give BOTH endpoints an unrelated edge so the graph has no orphans at
    // all — the old early-return would have skipped Rule 5 entirely.
    const other = insertEntity('other-node', 'knowledge');
    insertRelation(ev, other, 'related-to');
    insertRelation(work, other, 'related-to');

    const result = backfillRelations({});
    expect(result.byRule.evidenceLinks).toBe(1);
  });

  it('R5: second run writes nothing new (no-outgoing-edge filter + INSERT OR IGNORE)', () => {
    const ev = insertEntity('insight-idem', 'session-insight');
    insertTag(ev, 'session:sess-idem');
    const work = insertEntity('decision-idem', 'decision');
    insertTag(work, 'session:sess-idem');

    const run1 = backfillRelations({});
    expect(run1.byRule.evidenceLinks).toBe(1);
    const run2 = backfillRelations({});
    expect(run2.byRule.evidenceLinks).toBe(0);
    expect(run2.candidatesProposed).toBe(0);
  });

  it('R5: includeEvidenceLinks:false disables the rule', () => {
    const ev = insertEntity('insight-off', 'session-insight');
    insertTag(ev, 'session:sess-off');
    const work = insertEntity('decision-off', 'decision');
    insertTag(work, 'session:sess-off');

    const result = backfillRelations({ includeEvidenceLinks: false });
    expect(result.byRule.evidenceLinks).toBe(0);
    const rel = db.prepare("SELECT COUNT(*) AS c FROM relations WHERE relation_type='evidences'").get() as { c: number };
    expect(rel.c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task A2: Pure-function unit tests for tokenizeName + jaccardSimilarity
// ---------------------------------------------------------------------------

describe('tokenizeName — content token extraction', () => {
  it('lowercases and splits on non-word chars, removes stopwords', () => {
    // 'fix' is a stopword; 'auth' and 'flow' are content tokens
    expect(tokenizeName('Auth-Flow Fix')).toEqual(new Set(['auth', 'flow']));
  });

  it('filters tokens shorter than 3 chars', () => {
    expect(tokenizeName('io vs go')).toEqual(new Set([]));
  });

  it('removes stopwords', () => {
    expect(tokenizeName('fix the auth bug')).toEqual(new Set(['auth', 'bug']));
  });

  it('handles empty string', () => {
    expect(tokenizeName('')).toEqual(new Set());
  });

  it('splits on underscores (non-word boundary)', () => {
    expect(tokenizeName('session_auth_handler')).toEqual(new Set(['session', 'auth', 'handler']));
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical sets', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1.0);
  });

  it('returns 0.0 for disjoint sets', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0.0);
  });

  it('computes partial overlap correctly', () => {
    // intersection={auth,flow}, union={auth,flow,memesh,session} → 2/4 = 0.5
    const a = new Set(['auth', 'flow', 'memesh']);
    const b = new Set(['auth', 'flow', 'session']);
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5);
  });

  it('returns 0.0 when either set is empty', () => {
    expect(jaccardSimilarity(new Set(), new Set(['a']))).toBe(0.0);
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0.0);
  });
});
