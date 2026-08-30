#!/usr/bin/env bash
# upgrade-plugin.sh — one-liner upgrade for the Claude Code plugin install.
#
# Use:
#   bash scripts/upgrade-plugin.sh
#
# What it does:
#   1. Fast-forwards the marketplace cache under
#      ${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/marketplaces/pcircle-memesh
#      against origin.
#   2. Reads the new version from .claude-plugin/marketplace.json at the exact
#      marketplace commit that will be installed.
#   3. Stages a new install cache under the same Claude config root at
#      plugins/cache/pcircle-memesh/memesh/<new-version>/,
#      from `git archive` of the exact recorded commit (never the marketplace
#      checkout's working tree, which can hold uncommitted or tampered files).
#   4. Installs runtime deps inside that cache (npm install --omit=dev).
#   5. Patches plugins/installed_plugins.json under that config root to point at the
#      new version + path, rolling the cache swap back if the write fails,
#      the registry changed underneath it, or a signal interrupts the swap.
#   A same-version refresh (marketplace moved, version did not) is staged next
#   to the live cache and swapped in only after npm install succeeded.
#   The whole run holds a lock directory so two invocations cannot race.
#
# Why this exists:
#   Claude Code's plugin marketplace pins versions at install time and
#   does not auto-update. Without this script, every user on an old
#   version has to uninstall + reinstall from the /plugin UI to pick
#   up a new release — even for security advisories.

set -uo pipefail

if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  CLAUDE_CONFIG_ROOT="$CLAUDE_CONFIG_DIR"
elif [ -n "${HOME:-}" ]; then
  CLAUDE_CONFIG_ROOT="$HOME/.claude"
else
  echo "ERROR: neither CLAUDE_CONFIG_DIR nor HOME is set, so the Claude Code config root cannot be resolved safely." >&2
  echo "       Set CLAUDE_CONFIG_DIR to the active Claude Code config directory, then retry." >&2
  exit 1
fi
MARKETPLACE_DIR="$CLAUDE_CONFIG_ROOT/plugins/marketplaces/pcircle-memesh"
INSTALL_REGISTRY="$CLAUDE_CONFIG_ROOT/plugins/installed_plugins.json"
CACHE_ROOT="$CLAUDE_CONFIG_ROOT/plugins/cache/pcircle-memesh/memesh"
LOCK_DIR="$CACHE_ROOT.lock"

# ─── Pre-flight ────────────────────────────────────────────────────────────
if [ ! -d "$MARKETPLACE_DIR" ]; then
  echo "ERROR: marketplace cache not found at $MARKETPLACE_DIR" >&2
  echo "       Install the plugin from the Claude Code /plugin UI first." >&2
  exit 1
fi
if [ -L "$INSTALL_REGISTRY" ]; then
  echo "ERROR: installed_plugins.json is a symlink at $INSTALL_REGISTRY — refusing to replace a host-owned link." >&2
  echo "       Restore a regular Claude Code registry file, then retry." >&2
  exit 1
fi
if [ ! -f "$INSTALL_REGISTRY" ]; then
  echo "ERROR: installed_plugins.json not found at $INSTALL_REGISTRY" >&2
  echo "       Install the plugin from the Claude Code /plugin UI first." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not on PATH (needed to read/write JSON safely)." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is not on PATH (needed to install runtime deps)." >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is not on PATH (needed to fetch and archive the marketplace commit)." >&2
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "ERROR: tar is not on PATH (needed to unpack the exact marketplace commit)." >&2
  exit 1
fi

