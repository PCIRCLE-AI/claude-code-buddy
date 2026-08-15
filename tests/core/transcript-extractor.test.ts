// transcript-extractor — extraction half of the transcript source (Task #18,
// B2). The LLM is stubbed via a fetch spy (same pattern as dreamer.test.ts):
// no real API call ever leaves this suite. DB tests use a per-test temp
// MEMESH_DB_PATH/MEMESH_DIR so the developer's real ~/.memesh is untouched;
// scan tests point CLAUDE_PROJECTS_DIR at a temp dir so the real
// ~/.claude/projects is never read.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseConversation,
  countConversationTurns,
  buildExtractionPrompt,
  extractMemoriesFromTranscript,
  stageTranscriptProposals,
  runTranscriptSource,
  containsSecret,
  scrubSecrets,
  ORDERING_INSTRUCTION,
  findDuplicateEntity,
  TRANSCRIPT_DEDUP_MAX_DISTANCE,
  type ConversationTurn,
} from '../../src/core/transcript-extractor.js';
import { projectTranscriptSlug } from '../../src/core/transcript-source.js';
import { entityEmbedText } from '../../src/core/embedder.js';

const FAKE_LLM = { provider: 'anthropic' as const, apiKey: 'test-key-fake', model: 'claude-haiku-4-5' };

// A credential-SHAPED but non-real value for the secret-detection tests,
// ASSEMBLED from fragments so no contiguous `sk-ant-…` literal sits in the
// source (T1: no credential-shaped literals in fixtures; GitHub push protection
// blocks them). The runtime value still trips containsSecret's `sk-ant-` shape.
const FAKE_ANTHROPIC_KEY = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOP1234567890'].join('-');

/** Anthropic-shaped success response carrying `text` as the model output. */
function stubLLM(text: string): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    ({ ok: true, json: async () => ({ content: [{ text }] }) }) as any,
  );
}

/** Write a JSONL transcript from a list of {type, content} entries. */
function writeTranscript(dir: string, sessionId: string, entries: Array<{ type: string; content: unknown }>): string {
  const path = join(dir, `${sessionId}.jsonl`);
  const lines = entries.map((e) => JSON.stringify({ type: e.type, message: { role: e.type, content: e.content } }));
  writeFileSync(path, lines.join('\n') + '\n');
  const now = Date.now();
  utimesSync(path, new Date(now), new Date(now));
  return path;
}

// A conversation that states X ("library A") then reverses to not-X
// ("library B") — the contradiction fixture.
const CONTRADICTION_ENTRIES = [
  { type: 'user', content: "Let's use library A for parsing the transcripts." },
  { type: 'assistant', content: [{ type: 'text', text: "Sounds good, going with library A." }] },
  { type: 'user', content: 'Actually, library A cannot stream. Switch to library B instead.' },
  { type: 'assistant', content: [{ type: 'text', text: 'Correct — abandoning library A. We now use library B for parsing.' }] },
];

describe('transcript-extractor: parsing', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'memesh-tx-parse-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('extracts user prose + assistant text/thinking, skips tool + command noise, keeps chronological order', () => {
    const path = writeTranscript(tmp, 'sess', [
      { type: 'user', content: 'First user message' },
      { type: 'assistant', content: [
        { type: 'thinking', thinking: 'reasoning about the choice' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        { type: 'text', text: 'Assistant reply' },
      ] },
      { type: 'user', content: [{ type: 'tool_result', content: 'tool output noise' }] },
      { type: 'user', content: '<local-command-stdout>scaffolding</local-command-stdout>' },
      { type: 'user', content: 'Second user message' },
    ]);
    const turns = parseConversation(path);
    expect(turns.map((t) => `${t.role}:${t.text}`)).toEqual([
      'user:First user message',
      'assistant:reasoning about the choice',
      'assistant:Assistant reply',
      'user:Second user message',
    ]);
  });

  it('countConversationTurns is a cheap turn count and never throws on a missing file', () => {
    const path = writeTranscript(tmp, 'sess2', CONTRADICTION_ENTRIES);
    expect(countConversationTurns(path)).toBe(4);
    expect(countConversationTurns(join(tmp, 'does-not-exist.jsonl'))).toBe(0);
  });
});

describe('transcript-extractor: contradiction guard (prompt-level control)', () => {
  // The guard is a time-ordered prompt: with an LLM that is where correctness
  // lives. These tests pin that the ordering instruction is PRESENT and the
  // turns are CHRONOLOGICAL. They do not claim to prove model compliance
  // against a stub — that would be a fixture restating the assertion.
  const turns: ConversationTurn[] = CONTRADICTION_ENTRIES.map((e) => ({
    role: e.type as 'user' | 'assistant',
    text: typeof e.content === 'string' ? e.content : (e.content as Array<{ text: string }>)[0].text,
  }));

  it('carries the ordering instruction and presents turns chronologically (X before not-X)', () => {
    const prompt = buildExtractionPrompt(turns, 'memesh');
    // The break-test target: remove ORDERING_INSTRUCTION from
    // buildExtractionPrompt and this assertion goes red.
    expect(prompt).toContain(ORDERING_INSTRUCTION);
    // The reversal ("library B") must appear AFTER the original claim
    // ("library A") — a scrambled order would defeat the guard.
    const firstA = prompt.indexOf('library A');
    const firstB = prompt.indexOf('library B');
    expect(firstA).toBeGreaterThanOrEqual(0);
    expect(firstB).toBeGreaterThan(firstA);
  });
});

