// What counts as a REFERENCE to a script, when you are asking "does anything
// actually run this?"
//
// The C3 detector in `scripts/audit/verification-audit.mjs` finds gate-like
// scripts with no automated caller by counting how often their basename
// appears across workflows, scripts, tests and `package.json`. It counted the
// raw text, so a filename written in prose counted as a caller.
//
// That is not hypothetical. `scripts/audit/measure-injection-tokens.mjs` opens
// with "Companion to measure-work-topology-baseline.mjs", and that one
// sentence was enough to make the companion look called — its C3 entry was
// then reported as stale and pruned. Somebody noticed and, instead of fixing
// the detector, wrote the explanation into the OTHER script's baseline reason,
// where it sat as a warning not to delete the comment. The same thing happened
// again the moment a test's header comment named `wait-for-checks.mjs`.
//
// A detector for uncalled gates that any sentence can silence is not a
// detector. Comments come out before counting.

/**
 * Blank out comments so a filename mentioned in prose cannot read as a caller.
 *
 * Over-stripping is the safe direction: a reference lost this way makes a
 * script look UNcalled, which fails the audit loudly and is triaged by a
 * human. A reference wrongly kept hides a finding, silently, forever.
 *
 * Comments are replaced with a space rather than removed, so nothing on either
 * side is accidentally joined into a new token.
 *
 * @param {string} text
 * @param {string} file  Path or filename; the extension selects the syntax.
 * @returns {string}
 */
export function stripComments(text, file) {
  if (typeof text !== 'string') return '';
  const name = String(file ?? '');

  if (/\.(mjs|cjs|js|ts|tsx)$/.test(name)) {
    return (
      text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        // `[^:]` guards the `//` in a URL (`https://…`), which is not a comment
        // and can legitimately carry a filename.
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    );
  }

  if (/\.(yml|yaml|sh|bash)$/.test(name)) {
    return text.replace(/#[^\n]*/g, ' ');
  }

  // JSON and anything else: no comment syntax to strip. Returned unchanged so
  // an unknown extension can never silently lose a real reference.
  return text;
}
