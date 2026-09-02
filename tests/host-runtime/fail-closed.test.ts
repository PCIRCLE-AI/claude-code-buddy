import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every shipped host runtime must fail CLOSED and say why.
 *
 * Found by the entry-point gate, not by a review: `memesh-host-codex` and
 * `memesh-host-acp` awaited their entry function at module scope with no
 * `catch`, so a user whose only mistake was omitting `--config` got a raw Node
 * stack trace. `memesh-host-claude` caught it — and then discarded the error,
 * printing a generic "session startup failed." that hid the one sentence
 * telling the user what to do. Both are the same defect in opposite
 * directions, so all three are pinned here together: one line, the real
 * reason, non-zero exit, no stack trace.
 *
 * Spawned against `dist/` rather than imported, because the defect lives in
 * the module's top-level entry guard — importing the module never reaches it.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const HOSTS = [
  { bin: 'memesh-host-claude', dist: 'dist/host-runtime/claude.js' },
  { bin: 'memesh-host-codex', dist: 'dist/host-runtime/codex.js' },
  { bin: 'memesh-host-acp', dist: 'dist/host-runtime/acp.js' },
] as const;

describe.skipIf(process.platform === 'win32')('host runtimes fail closed with a reason', () => {
  for (const host of HOSTS) {
    it(`${host.bin} names the missing config and does not print a stack trace`, () => {
      const entry = path.join(repoRoot, host.dist);
      expect(fs.existsSync(entry), `${host.dist} is not built — run npm run build`).toBe(true);

      const memeshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-failclosed-'));
      try {
        const result = spawnSync(process.execPath, [entry], {
          input: '',
          encoding: 'utf8',
          timeout: 30_000,
          // No --config and no MEMESH_HOST_CONFIG: the case a real user hits.
          env: {
            ...process.env,
            MEMESH_DIR: memeshDir,
            MEMESH_DB_PATH: path.join(memeshDir, 'knowledge-graph.db'),
            MEMESH_HOST_CONFIG: '',
          },
        });

        expect(result.status, `${host.bin} must exit non-zero`).not.toBe(0);
        const stderr = result.stderr ?? '';

        // The reason, not a generic apology.
        expect(stderr).toContain(host.bin);
        expect(stderr).toMatch(/host config file is required/i);

        // Not a stack trace: no frame lines, no source-location banner.
        expect(stderr).not.toMatch(/^\s+at /m);
        expect(stderr).not.toMatch(/file:\/\/\/.*\.js:\d+/);

        // One line, so it fits wherever a host client shows it.
        expect(stderr.trim().split('\n')).toHaveLength(1);
      } finally {
        fs.rmSync(memeshDir, { recursive: true, force: true });
      }
    });
  }
});
