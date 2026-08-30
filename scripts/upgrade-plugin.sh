#!/usr/bin/env bash
# upgrade-plugin.sh — one-liner upgrade for the Claude Code plugin install.
#
# Use:
#   bash scripts/upgrade-plugin.sh
#
# What it does:
#   1. Fast-forwards the marketplace cache (~/.claude/plugins/marketplaces/pcircle-memesh)
#      against origin.
#   2. Reads the new version from .claude-plugin/marketplace.json.
#   3. Stages a new install cache at ~/.claude/plugins/cache/pcircle-memesh/memesh/<new-version>/,
#      from `git archive` of the exact recorded commit (never the marketplace
#      checkout's working tree, which can hold uncommitted or tampered files).
#   4. Installs runtime deps inside that cache (npm install --omit=dev).
#   5. Patches ~/.claude/plugins/installed_plugins.json to point at the
#      new version + path, atomically, rolling the cache swap back if the
#      write fails or the registry changed underneath it.
#   6. Leaves the previous version on disk (you can delete it manually if you want).
#   A same-version refresh (marketplace moved, version did not) is staged next
#   to the live cache and swapped in only after npm install succeeded.
#
# Why this exists:
#   Claude Code's plugin marketplace pins versions at install time and
#   does not auto-update. Without this script, every user on an old
#   version has to uninstall + reinstall from the /plugin UI to pick
#   up a new release — even for security advisories.

set -uo pipefail

MARKETPLACE_DIR="$HOME/.claude/plugins/marketplaces/pcircle-memesh"
INSTALL_REGISTRY="$HOME/.claude/plugins/installed_plugins.json"
CACHE_ROOT="$HOME/.claude/plugins/cache/pcircle-memesh/memesh"

# ─── Pre-flight ────────────────────────────────────────────────────────────
if [ ! -d "$MARKETPLACE_DIR" ]; then
  echo "ERROR: marketplace cache not found at $MARKETPLACE_DIR" >&2
  echo "       Install the plugin from the Claude Code /plugin UI first." >&2
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

# ─── 1. Refresh marketplace cache ─────────────────────────────────────────
echo "==> Fetching latest from marketplace origin..."
(
  cd "$MARKETPLACE_DIR" || exit 1
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  git fetch origin "$CURRENT_BRANCH" --quiet || {
    echo "ERROR: git fetch failed in $MARKETPLACE_DIR" >&2
    exit 1
  }
  git merge --ff-only "origin/$CURRENT_BRANCH" --quiet || {
    echo "ERROR: marketplace cache has local commits — refusing fast-forward." >&2
    echo "       Reset it: cd $MARKETPLACE_DIR && git reset --hard origin/$CURRENT_BRANCH" >&2
    exit 1
  }
) || exit 1

# ─── 2. Read new version ──────────────────────────────────────────────────
# Pass paths via env vars so bash variables never become JS string literals
# — quote-safety + injection-safety in one move. Same pattern as section 5.
NEW_VERSION="$(MARKETPLACE_DIR="$MARKETPLACE_DIR" node -e "
  const fs = require('fs');
  const p = process.env.MARKETPLACE_DIR + '/.claude-plugin/marketplace.json';
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const e = (j.plugins || []).find(x => x && x.name === 'memesh');
  if (!e || typeof e.version !== 'string') { process.exit(2); }
  process.stdout.write(e.version);
")" || {
  echo "ERROR: could not read memesh version from marketplace.json" >&2
  exit 1
}

if ! [[ "$NEW_VERSION" =~ ^[0-9A-Za-z.+-]+$ ]]; then
  echo "ERROR: marketplace.json reported an unsafe version string: $NEW_VERSION" >&2
  exit 1
fi

echo "==> Target version: $NEW_VERSION"

