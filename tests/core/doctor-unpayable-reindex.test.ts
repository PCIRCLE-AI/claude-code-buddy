/**
 * A `vectors-missing` reindex debt on a machine where sqlite-vec does not load
 * is one `memesh reindex` cannot pay ("sqlite-vec is not loaded"). Doctor
 * used to render it anyway — "0 memories have no search vector, run reindex"
 * — forever. The 4.8.2 lesson split marks that debt on every upgraded graph,
 * so the row would have appeared on every vec-less install after upgrade.
 *
 * `hasVectorIndex` is mocked to the "no vec0 module" answer, because on the
 * machine running this suite the extension does load.
 */
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../../src/core/doctor.js';
import { getDatabase, markReindexOwed } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

vi.mock('../../src/storage/vector-index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/vector-index.js')>();
  return { ...actual, hasVectorIndex: () => false };
});

const dbHandle = useTestDatabase('memesh-doctor-unpayable-reindex-');

afterEach(() => {
  expect(dbHandle.dbPath.endsWith('test.db')).toBe(true);
});

function doctor() {
  return runDoctor({
    packageRoot: process.cwd(),
    packageVersion: 'test',
    openDatabaseImpl: () => getDatabase(),
    closeDatabaseImpl: () => undefined,
    isDatabaseOpenImpl: () => true,
    detectCapabilitiesImpl: () => ({ searchLevel: 0, embeddings: 'tfidf', llm: null }) as never,
    getConfigPathImpl: () => path.join(dbHandle.tmpDir, 'config.json'),
    getUpdateCheckImpl: async () => ({ checkSucceeded: true, updateAvailable: false }) as never,
    getCurrentInstallChannelImpl: () => 'npm-global',
    getInstallChannelSupportImpl: () => ({ label: 'npm global', canSelfUpdate: false }) as never,
    nativeBindingProbeImpl: () => ({ ok: true }),
    resolveShellMemeshImpl: () => null,
  });
}

describe('doctor and a reindex debt that cannot be paid', () => {
  it('does not tell a vec-less machine to run reindex for missing vectors', async () => {
    markReindexOwed(384, 384, 'vectors-missing');
    const result = await doctor();
    const row = result.checks.find((c) => c.id === 'vector_index');
    expect(row?.status ?? 'absent', row?.summary).not.toBe('warn');
  });

  it('still reports a dimension change, which a later reindex on a capable machine must pay', async () => {
    markReindexOwed(384, 1536, 'dimension-change');
    const result = await doctor();
    const row = result.checks.find((c) => c.id === 'vector_index');
    expect(row?.status).toBe('warn');
    expect(row?.summary).toContain('rebuilding');
  });
});