# ─── Lock: one upgrade at a time ───────────────────────────────────────────
# `mkdir` is atomic on POSIX. Refuse immediately instead of waiting on an
# ownerless directory whose process identity cannot be proven.
STAGE_PATH=""
PREVIOUS_PATH=""
NEW_INSTALL_PATH=""
HAD_LIVE_CACHE=0
SWAP_PENDING=0
LOCK_HELD=0
cleanup_on_exit() {
  exit_status=$?
  trap - EXIT INT TERM HUP
  if [ "$SWAP_PENDING" = 1 ]; then
    should_rollback=0
    if [ -e "$PREVIOUS_PATH" ] || [ -L "$PREVIOUS_PATH" ]; then
      should_rollback=1
    elif [ "$HAD_LIVE_CACHE" = 0 ] && { [ -e "$NEW_INSTALL_PATH" ] || [ -L "$NEW_INSTALL_PATH" ]; }; then
      should_rollback=1
    fi
    if [ "$should_rollback" = 1 ]; then
      echo "ERROR: upgrade interrupted during the cache swap — restoring the previous state." >&2
      SWAP_PENDING=0
      if ! rollback_swap; then
        echo "ERROR: automatic rollback failed; follow the recovery instructions above." >&2
      fi
    fi
  fi
  [ -n "$STAGE_PATH" ] && rm -rf "$STAGE_PATH"
  [ "$LOCK_HELD" = 1 ] && rmdir "$LOCK_DIR" 2>/dev/null
  exit "$exit_status"
}
handle_signal() { exit "$1"; }
install_signal_traps() {
  trap 'handle_signal 130' INT
  trap 'handle_signal 143' TERM
  trap 'handle_signal 129' HUP
}
trap cleanup_on_exit EXIT
install_signal_traps

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if [ -d "$LOCK_DIR" ]; then
    echo "ERROR: could not acquire the upgrade lock at $LOCK_DIR — another upgrade may be running." >&2
    echo "       If nothing else is actually running (a previous run crashed and left the lock behind): rmdir \"$LOCK_DIR\"" >&2
  else
    echo "ERROR: could not create the upgrade lock at $LOCK_DIR." >&2
    echo "       Its parent must exist and be writable: ${LOCK_DIR%/*}" >&2
  fi
  exit 1
fi
LOCK_HELD=1

# ─── 1. Refresh marketplace cache ─────────────────────────────────────────
echo "==> Fetching latest from marketplace origin..."
(
  cd "$MARKETPLACE_DIR" || exit 1
  CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null)" || {
    echo "ERROR: marketplace cache is on a detached HEAD — refusing to guess which branch to update." >&2
    exit 1
  }
  git fetch --quiet origin "refs/heads/$CURRENT_BRANCH:refs/remotes/origin/$CURRENT_BRANCH" || {
    echo "ERROR: git fetch failed in $MARKETPLACE_DIR" >&2
    exit 1
  }
  MERGE_ERROR="$(git merge --ff-only "origin/$CURRENT_BRANCH" --quiet 2>&1)" || {
    AHEAD_COUNT="$(git rev-list --count "origin/$CURRENT_BRANCH..HEAD" 2>/dev/null || echo unknown)"
    if [[ "$AHEAD_COUNT" =~ ^[0-9]+$ ]] && [ "$AHEAD_COUNT" -gt 0 ]; then
      echo "ERROR: marketplace cache has $AHEAD_COUNT local commit(s), so it cannot fast-forward." >&2
      echo "       Reconcile those commits with origin/$CURRENT_BRANCH, then retry." >&2
    else
      echo "ERROR: marketplace fast-forward failed; the checkout may be dirty or its history may not match origin/$CURRENT_BRANCH." >&2
      [ -n "$MERGE_ERROR" ] && echo "       $MERGE_ERROR" >&2
      echo "       Inspect it without discarding work: git -C \"$MARKETPLACE_DIR\" status --short" >&2
    fi
    exit 1
  }
) || exit 1

# ─── 2. Bind the exact marketplace commit and read its version ────────────
MARKETPLACE_SHA="$(git -C "$MARKETPLACE_DIR" rev-parse HEAD 2>/dev/null)" || {
  echo "ERROR: could not read the marketplace checkout's commit ($MARKETPLACE_DIR)" >&2
  exit 1
}
if ! [[ "$MARKETPLACE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: marketplace HEAD is not a full 40-hex commit: $MARKETPLACE_SHA" >&2
  exit 1
fi

# Read from the same immutable commit that section 3 archives. A dirty tracked
# marketplace.json must never redirect committed bytes into a different
# version directory or produce a version/commit pair that never coexisted.
NEW_VERSION="$(
  git -C "$MARKETPLACE_DIR" show "$MARKETPLACE_SHA:.claude-plugin/marketplace.json" |
  node -e "
  const fs = require('fs');
  const j = JSON.parse(fs.readFileSync(0, 'utf8'));
  const e = (j.plugins || []).find(x => x && x.name === 'memesh');
  if (!e || typeof e.version !== 'string') { process.exit(2); }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(e.version);
  const prerelease = match && match[4] ? match[4].split('.') : [];
  if (!match || prerelease.some(x => /^\d+$/.test(x) && x.length > 1 && x.startsWith('0'))) {
    console.error('ERROR: marketplace.json reported an unsafe version string: ' + e.version);
    process.exit(3);
  }
  process.stdout.write(e.version);
  "
)" || {
  echo "ERROR: could not read memesh version from marketplace.json at commit $MARKETPLACE_SHA" >&2
  exit 1
}

