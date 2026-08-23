/**
 * The agentic-orchestration experiment is retired, on every surface, and says
 * so where a caller looks.
 *
 * It shipped in 4.1.0 behind an opt-in flag and never left opt-in; the
 * instrumentation it carried never produced a reason to keep it. This file is
 * the sibling of tests/consolidate-retired.test.ts, for the same reason that
 * file exists: a retired command that answers "unknown command", and a
 * retired endpoint that answers 404, both read as a broken install — and the
 * signposts are the part a future cleanup would delete without noticing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { TOOL_DEFINITIONS } from '../src/transports/mcp/handlers.js';
import { exportOpenAITools } from '../src/core/schema-export.js';
import { RETIRED_ROUTES } from '../src/transports/http/retired-routes.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(repoRoot, 'dist', 'transports', 'cli', 'cli.js');

describe('verify_agent_work and the orchestration surfaces are retired', () => {
  it('is not an MCP tool', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).not.toContain('verify_agent_work');
  });

  it('is not in the OpenAI function export either', () => {
    expect(exportOpenAITools().map((t) => (t as { function: { name: string } }).function.name))
      .not.toContain('memesh_verify_agent_work');
  });

  it('left no verifier or skill-usage module behind', () => {
    expect(fs.existsSync(path.join(repoRoot, 'src/core/verifier.ts'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, 'src/core/skill-usage-log.ts'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, 'scripts/hooks/pre-bash-orchestration-nudge.js'))).toBe(false);
  });

  it('ships no orchestration hook in the plugin manifest', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'hooks', 'hooks.json'), 'utf8'),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const commands = Object.values(manifest.hooks)
      .flat()
      .flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands.some((c) => c.includes('orchestration'))).toBe(false);
  });

  it('still answers `memesh verify` and `memesh patterns` with somewhere to go', () => {
    // The commands survive ONLY to say they are gone. Deleting the blocks
    // would make Commander print "unknown command", which reads as a broken
    // install — the exact failure mode the consolidate signpost documents.
    // RUN them, both. This used to slice the source between two markers —
    // a window holding BOTH retirement blocks, so every needle survived
    // deleting either command on its own, which is exactly what the test is
    // for. `verify … && deploy` in particular must fail loudly rather than
    // deploy on a command that no longer checks anything.
    for (const [command, replacement] of [
      ['verify', 'memesh remember'],
      ['patterns', 'memesh'],
    ] as const) {
      const result = spawnSync('node', [CLI_PATH, command], {
        encoding: 'utf8',
        env: { ...process.env, MEMESH_AUTO_UPDATE: '0' },
        timeout: 30_000,
      });
      const output = (result.stdout ?? '') + (result.stderr ?? '');

      expect(output, `the ${command} retirement signpost is gone from the CLI`)
        .toContain(`\`memesh ${command}\` has been retired`);
      expect(output, `the ${command} signpost does not name a replacement workflow`)
        .toContain(replacement);
      expect(result.status, `\`memesh ${command}\` exits 0, so gating scripts cannot tell it failed`)
        .toBe(1);
      expect(output, `\`memesh ${command}\` was deleted, not retired`)
        .not.toMatch(/unknown command/i);
    }
  });

  it('answers POST /v1/verify with 410, not 404', () => {
    const server = fs.readFileSync(path.join(repoRoot, 'src/transports/http/server.ts'), 'utf8');
    const route = server.slice(server.indexOf("app.post('/v1/verify'"));
    expect(route.slice(0, 400), 'the retired endpoint no longer answers 410').toContain('status(410)');
    expect(RETIRED_ROUTES['/v1/verify'], 'the 410 body does not name an alternative').toContain('/v1/remember');
    expect(route.slice(0, 400), 'the registration no longer sends the RETIRED_ROUTES message').toContain("RETIRED_ROUTES['/v1/verify']");
  });

  it('config no longer accepts the removed flag', () => {
    // `memesh config set enableAgenticOrchestration true` used to print a
    // success and write a key nothing reads — a reported success that does
    // nothing, the fake-working class this repo's audit exists to catch.
    const cli = fs.readFileSync(path.join(repoRoot, 'src/transports/cli/cli.ts'), 'utf8');
    expect(cli).not.toContain("'enableAgenticOrchestration'");
    const serverSrc = fs.readFileSync(path.join(repoRoot, 'src/transports/http/server.ts'), 'utf8');
    expect(serverSrc, 'POST /v1/config still accepts the removed field').not.toContain('enableAgenticOrchestration:');
  });
});
