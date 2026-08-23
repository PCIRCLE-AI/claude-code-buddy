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
#   3. Stages a new install cache at ~/.claude/plugins/cache/pcircle-memesh/memesh/<new-version>/.
#   4. Installs runtime deps inside that cache (npm install --omit=dev).
#   5. Patches ~/.claude/plugins/installed_plugins.json to point at the
#      new version + path.
#   6. Leaves the previous version on disk (you can delete it manually if you want).
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
if ! command -v rsync >/dev/null 2>&1; then
  echo "ERROR: rsync is not on PATH." >&2
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

CURRENT_VERSION="$(INSTALL_REGISTRY="$INSTALL_REGISTRY" node -e "
  const fs = require('fs');
  const j = JSON.parse(fs.readFileSync(process.env.INSTALL_REGISTRY, 'utf8'));
  const entries = (j.plugins && j.plugins['memesh@pcircle-memesh']) || [];
  if (entries.length === 0) { process.stdout.write('none'); process.exit(0); }
  process.stdout.write(entries[0].version || 'unknown');
")" || {
  # Its sibling twelve lines up has this guard; this read did not, so an
  # unreadable or malformed installed_plugins.json made CURRENT_VERSION the
  # empty string. That compares unequal to every target, so the script
  # reported an upgrade from "" and carried on — on a registry it had just
  # failed to parse.
  echo "ERROR: could not read the installed memesh version from $INSTALL_REGISTRY" >&2
  exit 1
}

echo "==> Currently installed: $CURRENT_VERSION"

if [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
  echo "==> Already at $NEW_VERSION — nothing to do."
  exit 0
fi

# ─── 3. Stage new install cache ───────────────────────────────────────────
NEW_INSTALL_PATH="$CACHE_ROOT/$NEW_VERSION"
echo "==> Staging $NEW_INSTALL_PATH..."
mkdir -p "$NEW_INSTALL_PATH"
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'tests' \
  --exclude 'benchmarks' \
  --exclude 'docs/plans' \
  "$MARKETPLACE_DIR/" "$NEW_INSTALL_PATH/" || {
  echo "ERROR: rsync failed" >&2
  exit 1
}

# ─── 4. Install runtime deps ──────────────────────────────────────────────
echo "==> Installing runtime deps (this may take a minute)..."
(
  cd "$NEW_INSTALL_PATH" || exit 1
  npm install --omit=dev --no-audit --no-fund --silent
) || {
  echo "ERROR: npm install failed in $NEW_INSTALL_PATH" >&2
  exit 1
}

# ─── 5. Patch installed_plugins.json ─────────────────────────────────────
echo "==> Updating installed_plugins.json..."
NEW_INSTALL_PATH="$NEW_INSTALL_PATH" \
NEW_VERSION="$NEW_VERSION" \
INSTALL_REGISTRY="$INSTALL_REGISTRY" \
MARKETPLACE_DIR="$MARKETPLACE_DIR" \
node -e "
  const fs = require('fs');
  const path = process.env.INSTALL_REGISTRY;
  const j = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!j.plugins || !Array.isArray(j.plugins['memesh@pcircle-memesh'])) {
    console.error('installed_plugins.json missing memesh@pcircle-memesh entry');
    process.exit(2);
  }
  // Read the actual commit sha so future doctor calls match the install.
  let sha = 'unknown';
  try {
    sha = require('child_process')
      .execFileSync('git', ['-C', process.env.MARKETPLACE_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
      .trim();
  } catch {}
  const entry = j.plugins['memesh@pcircle-memesh'][0] || {};
  entry.installPath = process.env.NEW_INSTALL_PATH;
  entry.version = process.env.NEW_VERSION;
  entry.lastUpdated = new Date().toISOString();
  entry.gitCommitSha = sha;
  j.plugins['memesh@pcircle-memesh'][0] = entry;
  fs.writeFileSync(path, JSON.stringify(j, null, 4) + '\n');
" || {
  echo "ERROR: failed to patch installed_plugins.json" >&2
  exit 1
}

# ─── 6. Done ─────────────────────────────────────────────────────────────
echo ""
echo "✓ MeMesh upgraded: $CURRENT_VERSION -> $NEW_VERSION"
echo "  Install path: $NEW_INSTALL_PATH"
echo ""
echo "Next step: restart Claude Code so the new MCP server picks up."
echo "Old version still on disk at $CACHE_ROOT/$CURRENT_VERSION (safe to delete once verified)."
