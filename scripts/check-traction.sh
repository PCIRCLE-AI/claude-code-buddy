#!/usr/bin/env bash
# Daily traction snapshot for @pcircle/memesh.
#
# Honest, internal sense-making. No company-logo claims, no fabricated
# attribution. Pulls only public APIs + the repo's own traffic stats.
#
# Usage: bash scripts/check-traction.sh > report.md
#
# Required: curl, jq.
# Optional: $GITHUB_TOKEN with metadata + traffic permission for the repo
# (without it the traffic / referrer / clone numbers are skipped).

# Don't use `set -e`: a failing API call should degrade the row, not kill
# the report. Every external call is wrapped in `|| ...fallback`.
set -uo pipefail

PKG="@pcircle/memesh"
REPO="PCIRCLE-AI/memesh-llm-memory"
TODAY="$(date -u +%Y-%m-%d)"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 24h-ago in epoch seconds (works on BSD date and GNU date)
SINCE_EPOCH=$(date -u -v-24H +%s 2>/dev/null || date -u -d '24 hours ago' +%s 2>/dev/null || echo 0)

GH_TOKEN_VAL="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
auth_header=()
[ -n "$GH_TOKEN_VAL" ] && auth_header=(-H "Authorization: token $GH_TOKEN_VAL")

# -------- Title --------
cat <<EOF
# memesh traction snapshot — $TODAY

_Internal sense-making, not external publication. Public-API signals only.
No company attribution, no logo claims._

EOF

# -------- npm downloads --------
echo "## npm downloads ($PKG)"
echo ""
echo "| Window | Downloads |"
echo "|---|---|"
for window in last-day last-week last-month; do
  raw=$(curl -fsS --max-time 10 "https://api.npmjs.org/downloads/point/${window}/${PKG}" 2>/dev/null || echo '{}')
  count=$(printf '%s' "$raw" | jq -r '.downloads // "n/a"' 2>/dev/null || echo "n/a")
  printf "| %s | %s |\n" "$window" "$count"
done
echo ""

# -------- GitHub repo stats --------
echo "## GitHub repo stats"
echo ""
repo_data=$(curl -fsS --max-time 10 "${auth_header[@]}" "https://api.github.com/repos/$REPO" 2>/dev/null || echo '{}')
stars=$(printf '%s' "$repo_data" | jq -r '.stargazers_count // "n/a"' 2>/dev/null || echo n/a)
forks=$(printf '%s' "$repo_data" | jq -r '.forks_count // "n/a"' 2>/dev/null || echo n/a)
watchers=$(printf '%s' "$repo_data" | jq -r '.subscribers_count // "n/a"' 2>/dev/null || echo n/a)
open_pr_issues=$(printf '%s' "$repo_data" | jq -r '.open_issues_count // "n/a"' 2>/dev/null || echo n/a)
echo "- Stars: $stars"
echo "- Forks: $forks"
echo "- Watchers (subscribed): $watchers"
echo "- Open issues + PRs: $open_pr_issues"
echo ""

# -------- GitHub traffic (needs push token) --------
echo "## GitHub traffic (last 14 days)"
echo ""
if [ -z "$GH_TOKEN_VAL" ]; then
  echo "_(no GITHUB_TOKEN with traffic permission; skipping views / clones / referrers)_"
