const AUTO_TYPES = ['session_keypoint', 'commit', 'session_identity', 'workflow_checkpoint', 'session-insight'];
const LEARNING_TYPES = ['lesson_learned', 'mistake', 'bug_fix', 'lesson'];
export function computePatterns(db, categories) {
    const allCategories = !categories || categories.length === 0;
    let hourDistribution = [];
    let dayDistribution = [];
    if (allCategories || categories.includes('workSchedule')) {
        hourDistribution = db.prepare(`
      SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) as hour, COUNT(*) as count
      FROM entities
      GROUP BY hour ORDER BY hour
    `).all();
        dayDistribution = db.prepare(`
      SELECT CAST(strftime('%w', created_at, 'localtime') AS INTEGER) as dayNum,
        COUNT(*) as count
      FROM entities GROUP BY dayNum ORDER BY dayNum
    `).all();
    }
    let toolPreferences = [];
    if (allCategories || categories.includes('toolPreferences')) {
        const sessionObs = db.prepare(`
      SELECT o.content FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE e.type IN ('session_keypoint', 'session-insight') AND o.content LIKE '[FOCUS]%'
      LIMIT 500
    `).all();
        const toolCounts = {};
        for (const row of sessionObs) {
            const match = row.content.match(/Top tools: (.+)/);
            if (match) {
                for (const part of match[1].split(', ')) {
                    const name = part.split('(')[0].trim();
                    if (name)
                        toolCounts[name] = (toolCounts[name] || 0) + 1;
                }
            }
        }
        toolPreferences = Object.entries(toolCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([tool, sessions]) => ({ tool, sessions }));
    }
    let focusAreas = [];
    if (allCategories || categories.includes('focusAreas')) {
        focusAreas = db.prepare(`
      SELECT type, COUNT(*) as count FROM entities
      WHERE status = 'active' AND type NOT IN (${AUTO_TYPES.map(() => '?').join(',')})
      GROUP BY type ORDER BY count DESC LIMIT 10
    `).all(...AUTO_TYPES);
    }
    let avgSessionMinutes = 0;
    let commitsPerSession = 0;
    let totalSessions = 0;
    let totalCommits = 0;
    if (allCategories || categories.includes('workflow')) {
        const sessionDurations = db.prepare(`
      SELECT o.content FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE e.type IN ('session_keypoint', 'session-insight') AND o.content LIKE '[SESSION]%'
      LIMIT 200
    `).all();
        let totalMinutes = 0;
        let sessionCount = 0;
        for (const row of sessionDurations) {
            const match = row.content.match(/Duration: (\d+)m/);
            if (match) {
                totalMinutes += parseInt(match[1]);
                sessionCount++;
            }
        }
        avgSessionMinutes = sessionCount > 0 ? Math.round(totalMinutes / sessionCount) : 0;
        totalCommits = db.prepare("SELECT COUNT(*) as c FROM entities WHERE type = 'commit'").get().c;
        totalSessions = db.prepare("SELECT COUNT(*) as c FROM entities WHERE type IN ('session_keypoint', 'session-insight')").get().c;
        commitsPerSession = totalSessions > 0 ? Math.round((totalCommits / totalSessions) * 10) / 10 : 0;
    }
    let strengths = [];
    if (allCategories || categories.includes('strengths')) {
        strengths = db.prepare(`
      SELECT type, ROUND(AVG(confidence), 2) as avgConfidence, COUNT(*) as count
      FROM entities WHERE status = 'active' AND type NOT IN (${AUTO_TYPES.map(() => '?').join(',')})
      GROUP BY type HAVING count >= 2
      ORDER BY avgConfidence DESC LIMIT 5
    `).all(...AUTO_TYPES);
    }
    let learningAreas = [];
    if (allCategories || categories.includes('learningAreas')) {
        learningAreas = db.prepare(`
      SELECT t.tag, COUNT(*) as count FROM tags t
      JOIN entities e ON t.entity_id = e.id
      WHERE e.type IN (${LEARNING_TYPES.map(() => '?').join(',')})
        AND t.tag NOT LIKE 'date:%' AND t.tag NOT LIKE 'auto%' AND t.tag NOT LIKE 'session%'
        AND t.tag != 'scope:project'
      GROUP BY t.tag ORDER BY count DESC LIMIT 10
    `).all(...LEARNING_TYPES);
    }
    return {
        workSchedule: { hourDistribution, dayDistribution },
        toolPreferences,
        focusAreas,
        workflow: { avgSessionMinutes, commitsPerSession, totalSessions, totalCommits },
        strengths,
        learningAreas,
    };
}
//# sourceMappingURL=patterns.js.map