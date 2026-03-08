import { z } from 'zod';
import type { ResponseFormatter } from '../../ui/ResponseFormatter.js';
import type { ProjectAutoTracker } from '../../memory/ProjectAutoTracker.js';
import type { KnowledgeGraph } from '../../knowledge-graph/index.js';
import { logger } from '../../utils/logger.js';
import { getRecoverySuggestion } from '../../utils/errorHandler.js';

export const BuddyDoInputSchema = z.object({
  task: z.string().trim().min(1).describe('Task description for MeMesh to process'),
});

export type ValidatedBuddyDoInput = z.infer<typeof BuddyDoInputSchema>;

/**
 * Task type patterns for detecting what kind of work is requested.
 * Used to tailor the enriched prompt with relevant skills and approaches.
 */
const TASK_PATTERNS: Array<{ type: string; patterns: RegExp[]; skills: string[]; approach: string }> = [
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

/**
 * Detect task type from description.
 *
 * Returns null (general) when:
 * - Task is too short (< 10 chars) to meaningfully classify
 * - The matched keyword is a small fraction of a long description,
 *   suggesting the match is incidental rather than defining
 */
function detectTaskType(task: string): { type: string; skills: string[]; approach: string } | null {
  // Too short to classify reliably
  if (task.trim().length < 10) {
    return null;
  }

  for (const pattern of TASK_PATTERNS) {
    const matchedPattern = pattern.patterns.find(p => p.test(task));
    if (matchedPattern) {
      // Check if the match is too generic: if the keyword is very short
      // relative to a long task description, the match is likely incidental
      const match = task.match(matchedPattern);
      if (match && match[0].length <= 5 && task.length > 80) {
        continue;
      }
      return { type: pattern.type, skills: pattern.skills, approach: pattern.approach };
    }
  }
  return null;
}

/**
 * Extract goal, reason, and expected outcome from task description
 */
function extractTaskMetadata(task: string): {
  goal: string;
  reason?: string;
  expectedOutcome?: string;
} {
  const goalMatch = task.match(/^([^.!?]+)[.!?]/) || task.match(/to ([^,]+)/);
  const reasonMatch = task.match(/because ([^,\.]+)/) || task.match(/so that ([^,\.]+)/);
  const expectedMatch = task.match(/should ([^,\.]+)/) || task.match(/will ([^,\.]+)/);

  return {
    goal: goalMatch?.[1]?.trim() || task.substring(0, 100),
    reason: reasonMatch?.[1]?.trim(),
    expectedOutcome: expectedMatch?.[1]?.trim(),
  };
}

/**
 * Query knowledge graph for related context
 */
async function queryRelatedContext(
  task: string,
  knowledgeGraph: KnowledgeGraph
): Promise<string[]> {
  try {
    const results = await knowledgeGraph.hybridSearch(task, { limit: 5, minSimilarity: 0.3 });
    if (results.length === 0) return [];

    return results.map(r => {
      const obs = r.entity.observations?.slice(0, 3) || [];
      const obsText = obs.length > 0 ? ` — ${obs.join('; ')}` : '';
      return `[${r.entity.entityType}] ${r.entity.name}${obsText}`;
    });
  } catch (error) {
    logger.debug('KG query for buddy-do context failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * buddy_do tool - Smart task analysis with memory-enriched proposals
 *
 * Analyzes the task, queries knowledge graph for related context,
 * detects task type, and returns an enriched proposal for user review.
 * Follows "propose, don't execute" pattern — user must confirm before proceeding.
 *
 * Examples:
 *   task: "setup authentication"
 *   task: "refactor user service"
 *   task: "fix login bug"
 */
export async function executeBuddyDo(
  input: ValidatedBuddyDoInput,
  formatter: ResponseFormatter,
  autoTracker?: ProjectAutoTracker,
  knowledgeGraph?: KnowledgeGraph
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const startTime = Date.now();
  const taskId = `buddy-do-${startTime}`;

  try {
    // Record task start with metadata
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

    // Detect task type for tailored guidance
    const taskType = detectTaskType(input.task);

    // Query KG for related context (if available)
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

    // Build enriched proposal
    const proposalParts: string[] = [
      `Task: ${input.task}`,
      '',
    ];

    if (taskType) {
      proposalParts.push(
        `Type: ${taskType.type}`,
        `Approach: ${taskType.approach}`,
        '',
      );
      if (taskType.skills.length > 0) {
        proposalParts.push(`Recommended skills: ${taskType.skills.join(', ')}`, '');
      }
    }

    if (relatedContext.length > 0) {
      proposalParts.push(
        'Related context from memory:',
        ...relatedContext.map(c => `  - ${c}`),
        '',
      );
    }

    proposalParts.push(
      'Proceed with this approach? (confirm or modify)',
    );

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

    // MeMesh memory reminder
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
          type: 'text' as const,
          text: formattedResponse + memeshReminder,
        },
      ],
    };
  } catch (error) {
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
          type: 'text' as const,
          text: formattedError,
        },
      ],
    };
  }
}