describe('transcript-extractor: extraction pipeline', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'memesh-tx-extract-')); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(tmp, { recursive: true, force: true }); });

  it('returns the durable memory the (stubbed) model emits', async () => {
    const path = writeTranscript(tmp, 'sess', CONTRADICTION_ENTRIES);
    stubLLM(JSON.stringify([
      { name: 'parser-choice', type: 'decision', observations: ['Chose library B for parsing because library A cannot stream.'], tags: ['parsing'] },
    ]));
    const res = await extractMemoriesFromTranscript(path, FAKE_LLM);
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0].type).toBe('decision');
    expect(res.memories[0].observations[0]).toContain('library B');
    expect(res.secretsDropped).toBe(0);
    expect(res.llmCalls).toBe(1);
    expect(res.parseFailures).toBe(0);
  });

  it('coerces an off-enum / misspelled type to the contract set (compaction-protection guarantee)', async () => {
    // The model returns a type outside {decision, lesson_learned, fact}. If it
    // were stored verbatim, an accepted `insight`/`Decision`/`lesson` entity
    // would fall outside dreamer's PROTECTED_TYPES and silently become
    // compaction-eligible. Each must be coerced.
    const path = writeTranscript(tmp, 'sess', CONTRADICTION_ENTRIES);
    stubLLM(JSON.stringify([
      { name: 'a', type: 'insight', observations: ['off-enum type'], tags: [] },
      { name: 'b', type: 'Decision', observations: ['cased variant'], tags: [] },
      { name: 'c', type: 'lesson', observations: ['near-miss of lesson_learned'], tags: [] },
      { name: 'd', type: 'decisions', observations: ['pluralised protected type'], tags: [] },
      { name: 'e', type: 'lessons learned', observations: ['pluralised, spaced'], tags: [] },
    ]));
    const res = await extractMemoriesFromTranscript(path, FAKE_LLM);
    const byName = Object.fromEntries(res.memories.map((m) => [m.name, m.type]));
    // Break-test: drop coerceCandidateType's fallback and `a` stays 'insight' → red.
    expect(byName.a).toBe('fact');       // unknown → fact
    expect(byName.b).toBe('decision');   // case-normalised into the set
    expect(byName.c).toBe('lesson_learned'); // 'lesson' mapped to the protected type
    // Plurals must map to the PROTECTED type, not fall through to 'fact' — that
    // fall-through was a silent downgrade out of PROTECTED_TYPES. Break-test:
    // remove the aliases and `d`/`e` become 'fact' → red.
    expect(byName.d).toBe('decision');
    expect(byName.e).toBe('lesson_learned');
  });

  it('a truncated / unparseable reply is a parseFailure, NOT a silent "no memories" (absence != evidence)', async () => {
    // The model's JSON array is cut off mid-object (what maxTokens truncation
    // produces): an opener with no balanced closer. extractJsonBlock returns
    // null, so the chunk's memories are lost — but this MUST be reported as a
    // retryable parse failure, not counted as a successful empty session.
    const path = writeTranscript(tmp, 'sess', CONTRADICTION_ENTRIES);
    stubLLM('[{"name":"parser-choice","type":"decision","observations":["Chose library B because library A cannot');
    const res = await extractMemoriesFromTranscript(path, FAKE_LLM);
    expect(res.memories).toHaveLength(0);
    expect(res.llmCalls).toBe(1);
    expect(res.llmFailures).toBe(0);   // the call SUCCEEDED — it just returned garbage
    // Break-test: make parseMemories return [] without the parseFailed flag and
    // this goes red — the loss would read as a clean empty session.
    expect(res.parseFailures).toBe(1);
  });

  it('a valid EMPTY array is a real "nothing found", not a parse failure', async () => {
    const path = writeTranscript(tmp, 'sess', CONTRADICTION_ENTRIES);
    stubLLM('[]');
    const res = await extractMemoriesFromTranscript(path, FAKE_LLM);
    expect(res.memories).toHaveLength(0);
    expect(res.parseFailures).toBe(0); // `[]` parsed fine — the model found nothing
  });

  it('drops a candidate whose observation carries a detected secret', async () => {
    const path = writeTranscript(tmp, 'sess', CONTRADICTION_ENTRIES);
    stubLLM(JSON.stringify([
      { name: 'leaky', type: 'fact', observations: [`The deploy key is ${FAKE_ANTHROPIC_KEY}`], tags: [] },
      { name: 'clean', type: 'fact', observations: ['The parser lives in src/core.'], tags: [] },
    ]));
    const res = await extractMemoriesFromTranscript(path, FAKE_LLM);
    // The break-test target: remove the memoryHasSecret drop and the leaky
    // candidate survives — this length assertion goes red.
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0].name).toBe('clean');
    expect(res.secretsDropped).toBe(1);
  });

  it('scrubSecrets redacts on the way out; containsSecret detects on the way in', () => {
    const raw = `token is ${FAKE_ANTHROPIC_KEY} here`;
    expect(containsSecret(raw)).toBe(true);
    const scrubbed = scrubSecrets(raw);
    expect(scrubbed).toContain('[REDACTED-SECRET]');
    // The placeholder must NOT itself trip the detector, or a scrubbed turn
    // would be dropped for carrying a "secret" that is only a placeholder.
    expect(containsSecret(scrubbed)).toBe(false);
  });

  // Every broadened secret shape (finding #1). Kept as one table so the
  // invariant — detected on the way in, gone after scrub — is asserted for
  // ALL of them, not one.
  //
  // Each value is ASSEMBLED from fragments at runtime (`j`) so no contiguous
  // secret-shaped literal sits in the source file. That is deliberate: a
  // literal `sk_live_…` here is a realistic-looking credential, which the T1
  // fixture rule forbids and GitHub push-protection blocks (it flagged exactly
  // this line). The runtime string is identical, so the detector is exercised
  // the same way — only the on-disk representation changes.
  const j = (...parts: string[]) => parts.join('');
  const BODY16 = 'ABCDEFGHIJKLMNOP1234567890';
  const SECRET_SAMPLES: Array<[string, string]> = [
    ['PEM block', j('-----BEGIN RSA PRIVATE KEY', '-----\n', 'MIIEpAIBAAKCAQEA', 'FAKEBASE64BODYabcdefghijklmnop0123456789\n', 'Q2hlY2tUaGlzSXNOb3RSZWFsCg==\n', '-----END RSA PRIVATE KEY', '-----')],
    ['postgres URL creds', j('postgres://admin:', 's3cretPassw0rd', '@db.internal.example.com:5432/app')],
    ['mongodb+srv URL creds', j('mongodb+srv://svc:', 'hunter2hunter2', '@cluster0.abc.mongodb.net/db')],
    ['JWT', j('eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5Nqr7xY9zAbCdEf')],
    ['SendGrid', j('SG', '.', 'ABCDEFGHIJKLMNOPQRSTUV', '.', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab')],
    ['Stripe live', j('sk', '_live_', BODY16)],
    ['generic sk_ underscore', j('sk', '_', BODY16)],
    ['npm token', j('npm', '_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')],
  ];

  it('detects every broadened secret shape and scrubbing removes it (invariant)', () => {
    for (const [label, sample] of SECRET_SAMPLES) {
      expect(containsSecret(sample), `${label}: should be detected`).toBe(true);
      const scrubbed = scrubSecrets(`prefix ${sample} suffix`);
      // The break-test target for finding #1: narrow SECRET_SOURCES back to the
      // old 6-pattern list and these go red for the new shapes.
      expect(containsSecret(scrubbed), `${label}: must be gone after scrub`).toBe(false);
      expect(scrubbed).toContain('[REDACTED-SECRET]');
    }
    // Ordinary "word:word@word" prose must NOT be treated as a DB-URL secret.
    expect(containsSecret('see foo:bar@baz for details')).toBe(false);
  });

  it('drops every broadened secret shape from staged candidates, keeping the clean one', async () => {
    const path = writeTranscript(tmp, 'sess', CONTRADICTION_ENTRIES);
    const leaky = SECRET_SAMPLES.map(([label, sample], i) => ({
      name: `leaky-${i}`, type: 'fact', observations: [`${label}: ${sample}`], tags: [],
    }));
    stubLLM(JSON.stringify([
      ...leaky,
      { name: 'clean', type: 'fact', observations: ['The parser lives in src/core.'], tags: [] },
    ]));
    const res = await extractMemoriesFromTranscript(path, FAKE_LLM);
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0].name).toBe('clean');
    expect(res.secretsDropped).toBe(SECRET_SAMPLES.length);
  });

  it('scrubs a TRUNCATED PEM (BEGIN with no END) — redacts the body, not just the marker (finding #3)', () => {
    // Assembled from fragments so no credential-shaped literal is on disk.
    const body1 = 'MIIEvQIBADANBgkqFAKEbodyLineOne';
    const body2 = 'MoreFAKEbodyLineTwoABCDEF0123456789';
    const truncatedPem = ['-----BEGIN RSA PRIVATE KEY', '-----\n', body1, '\n', body2, '\n'].join('');
    expect(containsSecret(truncatedPem)).toBe(true);
    const scrubbed = scrubSecrets(`context before\n${truncatedPem}`);
    // The break-test target for finding #3: revert the truncated-PEM pattern to
    // the lone BEGIN-line fallback and the base64 body survives — this goes red.
    expect(scrubbed).not.toContain(body1);
    expect(scrubbed).not.toContain(body2);
    expect(scrubbed).toContain('[REDACTED-SECRET]');
    expect(containsSecret(scrubbed)).toBe(false);
  });

  it('counts tail turns dropped by the size cap so a partial mine is never a silent 0 (finding #1)', async () => {
    // 20 turns; a tiny chunk budget forces one turn per chunk, so only the
    // first MAX_CHUNKS_PER_SESSION (4) are analysed and 16 tail turns are cut.
    const entries = Array.from({ length: 20 }, (_, i) => ({
      type: i % 2 === 0 ? 'user' : 'assistant',
      content: i % 2 === 0
        ? `Turn ${i}: a sentence about the parser decision worth some length.`
        : [{ type: 'text', text: `Turn ${i}: reasoning about the parser decision, some length.` }],
    }));
    const path = writeTranscript(tmp, 'big', entries);
    stubLLM(JSON.stringify([]));
    const res = await extractMemoriesFromTranscript(path, FAKE_LLM, { chunkCharBudget: 80 });
    // The break-test target for finding #1: make chunkTurns return
    // truncatedTurns:0 (drop the counter) and this goes red.
    expect(res.truncatedTurns).toBeGreaterThan(0);
    expect(res.truncatedTurns).toBe(20 - res.llmCalls); // turns analysed == chunks == llmCalls
  });
});