# Which registry entry is THIS install? Claude Code keeps one entry per scope
# (user / project / local); reading entries[0] on a machine with two of them
# reports another cache's version and sha, and section 5 would then rewrite
# the wrong entry. Pick the entry whose installPath sits under this cache
# root; fall back to the only entry; refuse when it is ambiguous.
ENTRY_INDEX="$(INSTALL_REGISTRY="$INSTALL_REGISTRY" CACHE_ROOT="$CACHE_ROOT" node -e "
  const fs = require('fs'), path = require('path');
  const j = JSON.parse(fs.readFileSync(process.env.INSTALL_REGISTRY, 'utf8'));
  const entries = (j.plugins && j.plugins['memesh@pcircle-memesh']) || [];
  if (entries.length === 0) { process.stdout.write('none'); process.exit(0); }
  const root = path.resolve(process.env.CACHE_ROOT) + path.sep;
  const underRoot = entries
    .map((e, i) => i)
    .filter(i => { const e = entries[i]; return e && typeof e.installPath === 'string' && (path.resolve(e.installPath) + path.sep).startsWith(root); });
  // Exactly one entry lives under this cache root: use it. None do, but there
  // is exactly one entry total: it must be this install (a fresh registry, or
  // one from before installPath was under CACHE_ROOT). Anything else — none
  // matching with several entries present, or more than one matching — is
  // ambiguous; guessing which scope to touch is how the wrong one gets
  // rewritten.
  if (underRoot.length === 1) { process.stdout.write(String(underRoot[0])); process.exit(0); }
  if (underRoot.length === 0 && entries.length === 1) { process.stdout.write('0'); process.exit(0); }
  // Two different, accurate refusals: several entries live under this root
  // (which one is THIS install?) vs. none do and there is more than one
  // entry (nothing to disambiguate by at all). Collapsing both into one
  // 'ambiguous' value produced a message that said 'none of them lives
  // under \$CACHE_ROOT' even when the real problem was the opposite —
  // several of them did.
  process.stdout.write(underRoot.length > 1 ? 'ambiguous-multiple' : 'ambiguous-none');
")" || {
  echo "ERROR: could not read the installed memesh entries from $INSTALL_REGISTRY" >&2
  exit 1
}
if [ "$ENTRY_INDEX" = "ambiguous-multiple" ]; then
  echo "ERROR: installed_plugins.json lists several memesh entries under $CACHE_ROOT — refusing to guess which one to upgrade." >&2
  exit 1
fi
if [ "$ENTRY_INDEX" = "ambiguous-none" ]; then
  echo "ERROR: installed_plugins.json lists several memesh entries and none of them lives under $CACHE_ROOT — refusing to guess which one to upgrade." >&2
  exit 1
fi
# Refuse before touching the filesystem, not after staging + swapping — a
# registry with no memesh entry at all has nothing for section 6 to update,
# and finding that out after the cache is already swapped would leave new
# code live with no registry record of it.
if [ "$ENTRY_INDEX" = "none" ]; then
  echo "ERROR: installed_plugins.json has no memesh@pcircle-memesh entry — nothing to upgrade in place." >&2
  echo "       Reinstall the plugin from the Claude Code /plugin UI." >&2
  exit 1
fi

# The identity that survives to the write in section 6. Not the numeric
# index — a position is only meaningful against the array it was computed
# from, and by section 6 that array may have changed (another process ran
# meanwhile). The entry's installPath, captured now, is the one value stable
# enough to re-find the SAME entry later — or to notice it is gone.
ORIGINAL_INSTALL_PATH="$(INSTALL_REGISTRY="$INSTALL_REGISTRY" ENTRY_INDEX="$ENTRY_INDEX" node -e "
  const fs = require('fs');
  const j = JSON.parse(fs.readFileSync(process.env.INSTALL_REGISTRY, 'utf8'));
  const entries = (j.plugins && j.plugins['memesh@pcircle-memesh']) || [];
  const entry = entries[Number(process.env.ENTRY_INDEX)];
  process.stdout.write(typeof entry.installPath === 'string' ? entry.installPath : '');
")" || {
  echo "ERROR: could not read the installed memesh entries from $INSTALL_REGISTRY" >&2
  exit 1
}

CURRENT_VERSION="$(INSTALL_REGISTRY="$INSTALL_REGISTRY" ENTRY_INDEX="$ENTRY_INDEX" node -e "
  const fs = require('fs');
  const j = JSON.parse(fs.readFileSync(process.env.INSTALL_REGISTRY, 'utf8'));
  const entries = (j.plugins && j.plugins['memesh@pcircle-memesh']) || [];
  if (process.env.ENTRY_INDEX === 'none') { process.stdout.write('none'); process.exit(0); }
  process.stdout.write(entries[Number(process.env.ENTRY_INDEX)].version || 'unknown');