echo "==> Target version: $NEW_VERSION"
NEW_INSTALL_PATH="$CACHE_ROOT/$NEW_VERSION"

# Which registry entry is THIS install? Claude Code keeps one entry per scope
# (user / project / local); reading entries[0] on a machine with two of them
# reports another cache's version and sha, and section 5 would then rewrite
# the wrong entry. Pick the entry whose installPath sits under this cache
# root; fall back only to a sole legacy entry with no installPath; refuse when
# a path points elsewhere or the registry is ambiguous. Resolve authority and
# capture its index/version/sha and the complete registry digest in this ONE
# read. The index is used later only after the registry's exact bytes still
# match this digest, so a concurrent reorder cannot redirect the write.
ENTRY_SNAPSHOT="$(INSTALL_REGISTRY="$INSTALL_REGISTRY" CACHE_ROOT="$CACHE_ROOT" NEW_VERSION="$NEW_VERSION" node -e "
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const registryPath = process.env.INSTALL_REGISTRY;
  let before, fd;
  try {
    before = fs.lstatSync(registryPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      process.stdout.write('identity-changed');
      process.exit(0);
    }
    fd = fs.openSync(registryPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    const raceCodes = new Set(['ELOOP', 'ENOENT', 'ENOTDIR']);
    process.stdout.write(raceCodes.has(error && error.code) ? 'identity-changed' : 'unreadable');
    process.exit(0);
  }
  let opened, registryText;
  try {
    opened = fs.fstatSync(fd, { bigint: true });
    registryText = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  const after = fs.lstatSync(registryPath, { bigint: true });
  const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
  if (!before.isFile() || before.isSymbolicLink() || !sameFile(before, opened) || !sameFile(opened, after)) {
    process.stdout.write('identity-changed');
    process.exit(0);
  }
  const registrySha256 = crypto.createHash('sha256').update(registryText).digest('hex');
  const j = JSON.parse(registryText);
  const raw = j && j.plugins ? j.plugins['memesh@pcircle-memesh'] : undefined;
  const entries = raw === undefined ? [] : raw;
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!Array.isArray(entries) || entries.some(entry => !isRecord(entry))) {
    process.stdout.write('malformed');
    process.exit(0);
  }
  if (entries.length === 0) { process.stdout.write('none'); process.exit(0); }
  const root = path.resolve(process.env.CACHE_ROOT) + path.sep;
  const underRoot = entries
    .map((e, i) => i)
    .filter(i => {
      const e = entries[i];
      return typeof e.installPath === 'string'
        && path.isAbsolute(e.installPath)
        && (path.resolve(e.installPath) + path.sep).startsWith(root);
    });
  // Exactly one entry lives under this cache root: use it. A sole legacy
  // entry with no usable installPath is also identifiable. Anything else — none
  // matching with several entries present, or more than one matching — is
  // ambiguous; guessing which scope to touch is how the wrong one gets
  // rewritten.
  let index;
  if (underRoot.length === 1) index = underRoot[0];
  const sole = entries.length === 1 ? entries[0] : null;
  const soleHasPath = sole && typeof sole.installPath === 'string' && sole.installPath.length > 0;
  if (underRoot.length === 0 && sole && !soleHasPath) index = 0;
  if (underRoot.length === 0 && soleHasPath) { process.stdout.write('outside-root'); process.exit(0); }
  // Two different, accurate refusals: several entries live under this root
  // (which one is THIS install?) vs. none do and there is more than one
  // entry (nothing to disambiguate by at all). Collapsing both into one
  // 'ambiguous' value produced a message that said 'none of them lives
  // under \$CACHE_ROOT' even when the real problem was the opposite —
  // several of them did.
  if (index === undefined) {
    process.stdout.write(underRoot.length > 1 ? 'ambiguous-multiple' : 'ambiguous-none');
    process.exit(0);
  }
  const entry = entries[index];
  const version = typeof entry.version === 'string' && !/[\\r\\n\\t]/.test(entry.version)
    ? entry.version
    : 'unknown';
  const sha = typeof entry.gitCommitSha === 'string' && /^[0-9a-f]{40}$/.test(entry.gitCommitSha)
    ? entry.gitCommitSha
    : 'unknown';
  const expectedPath = path.join(path.resolve(process.env.CACHE_ROOT), process.env.NEW_VERSION);
  const installPathState = typeof entry.installPath === 'string'
    && path.isAbsolute(entry.installPath)
    && path.resolve(entry.installPath) === expectedPath
    ? 'canonical'
    : 'noncanonical';
  process.stdout.write(['selected', index, version, sha, registrySha256, installPathState, String(opened.dev), String(opened.ino)].join('\\t'));
")" || {
  echo "ERROR: could not read the installed memesh entries from $INSTALL_REGISTRY" >&2
  exit 1
}
IFS=$'\t' read -r ENTRY_STATE ENTRY_INDEX CURRENT_VERSION INSTALLED_SHA ORIGINAL_REGISTRY_SHA256 INSTALL_PATH_STATE ORIGINAL_REGISTRY_DEV ORIGINAL_REGISTRY_INO <<< "$ENTRY_SNAPSHOT"
case "$ENTRY_STATE" in
  identity-changed)
    echo "ERROR: installed_plugins.json changed file identity while this upgrade was reading it — refusing to continue." >&2
    exit 1
    ;;
  unreadable)
    echo "ERROR: installed_plugins.json could not be opened safely at $INSTALL_REGISTRY — refusing to continue." >&2
    exit 1
    ;;
  ambiguous-multiple)
    echo "ERROR: installed_plugins.json lists several memesh entries under $CACHE_ROOT — refusing to guess which one to upgrade." >&2
    exit 1
    ;;
  ambiguous-none)
    echo "ERROR: installed_plugins.json lists several memesh entries and none of them lives under $CACHE_ROOT — refusing to guess which one to upgrade." >&2
    exit 1
    ;;
  outside-root)
    echo "ERROR: the only memesh entry in installed_plugins.json lives outside $CACHE_ROOT — refusing to guess which scope to upgrade." >&2
    exit 1
    ;;
  malformed)
    echo "ERROR: installed_plugins.json has a malformed memesh@pcircle-memesh entry — refusing to guess which scope to upgrade." >&2
    exit 1
    ;;
  none)
    # Refuse before touching the filesystem: section 6 has no entry to update.
    echo "ERROR: installed_plugins.json has no memesh@pcircle-memesh entry — nothing to upgrade in place." >&2
    echo "       Reinstall the plugin from the Claude Code /plugin UI." >&2
    exit 1
    ;;
