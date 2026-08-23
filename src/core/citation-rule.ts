// =============================================================================
// citation-rule — put the citation contract where instructions are read
// =============================================================================
//
// WHY THIS FILE EXISTS
// ────────────────────
// The Stop hook credits `recall_hits` from `[mem:id]` markers the agent
// writes, and that signal is the only evidence memesh has that an injected
// memory was worth its tokens. Measured on a real database on 2026-08-24:
// `citation_sessions_total = 4`, and the key that counts sessions WITH a
// citation did not exist at all — the branch that writes it had never run.
// Zero citations in every accounted session.
//
// The instruction asking for those markers was not missing. It is appended
// after the fenced block on purpose, precisely so it reads as an instruction
// rather than as data. The problem is one layer further out: Claude Code
// wraps every hook's `additionalContext` in a `<system-reminder>` that ends
//
//     IMPORTANT: this context may or may not be relevant to your tasks. You
//     should not respond to this context unless it is highly relevant.
//
// That wrapper is correct and must stay. Memory content is
// attacker-influenced in the general case — anything the agent was ever told
// can end up in an observation — so a hook's injected text must not be able
// to drive the agent. The line asking for citations lands inside that
// container along with the memories, and is read the same way: as data.
//
// So the contract moves to the layer that IS instructions. `CLAUDE.md` and
// `.claude/rules/*.md` are loaded as rules, not as context — the same
// difference that had this session obeying every CLAUDE.md rule while
// citing zero memories.
//
// WHAT THIS DOES NOT DO
// ─────────────────────
// Only the CONTRACT moves. Memory content stays in the fenced context block
// where it is treated as data. Nothing here gives injected memories the
// power to instruct.
//
// IS THIS ENOUGH? — an open question with a decision date
// ───────────────────────────────────────────────────────
// Moving the contract to the instruction layer is a SOFT fix. The evidence
// for it is one session's contrast (every CLAUDE.md rule obeyed while the
// injected citation instruction was ignored) plus outside reports that
// additionalContext loses to system-level instructions. Published accounts
// also describe CLAUDE.md itself as context Claude weighs, not a policy
// engine — so this may not be enough.
//
// The hard option exists and is deliberately NOT taken here: a Stop hook
// returning exit 2 refuses to end the session and hands its stderr to the
// agent, which is the only layer with real enforcement. KT's call
// (2026-08-24): keep that in reserve, observe first.
//
// The observation has a terminating condition, because "observe for a while"
// otherwise never concludes:
//
//   Measure : `memesh doctor` → citation_compliance, or
//             `node scripts/audit/measure-signals.mjs` → citation.sessions
//   Denominator: SESSIONS, not days. Judge once `citation_sessions_total`
//             has grown by 10 from the 4 it stood at when this shipped.
//   cited > 0  → the instruction layer works. Leave this alone.
//   cited == 0 → a soft contract does not survive this interface. Ship the
//             Stop-hook exit 2 (throttled — blocking every session gets the
//             hook switched off, which is worse than measuring nothing).
//
// A `?` rather than a number means the database predates the unconditional
// initialisation of `citation_sessions_cited`. That is not 0%; it is "no
// counter yet". Wait for it to start accumulating before judging.
//
// WHERE IT WRITES
// ───────────────
// `.claude/rules/memesh-citations.md` — its own file, never the user's
// `CLAUDE.md`. A separate file has no merge conflict, needs no parsing of
// someone else's prose, and uninstalls by deleting one path.

import fs from 'fs';
import path from 'path';

/** Marks the file as memesh's, so we never overwrite or delete a file a user
 *  wrote by hand at the same path. Checked on both write and remove. */
export const CITATION_RULE_MARKER = '<!-- managed-by: memesh -->';

export const CITATION_RULE_FILENAME = 'memesh-citations.md';

/**
 * The contract itself.
 *
 * Deliberately short: this is loaded as an instruction on every session, so
 * its length is a permanent per-session cost — the same budget pressure that
 * made the injected version one line. It buys back more than it costs by
 * letting the injection drop its own copy of the instruction, which was
 * being read as data anyway.
 */
