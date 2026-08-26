import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/core/doctor.js';
import { recordAgentWorkflowFact, sendAgentMessage } from '../../src/core/agent-messaging.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const dbHandle = useTestDatabase('memesh-agent-message-storage-doctor-');
const CUTOFF = '2025-01-01T00:00:00.000Z';

afterEach(() => {
  expect(dbHandle.dbPath.endsWith('test.db')).toBe(true);
});

function doctor(policy?: { storage_quota_bytes?: number; retention_cutoff?: Date | string }) {
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
    agentMessageStoragePolicy: policy,
  });
}

describe('doctor agent-message storage pressure', () => {
  it('reports real SQLite pressure read-only and names policy/quota state without activating cleanup', async () => {
    const sent = sendAgentMessage(getDatabase(), {
      project: 'doctor-storage', sender: 'sender', recipient: 'recipient', idempotency_key: 'message-1',
      content_type: 'application/json', payload: { body: 'retained-until-an-owner-policy-says-otherwise' },
    });
    recordAgentWorkflowFact(getDatabase(), {
      delivery_id: sent.delivery_id, actor: 'recipient', workflow_state: 'completed', idempotency_key: 'complete-1',
    });
    getDatabase().prepare(`UPDATE agent_workflow_facts SET created_at = ? WHERE delivery_id = ?`)
      .run('2020-01-01 00:00:00', sent.delivery_id);
    const before = getDatabase().prepare(`
      SELECT message_id, payload_json, payload_tombstoned_at FROM agent_messages
    `).all();

    const configured = await doctor({ storage_quota_bytes: 1024 * 1024, retention_cutoff: CUTOFF });
    const configuredRow = configured.checks.find((check) => check.id === 'agent_message_storage');
    expect(configuredRow).toMatchObject({ status: 'pass', informational: true });
    expect(configuredRow?.summary).toMatch(/logical payload/);
    expect(configuredRow?.summary).toMatch(/unresolved\/protected/);
    expect(configuredRow?.summary).toMatch(/SQLite freelist reusable/);
    expect(configuredRow?.summary).toMatch(/WAL/);
    expect(configuredRow?.summary).toMatch(/quota 1\.0 MiB/);
    expect(configuredRow?.summary).toMatch(/1 terminal message\(s\).*prunable/);
    expect(configuredRow?.summary).toMatch(/did not prune payloads.*VACUUM/);

    const unconfigured = await doctor();
    const unconfiguredRow = unconfigured.checks.find((check) => check.id === 'agent_message_storage');
    expect(unconfiguredRow?.summary).toContain('quota not configured');
    expect(unconfiguredRow?.summary).toContain('retention policy not configured');
    expect(getDatabase().prepare(`
      SELECT message_id, payload_json, payload_tombstoned_at FROM agent_messages
    `).all()).toEqual(before);
  });

  it('reports the named owner quota environment policy without enabling retention', async () => {
    const original = process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;
    process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = '4096';
    try {
      const result = await doctor();
      const row = result.checks.find((check) => check.id === 'agent_message_storage');
      expect(row?.summary).toContain('quota 4.0 KiB');
      expect(row?.summary).toContain('retention policy not configured');
    } finally {
      if (original === undefined) delete process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;
      else process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = original;
    }
  });

  it.each(['1e3', ' 1000', '1000 ', '+1000', '-1', '1.0', '9007199254740992'])(
    'warns and changes the overall state when quota %j is rejected by send syntax', async (raw) => {
      const original = process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;
      process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = raw;
      try {
        const result = await doctor();
        const row = result.checks.find((check) => check.id === 'agent_message_storage');
        expect(row?.status).toBe('warn');
        expect(row?.informational).toBeUndefined();
        expect(row?.summary).toContain('configured quota is invalid');
        expect(row?.summary).toContain('Send enforcement rejects this quota configuration');
        expect(result.status).not.toBe('PASS');
      } finally {
        if (original === undefined) delete process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;
        else process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = original;
      }
    },
  );

  it.each(['0', '4096'])(
    'keeps canonical quota %j as a valid informational report', async (raw) => {
      const original = process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;
      process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = raw;
      try {
        const result = await doctor();
        const row = result.checks.find((check) => check.id === 'agent_message_storage');
        expect(row).toMatchObject({ status: 'pass', informational: true });
        expect(row?.summary).not.toContain('configured quota is invalid');
        expect(row?.summary).toContain(raw === '0' ? 'quota 0 B' : 'quota 4.0 KiB');
      } finally {
        if (original === undefined) delete process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;
        else process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = original;
      }
    },
  );
});
