export const NOISE_TYPES = new Set([
    'session_keypoint', 'commit', 'weekly-summary', 'session-insight',
    'session-summary', 'session_identity', 'session-identity',
]);
export const RADAR_AXES = [
    { axis: 'lessons', types: ['lesson_learned', 'lesson', 'mistake'] },
    { axis: 'decisions', types: ['decision', 'architecture_decision', 'design_decision'] },
    { axis: 'patterns', types: ['pattern', 'technical_pattern', 'best_practice'] },
    { axis: 'bugs', types: ['bug_fix', 'verification_result', 'test_result'] },
    { axis: 'processes', types: ['process', 'workflow_checkpoint', 'refactoring', 'maintenance'] },
    { axis: 'architecture', types: ['architecture', 'infrastructure', 'feature', 'release'] },
];
export function computeAnalytics(db) {
    const totalActive = db.prepare("SELECT COUNT(*) as c FROM entities WHERE status = 'active'").get().c;
    const recentlyAccessed = db.prepare(`SELECT COUNT(*) as c FROM entities WHERE status = 'active' AND datetime(last_accessed_at) >= datetime('now', '-30 days')`).get().c;
    const activityRatio = totalActive > 0 ? recentlyAccessed / totalActive : 0;
    const highConfidence = db.prepare("SELECT COUNT(*) as c FROM entities WHERE status = 'active' AND confidence > 0.7").get().c;
    const qualityRatio = totalActive > 0 ? highConfidence / totalActive : 0;
    const newThisWeek = db.prepare(`SELECT COUNT(*) as c FROM entities WHERE created_at >= datetime('now', '-7 days')`).get().c;
    const freshnessRatio = totalActive > 0 ? Math.min(newThisWeek / totalActive, 1.0) : 0;
    const lessonCount = db.prepare("SELECT COUNT(*) as c FROM entities WHERE type = 'lesson_learned'").get().c;
    const lessonRatio = Math.min(lessonCount / 5, 1.0);
    const healthScore = Math.round(activityRatio * 30 + qualityRatio * 30 + freshnessRatio * 20 + lessonRatio * 20);
    const healthFactors = {
        activity: {
            score: Math.round(activityRatio * 30),
            weight: 30,
            detail: `${recentlyAccessed}/${totalActive} active entities accessed in last 30 days`,
        },
        quality: {
            score: Math.round(qualityRatio * 30),
            weight: 30,
            detail: `${highConfidence}/${totalActive} active entities with confidence > 0.7`,
        },
        freshness: {
            score: Math.round(freshnessRatio * 20),
            weight: 20,
            detail: `${newThisWeek} new entities this week`,
        },
        lessons: {
            score: Math.round(lessonRatio * 20),
            weight: 20,
            detail: `${lessonCount} lessons learned`,
        },
    };
    const createdTimeline = db.prepare(`
    SELECT DATE(created_at) as day, COUNT(*) as created
    FROM entities
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY DATE(created_at)
    ORDER BY day
  `).all();
    const recalledTimeline = db.prepare(`
    SELECT DATE(last_accessed_at) as day, COUNT(*) as recalled
    FROM entities
    WHERE datetime(last_accessed_at) >= datetime('now', '-30 days')
    GROUP BY DATE(last_accessed_at)
    ORDER BY day
  `).all();
    const timelineMap = new Map();
    for (const row of createdTimeline) {
        timelineMap.set(row.day, { date: row.day, created: row.created, recalled: 0 });
    }
    for (const row of recalledTimeline) {
        const existing = timelineMap.get(row.day);
        if (existing) {
            existing.recalled = row.recalled;
        }
        else {
            timelineMap.set(row.day, { date: row.day, created: 0, recalled: row.recalled });
        }
    }
    const timeline = Array.from(timelineMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    const ageMatrixRaw = db.prepare(`
    SELECT type,
      CASE
        WHEN created_at > datetime('now', '-7 days')  THEN 'week'
        WHEN created_at > datetime('now', '-30 days') THEN 'month'
        WHEN created_at > datetime('now', '-90 days') THEN 'quarter'
        ELSE 'older'
      END as bucket,
      COUNT(*) as count
    FROM entities
    WHERE status = 'active'
    GROUP BY type, bucket
    ORDER BY type, bucket
  `).all();
    const ageMatrix = ageMatrixRaw.filter(r => !NOISE_TYPES.has(r.type));
    const typeCounts = {};
    for (const row of ageMatrixRaw) {
        typeCounts[row.type] = (typeCounts[row.type] ?? 0) + row.count;
    }
    const knowledgeRadar = RADAR_AXES.map(({ axis, types }) => ({
        axis,
        types,
        count: types.reduce((sum, t) => sum + (typeCounts[t] ?? 0), 0),
    }));
    const KNOWLEDGE_TYPE_LIST = [
        'lesson_learned', 'lesson', 'mistake',
        'decision', 'architecture_decision', 'design_decision',
        'pattern', 'technical_pattern', 'best_practice',
        'bug_fix', 'verification_result', 'test_result',
        'process', 'architecture', 'infrastructure',
        'feature', 'release', 'refactoring',
    ];
    const knowledgeTypePlaceholders = KNOWLEDGE_TYPE_LIST.map(() => '?').join(',');
    const reusedThisWeek = db.prepare(`SELECT COUNT(*) as c FROM entities
     WHERE type IN (${knowledgeTypePlaceholders})
       AND status = 'active'
       AND datetime(last_accessed_at) >= datetime('now', '-7 days')`).get(...KNOWLEDGE_TYPE_LIST).c;
    const loopTrendRows = db.prepare(`
    SELECT DATE(last_accessed_at) as day, COUNT(*) as count
    FROM entities
    WHERE type IN (${knowledgeTypePlaceholders})
      AND status = 'active'
      AND datetime(last_accessed_at) >= datetime('now', '-30 days')
    GROUP BY DATE(last_accessed_at)
    ORDER BY day
  `).all(...KNOWLEDGE_TYPE_LIST);
    const loopMetric = {
        reusedThisWeek,
        trend: loopTrendRows.map((r) => ({ date: r.day, count: r.count })),
        computedFrom: 'last_accessed_at_approximation',
    };
    const LESSON_TYPES = ['lesson_learned', 'lesson', 'mistake'];
    const lessonPlaceholders = LESSON_TYPES.map(() => '?').join(',');
    const lessonTotal = db.prepare(`SELECT COUNT(*) as c FROM entities
     WHERE status = 'active' AND type IN (${lessonPlaceholders})`).get(...LESSON_TYPES).c;
    const severityTagged = db.prepare(`SELECT COUNT(DISTINCT e.id) as c FROM entities e
     JOIN tags t ON t.entity_id = e.id
     WHERE e.status = 'active' AND e.type IN (${lessonPlaceholders})
       AND t.tag LIKE 'severity:%'`).get(...LESSON_TYPES).c;
    const criticalCount = db.prepare(`SELECT COUNT(DISTINCT e.id) as c FROM entities e
     JOIN tags t ON t.entity_id = e.id
     WHERE e.status = 'active' AND e.type IN (${lessonPlaceholders})
       AND t.tag = 'severity:critical'`).get(...LESSON_TYPES).c;
    const criticalLessons = { critical: criticalCount, severityTagged, total: lessonTotal };
    const readCounter = (key) => {
        try {
            const row = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(key);
            if (!row)
                return null;
            const n = parseInt(row.value, 10);
            return Number.isInteger(n) && n >= 0 ? n : null;
        }
        catch {
            return null;
        }
    };
    const citationTotal = readCounter('citation_sessions_total');
    const citationCompliance = citationTotal === null || citationTotal === 0
        ? null
        : { cited: readCounter('citation_sessions_cited') ?? 0, total: citationTotal };
    return {
        healthScore,
        healthFactors,
        loopMetric,
        criticalLessons,
        citationCompliance,
        timeline,
        ageMatrix,
        knowledgeRadar,
    };
}
export function computePmAnalytics(db, windowDays = 30) {
    const decisionsInWindow = db.prepare(`SELECT COUNT(*) AS n FROM entities WHERE type='decision' AND status='active'
     AND created_at >= datetime('now', '-' || ? || ' days')`).get(windowDays).n;
    const releasesInWindow = db.prepare(`SELECT COUNT(*) AS n FROM entities WHERE type='release' AND status='active'
     AND created_at >= datetime('now', '-' || ? || ' days')`).get(windowDays).n;
    const stalePlans = db.prepare(`SELECT COUNT(*) AS n FROM entities
     WHERE type='plan' AND status='active'
       AND (last_accessed_at IS NULL OR datetime(last_accessed_at) < datetime('now', '-30 days'))`).get().n;
    const openDecisions = db.prepare(`SELECT COUNT(*) AS n FROM entities e
     WHERE e.type='decision' AND e.status='active'
       AND e.created_at < datetime('now', '-14 days')
       AND NOT EXISTS (
         SELECT 1 FROM relations r
         WHERE r.from_entity_id=e.id AND r.relation_type='supersedes'
       )`).get().n;
    const totalActive = db.prepare(`SELECT COUNT(*) AS n FROM entities WHERE status='active'`).get().n;
    const withRelations = db.prepare(`SELECT COUNT(DISTINCT e.id) AS n
     FROM entities e
     JOIN relations r ON r.from_entity_id=e.id OR r.to_entity_id=e.id
     WHERE e.status='active'`).get().n;
    const totalRelations = db.prepare(`SELECT COUNT(*) AS n FROM relations`).get().n;
    const weeks = windowDays / 7;
    const months = windowDays / 30;
    return {
        velocity: {
            decisionsPerWeek: weeks > 0 ? decisionsInWindow / weeks : 0,
            releasesPerMonth: months > 0 ? releasesInWindow / months : 0,
            windowDays,
        },
        staleness: {
            stalePlanCount: stalePlans,
            openDecisionCount: openDecisions,
        },
        connectedness: {
            orphanRate: totalActive > 0 ? (totalActive - withRelations) / totalActive : 0,
            totalRelations,
            activeEntities: totalActive,
        },
    };
}
//# sourceMappingURL=analytics.js.map