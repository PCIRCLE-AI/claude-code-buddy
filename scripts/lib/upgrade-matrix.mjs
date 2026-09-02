/**
 * Which upgrade paths the packed-upgrade gate has to prove.
 *
 * `scripts/smoke-packed-upgrade.mjs` used to name both ends of the one path
 * it tested by hand: `expectedPreviousVersion = '4.8.2'` and
 * `expectedCandidateVersion = '4.8.3'`, with the candidate spelled out again
 * inside the auto-update shim and three regex assertions. Seventy versions are
 * published. The moment 4.8.4 shipped, that pin would have gone on passing
 * while proving an upgrade nobody performs — a green gate for a path out of
 * use, which is the same shape as every incident this repository has had:
 * a check that cannot go red for the thing it is named after.
 *
 * So the ends are derived instead. The candidate comes from `package.json`,
 * and the from-versions come from the registry the users install from:
 *
 *   - the newest published release below the candidate, which is what almost
 *     every upgrade actually starts from, plus the current `latest` dist-tag
 *     when that is a different, older version (a dist-tag can be moved back
 *     to a version that is not the highest one published);
 *   - the oldest published release that installs without a native build. That
 *     row is the long migration chain — a database made by that version
 *     predates the `title` column, the delivery `target_kind` column, FTS
 *     segmentation v3 and the tags unique index. Older releases than that
 *     depend on `better-sqlite3`, whose install compiles against the running
 *     Node ABI; including them would make the gate red for the toolchain
 *     rather than for the candidate.
 *
 * Every function here is pure except `fetchPackument`, so
 * `tests/upgrade-matrix.test.ts` can drive the selection with a fabricated
 * registry document and no network.
 */

/**
 * Dependencies whose installation compiles native code.
 *
 * One name, because one is what this package has ever had: `better-sqlite3`,
 * removed in the release after 4.5.0 when storage moved to `node:sqlite`.
 */
export const NATIVE_BUILD_DEPENDENCIES = ['better-sqlite3'];

/** `X.Y.Z` and nothing else — a prerelease is not an upgrade path users take. */
const RELEASE_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * @param {string} version
 * @returns {[number, number, number] | null} numeric parts, or null when the
 *   version is not a plain release
 */
