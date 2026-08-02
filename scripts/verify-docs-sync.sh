#!/usr/bin/env bash
# Documentation synchronization verification script
# Run before PR merge or major commits

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🔍 MeMesh Documentation Sync Verification"
echo "=========================================="
echo ""

ERRORS=0

# 1. Version consistency
echo "📌 Checking version consistency..."
PKG_VERSION=$(node -p "require('./package.json').version")
ARCH_VERSION=$(grep -m1 "Version" docs/ARCHITECTURE.md | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "NOT_FOUND")
API_VERSION=$(grep -m1 "Version" docs/api/API_REFERENCE.md | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "NOT_FOUND")

echo "  package.json: $PKG_VERSION"
echo "  ARCHITECTURE.md: $ARCH_VERSION"
echo "  API_REFERENCE.md: $API_VERSION"

if [ "$PKG_VERSION" != "$ARCH_VERSION" ] || [ "$PKG_VERSION" != "$API_VERSION" ]; then
  echo -e "  ${RED}✗ FAIL${NC}: Version mismatch"
  ERRORS=$((ERRORS + 1))
else
  echo -e "  ${GREEN}✓ PASS${NC}: All versions match $PKG_VERSION"
fi
echo ""

# 2. Hook count consistency
echo "📌 Checking hook count..."
# `-maxdepth 1` and the `_` prefix, not a list of exceptions.
#
# This counted every .js under scripts/hooks/ except one named file, so when
# `scripts/hooks/_generated/` arrived — the build-generated mirror of
# `src/core/paths.ts` and `src/storage/fts-index.ts`, which are not hooks — the
# count went to 9 and this gate reported FAIL on a completely correct tree. A
# gate that fails on a healthy repo gets ignored, and then it is not a gate.
# The underscore prefix is already the convention for "in this directory but
# not a hook"; keying on it means the next such file needs no edit here.
HOOK_FILES=$(find scripts/hooks -maxdepth 1 -name "*.js" ! -name "_*" | wc -l | tr -d ' ')
ARCH_HOOKS=$(grep -c "\.js.*UserPromptSubmit\|PreToolUse\|SessionStart\|PostToolUse\|Stop\|PreCompact" docs/ARCHITECTURE.md || echo "0")

echo "  Hook files in scripts/hooks/: $HOOK_FILES"
echo "  Hooks mentioned in ARCHITECTURE.md: $ARCH_HOOKS"

if [ "$HOOK_FILES" -ne 7 ]; then
  echo -e "  ${RED}✗ FAIL${NC}: Expected 7 hook files, found $HOOK_FILES"
  ERRORS=$((ERRORS + 1))
else
  echo -e "  ${GREEN}✓ PASS${NC}: Hook count is correct (7)"
fi
echo ""

# 3. Deprecated terms check
echo "📌 Checking for deprecated terms..."
DEPRECATED_TERMS=("dual-write" "bidirectional pointer")
FOUND_DEPRECATED=0

for term in "${DEPRECATED_TERMS[@]}"; do
  if grep -rq "$term" docs/ skills/ README*.md 2>/dev/null; then
    echo -e "  ${RED}✗ FAIL${NC}: Found deprecated term '$term'"
    grep -rn "$term" docs/ skills/ README*.md 2>/dev/null | head -3
    FOUND_DEPRECATED=1
    ERRORS=$((ERRORS + 1))
  fi
done

if [ $FOUND_DEPRECATED -eq 0 ]; then
  echo -e "  ${GREEN}✓ PASS${NC}: No deprecated terms found"
fi
echo ""

# 4. MCP tools count
echo "📌 Checking MCP tools count..."
TOOLS_IN_CODE=$(grep -c "name: '" src/transports/mcp/handlers.ts || echo "0")
TOOLS_IN_API=$(grep -c "^### " docs/api/API_REFERENCE.md || echo "0")

echo "  Tools in handlers.ts: $TOOLS_IN_CODE"
echo "  Tools in API_REFERENCE.md: $TOOLS_IN_API"

if [ "$TOOLS_IN_CODE" -ne 9 ]; then
  echo -e "  ${YELLOW}⚠ WARN${NC}: Expected 9 tools in code, found $TOOLS_IN_CODE"
fi

if [ "$TOOLS_IN_API" -lt 9 ]; then
  echo -e "  ${YELLOW}⚠ WARN${NC}: Expected 9+ sections in API docs, found $TOOLS_IN_API"
fi
echo ""

# 5. Skills description check
echo "📌 Checking skills/*.md hook tables..."
MEMESH_SKILL_HOOKS=$(grep -c "^|.*|.*|.*|$" skills/memesh/SKILL.md | head -1 || echo "0")

echo "  Hook rows in skills/memesh/SKILL.md: $MEMESH_SKILL_HOOKS"

if [ "$MEMESH_SKILL_HOOKS" -lt 7 ]; then
  echo -e "  ${RED}✗ FAIL${NC}: Expected 7+ hook rows in table, found $MEMESH_SKILL_HOOKS"
  ERRORS=$((ERRORS + 1))
else
  echo -e "  ${GREEN}✓ PASS${NC}: Hook table looks complete"
fi
echo ""

# 6. Lint check (if available)
echo "📌 Checking lint status..."
if npm run lint > /dev/null 2>&1; then
  echo -e "  ${GREEN}✓ PASS${NC}: Lint passed (or within warning threshold)"
else
  LINT_EXIT=$?
  if [ $LINT_EXIT -eq 127 ]; then
    echo -e "  ${YELLOW}⚠ SKIP${NC}: No lint script configured"
  else
    echo -e "  ${YELLOW}⚠ WARN${NC}: Lint has issues (exit code: $LINT_EXIT)"
    echo "  Run 'npm run lint' to see details"
  fi
fi
echo ""

# Summary
echo "=========================================="
if [ $ERRORS -eq 0 ]; then
  echo -e "${GREEN}✅ ALL CHECKS PASSED${NC}"
  exit 0
else
  echo -e "${RED}❌ FAILED: $ERRORS issue(s) found${NC}"
  echo ""
  echo "Fix these issues before merging the PR."
  exit 1
fi