describe('transcript-extractor: staging + apply', () => {
  let tmpHome: string;
  let db: any;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memesh-tx-stage-'));
    process.env.MEMESH_DB_PATH = join(tmpHome, 'graph.db');
    process.env.MEMESH_DIR = tmpHome;
    const dbMod = await import('../../src/db.js');
    db = dbMod.openDatabase(process.env.MEMESH_DB_PATH);
  });
  afterEach(async () => {
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    delete process.env.MEMESH_DB_PATH;
    delete process.env.MEMESH_DIR;
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const session = { sessionId: 'sess-abc', path: '/tmp/sess-abc.jsonl', lineCount: 42 };
  const memories = [
    { name: 'parser-choice', type: 'decision', observations: ['Chose library B for parsing.'], tags: ['parsing'] },
  ];

  it('stages with source_kind=transcript and is idempotent on re-run', () => {
    const first = stageTranscriptProposals(db, session, memories, FAKE_LLM, 'memesh');
    expect(first.created).toBe(1);
    const row = db.prepare("SELECT source_kind, cluster_key, source_ids, prompt_version FROM dream_proposals WHERE status='pending'").get() as any;
    // The break-test target: revert the INSERT's source_kind to the 'entities'
    // default and this assertion goes red.
    expect(row.source_kind).toBe('transcript');
    expect(row.cluster_key).toBe('transcript:sess-abc');
    expect(JSON.parse(row.source_ids).sessionId).toBe('sess-abc');
    expect(row.prompt_version).toBe('transcript-v1');

    // Re-run: same candidate name → deduped, nothing new written.
    const second = stageTranscriptProposals(db, session, memories, FAKE_LLM, 'memesh');
    expect(second.created).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
    const count = db.prepare("SELECT COUNT(*) c FROM dream_proposals").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('dream accept applies a transcript proposal to the KG without throwing', async () => {
    stageTranscriptProposals(db, session, memories, FAKE_LLM, 'memesh');
    const proposalId = (db.prepare("SELECT id FROM dream_proposals WHERE status='pending'").get() as { id: number }).id;

    const { applyProposal } = await import('../../src/core/dreamer.js');
    const { KnowledgeGraph } = await import('../../src/knowledge-graph.js');
    const kg = new KnowledgeGraph(db);

    // The regression this guards: source_ids is a JSON OBJECT, not an id array,
    // so the entities-path `for (const id of sourceIds)` would throw "not
    // iterable". The transcript branch must short-circuit before that.
    const result = applyProposal(db, proposalId, kg);
    expect(result.digestEntityName).toBe('parser-choice');
    expect(result.sourcesArchived).toBe(0);

    const entity = db.prepare("SELECT type, status FROM entities WHERE name = 'parser-choice'").get() as any;
    expect(entity.type).toBe('decision');
    expect(entity.status).toBe('active');
    const applied = db.prepare("SELECT status FROM dream_proposals WHERE id = ?").get(proposalId) as any;
    expect(applied.status).toBe('applied');
  });

  it('a name collision with a TRUSTED entity does not merge into it or make it auto-context-eligible (finding #2)', async () => {
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const { KnowledgeGraph } = await import('../../src/knowledge-graph.js');
    const kg = new KnowledgeGraph(db);

    // A pre-existing TRUSTED entity (default trust) with its OWN, unrelated
    // observation — seed something distinct so any merge is visible.
    kg.createEntity('parser-choice', 'decision', {
      observations: ['TRUSTED original note about the parser'],
      tags: ['project:memesh'],
    });

    // A transcript proposal whose slug name collides with it, carrying
    // DIFFERENT (untrusted) text.
    stageTranscriptProposals(db, session, [
      { name: 'parser-choice', type: 'decision', observations: ['UNTRUSTED transcript claim about the parser'], tags: [] },
    ], FAKE_LLM, 'memesh');
    const proposalId = (db.prepare("SELECT id FROM dream_proposals WHERE status='pending'").get() as { id: number }).id;

    const result = applyProposal(db, proposalId, kg);
    // The break-test target for finding #2: revert applyTranscriptProposal to
    // createEntity(digest.name) and the trusted row gains the untrusted obs
    // (and no separate entity exists) → these assertions go red.
    expect(result.digestEntityName).not.toBe('parser-choice'); // collision-suffixed
    expect(result.digestEntityName).toContain('transcript #');

    // The original trusted entity is UNTOUCHED: still exactly one observation,
    // its own, and no transcript metadata making it auto-context-eligible.
    const trustedId = (db.prepare("SELECT id FROM entities WHERE name = 'parser-choice'").get() as { id: number }).id;
    const trustedObs = db.prepare('SELECT content FROM observations WHERE entity_id = ?').all(trustedId) as Array<{ content: string }>;
    expect(trustedObs.map((o) => o.content)).toEqual(['TRUSTED original note about the parser']);
    const trustedMeta = JSON.parse((db.prepare('SELECT metadata FROM entities WHERE id = ?').get(trustedId) as { metadata: string }).metadata);
    expect(trustedMeta.source_kind).toBeUndefined();
    expect(trustedMeta.trust).not.toBe('untrusted');

    // The transcript memory landed in its OWN, untrusted entity.
    const newRow = db.prepare('SELECT metadata FROM entities WHERE name = ?').get(result.digestEntityName) as { metadata: string } | undefined;
    expect(newRow).toBeDefined();
    const newMeta = JSON.parse(newRow!.metadata);
    // The separation is the guard, not the trust marker: transcript text must
    // land in its OWN row rather than inheriting an existing entity's identity
    // and observations. (Auto-context eligibility now follows human
    // acceptance — see tests/core/accepted-proposal-trust.test.ts — so the
    // former `trust: 'untrusted'` assertion here would pin a policy this row
    // no longer carries, while proving nothing about the merge.)
    expect(newMeta.source_kind).toBe('transcript');
    expect(newMeta.proposal_id).toBe(proposalId);
  });

  it('dream show returns the FULL digest — all observations, not a 120-char preview (finding #1)', async () => {
    const { getProposalDetail } = await import('../../src/core/dreamer.js');
    stageTranscriptProposals(db, session, [
      {
        name: 'multi-obs',
        type: 'lesson_learned',
        observations: [
          'First observation, long enough to exceed any preview: ' + 'x'.repeat(150),
          'Second observation — invisible to a first-observation preview.',
          'Third observation — also invisible to `dream list`.',
        ],
        tags: ['a', 'b'],
      },
    ], FAKE_LLM, 'memesh');
    const proposalId = (db.prepare("SELECT id FROM dream_proposals WHERE status='pending'").get() as { id: number }).id;

    const detail = getProposalDetail(db, proposalId);
    expect(detail).not.toBeNull();
    expect(detail!.source_kind).toBe('transcript');
    // ALL observations, in full — the whole point of `dream show`.
    expect(detail!.digest.observations).toHaveLength(3);
    expect(detail!.digest.observations[1]).toContain('Second observation');
    expect(detail!.digest.observations[2]).toContain('Third observation');
    expect(getProposalDetail(db, 999999)).toBeNull();
  });
});

describe('transcript-extractor: session-level contradiction guard across chunks (finding #3)', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'memesh-tx-chunk-')); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(tmp, { recursive: true, force: true }); });

  it('carries prior-chunk decisions into later chunks\' prompts, so a reversal can override', async () => {
    // Enough turns that a small budget forces multiple chunks.
    const entries = Array.from({ length: 6 }, (_, i) => ({
      type: i % 2 === 0 ? 'user' : 'assistant',
      content: i % 2 === 0
        ? `Turn ${i}: discussing the parser library decision in detail here.`
        : [{ type: 'text', text: `Turn ${i}: reasoning about the parser library decision here.` }],
    }));
    const path = writeTranscript(tmp, 'sess', entries);

    // Capture every outgoing prompt body; return a decision each call so the
    // rolling summary gets populated after chunk 1.
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init: any) => {
      bodies.push(String(init?.body ?? ''));
      return { ok: true, json: async () => ({ content: [{ text: JSON.stringify([
        { name: 'use-lib-A', type: 'decision', observations: ['Chose library A over library B'], tags: [] },
      ]) }] }) } as any;
    });

    // Tiny per-chunk budget forces one turn per chunk (multi-chunk).
    const res = await extractMemoriesFromTranscript(path, FAKE_LLM, { chunkCharBudget: 80, project: 'memesh' });
    expect(res.llmCalls).toBeGreaterThanOrEqual(2); // actually chunked

    // First chunk has no prior context; later chunks MUST carry the rolling
    // summary of what chunk 1 decided. The break-test target for finding #3:
    // revert to per-chunk (stop threading priorDecisions) and the later prompt
    // no longer contains the prior decision → this goes red.
    expect(bodies[0]).not.toContain('<prior_decisions>');
    expect(bodies[1]).toContain('<prior_decisions>');
    expect(bodies[1]).toContain('use-lib-A');
    expect(bodies[1]).toContain('library A over library B');
  });
});