export function parseRelease(version) {
  const match = RELEASE_PATTERN.exec(String(version ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Order two plain releases. Throws on anything this package has never
 * published rather than sorting it to an arbitrary place.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b
 */
export function compareReleases(a, b) {
  const left = parseRelease(a);
  const right = parseRelease(b);
  if (!left || !right) throw new Error(`not a plain X.Y.Z release: ${!left ? a : b}`);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * Does this version's dependency set require a native build?
 *
 * @param {Record<string, string> | undefined} dependencies
 * @returns {boolean}
 */
export function needsNativeBuild(dependencies) {
  const names = Object.keys(dependencies ?? {});
  return NATIVE_BUILD_DEPENDENCIES.some((native) => names.includes(native));
}

/**
 * The from-versions the gate must prove an upgrade from, ascending.
 *
 * Fails loudly rather than returning fewer rows: an empty or short matrix is
 * indistinguishable from a passing one once the gate is green, and that is
 * the failure this whole module exists to remove.
 *
 * @param {{ 'dist-tags'?: Record<string, string>, versions?: Record<string, { dependencies?: Record<string, string> }> }} packument
 *   the abbreviated registry document for the package
 * @param {string} candidateVersion the version in the working tree
 * @returns {string[]} distinct published versions, ascending
 */
export function selectUpgradePaths(packument, candidateVersion) {
  if (!parseRelease(candidateVersion)) {
    throw new Error(`candidate version is not a plain X.Y.Z release: ${candidateVersion}`);
  }

  const versions = packument?.versions ?? {};
  const older = Object.keys(versions)
    .filter((version) => parseRelease(version))
    .filter((version) => compareReleases(version, candidateVersion) < 0)
    .sort(compareReleases);

  if (older.length === 0) {
    throw new Error(
      `the registry has no published release below ${candidateVersion}, so there is no upgrade to prove`,
    );
  }

  const previous = older[older.length - 1];
  const buildless = older.filter((version) => !needsNativeBuild(versions[version]?.dependencies));
  if (buildless.length === 0) {
    throw new Error(
      'every published release below the candidate depends on a package that needs a native build '
        + `(${NATIVE_BUILD_DEPENDENCIES.join(', ')}), so no long-chain upgrade row can be installed`,
    );
  }

  const paths = new Set([previous, buildless[0]]);

  // A dist-tag can point below the highest published version — that is what
  // users on `latest` would upgrade from, so prove that path too.
  const latest = packument?.['dist-tags']?.latest;
  if (latest && parseRelease(latest) && compareReleases(latest, candidateVersion) < 0) {
    paths.add(latest);
  }

  return [...paths].sort(compareReleases);
}

/** How long a registry lookup may take before the gate gives up. */
export const REGISTRY_TIMEOUT_MS = 30_000;

/** npm's own package-name grammar: an optional scope, then one name. */
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9\-._]*\/)?[a-z0-9][a-z0-9\-._]*$/;

/**
 * The registry URL for a package's packument.
 *
 * Two things, because one was not enough. `packageName.replace('/', '%2f')`
 * substitutes only the FIRST match — a name carrying a second separator kept
 * it, and a path segment that survives into a URL is a traversal waiting for
 * an input that is not a constant (CodeQL js/incomplete-sanitization, high,
 * on this exact line). Replacing every occurrence closes that, and rejecting
 * anything that is not an npm package name closes the question of what else
 * could arrive here — the value is validated before it is used, not repaired
 * after.
 *
 * @param {string} registry registry base URL, from `npm config get registry`
 * @param {string} packageName e.g. `@pcircle/memesh`
 * @returns {string}
 */
export function packumentUrl(registry, packageName) {
  if (!PACKAGE_NAME_PATTERN.test(packageName)) {
    throw new Error(`not an npm package name: ${packageName}`);
  }
  const base = registry.endsWith('/') ? registry : `${registry}/`;
  return `${base}${packageName.replaceAll('/', '%2f')}`;
}

/**
 * Every path that was derived must have been proven.
 *
 * The gap this closes was measured: changing the runner's loop to
 * `upgradePaths.slice(0, 1)` proved one row instead of two, printed a
 * cheerful summary and exited 0, and all 55 tests over these files stayed
 * green. Nothing in the repository could tell a two-row matrix from a
 * one-row one — which is the same defect, in the gate itself, that the gate
 * exists to prevent.
 *
 * @param {string[]} derived what selectUpgradePaths returned
 * @param {string[]} proven what the runner actually ran
 * @throws when a derived path was skipped, or a path nobody derived was run
 */
export function assertEveryPathProven(derived, proven) {
  const missing = derived.filter((version) => !proven.includes(version));
  const unexpected = proven.filter((version) => !derived.includes(version));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `the upgrade matrix proved ${proven.length} of ${derived.length} derived paths`
        + (missing.length > 0 ? `; never proved: ${missing.join(', ')}` : '')
        + (unexpected.length > 0 ? `; proved but never derived: ${unexpected.join(', ')}` : ''),
    );
  }
}

/**
 * The abbreviated packument for a package, from the registry npm is
 * configured to use.
 *
 * @param {string} packageName e.g. `@pcircle/memesh`
 * @param {string} registry registry base URL, from `npm config get registry`
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<object>}
 */
export async function fetchPackument(packageName, registry, fetchImpl = fetch) {
  const url = packumentUrl(registry, packageName);
  // The timeout lives here rather than at a call site: it was added to one of
  // the two callers, which reads as "the registry lookup is bounded" while
  // the other one could still hang on undici's multi-minute default.
  const response = await fetchImpl(url, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`registry lookup failed: ${url} answered ${response.status}`);
  }
  return response.json();
}