esac
if [ "$ENTRY_STATE" != "selected" ] \
  || ! [[ "$ENTRY_INDEX" =~ ^[0-9]+$ ]] \
  || ! [[ "$ORIGINAL_REGISTRY_SHA256" =~ ^[0-9a-f]{64}$ ]] \
  || ! [[ "$ORIGINAL_REGISTRY_DEV" =~ ^[0-9]+$ ]] \
  || ! [[ "$ORIGINAL_REGISTRY_INO" =~ ^[0-9]+$ ]] \
  || { [ "$INSTALL_PATH_STATE" != "canonical" ] && [ "$INSTALL_PATH_STATE" != "noncanonical" ]; }; then
  echo "ERROR: could not select one installed memesh entry from $INSTALL_REGISTRY" >&2
  exit 1
fi

echo "==> Currently installed: $CURRENT_VERSION"

# Same version is NOT "same code". Claude Code keys the plugin cache by
# version, and so did this script — which is exactly how a machine that
# auto-updated between the `release: prepare v4.8.2` commit and the two fix
# PRs that merged under the same version kept serving a 4.8.2 that lacked
# them, and was told "Already at 4.8.2 — nothing to do." The registry
# records the commit the cache was staged from (section 5 below); compare
# that, not the version string. CURRENT_VERSION and INSTALLED_SHA came from
# the same authority-bound registry snapshot above.

