// ============================================================================
// AUTO-GENERATED from src/core/work-topology.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
export const WORK_LAYER_TYPES = new Set([
    'decision',
    'lesson_learned',
    'lesson',
    'mistake',
    'milestone',
    'pattern',
    'technical_pattern',
    'goal',
    'plan',
    'task-state',
]);
export const EVIDENCE_LAYER_TYPES = new Set([
    'commit',
    'session-insight',
    'session-summary',
    'session_keypoint',
    'session-identity',
    'session_identity',
    'weekly-summary',
    'weekly_summary',
    'workflow_checkpoint',
]);
export function layerOf(type) {
    if (WORK_LAYER_TYPES.has(type))
        return 'work';
    if (EVIDENCE_LAYER_TYPES.has(type))
        return 'evidence';
    return 'knowledge';
}
export function topologyLine(entity, maxChars) {
    const title = entity.title?.trim();
    const snippet = entity.snippet?.trim();
    const text = title || snippet || `${entity.type} memory`;
    return `- [${entity.type}] ${clip(text, maxChars)}`;
}
function clip(text, maxChars) {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length <= maxChars)
        return flat;
    const cut = flat.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(' ');
    const base = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
    return `${base.trimEnd()}…`;
}
function bySignal(a, b) {
    const av = typeof a.signalScore === 'number' ? a.signalScore : -1;
    const bv = typeof b.signalScore === 'number' ? b.signalScore : -1;
    return bv - av;
}
export function groupTopology(entities, projectName) {
    const decisions = [];
    const lessons = [];
    const knowledge = [];
    const evidence = [];
    const foreign = [];
    for (const e of entities) {
        if (e.foreign) {
            foreign.push(e);
            continue;
        }
        const layer = layerOf(e.type);
        if (layer === 'evidence') {
            evidence.push(e);
            continue;
        }
        if (layer === 'knowledge') {
            knowledge.push(e);
            continue;
        }
        if (e.type === 'lesson_learned' || e.type === 'lesson' || e.type === 'mistake')
            lessons.push(e);
        else
            decisions.push(e);
    }
    for (const list of [decisions, lessons, knowledge, evidence, foreign])
        list.sort(bySignal);
    const sections = [];
    if (decisions.length)
        sections.push({ heading: `Decisions and direction for "${projectName}":`, entities: decisions });
    if (lessons.length)
        sections.push({ heading: `Lessons from "${projectName}" — do not repeat these:`, entities: lessons });
    if (knowledge.length)
        sections.push({ heading: `What is known about "${projectName}":`, entities: knowledge });
    if (evidence.length)
        sections.push({ heading: `Recent activity in "${projectName}":`, entities: evidence });
    if (foreign.length)
        sections.push({ heading: 'From your other projects (may or may not apply here):', entities: foreign });
    return sections;
}
export function buildTopologyLines(entities, projectName, budget) {
    const maxLineChars = budget.maxLineChars ?? 150;
    const maxPerSection = budget.maxPerSection ?? 8;
    const lines = [];
    let used = 0;
    for (const section of groupTopology(entities, projectName)) {
        const candidate = section.entities.slice(0, maxPerSection);
        const rendered = [];
        for (const e of candidate) {
            const line = topologyLine(e, maxLineChars);
            if (used + line.length + 1 > budget.maxChars)
                break;
            rendered.push(line);
            used += line.length + 1;
        }
        if (rendered.length === 0)
            continue;
        if (used + section.heading.length + 2 > budget.maxChars)
            break;
        used += section.heading.length + 2;
        lines.push(section.heading, ...rendered, '');
    }
    if (lines[lines.length - 1] === '')
        lines.pop();
    return lines;
}
