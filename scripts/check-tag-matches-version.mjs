import fs from 'node:fs';

/**
 * Fail if the release tag and package.json disagree about the version.
 *
 * `publish-npm.yml` fires on `release: published` and publishes whatever
 * version package.json carries, with nothing comparing it to the tag the
 * release was cut from. Two ways that goes wrong:
 *
 *   - Tag `v4.2.12` on a commit whose package.json says `4.3.0` publishes
 *     4.3.0 while the GitHub release advertises v4.2.12. Users install a
 *     version whose release notes describe something else.
 *   - Tag a commit whose package.json still says an already-published version
 *     and the run fails at the very last step, after ~10 minutes of build,
 *     tests and two smoke suites.
 *
 * Both are cheap to catch first. Accepts `v4.2.11` and `4.2.11`.
 *
 * Usage: node scripts/check-tag-matches-version.mjs <tag>
 */
const rawTag = process.argv[2];

if (!rawTag) {
  console.error('✗ no tag given. Usage: node scripts/check-tag-matches-version.mjs <tag>');
  process.exit(1);
}

const tag = rawTag.trim().replace(/^v/, '');
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));

if (tag !== version) {
  console.error(
    `✗ release tag and package.json disagree:\n` +
      `    tag:          ${rawTag}\n` +
      `    package.json: ${version}\n\n` +
      `  Publishing would ship ${version} under a release advertising ${rawTag}.\n` +
      `  Fix the version anchors (npm run check:versions) or re-cut the release on the right commit.`
  );
  process.exit(1);
}

console.log(`✓ release tag ${rawTag} matches package.json ${version}`);
