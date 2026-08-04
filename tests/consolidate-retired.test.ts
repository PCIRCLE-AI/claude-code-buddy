/**
 * `consolidate` is retired, on every surface, and says so where a caller looks.
 *
 * It deleted an entity's observations and wrote an LLM summary in their place —
 * immediately, with no proposal, no review, and nothing to restore from. Along
 * the way it ignored pins and reset confidence to 1.0, and a failure between
 * the delete and the write left the entity permanently empty while reporting
 * that nothing had happened.
 *
 * Removal alone is not the change. A retired command that answers "unknown
 * command", and a retired endpoint that answers 404, both read as a typo or a
 * broken install — so the user goes looking for the problem in the wrong place.
 * These cases pin the signposts as well as the absence, because the signposts
 * are the part a future cleanup would delete without noticing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TOOL_DEFINITIONS } from '../src/transports/mcp/handlers.js';
import { exportOpenAITools } from '../src/core/schema-export.js';
import * as operations from '../src/core/operations.js';
import { RETIRED_ROUTES } from '../src/transports/http/retired-routes.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('consolidate is retired', () => {
  it('is not an MCP tool', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).not.toContain('consolidate');
  });

  it('is not in the OpenAI function export either', () => {
    // Two registries that drifted apart once already; both are checked.
    expect(exportOpenAITools().map((t) => (t as { function: { name: string } }).function.name))
      .not.toContain('memesh_consolidate');
  });

  it('is not exported from core operations', () => {
    expect(Object.keys(operations)).not.toContain('consolidate');
  });

  it('left no consolidator module behind', () => {
    expect(fs.existsSync(path.join(repoRoot, 'src/core/consolidator.ts'))).toBe(false);
  });

  it('still answers `memesh consolidate` with somewhere to go', () => {
    // The command survives ONLY to say it is gone and name the alternative.
    // Deleting the block would make Commander print "unknown command", which
    // is why this asserts on the message and not merely on the command's
    // existence.
    const cli = fs.readFileSync(path.join(repoRoot, 'src/transports/cli/cli.ts'), 'utf8');
    const block = cli.slice(cli.indexOf("// --- consolidate (retired) ---"), cli.indexOf('// --- export ---'));
    expect(block, 'the retirement signpost is gone from the CLI').toContain("has been retired");
    expect(block, 'the signpost does not name where to go instead').toContain('memesh dream');
    expect(block, 'the signpost exits 0, so scripts cannot tell it failed').toContain('process.exitCode = 1');
  });

  it('answers POST /v1/consolidate with 410, not 404', () => {
    // 404 invites a retry against a different base URL; 410 says the resource
    // is gone on purpose. A script author reads the difference.
    const server = fs.readFileSync(path.join(repoRoot, 'src/transports/http/server.ts'), 'utf8');
    const route = server.slice(server.indexOf("app.post('/v1/consolidate'"));
    expect(route.slice(0, 600), 'the retired endpoint no longer answers 410').toContain('status(410)');
    // The message lives in RETIRED_ROUTES (one module feeds both the server
    // and the route test); assert the data says where to go, and that the
    // registration actually sends that data.
    expect(RETIRED_ROUTES['/v1/consolidate'], 'the 410 body does not name the alternative').toContain('/v1/dream/run');
    expect(route.slice(0, 600), 'the registration no longer sends the RETIRED_ROUTES message').toContain("RETIRED_ROUTES['/v1/consolidate']");
  });
});
