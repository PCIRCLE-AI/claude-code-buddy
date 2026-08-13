/**
 * Every `memesh <command>` a CLI message tells the user to run must be a
 * command the CLI registers, and must not be a retired one.
 *
 * The telemetry empty-state hint said "run `memesh dream run`, `memesh
 * consolidate`, …" for a release after `consolidate` was retired — the hint
 * sent users to a command whose only behaviour is printing that it no longer
 * exists. A first draft of the fix then pointed at `memesh auto-tag`, which
 * has never existed at all. Nothing compared hint text to the command
 * registry in either direction; this does.
 *
 * Same shape as http-clients-call-real-routes.test.ts: mentions are scanned
 * from source text, the registry they must exist in comes from the
 * `.command('name')` registrations in the same file.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = fs.readFileSync(path.join(repoRoot, 'src/transports/cli/cli.ts'), 'utf8');

/** Every name `.command('...')` registers, top-level and sub-command alike. */
const registeredNames = new Set(
  [...cli.matchAll(/\.command\((['"`])([A-Za-z][A-Za-z0-9-]*)/g)].map(m => m[2])
);

/**
 * Commands whose registration is a retirement stub. Derived from the
 * convention the stub itself established: its description starts "(retired)".
 */
const retiredNames = new Set(
  [...cli.matchAll(/\.command\((['"`])([A-Za-z][A-Za-z0-9-]*)[^\n]*\)\s*\n\s*\.description\('\(retired\)/g)].map(
    m => m[2]
  )
);

/**
 * `<group> <sub>` pairs that are REGISTERED subcommands (e.g. `dream
 * patterns`). Retirement is a property of the top-level namespace: retiring
 * top-level `patterns` must not condemn `dream patterns`, which is a live
 * subcommand that merely shares the name. Group variables follow the
 * `const xCmd = program.command('x')` convention.
 */
const registeredPairs = new Set<string>();
{
  const groupVars = new Map(
    [...cli.matchAll(/const (\w+) = program\s*\n?\s*\.command\((['"`])([A-Za-z][A-Za-z0-9-]*)/g)].map(
      m => [m[1], m[3]]
    )
  );
  for (const [varName, groupName] of groupVars) {
    for (const m of cli.matchAll(new RegExp(`${varName}\\s*\\n?\\s*\\.command\\((['"\`])([A-Za-z][A-Za-z0-9-]*)`, 'g'))) {
      registeredPairs.add(`${groupName} ${m[2]}`);
    }
  }
}

/**
 * Every backticked `memesh <word> [<word>]` in a user-facing string. The
 * enclosing LINE decides intent: a line that itself talks about retirement
 * (the stub's own message, this class of comment) may name the dead command;
 * any other line is a live recommendation and must point at something real.
 */
function hintMentions(): Array<{ line: string; tokens: string[]; retirementContext: boolean }> {
  const out: Array<{ line: string; tokens: string[]; retirementContext: boolean }> = [];
  for (const line of cli.split('\n')) {
    // Comments talk to maintainers, not users — and they legitimately name
    // dead or made-up commands ("`memesh nonexistent-cmd`") as examples.
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    for (const m of line.matchAll(/`memesh ([a-z][a-z0-9-]*)(?: ([a-z][a-z0-9-]*))?/g)) {
      out.push({
        line: line.trim(),
        tokens: [m[1], m[2]].filter((tok): tok is string => Boolean(tok)),
        // A retirement message may name the dead command it is ABOUT — but
        // only that. The first version skipped the whole line, which also
        // exempted the replacement the stub recommends ("(retired) Use
        // `memesh dream`") — the exact place a renamed replacement would
        // silently rot.
        retirementContext: /retired/i.test(line),
      });
    }
  }
  return out;
}

describe('CLI hints name real commands', () => {
  it('the command registry was actually extracted', () => {
    expect(registeredNames.size).toBeGreaterThan(15);
    expect(registeredNames.has('doctor')).toBe(true);
    expect(registeredNames.has('dream')).toBe(true);
  });

  it('the retired set was actually extracted', () => {
    // `consolidate` is the one retirement in the tree. An empty set here
    // would turn the recommendation check below vacuous for retirements.
    expect(retiredNames.has('consolidate')).toBe(true);
  });

  it('hints were actually found', () => {
    // The CLI's whole help style leans on `memesh <cmd>` mentions; zero
    // matches means the extraction rotted, not that the hints are gone.
    expect(hintMentions().length).toBeGreaterThan(3);
  });

  it('every recommended command exists and is not retired', () => {
    const bad: string[] = [];
    for (const { line, tokens, retirementContext } of hintMentions()) {
      // First token must be a registered top-level command; a second token
      // (e.g. `dream run`) may be a registered sub-command name or a plain
      // argument — only flag it when it LOOKS like a command and is known to
      // be retired. A retirement line may name the retired command itself;
      // every OTHER token on it is a live recommendation like any other.
      const [head, sub] = tokens;
      const headRetiredOk = retirementContext && retiredNames.has(head);
      if (!registeredNames.has(head)) bad.push(line);
      else if (retiredNames.has(head) && !headRetiredOk) bad.push(line);
      // A sub token is only condemned by a retirement when it is NOT a live
      // subcommand under its head — `dream patterns` outlives the retired
      // top-level `patterns`, which merely shares the name.
      else if (sub && retiredNames.has(sub) && !registeredPairs.has(`${head} ${sub}`)) bad.push(line);
    }
    expect(bad).toEqual([]);
  });
});
