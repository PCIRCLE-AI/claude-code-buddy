/**
 * BetterSqlite3Adapter Unit Tests
 *
 * Tests for the quick_check PRAGMA validation added to the create() method.
 * Covers: file-based DB success, in-memory DB skip, and quick_check failure path.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { BetterSqlite3Adapter } from '../../../src/db/adapters/BetterSqlite3Adapter.js';

describe('BetterSqlite3Adapter', () => {
  const tmpDir = os.tmpdir();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('create() — quick_check validation', () => {
    it('should open a valid file-based database without error', async () => {
      const dbPath = path.join(tmpDir, `adapter-valid-${Date.now()}.db`);

      try {
        const adapter = await BetterSqlite3Adapter.create(dbPath);

        expect(adapter).toBeDefined();
        expect(adapter.open).toBe(true);
        expect(adapter.inMemory).toBe(false);
        expect(adapter.name).toBe('better-sqlite3');

        adapter.close();
      } finally {
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      }
    });

    it('should open an in-memory database without running quick_check', async () => {
      // We spy on Database.prototype.pragma to verify it is NOT called for :memory:
      const BetterSqlite3 = (await import('better-sqlite3')).default;
      const pragmaSpy = vi.spyOn(BetterSqlite3.prototype, 'pragma');

      const adapter = await BetterSqlite3Adapter.create(':memory:');

      expect(adapter).toBeDefined();
      expect(adapter.open).toBe(true);
      expect(adapter.inMemory).toBe(true);

      // pragma('quick_check') must NOT have been called for in-memory databases
      const quickCheckCalls = pragmaSpy.mock.calls.filter(([name]) => name === 'quick_check');
      expect(quickCheckCalls).toHaveLength(0);

      adapter.close();
    });

    it('should throw a descriptive error when quick_check returns a non-ok result', async () => {
      const dbPath = path.join(tmpDir, `adapter-corrupt-${Date.now()}.db`);

      // Create the DB file so better-sqlite3 can open it
      const BetterSqlite3 = (await import('better-sqlite3')).default;

      try {
        // Spy on pragma to simulate a failed integrity check
        vi.spyOn(BetterSqlite3.prototype, 'pragma').mockImplementation((name: string) => {
          if (name === 'quick_check') {
            return 'integrity_check_failed';
          }
          // Call original for any other pragma
          return undefined;
        });

        await expect(BetterSqlite3Adapter.create(dbPath)).rejects.toThrow(
          'Database integrity check failed'
        );
      } finally {
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      }
    });

    it('should re-throw the integrity check error (not swallow it)', async () => {
      const dbPath = path.join(tmpDir, `adapter-check-${Date.now()}.db`);

      const BetterSqlite3 = (await import('better-sqlite3')).default;

      try {
        vi.spyOn(BetterSqlite3.prototype, 'pragma').mockImplementation((name: string) => {
          if (name === 'quick_check') {
            return 'error_on_page_1';
          }
          return undefined;
        });

        const rejection = BetterSqlite3Adapter.create(dbPath);

        await expect(rejection).rejects.toThrow('Database integrity check failed: error_on_page_1');
      } finally {
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      }
    });
  });
});
