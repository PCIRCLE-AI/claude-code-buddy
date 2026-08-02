/**
 * Give DOM tests a working `localStorage` on Node 26.
 *
 * Node 26 ships the Web Storage API, so `localStorage` and `sessionStorage`
 * are now globals. Without `--localstorage-file` they are accessors that
 * return `undefined`, and — this is the part that bites — they exist as OWN
 * properties of `globalThis` before any test environment is set up. vitest's
 * happy-dom environment populates globals from its `Window` and skips names
 * that are already there, so under `// @vitest-environment happy-dom` the
 * window and the global are the same object and BOTH have an undefined
 * `localStorage`. Every dashboard test that touches storage then dies on
 * `Cannot read properties of undefined (reading 'clear')`.
 *
 * Measured: broken on v26.5.1, fine on v20.20.2 / v22.23.2 / v24.15.0, where
 * Node defines no such global and happy-dom's own copy comes through.
 * happy-dom 20.11.1 — the newest release at the time of writing — does not
 * change it, so this is not something an upgrade fixes today.
 *
 * Two things this deliberately does NOT do:
 *
 *   - It does not hand-roll a Storage. The replacement is happy-dom's own
 *     `Storage`, borrowed from a throwaway `Window`, so tests on Node 26
 *     exercise the same implementation they exercise on every other version.
 *     A polyfill would make them pass against code that only exists here.
 *
 *   - It does not run for `environment: 'node'` tests. The `window` guard
 *     keeps the node-environment suite — which is nearly all of it — with
 *     exactly the globals it has on Node 24. Installing storage there would
 *     be inventing a capability the real runtime does not offer.
 *
 * `--no-experimental-webstorage` would be the tidier fix and was tried first:
 * vitest replaces `poolOptions.forks.execArgv` with its own list, so the flag
 * never reaches the worker (verified by printing `process.execArgv` inside a
 * test). Node 20 also rejects the flag outright.
 */
import { Window } from 'happy-dom';

const g = globalThis as Record<string, unknown>;

// Only in a DOM environment, and only when the name is present but broken.
//
// Reading the value is a deliberate choice over branching on
// `process.versions.node >= 26`. It asks the capability question directly, so
// it stops repairing by itself the day Node or happy-dom fixes this, whereas a
// version check would keep firing forever and would have to be revisited by
// someone who remembered why it was there. The cost is one line of Node's
// `ExperimentalWarning: localStorage is not available ...` per worker in the
// Node 26 test log — test-time noise on a path nothing parses, not a shipped
// one.
if (typeof g.window !== 'undefined') {
  const needed = (['localStorage', 'sessionStorage'] as const).filter(
    (key) => typeof g[key] === 'undefined'
  );

  if (needed.length > 0) {
    const donor = new Window() as unknown as Record<string, unknown>;
    for (const key of needed) {
      const storage = donor[key];
      if (!storage) continue;
      Object.defineProperty(g, key, {
        value: storage,
        configurable: true,
        writable: true,
        enumerable: false,
      });
    }
  }
}