describe('transcript-extractor: orchestrator end-to-end', () => {
  let tmpHome: string;
  let projectsDir: string;
  let prevProjects: string | undefined;
  let db: any;
  const cwd = '/proj/memesh-fixture';

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memesh-tx-run-'));
    projectsDir = mkdtempSync(join(tmpdir(), 'memesh-tx-projects-'));
    prevProjects = process.env.CLAUDE_PROJECTS_DIR;
    process.env.CLAUDE_PROJECTS_DIR = projectsDir;
    process.env.MEMESH_DB_PATH = join(tmpHome, 'graph.db');
    process.env.MEMESH_DIR = tmpHome;
    const dbMod = await import('../../src/db.js');
    db = dbMod.openDatabase(process.env.MEMESH_DB_PATH);
  });
  afterEach(async () => {
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    if (prevProjects === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
    else process.env.CLAUDE_PROJECTS_DIR = prevProjects;
    delete process.env.MEMESH_DB_PATH;
    delete process.env.MEMESH_DIR;
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(projectsDir, { recursive: true, force: true });
  });

  function seedSessionFile(): void {
    const dir = join(projectsDir, projectTranscriptSlug(cwd));
    mkdirSync(dir, { recursive: true });
    writeTranscript(dir, 'sess-run', CONTRADICTION_ENTRIES);
  }

  it('scans → extracts → stages, and is idempotent on re-run', async () => {
    seedSessionFile();
    stubLLM(JSON.stringify([
      { name: 'parser-choice', type: 'decision', observations: ['Chose library B for parsing.'], tags: ['parsing'] },
    ]));
    const res = await runTranscriptSource(db, FAKE_LLM, { cwd, windowDays: 3 });
    expect(res.sessionsScanned).toBe(1);
    expect(res.proposalsCreated).toBe(1);
    expect(res.candidatesExtracted).toBe(1);
    const row = db.prepare("SELECT source_kind FROM dream_proposals WHERE status='pending'").get() as any;
    expect(row.source_kind).toBe('transcript');

    // Re-run: dedup against the pending proposal — nothing new.
    const res2 = await runTranscriptSource(db, FAKE_LLM, { cwd, windowDays: 3 });
    expect(res2.proposalsCreated).toBe(0);
    expect(res2.duplicatesSkipped).toBe(1);
  });

  it('B3: an injected embedder drives runTranscriptSource to dedup against an already-accepted entity (accept → re-run → skip)', async () => {
    // Coverage for the widened gate: runTranscriptSource used to run B3 vector
    // dedup only `if (isEmbeddingAvailable())`, which is always false under a
    // test HOME with no provider — so the whole orchestrator→findDuplicateEntity
    // →nearDuplicatesSkipped path was unreachable end-to-end. The gate now also
    // fires on an injected `opts.dedup.embed`. Here we stand in for the
    // post-`dream accept` state (the memory is already an entity WITH a vector),
    // then re-run and prove the transcript candidate is dropped as a near-dup.
    seedSessionFile();
    stubLLM(JSON.stringify([
      { name: 'parser-choice', type: 'decision', observations: ['Chose library B for parsing.'], tags: ['parsing'] },
    ]));

    const { getProjectName } = await import('../../src/core/paths.js');
    const { KnowledgeGraph } = await import('../../src/knowledge-graph.js');
    const projectLabel = getProjectName(cwd);
    const kg = new KnowledgeGraph(db);
    const acceptedId = kg.createEntity('parser-choice', 'decision', {
      observations: ['Chose library B for parsing.'],
      tags: [`project:${projectLabel}`, 'parsing'],
    });
    const dimRow = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get() as { value: string } | undefined;
    const dim = dimRow ? parseInt(dimRow.value, 10) : 384;
    const unitVec = (cos: number) => {
      const v = new Float32Array(dim);
      v[0] = cos;
      v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
      return v;
    };
    // Seed the accepted entity's vector at e0 = [1,0,…].
    const atE0 = unitVec(1);
    db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(
      BigInt(acceptedId), Buffer.from(atE0.buffer, atE0.byteOffset, atE0.byteLength),
    );

    // Injected embedder places the extracted candidate 0.30 from the accepted
    // entity — inside TRANSCRIPT_DEDUP_MAX_DISTANCE (0.44) — and, being present,
    // flips the widened gate ON. That gate line is what this test exists to cover.
    const cosFor = (d: number) => 1 - (d * d) / 2;
    const embed = async () => unitVec(cosFor(0.30));

    const res = await runTranscriptSource(db, FAKE_LLM, { cwd, windowDays: 3, dedup: { embed } });
    expect(res.candidatesExtracted).toBe(1);
    expect(res.nearDuplicatesSkipped).toBe(1);
    expect(res.proposalsCreated).toBe(0);
    // Break-test: revert the gate to `if (isEmbeddingAvailable())` and this goes
    // red — the B3 branch is skipped, so nothing is deduped: proposalsCreated
    // becomes 1 and nearDuplicatesSkipped 0.
  });

  it('surfaces per-session size-cap truncation up to the orchestrator result (finding #1)', async () => {
    const dir = join(projectsDir, projectTranscriptSlug(cwd));
    mkdirSync(dir, { recursive: true });
    const entries = Array.from({ length: 20 }, (_, i) => ({
      type: i % 2 === 0 ? 'user' : 'assistant',
      content: i % 2 === 0
        ? `Turn ${i}: a sentence about the parser decision worth some length.`
        : [{ type: 'text', text: `Turn ${i}: reasoning about the parser decision, some length.` }],
    }));
    writeTranscript(dir, 'sess-big', entries);
    stubLLM(JSON.stringify([]));
    const res = await runTranscriptSource(db, FAKE_LLM, { cwd, windowDays: 3, chunkCharBudget: 80 });
    expect(res.truncatedTurns).toBeGreaterThan(0);
    expect(res.truncatedSessions.map((t) => t.sessionId)).toContain('sess-big');
  });

  it('reports an LLM outage distinctly, NOT as "no durable memories" (absence != evidence)', async () => {
    seedSessionFile();
    // Every call fails (network down). The session must be reported as an
    // outage, never as "nothing worth remembering".
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('network down'); });
    const res = await runTranscriptSource(db, FAKE_LLM, { cwd, windowDays: 3 });
    expect(res.proposalsCreated).toBe(0);
    expect(res.llmFailures).toBeGreaterThan(0);
    expect(res.skipped.some((s) => s.reason.includes('LLM call(s) failed'))).toBe(true);
    expect(res.skipped.some((s) => s.reason === 'no durable memories extracted')).toBe(false);
  });

  it('reports a truncated/unparseable reply as retryable, NOT "no durable memories"', async () => {
    seedSessionFile();
    // Call succeeds but returns a cut-off array — memories lost, must be retryable.
    stubLLM('[{"name":"x","type":"decision","observations":["chose B because A cannot');
    const res = await runTranscriptSource(db, FAKE_LLM, { cwd, windowDays: 3 });
    expect(res.proposalsCreated).toBe(0);
    expect(res.parseFailures).toBeGreaterThan(0);
    expect(res.skipped.some((s) => /could not be parsed/.test(s.reason))).toBe(true);
    expect(res.skipped.some((s) => s.reason === 'no durable memories extracted')).toBe(false);
  });

  it('respects --max-llm-calls (0 budget → no LLM call, no proposal)', async () => {
    seedSessionFile();
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await runTranscriptSource(db, FAKE_LLM, { cwd, windowDays: 3, maxLlmCalls: 0 });
    expect(res.proposalsCreated).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips cleanly with no LLM configured (never touches the KG)', async () => {
    seedSessionFile();
    const res = await runTranscriptSource(db, null, { cwd, windowDays: 3 });
    expect(res.proposalsCreated).toBe(0);
    expect(res.skipped.some((s) => s.reason.includes('no LLM configured'))).toBe(true);
  });
});

