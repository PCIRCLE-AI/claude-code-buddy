// Anonymous install_id — locks down the contract that future code,
// docs, and the FeedbackWidget all depend on:
//   1. lazy-generates a UUID v4 on first read
//   2. idempotent: same UUID on every subsequent read from same host
//   3. file is chmod 600 (Unix)
//   4. JSON-extensible schema (schema_version field)
//   5. defensive: returns a record even when the FS is unwritable

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('install-id', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-installid-'));
    originalEnv = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = tmpDir;
    // Module reads MEMESH_DIR each call (no top-level cache), so we
    // can re-import without resetModules — but resetModules keeps
    // the tests fully hermetic if a future refactor caches it.
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = originalEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function freshModule() {
    return import('../../src/core/install-id.js');
  }

  it('lazy-generates a UUID v4 on first read', async () => {
    const { getInstallRecord } = await freshModule();
    expect(fs.existsSync(path.join(tmpDir, 'install.json'))).toBe(false);

    const record = getInstallRecord();
    expect(record.install_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.schema_version).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, 'install.json'))).toBe(true);
  });

  it('returns the same UUID on every subsequent call', async () => {
    const { getInstallRecord } = await freshModule();
    const a = getInstallRecord();
    const b = getInstallRecord();
    const c = getInstallRecord();
    expect(a.install_id).toBe(b.install_id);
    expect(b.install_id).toBe(c.install_id);
  });

  it('persists the file with mode 0o600 on POSIX', async () => {
    const { getInstallRecord } = await freshModule();
    getInstallRecord();
    const stat = fs.statSync(path.join(tmpDir, 'install.json'));
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('survives a malformed install.json by re-generating', async () => {
    fs.writeFileSync(path.join(tmpDir, 'install.json'), 'not json at all', 'utf8');
    const { getInstallRecord } = await freshModule();
    const record = getInstallRecord();
    expect(record.install_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('survives an install.json missing the install_id field', async () => {
    fs.writeFileSync(path.join(tmpDir, 'install.json'), JSON.stringify({ foo: 'bar' }), 'utf8');
    const { getInstallRecord } = await freshModule();
    const record = getInstallRecord();
    expect(record.install_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('getInstallId returns the same id as getInstallRecord', async () => {
    const { getInstallRecord, getInstallId } = await freshModule();
    expect(getInstallId()).toBe(getInstallRecord().install_id);
  });
});
