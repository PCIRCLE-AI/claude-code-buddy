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
    return stripJsComments(text);
  }

  if (/\.(yml|yaml|sh|bash)$/.test(name)) {
    return text.replace(/#[^\n]*/g, ' ');
  }

  // JSON and anything else: no comment syntax to strip. Returned unchanged so
  // an unknown extension can never silently lose a real reference.
  return text;
}

// Strip JS/TS comments by walking the text once, tracking whether we are in
// code, a string, or a comment.
//
// This was two regexes, and the block-comment one could not tell a real block
// opener from one written inside a string or a line comment.
// `tests/core/doctor.test.ts` carries the tsconfig glob `**/*.test.ts` inside a
// `//` comment, as prose. The regex opened a block comment at that glob and
// closed it at the next `*/` hundreds of lines later, blanking every line
// between — fourteen openers against thirteen closers in that one file. Every
// detector built on this corpus then reported the ids inside that hole as
// unreferenced: the C8 detector found twelve doctor rows with no test, and six
// of them were this.
//
// Written as line comments on purpose. A block comment cannot contain the
// sequence that ends it, and the first version of this note reached for
// zero-width spaces to break it up — invisible characters in source, to
// document a bug about characters being misread.
//
// Over-stripping is still the safe direction when a case is genuinely
// ambiguous: a lost reference fails an audit loudly, a kept one hides a finding
// forever. What is fixed here is not ambiguity, it is a parse error.
//
// Not a JS parser: regex literals are not tracked, so a `/pattern/` containing
// a quote can still confuse the string states. Same failure direction as before
// (over-strip), and doing it properly needs the preceding-token analysis a real
// lexer does — out of proportion to a corpus builder.
//
// @param {string} text
// @returns {string}
function stripJsComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '/' && next === '/') {
      // Everything to the end of the line, including any `/*` written in it.
      while (i < n && text[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (text[i] === '\\') { out += text[i] + (text[i + 1] ?? ''); i += 2; continue; }
        if (text[i] === quote) break;
        // An unterminated quote would otherwise eat the rest of the file. A
        // newline ends '' and "" (they cannot span lines unescaped); a
        // template literal legitimately can, so it is allowed to continue.
        if (quote !== '`' && text[i] === '\n') break;
        out += text[i];
        i++;
      }
      if (i < n) { out += text[i]; i++; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