// =============================================================================
// B3 — vector dedup against EXISTING (accepted / manually-remembered) entities
// =============================================================================
// These tests drive findDuplicateEntity with an INJECTED embedder (so the
// distance is exact and deterministic) but the REAL vectorSearch against a real
// entities_vec — vectors are inserted with the same statement embedAndStore
// uses, so sqlite-vec computes the real L2 and the break-tests exercise
// production code, not a double.
describe('transcript-extractor: B3 vector dedup (findDuplicateEntity)', () => {
  let tmpHome: string;
  let db: any;
  let dim: number;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memesh-tx-dedup-'));
    process.env.MEMESH_DB_PATH = join(tmpHome, 'graph.db');
    process.env.MEMESH_DIR = tmpHome;
    const dbMod = await import('../../src/db.js');
    db = dbMod.openDatabase(process.env.MEMESH_DB_PATH);
    // The vector width entities_vec was actually created with, so the inserted
    // blobs and the injected embeddings match the table (no hardcoded 384).
    const row = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get() as { value: string } | undefined;
    dim = row ? parseInt(row.value, 10) : 384;
  });
  afterEach(async () => {
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    delete process.env.MEMESH_DB_PATH;
    delete process.env.MEMESH_DIR;
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** A unit vector whose dot product with e0 = [1,0,0,…] is `cos`, so the L2
   * distance between them is sqrt(2 - 2·cos). Lets a test dial an exact
   * distance. */
  function unitVec(cos: number): Float32Array {
    const v = new Float32Array(dim);
    v[0] = cos;
    v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
    return v;
  }
  /** The cos that yields a target L2 distance between unit vectors. */
  const cosFor = (distance: number) => 1 - (distance * distance) / 2;
  /** Insert a vector at an entity's rowid — the exact statement embedAndStore
   * uses, so the real vectorSearch computes a real distance against it. */
  function insertVec(entityId: number, vec: Float32Array): void {
    db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(
      BigInt(entityId),
      Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
    );
  }
  async function seedEntity(name: string, projectTag: string, atCos: number): Promise<number> {
    const { KnowledgeGraph } = await import('../../src/knowledge-graph.js');
    const kg = new KnowledgeGraph(db);
    const id = kg.createEntity(name, 'fact', { observations: [`obs for ${name}`], tags: [projectTag] });
    insertVec(id, unitVec(atCos));
    return id;
  }
  const candidate = { name: 'cand', type: 'fact', observations: ['a candidate memory'], tags: [] };

  it('skips a candidate that duplicates an EXISTING same-project entity', async () => {
    // Existing entity sits at e0; candidate embeds 0.30 away — well inside 0.55.
    await seedEntity('existing-memory', 'project:memesh', 1.0);
    const embed = async () => unitVec(cosFor(0.30));
    const hit = await findDuplicateEntity(db, candidate, 'memesh', { embed });
    expect(hit).not.toBeNull();
    expect(hit!.matchedEntityName).toBe('existing-memory');
    expect(hit!.distance).toBeCloseTo(0.30, 2);
  });

  it('stages a genuinely-distinct candidate (returns null)', async () => {
    // Existing entity at e0; candidate a full 1.0 away — clearly not the same
    // memory. Break-test target: invert the `<=` comparison in
    // findDuplicateEntity and this distinct candidate gets DROPPED → red.
    await seedEntity('existing-memory', 'project:memesh', 1.0);
    const embed = async () => unitVec(cosFor(1.0));
    const hit = await findDuplicateEntity(db, candidate, 'memesh', { embed });
    expect(hit).toBeNull();
  });

  it('conservative bias: a BORDERLINE pair just beyond the threshold is treated as distinct (staged, not dropped)', async () => {
    await seedEntity('existing-memory', 'project:memesh', 1.0);
    // 0.50 sits just ABOVE the 0.44 cut — the false-negative side. It must be
    // STAGED (null), never silently dropped: re-proposing a maybe-dup is the
    // safe error, dropping a maybe-new-memory is not. It is also inside the
    // 0.44…0.53 band where real duplicates and real distinct memories overlap,
    // which is exactly the region a human, not a number, should judge.
    const borderline = async () => unitVec(cosFor(0.50));
    expect(await findDuplicateEntity(db, candidate, 'memesh', { embed: borderline })).toBeNull();
    // And a pair just BELOW the cut is caught — proving 0.50 was rejected by the
    // threshold, not by a broken query.
    const justInside = async () => unitVec(cosFor(0.40));
    expect(await findDuplicateEntity(db, candidate, 'memesh', { embed: justInside })).not.toBeNull();
    // Guard the documented constant so a silent bump can't widen the drop zone.
    // 0.44 is the measured false-positive floor on a real graph — see the
    // constant's comment. It was 0.55, taken from a synthetic fixture that put
    // the floor 0.22 too high.
    expect(TRANSCRIPT_DEDUP_MAX_DISTANCE).toBe(0.44);
  });

  it('does NOT treat another project\'s entity as a duplicate (entities_vec is one table for the whole DB)', async () => {
    // The nearest vector belongs to a DIFFERENT project. A raw vector hit would
    // call it a duplicate and silently drop the candidate — cross-project data
    // loss. The recall-path hydration (project tag + archived excluded) must
    // exclude it. Break-test target: drop the getEntitiesByIds scoping and this
    // goes red (the candidate is wrongly deduped).
    await seedEntity('other-project-memory', 'project:OTHER', 1.0);
    const embed = async () => unitVec(cosFor(0.20)); // very close, but wrong project
    const hit = await findDuplicateEntity(db, candidate, 'memesh', { embed });
    expect(hit).toBeNull();
  });

  it('fails OPEN: an embed outage stages the candidate rather than dropping it', async () => {
    await seedEntity('existing-memory', 'project:memesh', 1.0);
    const embed = async () => { throw new Error('embedder down'); };
    expect(await findDuplicateEntity(db, candidate, 'memesh', { embed })).toBeNull();
  });

  it('entityEmbedText matches the runtime builder (name + observations)', () => {
    expect(entityEmbedText('n', ['a', 'b'])).toBe('n a b');
  });
});
