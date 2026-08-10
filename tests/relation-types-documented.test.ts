/**
 * A relation type the code acts on must be named in the schema the model reads.
 *
 * `createRelation()` accepts any string, and most relation types are inert
 * labels. Two are not:
 *
 *   - `supersedes` archives the target entity, on write, immediately.
 *   - `contradicts` makes both entities surface as a conflict on every recall.
 *
 * Neither appeared in the MCP `remember` schema, which offered `"implements"`
 * and `"related-to"` as its examples — both inert. That description is the ONLY
 * thing a model reads about relation types at run time, so the consequences of
 * this feature were unreachable except by guessing the word, and
 * `findConflicts()` ran on every recall with nothing it could ever find. Every
 * transport rendered that empty result as "no conflicts", which reads as
 * checked-and-clean.
 *
 * The failure mode is silent in both directions, so both are pinned here:
 *
 *   1. the code branches on a relation type that `BEHAVIOURAL_RELATION_TYPES`
 *      does not list — a new consequence nobody wrote down, and
 *   2. a listed type is missing from the schema description — written down
 *      somewhere the model cannot see.
 *
 * The first is found by scanning source text, which fails open by nature: if
 * the patterns stop matching, the set is empty and "every type found is
 * documented" becomes vacuously true. So the scan asserts it found something
 * before it asserts anything about what it found — the same guard as
 * `ci-matrix-covers-engines.test.ts`. A false positive here (an unrelated
 * `r.type === '...'`) fails loudly and names the string, which is the safe
 * direction for a test about undocumented behaviour.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BEHAVIOURAL_RELATION_TYPES } from '../src/core/types.js';
import { TOOL_DEFINITIONS } from '../src/transports/mcp/handlers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(repoRoot, 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every relation type the source compares against, as `{ type, where }`. */
function branchedOnTypes(): Array<{ type: string; where: string }> {
  const found: Array<{ type: string; where: string }> = [];
  const files = sourceFiles(srcRoot);
  expect(files.length, 'no .ts files found under src/ — did the tree move?').toBeGreaterThan(0);

  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    const text = fs.readFileSync(file, 'utf8');
    // SQL: `relation_type = 'supersedes'`
    for (const m of text.matchAll(/relation_type\s*=\s*'([^']+)'/g)) {
      found.push({ type: m[1], where: `${rel} (SQL)` });
    }
    // JS/TS: `rel.type === 'supersedes'`, `r.type === 'supersedes'`
    for (const m of text.matchAll(/\b(?:rel|relation|r)\.type\s*===?\s*'([^']+)'/g)) {
      found.push({ type: m[1], where: `${rel}` });
    }
  }
  return found;
}

/** The `type` field description inside `remember`'s `relations` array. */
function relationTypeDescription(): string {
  const remember = TOOL_DEFINITIONS.find((t) => t.name === 'remember');
  expect(remember, 'the remember tool is gone from TOOL_DEFINITIONS').toBeDefined();
  const schema = remember!.inputSchema as {
    properties?: { relations?: { items?: { properties?: { type?: { description?: string } } } } };
  };
  const description = schema.properties?.relations?.items?.properties?.type?.description;
  expect(
    description,
    'the relations[].type field has no description at all — the model is told nothing'
  ).toBeTypeOf('string');
  return description as string;
}

describe('relation types with consequences are documented where the model reads', () => {
  it('branches on no relation type that BEHAVIOURAL_RELATION_TYPES omits', () => {
    const branches = branchedOnTypes();

    // Without this, patterns that stopped matching would make the loop below
    // vacuous and this test would pass on a codebase full of undocumented
    // behaviour.
    expect(
      branches.length,
      'no relation-type comparison was found anywhere in src/ — the patterns stopped matching'
    ).toBeGreaterThanOrEqual(2);

    const documented = Object.keys(BEHAVIOURAL_RELATION_TYPES);
    for (const branch of branches) {
      expect(
        documented,
        `${branch.where} changes behaviour for relation type "${branch.type}", which BEHAVIOURAL_RELATION_TYPES does not list — so nothing forces it into the schema the model reads`
      ).toContain(branch.type);
    }
  });

  it('names every behavioural relation type, and its consequence, in the MCP schema', () => {
    const description = relationTypeDescription();
    const entries = Object.entries(BEHAVIOURAL_RELATION_TYPES);
    expect(entries.length, 'BEHAVIOURAL_RELATION_TYPES is empty').toBeGreaterThanOrEqual(2);

    for (const [type, consequence] of entries) {
      expect(
        description,
        `a model calling remember is never told that "${type}" does anything`
      ).toContain(type);
      // The name alone is not documentation: "supersedes" in a list of examples
      // reads as another inert label. The consequence has to travel with it.
      expect(
        description,
        `"${type}" is named in the schema but its consequence is not — the model cannot tell it apart from an inert label`
      ).toContain(consequence);
    }
  });

  it('names every behavioural relation type in the CLI too', () => {
    // The third direction. MCP and HTTP callers could state a relation through
    // `remember`'s `relations`; the CLI had no flag for any relation at all, so
    // `contradicts` was unreachable from the terminal and `memesh recall`
    // answered "no conflicts" to a CLI-only user for a question nothing they
    // could type would ever change. A type with a consequence has to be
    // reachable from every surface that can write memories, and the flag has
    // to carry the consequence — `--supersedes <name>` alone reads as a label.
    const cli = fs.readFileSync(path.join(srcRoot, 'transports', 'cli', 'cli.ts'), 'utf8');
    for (const type of Object.keys(BEHAVIOURAL_RELATION_TYPES)) {
      const flag = new RegExp(`'--${type} <[^']*'\\s*,\\s*'([^']*)'`);
      const m = flag.exec(cli);
      expect(m, `\`memesh remember\` has no --${type} flag, so the CLI cannot state it`).not.toBeNull();
      expect(
        (m as RegExpExecArray)[1].length,
        `--${type}'s help text does not say what it does`
      ).toBeGreaterThan(40);
    }
  });

  it('still offers an inert example, so the field does not read as an enum', () => {
    // Relation type is free-form; a description listing only the two special
    // values would imply those are the only allowed ones.
    const description = relationTypeDescription();
    expect(description).toMatch(/related-to|implements/);
  });
});
