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
 * Every backticked `memesh <word> [<word>]` in a user-facing string. The
 * enclosing LINE decides intent: a line that itself talks about retirement
 * (the stub's own message, this class of comment) may name the dead command;
 * any other line is a live recommendation and must point at something real.
 */
function hintMentions(): Array<{ line: string; tokens: string[] }> {
  const out: Array<{ line: string; tokens: string[] }> = [];
  for (const line of cli.split('\n')) {
    // Comments talk to maintainers, not users — and they legitimately name
    // dead or made-up commands ("`memesh nonexistent-cmd`") as examples.
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    if (/retired/i.test(line)) continue;
    for (const m of line.matchAll(/`memesh ([a-z][a-z0-9-]*)(?: ([a-z][a-z0-9-]*))?/g)) {
      out.push({ line: line.trim(), tokens: [m[1], m[2]].filter((t): t is string => Boolean(t)) });
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
    for (const { line, tokens } of hintMentions()) {
      // First token must be a registered top-level command; a second token
      // (e.g. `dream run`) may be a registered sub-command name or a plain
      // argument — only flag it when it LOOKS like a command and is known to
      // be retired.
      const [head, sub] = tokens;
      if (!registeredNames.has(head) || retiredNames.has(head)) bad.push(line);
      else if (sub && retiredNames.has(sub)) bad.push(line);
    }
    expect(bad).toEqual([]);
  });
});