export const CITATION_RULE_BODY = `${CITATION_RULE_MARKER}
# MeMesh memory citations

MeMesh injects relevant memories at session start and before file edits. Every
injected line ends with a handle: \`[mem:42]\`.

When an injected memory genuinely informs your work — you used the fact, the
lesson changed what you did, the decision answered a question you were about to
re-ask — cite it inline once as \`[mem:42]\`, in the sentence it affected.

Do not cite a memory you only read past, and never invent an id. An uncited
memory is recorded as unused: that is how MeMesh learns which memories are
worth the tokens they cost you.
`;

export type CitationRuleScope = 'user' | 'project';

/**
 * Where the rule lives.
 *
 * `home` is a parameter rather than a `homeDir()` call so this module imports
 * nothing but node builtins. That is the condition `generate-hook-core.mjs`
 * requires to mirror a compiled module into `scripts/hooks/_generated/`, and
 * the hooks need this code: a plugin install never runs `install-hooks`, so
 * without a hook-side copy the contract would only ever reach npm users.
 */
export function citationRuleDir(scope: CitationRuleScope, home: string, cwd: string): string {
  const base = scope === 'user' ? home : cwd;
  return path.join(base, '.claude', 'rules');
}

export function citationRulePath(scope: CitationRuleScope, home: string, cwd: string): string {
  return path.join(citationRuleDir(scope, home, cwd), CITATION_RULE_FILENAME);
}

export type CitationRuleAction = 'created' | 'updated' | 'unchanged' | 'foreign-file';

export interface CitationRuleResult {
  path: string;
  action: CitationRuleAction;
}

/**
 * Write the rule, idempotently.
 *
 * `foreign-file` is a refusal, not a failure: a file at this path without the
 * memesh marker belongs to the user, and overwriting it would destroy
 * instructions they wrote. Reported so it is visible rather than silently
 * skipped — the caller surfaces it and the user decides.
 */
export function writeCitationRule(
  scope: CitationRuleScope,
  home: string,
  cwd: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync'> = fs,
): CitationRuleResult {
  const filePath = citationRulePath(scope, home, cwd);

  if (fsImpl.existsSync(filePath)) {
    const current = String(fsImpl.readFileSync(filePath, 'utf8'));
    if (!current.includes(CITATION_RULE_MARKER)) {
      return { path: filePath, action: 'foreign-file' };
    }
    if (current === CITATION_RULE_BODY) return { path: filePath, action: 'unchanged' };
    fsImpl.writeFileSync(filePath, CITATION_RULE_BODY);
    return { path: filePath, action: 'updated' };
  }

  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(filePath, CITATION_RULE_BODY);
  return { path: filePath, action: 'created' };
}

export type CitationRuleRemoval = 'removed' | 'absent' | 'foreign-file';

/** Remove the rule. Refuses to delete a file memesh did not write. */
export function removeCitationRule(
  scope: CitationRuleScope,
  home: string,
  cwd: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'rmSync'> = fs,
): { path: string; action: CitationRuleRemoval } {
  const filePath = citationRulePath(scope, home, cwd);
  if (!fsImpl.existsSync(filePath)) return { path: filePath, action: 'absent' };
  const current = String(fsImpl.readFileSync(filePath, 'utf8'));
  if (!current.includes(CITATION_RULE_MARKER)) return { path: filePath, action: 'foreign-file' };
  fsImpl.rmSync(filePath);
  return { path: filePath, action: 'removed' };
}

export type CitationRuleState = 'current' | 'stale' | 'missing' | 'foreign-file';

/**
 * What doctor reports.
 *
 * Three states, not two: `stale` (an older wording is installed) is separate
 * from `missing` because the remedies differ — one is a re-install, the other
 * is a first install — and collapsing them would report a healthy-but-old
 * install as if memesh had never been wired up.
 */
export function citationRuleState(
  scope: CitationRuleScope,
  home: string,
  cwd: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'readFileSync'> = fs,
): { path: string; state: CitationRuleState } {
  const filePath = citationRulePath(scope, home, cwd);
  if (!fsImpl.existsSync(filePath)) return { path: filePath, state: 'missing' };
  const current = String(fsImpl.readFileSync(filePath, 'utf8'));
  if (!current.includes(CITATION_RULE_MARKER)) return { path: filePath, state: 'foreign-file' };
  return { path: filePath, state: current === CITATION_RULE_BODY ? 'current' : 'stale' };
}
