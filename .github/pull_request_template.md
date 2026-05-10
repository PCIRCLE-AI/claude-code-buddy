## Summary

<!-- 1-3 sentences. What does this change do, at the level a reviewer needs to know? -->

## Type of change

<!-- Pick the most accurate; multiple OK -->

- [ ] Feature (`feat`)
- [ ] Bug fix (`fix`)
- [ ] Refactor (`refactor`)
- [ ] Docs only (`docs`)
- [ ] Test only (`test`)
- [ ] Build / CI / chore
- [ ] Release (`release`)

## Docs synced (project doc-sync rule — `CLAUDE.md`)

<!-- Tick each that applies; do NOT untick boxes that don't apply, just leave them unchecked. -->

- [ ] CHANGELOG.md updated for this change (under `[Unreleased]` or current `[X.Y.Z]` section)
- [ ] `docs/ARCHITECTURE.md` updated if module structure or counts changed (incl. version header)
- [ ] `docs/api/API_REFERENCE.md` updated if MCP / HTTP / CLI surface changed (incl. version header)
- [ ] `README.md` updated if user-facing features / install / Smart Mode framing changed
- [ ] README locales (de / vi / th / pt / ja / ko / zh-CN / zh-TW / es / fr) re-synced if `README.md` changed
- [ ] Version files (`package.json` + `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`) bumped consistently if any version-bumping
- [ ] `dist/skills-manifest.json` regenerated via `npm run build` (required after ANY change to `.claude-plugin/`, `scripts/hooks/`, `skills/`, or version files)
- [ ] `memesh doctor` reports `Overall: PASS` (or `PASS_WITH_CONCERNS` only when the WARN is `Update status` — that's expected for an unreleased local version)

## Verification

<!-- Concrete evidence that the change works. Cite specific commands / outputs / screenshots. Lower the trust bar — say what you actually ran, not what should happen. -->

- [ ] `npx tsc --noEmit` clean
- [ ] `npm run build` clean
- [ ] `npm test -- --run` passing (state count vs baseline if changed)
- [ ] If hooks were touched: full hook protocol run (real Claude Code Stop / PreToolUse / etc. payload, `memesh doctor` hook-activity check post-install green)
- [ ] If LLM flows were touched: `memesh telemetry` shows the new flow's rows after a manual run

## Test plan

<!-- Bulleted checklist a reviewer can copy-paste to verify locally. Be specific about commands and expected output. -->

- [ ]
- [ ]

## Known limitations / follow-ups

<!-- What's intentionally NOT in this PR. Skipped tests, deferred refactors, etc. Better to surface than to hide. -->
