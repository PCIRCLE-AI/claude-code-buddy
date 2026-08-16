/**
 * Lesson guards — the shapes and the two pure decisions (validate a proposed
 * guard, match active guards against a tool input).
 *
 * A runtime leaf with no imports at all, so `scripts/generate-hook-core.mjs`
 * copies it next to the hooks: the PreToolUse guard hook, the dreamer's
 * proposer and the accept path must all agree on what a valid guard is, and
 * the only way three surfaces agree is one definition.
 *
 * A guard is a lesson promoted to speak at the moment its mistake is about to
 * repeat: `{ tool, pattern, message }` proposed by the dreamer from a
 * failure-shaped lesson, accepted by a human (proposal flow — a guard is
 * never self-enabling), stored on the source lesson as `metadata.guard`, and
 * evaluated by PreToolUse hooks as a plain regex test. v1 guards only WARN
 * (the schema carries `action` so block can arrive once measured fire
 * accuracy justifies it).
 */

/** What the dreamer proposes and the validator checks. */
export interface GuardSpec {
  tool: 'Bash' | 'Edit' | 'Write';
  /** Case-insensitive regex source tested against the tool input. */
  pattern: string;
  /** The warning voice — shown when the guard fires. Attacker-influenced
   *  like all memory content: renderers must fence it as data. */
  message: string;
  /** Validator evidence: inputs that MUST match / MUST NOT match. The
   *  examples travel with the spec so a reviewer sees what the pattern
   *  actually does, and the accept path can re-verify years later. */
  should_match: string[];
  should_not_match: string[];
}

/** What `metadata.guard` holds once accepted, as the hooks read it. */
export interface ActiveGuard {
  lessonId: number;
  tool: string;
  pattern: string;
  message: string;
  action: string;
}

export const GUARD_TOOLS = new Set(['Bash', 'Edit', 'Write']);

/**
 * Inputs no reasonable guard should fire on. A pattern that matches one of
 * these is too broad to be a guard — it would nag on routine work until the
 * user turns the whole feature off, which is how safety features die.
 */
export const GUARD_BENIGN_PROBES = [
  'ls',
  'git status',
  'git diff',
  'npm test',
  'echo ok',
  'cd ..',
  'src/index.ts',
];

const PATTERN_MIN = 6;
const PATTERN_MAX = 200;
const MESSAGE_MAX = 280;

/**
 * Every reason a proposed guard is unusable, or an empty list. Pure and
 * LLM-free on purpose: it runs when the dreamer stages the proposal AND
 * again when a human accepts it — a proposal accepted months later must
 * still hold, and the acceptance re-check cannot depend on a model.
 */
export function validateGuardSpec(spec: unknown): string[] {
  const errors: string[] = [];
  const s = spec as Partial<GuardSpec> | null | undefined;
  if (!s || typeof s !== 'object') return ['guard spec is not an object'];

  if (typeof s.tool !== 'string' || !GUARD_TOOLS.has(s.tool)) {
    errors.push(`tool must be one of ${[...GUARD_TOOLS].join('/')}`);
  }

  if (typeof s.pattern !== 'string' || s.pattern.length < PATTERN_MIN || s.pattern.length > PATTERN_MAX) {
    errors.push(`pattern must be a string of ${PATTERN_MIN}–${PATTERN_MAX} chars`);
    return errors; // nothing below is meaningful without a pattern
  }
  let re: RegExp;
  try {
    re = new RegExp(s.pattern, 'i');
  } catch (err) {
    return [...errors, `pattern does not compile: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (re.test('')) errors.push('pattern matches the empty string — it would fire on everything');
  for (const probe of GUARD_BENIGN_PROBES) {
    if (re.test(probe)) errors.push(`pattern matches the benign input "${probe}" — too broad to be a guard`);
  }

  if (typeof s.message !== 'string' || s.message.trim().length === 0 || s.message.length > MESSAGE_MAX) {
    errors.push(`message must be a non-empty string of at most ${MESSAGE_MAX} chars`);
  }

  const matches = Array.isArray(s.should_match) ? s.should_match.filter((x) => typeof x === 'string') : [];
  const nonMatches = Array.isArray(s.should_not_match) ? s.should_not_match.filter((x) => typeof x === 'string') : [];
  if (matches.length < 2) {
    errors.push('should_match needs at least 2 example inputs');
  }
  if (nonMatches.length < 2) {
    errors.push('should_not_match needs at least 2 example inputs');
  }
  // The examples are the evidence the reviewer sees; a spec whose own
  // evidence fails is wrong regardless of what the pattern "meant".
  for (const ex of matches) {
    if (!re.test(ex)) errors.push(`should_match example does not match: "${ex.slice(0, 80)}"`);
  }
  for (const ex of nonMatches) {
    if (re.test(ex)) errors.push(`should_not_match example matches: "${ex.slice(0, 80)}"`);
  }

  return errors;
}

/**
 * The guards that fire for one tool input. A pattern that no longer
 * compiles is skipped silently — a corrupt guard must degrade to "no
 * warning", never to a crashed hook (the hook's own contract: guard
 * failure can never block the user's work).
 */
export function matchingGuards(guards: ActiveGuard[], tool: string, haystack: string): ActiveGuard[] {
  const out: ActiveGuard[] = [];
  if (typeof haystack !== 'string' || haystack.length === 0) return out;
  for (const g of guards) {
    if (g.tool !== tool) continue;
    if (g.action !== 'warn' && g.action !== 'block') continue;
    let re: RegExp;
    try {
      re = new RegExp(g.pattern, 'i');
    } catch {
      continue;
    }
    if (re.test(haystack)) out.push(g);
  }
  return out;
}

/**
 * Parse one entity row's metadata into an ActiveGuard, or null. Tolerant by
 * design: hooks read every lesson row that mentions "guard" and anything
 * malformed is simply not a guard.
 */
export function guardFromMetadata(lessonId: number, metadata: string | null): ActiveGuard | null {
  if (!metadata) return null;
  try {
    const meta = JSON.parse(metadata) as { guard?: Record<string, unknown> };
    const g = meta?.guard;
    if (!g || g.enabled !== true) return null;
    if (typeof g.tool !== 'string' || typeof g.pattern !== 'string' || typeof g.message !== 'string') return null;
    return {
      lessonId,
      tool: g.tool,
      pattern: g.pattern,
      message: g.message,
      action: typeof g.action === 'string' ? g.action : 'warn',
    };
  } catch {
    return null;
  }
}
