/**
 * D6: `memesh doctor`'s Vector Index WARN told every reader to
 * "Run 'memesh reindex' to fix" — but `memesh reindex` refuses (exit 1,
 * "Nothing was rebuilt: no embedding provider is configured") on a fresh
 * Core-mode install, which is the DEFAULT: the first `remember` calls create
 * entities with no vector, and Core mode has no embedder configured by
 * design. The WARN was accurate; its one-line fix was not self-sufficient,
 * and this combination fires for nearly every new user.
 *
 * The fix line must name the prerequisite — configure an embedder first —
 * whenever `capabilities.embeddings === 'tfidf'`, the same predicate
 * `inspectEmbeddingProbe` already uses to report "no embedder configured".
 * When an embedder IS configured, the original one-line fix is still
 * correct and must not change.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/core/doctor.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const dbHandle = useTestDatabase('memesh-doctor-vector-fix-');

function doctor(embeddings: 'tfidf' | 'ollama') {
  return runDoctor({
    packageRoot: process.cwd(),
    packageVersion: 'test',
    openDatabaseImpl: () => getDatabase(),
    closeDatabaseImpl: () => undefined,
    isDatabaseOpenImpl: () => true,
    detectCapabilitiesImpl: () => ({ searchLevel: embeddings === 'tfidf' ? 0 : 1, embeddings, llm: null }) as never,
    getConfigPathImpl: () => path.join(dbHandle.tmpDir, 'config.json'),
    getUpdateCheckImpl: async () => ({ checkSucceeded: true, updateAvailable: false }) as never,
    getCurrentInstallChannelImpl: () => 'npm-global',
    getInstallChannelSupportImpl: () => ({ label: 'npm global', canSelfUpdate: false }) as never,
    nativeBindingProbeImpl: () => ({ ok: true }),
    resolveShellMemeshImpl: () => null,
  });
}

describe('doctor: vector_index fix names the missing embedder', () => {
  it('tells a Core-mode (no embedder) install to configure one before reindexing', async () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('note-without-vector', 'note', { observations: ['hello world'] });

    const result = await doctor('tfidf');
    const row = result.checks.find((c) => c.id === 'vector_index');
    expect(row?.status, row?.summary).toBe('warn');
    expect(row?.fix).toMatch(/no embedder is configured/i);
    expect(row?.fix).toContain('memesh config set embedder.provider');
  });

  it('keeps the plain reindex fix when an embedder is already configured', async () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('note-without-vector', 'note', { observations: ['hello world'] });

    const result = await doctor('ollama');
    const row = result.checks.find((c) => c.id === 'vector_index');
    expect(row?.status, row?.summary).toBe('warn');
    expect(row?.fix).toBe(`Run 'memesh reindex' to fix. This will restore full search functionality.`);
  });
});