")" || {
  # Its sibling above has this guard; an earlier version of this read did
  # not, so an unreadable or malformed installed_plugins.json made
  # CURRENT_VERSION the empty string. That compares unequal to every
  # target, so the script reported an upgrade from "" and carried on — on
  # a registry it had just failed to parse.
  echo "ERROR: could not read the installed memesh version from $INSTALL_REGISTRY" >&2
  exit 1
}

echo "==> Currently installed: $CURRENT_VERSION"

# Same version is NOT "same code". Claude Code keys the plugin cache by
# version, and so did this script — which is exactly how a machine that
# auto-updated between the `release: prepare v4.8.2` commit and the two fix
# PRs that merged under the same version kept serving a 4.8.2 that lacked
# them, and was told "Already at 4.8.2 — nothing to do." The registry
# records the commit the cache was staged from (section 5 below); compare
# that, not the version string.
INSTALLED_SHA="$(INSTALL_REGISTRY="$INSTALL_REGISTRY" ENTRY_INDEX="$ENTRY_INDEX" node -e "
  const fs = require('fs');
  const j = JSON.parse(fs.readFileSync(process.env.INSTALL_REGISTRY, 'utf8'));
  const entries = (j.plugins && j.plugins['memesh@pcircle-memesh']) || [];
  const e = (process.env.ENTRY_INDEX === 'none' ? null : entries[Number(process.env.ENTRY_INDEX)]) || {};
  process.stdout.write(typeof e.gitCommitSha === 'string' ? e.gitCommitSha : 'unknown');
")" || INSTALLED_SHA="unknown"

MARKETPLACE_SHA="$(git -C "$MARKETPLACE_DIR" rev-parse HEAD 2>/dev/null)" || {
  echo "ERROR: could not read the marketplace checkout's commit ($MARKETPLACE_DIR)" >&2
  exit 1
}