if [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
  if [ "$INSTALLED_SHA" = "$MARKETPLACE_SHA" ] \
    && [ "$INSTALL_PATH_STATE" = "canonical" ] \
    && [ -d "$NEW_INSTALL_PATH" ] \
    && [ ! -L "$NEW_INSTALL_PATH" ]; then
    echo "==> Already at $NEW_VERSION (commit ${MARKETPLACE_SHA:0:8}) — nothing to do."
    exit 0
  fi
  if [ "$INSTALLED_SHA" != "$MARKETPLACE_SHA" ]; then
    echo "==> $NEW_VERSION is installed, but the plugin cache was built from commit ${INSTALLED_SHA:0:8}"
    echo "    and the marketplace is at ${MARKETPLACE_SHA:0:8} — refreshing the cache in place."
  elif [ "$INSTALL_PATH_STATE" != "canonical" ]; then
    echo "==> $NEW_VERSION is recorded at a noncanonical cache path — repairing it at $NEW_INSTALL_PATH."
  else
    echo "==> $NEW_VERSION is recorded at $NEW_INSTALL_PATH, but that path is missing or not a real directory — repairing it."
  fi
fi

# ─── 3. Stage into a sibling, never into the live cache ───────────────────
# A same-version refresh targets the directory Claude Code is running from.
# Staging straight into it and then a failed npm install would leave new
# code with old or missing dependencies and the old registry sha — a broken
# install that the next restart loads. So: build the whole thing next to the
# live cache, and only swap once every step has succeeded.
STAGE_PATH="$CACHE_ROOT/.staging-$NEW_VERSION-$$"
PREVIOUS_PATH="$CACHE_ROOT/.previous-$NEW_VERSION-$$"

# Remove the failed candidate before restoring the previous cache. Never move
# the previous cache while the failed live path still exists: `mv` would nest
# it below that directory and make the postcondition look successful.
rollback_swap() {
  # Cache removal + restoration is one short recovery transaction. A second
  # signal after the failed candidate is removed but before the previous cache
  # is restored must not strand the install with only .previous-* left behind.
  trap '' INT TERM HUP
  rm -rf "$NEW_INSTALL_PATH" 2>/dev/null
  if [ -e "$NEW_INSTALL_PATH" ] || [ -L "$NEW_INSTALL_PATH" ]; then
    echo "ERROR: could not remove the broken cache at $NEW_INSTALL_PATH." >&2
    if [ -e "$PREVIOUS_PATH" ] || [ -L "$PREVIOUS_PATH" ]; then
      echo "       The previous cache is still intact at $PREVIOUS_PATH; installed_plugins.json remains unchanged." >&2
      echo "       Remove the broken cache, then restore the previous cache manually:" >&2
      echo "       rm -rf \"$NEW_INSTALL_PATH\"" >&2
      echo "       mv \"$PREVIOUS_PATH\" \"$NEW_INSTALL_PATH\"" >&2
    else
      echo "       installed_plugins.json was not updated to point at it, so it is orphaned. Remove it manually:" >&2
      echo "       rm -rf \"$NEW_INSTALL_PATH\"" >&2
    fi
    return 1
  fi
  if [ -e "$PREVIOUS_PATH" ] || [ -L "$PREVIOUS_PATH" ]; then
    mv "$PREVIOUS_PATH" "$NEW_INSTALL_PATH" 2>/dev/null
    if { [ -e "$NEW_INSTALL_PATH" ] || [ -L "$NEW_INSTALL_PATH" ]; } \
      && [ ! -e "$PREVIOUS_PATH" ] \
      && [ ! -L "$PREVIOUS_PATH" ]; then
      echo "Rollback succeeded: restored the previous cache; installed_plugins.json remains unchanged." >&2
      return 0
    fi
    echo "ERROR: could not restore the previous cache." >&2
    if [ -e "$PREVIOUS_PATH" ] || [ -L "$PREVIOUS_PATH" ]; then
      echo "       It is still intact at $PREVIOUS_PATH — move it back manually:" >&2
      echo "       mv \"$PREVIOUS_PATH\" \"$NEW_INSTALL_PATH\"" >&2
    else
      echo "       It is gone from $PREVIOUS_PATH and $NEW_INSTALL_PATH is also missing. This should not happen — check $CACHE_ROOT by hand." >&2
    fi
    return 1
  fi
  echo "Cleanup succeeded: no failed cache remains; installed_plugins.json remains unchanged." >&2
  return 0
}

echo "==> Staging $NEW_VERSION next to the cache..."
if ! rm -rf "$STAGE_PATH"; then
  echo "ERROR: could not clear the staging path at $STAGE_PATH — the live cache was not touched." >&2
  exit 1
fi
if ! mkdir -p "$STAGE_PATH"; then
  echo "ERROR: could not create the staging directory at $STAGE_PATH — the live cache was not touched." >&2
  exit 1
fi
# `git archive`, not `rsync` of the working tree: rsync would copy whatever
# is sitting in $MARKETPLACE_DIR right now, including files nobody committed
# — so a machine with a tampered or half-merged marketplace checkout could
# have those bytes installed while MARKETPLACE_SHA (recorded above, and
# written into the registry in section 6) truthfully names a clean commit
# that never contained them. `git archive` extracts exactly the tree at
# $MARKETPLACE_SHA; nothing untracked or uncommitted can reach the cache.
# node_modules and .git are never tracked, so they never appear in the
# archive; tests/benchmarks/docs/plans are tracked (real source) and are
# removed after extraction to keep the shipped cache the same shape as
# before.
git -C "$MARKETPLACE_DIR" archive "$MARKETPLACE_SHA" | tar -x -C "$STAGE_PATH" || {
  echo "ERROR: git archive failed — the live cache at $NEW_INSTALL_PATH was not touched" >&2
  exit 1
}
if ! rm -rf "$STAGE_PATH/tests" "$STAGE_PATH/benchmarks" "$STAGE_PATH/docs/plans"; then
  echo "ERROR: could not remove development-only files from the staging copy — the live cache was not touched." >&2
  exit 1
fi

# ─── 4. Install runtime deps in the staging copy ──────────────────────────
echo "==> Installing runtime deps (this may take a minute)..."
(
  cd "$STAGE_PATH" || exit 1
  npm install --omit=dev --no-audit --no-fund --silent
) || {
  echo "ERROR: npm install failed in the staging copy — the live cache at $NEW_INSTALL_PATH was not touched" >&2
  exit 1
}

# ─── 5. Swap the staged copy in ───────────────────────────────────────────
if [ -e "$NEW_INSTALL_PATH" ] || [ -L "$NEW_INSTALL_PATH" ]; then
  HAD_LIVE_CACHE=1
fi
SWAP_PENDING=1
if [ "$HAD_LIVE_CACHE" = 1 ]; then
  mv "$NEW_INSTALL_PATH" "$PREVIOUS_PATH" || {
    SWAP_PENDING=0
    echo "ERROR: could not move the live cache aside — nothing was changed" >&2
    exit 1
  }
fi
mv "$STAGE_PATH" "$NEW_INSTALL_PATH" || {
  echo "ERROR: could not move the staged copy into place." >&2
  SWAP_PENDING=0
  rollback_swap
  exit 1
}

# ─── 6. Patch installed_plugins.json (last: the registry names a cache that exists) ──
# Compare the complete registry snapshot captured during authority selection,
# then write and rename in one Node process. Re-check the snapshot immediately
# before rename to detect host writes observed up to that point. Ignore signals
# only for this short registry critical section;
# before it, the signal trap restores the cache, and after it the registry and
# live path already agree.
echo "==> Updating installed_plugins.json..."
trap '' INT TERM HUP
NEW_INSTALL_PATH="$NEW_INSTALL_PATH" \
NEW_VERSION="$NEW_VERSION" \
INSTALL_REGISTRY="$INSTALL_REGISTRY" \
MARKETPLACE_SHA="$MARKETPLACE_SHA" \
ORIGINAL_REGISTRY_SHA256="$ORIGINAL_REGISTRY_SHA256" \
ORIGINAL_REGISTRY_DEV="$ORIGINAL_REGISTRY_DEV" \
ORIGINAL_REGISTRY_INO="$ORIGINAL_REGISTRY_INO" \
ENTRY_INDEX="$ENTRY_INDEX" \
node -e "
  const fs = require('fs'), crypto = require('crypto');
  const registryPath = process.env.INSTALL_REGISTRY;
  const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
  const expectedDev = BigInt(process.env.ORIGINAL_REGISTRY_DEV);
  const expectedIno = BigInt(process.env.ORIGINAL_REGISTRY_INO);
  const assertOriginalFile = stat => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== expectedDev || stat.ino !== expectedIno) {
      throw new Error('registry file identity changed since this upgrade started');
    }
  };
  const readOriginalFile = () => {
    const before = fs.lstatSync(registryPath, { bigint: true });
    assertOriginalFile(before);
    const fd = fs.openSync(registryPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      assertOriginalFile(opened);
      const text = fs.readFileSync(fd, 'utf8');
      assertOriginalFile(fs.lstatSync(registryPath, { bigint: true }));
      return { text, mode: Number(opened.mode & 0o777n) };
    } finally {
      fs.closeSync(fd);
    }
  };
  const original = readOriginalFile();
  const registryText = original.text;
  if (sha256(registryText) !== process.env.ORIGINAL_REGISTRY_SHA256) {
    console.error('the complete registry changed since this upgrade started');
    process.exit(2);
  }
  const j = JSON.parse(registryText);
  const registryMode = original.mode;
  const entries = j.plugins && j.plugins['memesh@pcircle-memesh'];
  const idx = Number(process.env.ENTRY_INDEX);
  const entry = Array.isArray(entries) ? entries[idx] : undefined;
  if (!Number.isSafeInteger(idx) || idx < 0 || entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    console.error('the authority-selected registry entry is no longer structurally valid');
    process.exit(2);
  }
  entry.installPath = process.env.NEW_INSTALL_PATH;
  entry.version = process.env.NEW_VERSION;
  entry.lastUpdated = new Date().toISOString();
  // Read once above (MARKETPLACE_SHA); the staleness check compares against it next run.
  entry.gitCommitSha = process.env.MARKETPLACE_SHA;
  entries[idx] = entry;
  const tmp = registryPath + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(j, null, 4) + '\n', { mode: registryMode });
    fs.chmodSync(tmp, registryMode);
    if (sha256(readOriginalFile().text) !== process.env.ORIGINAL_REGISTRY_SHA256) {
      throw new Error('the complete registry changed immediately before the atomic write');
    }
    assertOriginalFile(fs.lstatSync(registryPath, { bigint: true }));
    fs.renameSync(tmp, registryPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
"
REGISTRY_STATUS=$?
if [ "$REGISTRY_STATUS" = 0 ]; then
  SWAP_PENDING=0
fi
install_signal_traps
if [ "$REGISTRY_STATUS" != 0 ]; then
  echo "ERROR: failed to update installed_plugins.json." >&2
  SWAP_PENDING=0
  rollback_swap
  exit 1
fi
rm -rf "$PREVIOUS_PATH" 2>/dev/null
if [ -e "$PREVIOUS_PATH" ] || [ -L "$PREVIOUS_PATH" ]; then
  echo "WARNING: upgrade succeeded, but the previous cache could not be removed at $PREVIOUS_PATH." >&2
  echo "         Remove it manually when no Claude Code process is using it: rm -rf \"$PREVIOUS_PATH\"" >&2
fi

# ─── 7. Done ─────────────────────────────────────────────────────────────
echo ""
echo "✓ MeMesh upgraded: $CURRENT_VERSION (${INSTALLED_SHA:0:8}) -> $NEW_VERSION (${MARKETPLACE_SHA:0:8})"
echo "  Install path: $NEW_INSTALL_PATH"
echo ""
echo "Next step: restart Claude Code so the new MCP server picks up."
