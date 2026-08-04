import fs from 'node:fs';

/**
 * The `.js` files in a hooks directory that ARE hooks: files only (so
 * `_generated/`, a directory of build mirrors, can never be counted), and
 * nothing `_`-prefixed (the existing convention for "lives here but is not a
 * hook", e.g. `_shared.js`).
 *
 * Extracted from `check-doc-claims.mjs` so the property can be TESTED against
 * a fixture directory instead of asserted by regexing this file's source —
 * the old test pinned three implementation substrings, which proved the text
 * was present, not that the text did anything.
 */
export function listHookFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.js') && !e.name.startsWith('_'))
    .map(e => e.name)
    .sort();
}