if [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
  if [ "$INSTALLED_SHA" = "$MARKETPLACE_SHA" ]; then
    echo "==> Already at $NEW_VERSION (commit ${MARKETPLACE_SHA:0:8}) — nothing to do."
    exit 0
  fi
  echo "==> $NEW_VERSION is installed, but the plugin cache was built from commit ${INSTALLED_SHA:0:8}"
  echo "    and the marketplace is at ${MARKETPLACE_SHA:0:8} — refreshing the cache in place."
fi

# ─── 3. Stage into a sibling, never into the live cache ───────────────────
# A same-version refresh targets the directory Claude Code is running from.
# rsync --delete straight into it and then a failed npm install would leave
# new code with old or missing dependencies and the old registry sha — a
# broken install that the next restart loads. So: build the whole thing
# next to the live cache, and only swap once every step has succeeded.
NEW_INSTALL_PATH="$CACHE_ROOT/$NEW_VERSION"
STAGE_PATH="$CACHE_ROOT/.staging-$NEW_VERSION-$$"
PREVIOUS_PATH="$CACHE_ROOT/.previous-$NEW_VERSION-$$"
cleanup_stage() { rm -rf "$STAGE_PATH"; }
trap cleanup_stage EXIT

# Shared by every failure branch below that needs to undo the swap: remove
# whatever got left at NEW_INSTALL_PATH and move the previous cache back.
# Returns nonzero if the previous cache existed and moving it back failed —
# callers must check this before claiming "nothing changed".
rollback_swap() {
  rm -rf "$NEW_INSTALL_PATH" || return $?
  if [ -e "$PREVIOUS_PATH" ]; then
    mv "$PREVIOUS_PATH" "$NEW_INSTALL_PATH"
    return $?
  fi
  # Nothing to restore (this was a fresh install, not an upgrade) — but only
  # a real success if the rm above actually succeeded, checked above, not
  # assumed here.
  return 0
}

echo "==> Staging $NEW_VERSION next to the cache..."
rm -rf "$STAGE_PATH"
mkdir -p "$STAGE_PATH"
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
rm -rf "$STAGE_PATH/tests" "$STAGE_PATH/benchmarks" "$STAGE_PATH/docs/plans"

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
if [ -e "$NEW_INSTALL_PATH" ]; then
  mv "$NEW_INSTALL_PATH" "$PREVIOUS_PATH" || {
    echo "ERROR: could not move the live cache aside — nothing was changed" >&2
    exit 1
  }
fi
mv "$STAGE_PATH" "$NEW_INSTALL_PATH" || {
  if rollback_swap; then
    echo "ERROR: could not move the staged copy into place — restored the previous cache; nothing changed" >&2
  else
    echo "ERROR: could not move the staged copy into place, AND restoring the previous cache also failed." >&2
    echo "       The live install may now be MISSING. The previous cache, if it still exists, is at $PREVIOUS_PATH — move it back manually:" >&2
    echo "       mv \"$PREVIOUS_PATH\" \"$NEW_INSTALL_PATH\"" >&2
  fi
  exit 1
}

# ─── 6. Patch installed_plugins.json (last: the registry names a cache that exists) ──
# Re-resolve which entry is THIS install from a fresh read of the registry —
# not the index captured before npm install ran, and not section 2's
# "under CACHE_ROOT, else the sole entry" fallback run again either: if the
# entry we started with was removed by a concurrent process and exactly one
# OTHER entry happens to remain, that fallback would silently pick and
# overwrite it — the wrong scope, not "no scope". The one value that
# identifies the SAME entry we started with is ORIGINAL_INSTALL_PATH,
# captured in section 2 before anything here could have changed it; refuse
# unless it still matches exactly one entry. Any failure here — no match,
# more than one match, or the write itself failing — rolls the cache swap
# back: the write is the only place a partial upgrade gets recorded as done,
# so nothing partial should exist when it does not happen.
echo "==> Updating installed_plugins.json..."
REGISTRY_TMP="$INSTALL_REGISTRY.tmp-$$"
NEW_INSTALL_PATH="$NEW_INSTALL_PATH" \
NEW_VERSION="$NEW_VERSION" \
INSTALL_REGISTRY="$INSTALL_REGISTRY" \
REGISTRY_TMP="$REGISTRY_TMP" \
MARKETPLACE_SHA="$MARKETPLACE_SHA" \
ORIGINAL_INSTALL_PATH="$ORIGINAL_INSTALL_PATH" \
node -e "
  const fs = require('fs');
  const registryPath = process.env.INSTALL_REGISTRY;
  const j = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const entries = (j.plugins && j.plugins['memesh@pcircle-memesh']) || [];
  const matches = entries
    .map((e, i) => [e, i])
    .filter(([e]) => e && e.installPath === process.env.ORIGINAL_INSTALL_PATH);
  if (matches.length !== 1) {
    console.error(\`re-resolved to \${matches.length} entries whose installPath still equals what this upgrade started with (expected exactly 1) — the registry changed since this upgrade started\`);
    process.exit(2);
  }
  const [entry, idx] = matches[0];
  entry.installPath = process.env.NEW_INSTALL_PATH;
  entry.version = process.env.NEW_VERSION;
  entry.lastUpdated = new Date().toISOString();
  // Read once above (MARKETPLACE_SHA); the staleness check compares against it next run.
  entry.gitCommitSha = process.env.MARKETPLACE_SHA;
  entries[idx] = entry;
  fs.writeFileSync(process.env.REGISTRY_TMP, JSON.stringify(j, null, 4) + '\n');
" && mv "$REGISTRY_TMP" "$INSTALL_REGISTRY" || {
  rm -f "$REGISTRY_TMP"
  if rollback_swap; then
    echo "ERROR: failed to update installed_plugins.json — restored the previous cache; nothing changed" >&2
  else
    echo "ERROR: failed to update installed_plugins.json, AND restoring the previous cache also failed." >&2
    echo "       The live install may now be MISSING. The previous cache, if it still exists, is at $PREVIOUS_PATH — move it back manually:" >&2
    echo "       mv \"$PREVIOUS_PATH\" \"$NEW_INSTALL_PATH\"" >&2
  fi
  exit 1
}
rm -rf "$PREVIOUS_PATH"

# ─── 7. Done ─────────────────────────────────────────────────────────────
echo ""
echo "✓ MeMesh upgraded: $CURRENT_VERSION (${INSTALLED_SHA:0:8}) -> $NEW_VERSION (${MARKETPLACE_SHA:0:8})"
echo "  Install path: $NEW_INSTALL_PATH"
echo ""
echo "Next step: restart Claude Code so the new MCP server picks up."
if [ "$CURRENT_VERSION" != "$NEW_VERSION" ]; then
  echo "Old version still on disk at $CACHE_ROOT/$CURRENT_VERSION (safe to delete once verified)."
fi