else
  views=$(curl -fsS --max-time 10 "${auth_header[@]}" "https://api.github.com/repos/$REPO/traffic/views" 2>/dev/null || echo '{}')
  clones=$(curl -fsS --max-time 10 "${auth_header[@]}" "https://api.github.com/repos/$REPO/traffic/clones" 2>/dev/null || echo '{}')
  v_count=$(printf '%s' "$views" | jq -r '.count // "n/a"' 2>/dev/null || echo n/a)
  v_uniq=$(printf '%s' "$views"  | jq -r '.uniques // "n/a"' 2>/dev/null || echo n/a)
  c_count=$(printf '%s' "$clones" | jq -r '.count // "n/a"' 2>/dev/null || echo n/a)
  c_uniq=$(printf '%s' "$clones"  | jq -r '.uniques // "n/a"' 2>/dev/null || echo n/a)
  echo "- Views:  $v_count total, $v_uniq unique visitors"
  echo "- Clones: $c_count total, $c_uniq unique cloners"
  echo ""
  echo "### Top referrers"
  echo ""
  refs=$(curl -fsS --max-time 10 "${auth_header[@]}" "https://api.github.com/repos/$REPO/traffic/popular/referrers" 2>/dev/null || echo '[]')
  echo "| Referrer | Views | Unique |"
  echo "|---|---|---|"
  printf '%s' "$refs" | jq -r '.[] | "| \(.referrer) | \(.count) | \(.uniques) |"' 2>/dev/null | head -10 || echo "_(none)_"
  echo ""
  echo "### Top paths"
  echo ""
  paths=$(curl -fsS --max-time 10 "${auth_header[@]}" "https://api.github.com/repos/$REPO/traffic/popular/paths" 2>/dev/null || echo '[]')
  echo "| Path | Views | Unique |"
  echo "|---|---|---|"
  printf '%s' "$paths" | jq -r '.[] | "| \(.path) | \(.count) | \(.uniques) |"' 2>/dev/null | head -10 || echo "_(none)_"
fi
echo ""

# -------- HN mentions in last 24h --------
echo "## Hacker News mentions (last 24h)"
echo ""
hn=$(curl -fsS --max-time 10 "https://hn.algolia.com/api/v1/search?query=memesh&numericFilters=created_at_i%3E${SINCE_EPOCH}&hitsPerPage=20" 2>/dev/null || echo '{"hits":[]}')
hn_count=$(printf '%s' "$hn" | jq -r '.nbHits // 0' 2>/dev/null || echo 0)
echo "Total: **$hn_count** new HN items in last 24h matching \"memesh\"."
if [ "${hn_count:-0}" -gt 0 ] 2>/dev/null; then
  echo ""
  printf '%s' "$hn" | jq -r '.hits[] | "- [\(.created_at)] \(.author // "?"): \(.title // (.comment_text // "" | gsub("<[^>]+>"; "") | .[0:140]))\n  https://news.ycombinator.com/item?id=\(.objectID)"' 2>/dev/null | head -40
fi
echo ""

# -------- Reddit mentions in last 24h --------
echo "## Reddit mentions (last 24h)"
echo ""
reddit=$(curl -fsS --max-time 10 -A "memesh-traction-bot/1.0 (read-only)" "https://www.reddit.com/search.json?q=memesh+OR+%22pcircle%2Fmemesh%22&sort=new&t=day&limit=25" 2>/dev/null || echo '{}')
reddit_count=$(printf '%s' "$reddit" | jq -r '.data.children | length // 0' 2>/dev/null || echo 0)
echo "Total: **$reddit_count** Reddit posts/comments in last 24h."
if [ "${reddit_count:-0}" -gt 0 ] 2>/dev/null; then
  echo ""
  printf '%s' "$reddit" | jq -r '.data.children[] | .data | "- [r/\(.subreddit)] \(.author): \(.title // (.body // "" | .[0:140]))\n  https://reddit.com\(.permalink)"' 2>/dev/null | head -40
fi
echo ""

# -------- npm package metadata sanity --------
echo "## Package version on npm"
echo ""
npm_meta=$(curl -fsS --max-time 10 "https://registry.npmjs.org/${PKG}/latest" 2>/dev/null || echo '{}')
npm_version=$(printf '%s' "$npm_meta" | jq -r '.version // "n/a"' 2>/dev/null || echo n/a)
npm_published=$(curl -fsS --max-time 10 "https://registry.npmjs.org/${PKG}" 2>/dev/null | jq -r --arg v "$npm_version" '.time[$v] // "n/a"' 2>/dev/null || echo n/a)
echo "- Latest published version: \`$npm_version\`"
echo "- Published at: $npm_published"
echo ""

# -------- Footer --------
echo "---"
echo ""
echo "_Generated: $NOW_ISO via \`scripts/check-traction.sh\`._"
echo "_Honest signals only. No company-logo claims. No internal grading._"
