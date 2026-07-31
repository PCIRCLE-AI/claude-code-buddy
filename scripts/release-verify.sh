#!/usr/bin/env bash
# release-verify.sh — pre-publish gate for `memesh` releases (#28)
#
# Use:
#   bash scripts/release-verify.sh                    # full pass
#   bash scripts/release-verify.sh --skip-llm-probe   # skip live LLM call (CI without secrets)
#   bash scripts/release-verify.sh --quick            # build + tests only (no smoke / install probe)
#
# Exit code:
#   0 — every gate passed; safe to tag/release
#   1 — at least one gate failed; do NOT publish
#
# This is the "verify before update" rule (per user directive,
# 2026-05-08): every npm publish must pass these gates first.
# Tests-pass alone has been insufficient — this also probes the
# end-to-end install path and runtime smoke that pure unit tests
# can't see.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SKIP_LLM_PROBE=0
QUICK=0
for arg in "$@"; do
  case "$arg" in
    --skip-llm-probe) SKIP_LLM_PROBE=1 ;;
    --quick)          QUICK=1 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "unknown flag: $arg" >&2
      exit 1
      ;;
  esac
done

PASSED=0
FAILED=0
FAIL_NAMES=()

run_gate() {
  local name="$1"; shift
  printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$name"
  if "$@"; then
    echo "  ✅ PASS"
    PASSED=$((PASSED + 1))
  else
    echo "  ❌ FAIL"
    FAILED=$((FAILED + 1))
    FAIL_NAMES+=("$name")
  fi
}

gate_typecheck() { npm run typecheck >/dev/null 2>&1; }
gate_build() { npm run build >/dev/null 2>&1; }

gate_full_test_suite() {
  # Run against a throwaway HOME instead of editing the maintainer's real
  # ~/.memesh/config.json and putting it back with an EXIT trap.
  #
  # What the suite needs is an environment with no LLM credentials — not this
  # machine's environment minus its credentials. Stripping the `llm` block out
  # of the live config meant the only copy of real API keys sat in a
  # world-readable /tmp file for the duration of the run, and a SIGKILL, a
  # crash between the two writes, or a /tmp sweep lost them. A throwaway HOME
  # has no config to strip, so there is nothing to restore and nothing to lose.
  #
  # MEMESH_DB_PATH is deliberately NOT set: pointing it at an existing file
  # makes tests/hooks/session-start-telemetry.test.ts fail, because its
  # "short-circuits on missing DB" case then cannot short-circuit.
  local throwaway_home
  throwaway_home="$(mktemp -d)"
  HOME="$throwaway_home" npx vitest run >/dev/null 2>&1
  local rc=$?
  rm -rf "$throwaway_home"
  return $rc
}

gate_doctor_runs() {
  node dist/transports/cli/cli.js doctor --json >/tmp/memesh-rv-doctor.json 2>/dev/null
  if [ ! -s /tmp/memesh-rv-doctor.json ]; then return 1; fi
  python3 - <<'PY'
import json
with open('/tmp/memesh-rv-doctor.json') as f: d = json.load(f)
status = d.get('status', '')
checks = d.get('checks', [])
fail = [c for c in checks if c.get('status') == 'fail']
if fail:
    print('FAIL checks:')
    for c in fail:
        print(f'  - {c.get("label")}: {c.get("summary")[:120]}')
    raise SystemExit(1)
print(f'overall: {status}, checks: {len(checks)}')
PY
}

gate_install_hooks_dryrun() {
  node dist/transports/cli/cli.js install-hooks --dry-run >/dev/null 2>&1
}

gate_feedback_url_builds() {
  node dist/transports/cli/cli.js feedback --bug --no-open --no-diagnostics --message "release-verify" 2>/dev/null \
    | grep -q "github.com/PCIRCLE-AI/memesh-llm-memory/issues/new"
}

gate_demo_seed_idempotent() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  MEMESH_DB_PATH="$tmpdir/memesh-rv-demo.db" node -e "
    Promise.all([import('./dist/core/demo.js'), import('./dist/db.js')]).then(([demo, dbMod]) => {
      const db = dbMod.openDatabase(process.env.MEMESH_DB_PATH);
      const a = demo.seedDemo(db);
      const b = demo.seedDemo(db);
      process.exit(a.inserted === 30 && b.inserted === 0 ? 0 : 1);
    });
  " 2>/dev/null
  local rc=$?
  rm -rf "$tmpdir"
  return $rc
}

gate_llm_probe_optional() {
  if [ "$SKIP_LLM_PROBE" = 1 ]; then
    echo "  (skipped via --skip-llm-probe)"
    return 0
  fi
  REPO_ROOT="$REPO_ROOT" node --input-type=module -e "
    import { join } from 'path';
    import { pathToFileURL } from 'url';
    const root = process.env.REPO_ROOT;
    // ESM import() takes a URL; a bare Windows path (D:\\...) is rejected as
    // an unknown 'd:' scheme. pathToFileURL keeps this cross-platform.
    const imp = (rel) => import(pathToFileURL(join(root, rel)).href);
    const { readConfig } = await imp('dist/core/config.js');
    const cfg = readConfig();
    if (!cfg.llm) { console.log('no LLM configured — skip'); process.exit(0); }
    const { callLLM } = await imp('dist/core/llm-client.js');
    try {
      const text = await callLLM('Reply with PONG only.', cfg.llm, { maxTokens: 5 });
      if (typeof text !== 'string' || text.length === 0) { console.error('empty LLM response'); process.exit(1); }
      console.log('LLM responded:', text.trim().slice(0, 20));
    } catch (e) {
      console.error('LLM probe failed:', e.message);
      process.exit(1);
    }
  " 2>&1 | head -3
}

echo "release-verify @ $(date)"
echo "repo: $REPO_ROOT"

run_gate "typecheck (tsc --noEmit)" gate_typecheck
run_gate "build (tsc + dashboard)" gate_build

if [ "$QUICK" = 0 ]; then
  run_gate "full vitest suite (hermetic, LLM stripped)" gate_full_test_suite
  run_gate "memesh doctor — overall status not FAIL" gate_doctor_runs
  run_gate "memesh install-hooks --dry-run" gate_install_hooks_dryrun
  run_gate "memesh feedback URL build" gate_feedback_url_builds
  run_gate "demo seed idempotency" gate_demo_seed_idempotent
  run_gate "LLM live probe (optional)" gate_llm_probe_optional
fi

echo ""
echo "─────────────────────────────────"
echo "$PASSED gate(s) passed, $FAILED failed"
if [ "$FAILED" -gt 0 ]; then
  echo "FAILED gates:"
  for n in "${FAIL_NAMES[@]}"; do echo "  - $n"; done
  echo ""
  echo "DO NOT release. Fix the gates above and re-run."
  exit 1
fi
echo "✅ All release gates passed. Safe to tag + npm publish."
