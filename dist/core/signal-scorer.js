export function computeSignalScore(input) {
    const { type, observations, tags = [] } = input;
    const obsText = observations.join(' ').trim();
    const obsLen = obsText.length;
    const base = baseScoreForType(type);
    if (obsLen < 10)
        return Math.min(base, 0.1);
    if (type === 'session_keypoint' && /Duration: 0s, Tools used: 0/.test(obsText)) {
        return 0.0;
    }
    if (type === 'commit') {
        const message = (observations[0] ?? '').trim();
        const [subject = '', ...rest] = message.split('\n');
        const head = subject.trim();
        const hasBody = rest.join('\n').trim().length > 0;
        if (!hasBody) {
            if (head.length < 30 && !/[!:]/.test(head))
                return 0.2;
            if (head.length < 30)
                return 0.3;
            if (head.length < 60)
                return 0.4;
        }
        return Math.min(0.7, base + 0.1);
    }
    if (type === 'session-insight') {
        if (tags.includes('type:bugfix'))
            return 0.7;
        if (tags.includes('type:heavy-session'))
            return 0.6;
        return 0.5;
    }
    if (type === 'weekly-summary' || type === 'weekly_summary') {
        return obsLen > 200 ? 0.5 : 0.3;
    }
    if (base >= 0.8) {
        if (obsLen > 200)
            return Math.min(1.0, base + 0.05);
        return base;
    }
    return base;
}
function baseScoreForType(type) {
    if (type === 'lesson_learned')
        return 1.0;
    if (type === 'release')
        return 1.0;
    if (type === 'decision' || type === 'architecture' || type === 'architecture_decision')
        return 0.9;
    if (type === 'pattern' || type === 'technical_pattern' || type === 'best_practice')
        return 0.9;
    if (type === 'plan')
        return 0.85;
    if (type === 'feature')
        return 0.65;
    if (type === 'bug_fix')
        return 0.7;
    if (type === 'note')
        return 0.55;
    if (type === 'session-insight')
        return 0.5;
    if (type === 'session_keypoint')
        return 0.2;
    if (type === 'commit')
        return 0.5;
    if (type === 'workflow_checkpoint')
        return 0.4;
    if (type === 'reference' || type === 'documentation')
        return 0.6;
    if (type === 'weekly-summary' || type === 'weekly_summary')
        return 0.4;
    return 0.5;
}
//# sourceMappingURL=signal-scorer.js.map