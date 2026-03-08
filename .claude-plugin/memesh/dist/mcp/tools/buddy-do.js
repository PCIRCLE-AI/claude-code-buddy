import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { getRecoverySuggestion } from '../../utils/errorHandler.js';
export const BuddyDoInputSchema = z.object({
    task: z.string().trim().min(1).describe('Task description for MeMesh to process'),
});
const TASK_PATTERNS = [
    {
        type: 'bug-fix',
        patterns: [/\bfix\b/i, /\bbug\b/i, /\berror\b/i, /\bcrash/i, /\bbroken\b/i, /\bfailing\b/i],
        skills: ['@systematic-debugging', '@test-driven-development'],
        approach: 'Reproduce → Root cause analysis → Fix → Regression test → Verify',
    },
    {
        type: 'feature',
        patterns: [/\badd\b/i, /\bcreate\b/i, /\bimplement\b/i, /\bbuild\b/i, /\bnew\b/i, /\bsetup\b/i],
        skills: ['@writing-plans', '@test-driven-development'],
        approach: 'Plan → Design → Implement → Test → Review',
    },
    {
        type: 'refactor',
        patterns: [/\brefactor\b/i, /\bclean\s?up\b/i, /\breorganize\b/i, /\bsimplify\b/i, /\bextract\b/i],
        skills: ['@comprehensive-code-review'],
        approach: 'Ensure tests exist → Refactor in small steps → Verify tests still pass',
    },
    {
        type: 'test',
        patterns: [/\btest\b/i, /\bcoverage\b/i, /\bspec\b/i],
        skills: ['@test-driven-development'],
        approach: 'Identify coverage gaps → Write failing tests → Verify behavior',
    },
    {
        type: 'performance',
        patterns: [/\bperformance\b/i, /\boptimize\b/i, /\bslow\b/i, /\bfast\b/i, /\bspeed\b/i],
        skills: ['@systematic-debugging'],
        approach: 'Profile → Identify bottleneck → Optimize → Benchmark → Verify no regressions',
    },
    {
        type: 'security',
        patterns: [/\bsecurity\b/i, /\bauth\b/i, /\bvulnerabilit/i, /\bpermission\b/i, /\baccess\b/i],
        skills: ['@comprehensive-code-review'],
        approach: 'Threat model → Identify vulnerabilities → Fix → Security review → Verify',
    },
];
function detectTaskType(task) {
    if (task.trim().length < 10) {
        return null;
    }
    for (const pattern of TASK_PATTERNS) {
        const matchedPattern = pattern.patterns.find(p => p.test(task));
        if (matchedPattern) {
            const match = task.match(matchedPattern);
            if (match && match[0].length <= 5 && task.length > 80) {
                continue;
            }
            return { type: pattern.type, skills: pattern.skills, approach: pattern.approach };
        }
    }
    return null;
}
function extractTaskMetadata(task) {
    const goalMatch = task.match(/^([^.!?]+)[.!?]/) || task.match(/to ([^,]+)/);
    const reasonMatch = task.match(/because ([^,\.]+)/) || task.match(/so that ([^,\.]+)/);
    const expectedMatch = task.match(/should ([^,\.]+)/) || task.match(/will ([^,\.]+)/);
    return {
        goal: goalMatch?.[1]?.trim() || task.substring(0, 100),
        reason: reasonMatch?.[1]?.trim(),
        expectedOutcome: expectedMatch?.[1]?.trim(),
    };
}
async function queryRelatedContext(task, knowledgeGraph) {
    try {
        const results = await knowledgeGraph.hybridSearch(task, { limit: 5, minSimilarity: 0.3 });
        if (results.length === 0)
            return [];
        return results.map(r => {
            const obs = r.entity.observations?.slice(0, 3) || [];
            const obsText = obs.length > 0 ? ` — ${obs.join('; ')}` : '';
            return `[${r.entity.entityType}] ${r.entity.name}${obsText}`;
        });
    }
    catch (error) {
        logger.debug('KG query for buddy-do context failed', {
            error: error instanceof Error ? error.message : String(error),
        });
        return [];
    }
}
export async function executeBuddyDo(input, formatter, autoTracker, knowledgeGraph) {
    const startTime = Date.now();
    const taskId = `buddy-do-${startTime}`;
    try {
        const taskMeta = extractTaskMetadata(input.task);
        if (autoTracker) {
            await autoTracker.recordTaskStart({
                task_description: input.task,
                goal: taskMeta.goal,
                reason: taskMeta.reason,
                expected_outcome: taskMeta.expectedOutcome,
                priority: 'normal',
            });
            logger.debug('Task start recorded', {
                goal: taskMeta.goal,
                hasReason: !!taskMeta.reason,
                hasExpectedOutcome: !!taskMeta.expectedOutcome,
            });
        }
        const taskType = detectTaskType(input.task);
        const relatedContext = knowledgeGraph
            ? await queryRelatedContext(input.task, knowledgeGraph)
            : [];
        const durationMs = Date.now() - startTime;
        logger.debug('buddy_do task analyzed', {
            taskId,
            taskType: taskType?.type || 'general',
            relatedContextCount: relatedContext.length,
            durationMs,
        });
        const proposalParts = [
            `Task: ${input.task}`,
            '',
        ];
        if (taskType) {
            proposalParts.push(`Type: ${taskType.type}`, `Approach: ${taskType.approach}`, '');
            if (taskType.skills.length > 0) {
                proposalParts.push(`Recommended skills: ${taskType.skills.join(', ')}`, '');
            }
        }
        if (relatedContext.length > 0) {
            proposalParts.push('Related context from memory:', ...relatedContext.map(c => `  - ${c}`), '');
        }
        proposalParts.push('Proceed with this approach? (confirm or modify)');
        const formattedResponse = formatter.format({
            agentType: 'buddy-do',
            taskDescription: input.task,
            status: 'success',
            results: {
                message: proposalParts.join('\n'),
                confirmationRequired: true,
                stats: {
                    durationMs,
                    taskType: taskType?.type || 'general',
                    relatedContextCount: relatedContext.length,
                },
            },
        });
        const memeshReminder = [
            '',
            'MeMesh Auto-Memory Reminder:',
            'After completing this task, save key implementation details:',
            '  create-entities with observations like:',
            '  - What was implemented (specific configs, values, patterns)',
            '  - Key decisions made and why',
            '  - Any gotchas or important notes for future reference',
        ].join('\n');
        return {
            content: [
                {
                    type: 'text',
                    text: formattedResponse + memeshReminder,
                },
            ],
        };
    }
    catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        logger.error('buddy_do task failed', { taskId, error: errorObj.message });
        const recovery = getRecoverySuggestion(errorObj);
        const formattedError = formatter.format({
            agentType: 'buddy-do',
            taskDescription: input.task,
            status: 'error',
            error: errorObj,
            ...(recovery && {
                results: {
                    recoverySuggestion: recovery.suggestion,
                    recoveryCategory: recovery.category,
                },
            }),
        });
        return {
            content: [
                {
                    type: 'text',
                    text: formattedError,
                },
            ],
        };
    }
}
//# sourceMappingURL=buddy-do.js.map