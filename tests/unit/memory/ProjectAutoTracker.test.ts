/**
 * ProjectAutoTracker Tests
 *
 * Tests for the hybrid event-driven + token-based memory tracking system.
 *
 * Test coverage:
 * - Constructor / initialization
 * - Token tracking (addTokens, snapshot threshold)
 * - Code change recording (recordCodeChange, aggregation, deduplication)
 * - Event recording (recordTaskStart, recordDecision, recordProgressMilestone, recordError)
 * - Test result recording (recordTestResult)
 * - Commit recording (recordCommit)
 * - Workflow checkpoint recording (recordWorkflowCheckpoint)
 * - flushPendingCodeChanges (priority-aware deduplication)
 * - Hook factory methods (createFileChangeHook, createTestResultHook, createTokenHook)
 * - Edge cases (empty inputs, merge window, cleanup)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProjectAutoTracker, CheckpointPriority } from '../../../src/memory/ProjectAutoTracker.js';
import type { MCPToolInterface } from '../../../src/core/MCPToolInterface.js';

// ─── Mock Factory ────────────────────────────────────────────────────────────

function createMockMcp(): MCPToolInterface {
  return {
    memory: {
      createEntities: vi.fn().mockResolvedValue(undefined),
      searchNodes: vi.fn().mockResolvedValue([]),
    },
  } as unknown as MCPToolInterface;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('ProjectAutoTracker', () => {
  let mcp: MCPToolInterface;
  let tracker: ProjectAutoTracker;

  beforeEach(() => {
    mcp = createMockMcp();
    tracker = new ProjectAutoTracker(mcp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Constructor ─────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should initialize with default snapshot threshold of 10000', () => {
      expect(tracker.getSnapshotThreshold()).toBe(10000);
    });

    it('should initialize with zero current token count', () => {
      expect(tracker.getCurrentTokenCount()).toBe(0);
    });
  });

  // ── getSnapshotThreshold / getCurrentTokenCount ──────────────────────────────

  describe('getSnapshotThreshold()', () => {
    it('should return 10000 as the default threshold', () => {
      expect(tracker.getSnapshotThreshold()).toBe(10000);
    });
  });

  describe('getCurrentTokenCount()', () => {
    it('should return current accumulated token count', async () => {
      await tracker.addTokens(500);
      expect(tracker.getCurrentTokenCount()).toBe(500);
    });
  });

  // ── addTokens ───────────────────────────────────────────────────────────────

  describe('addTokens()', () => {
    it('should accumulate token count across multiple calls', async () => {
      await tracker.addTokens(3000);
      await tracker.addTokens(2000);
      expect(tracker.getCurrentTokenCount()).toBe(5000);
    });

    it('should create a snapshot and reset count when threshold is reached', async () => {
      await tracker.addTokens(10000);

      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
      const call = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.entities[0].entityType).toBe('project_snapshot');
      expect(tracker.getCurrentTokenCount()).toBe(0);
    });

    it('should create a snapshot when threshold is exceeded (not just exact match)', async () => {
      await tracker.addTokens(15000);

      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
      expect(tracker.getCurrentTokenCount()).toBe(0);
    });

    it('should not create a snapshot below threshold', async () => {
      await tracker.addTokens(9999);

      expect(mcp.memory.createEntities).not.toHaveBeenCalled();
      expect(tracker.getCurrentTokenCount()).toBe(9999);
    });

    it('should include token count in snapshot observations', async () => {
      await tracker.addTokens(10000);

      const call = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const observations: string[] = call.entities[0].observations;
      expect(observations.some(o => o.includes('Token count:'))).toBe(true);
      expect(observations.some(o => o.includes('Snapshot threshold: 10000'))).toBe(true);
    });
  });

  // ── recordCodeChange ─────────────────────────────────────────────────────────

  describe('recordCodeChange()', () => {
    it('should schedule a pending flush for files', async () => {
      await tracker.recordCodeChange(['src/foo.ts'], 'Added feature');

      // No immediate memory creation — aggregated
      expect(mcp.memory.createEntities).not.toHaveBeenCalled();
    });

    it('should return early when both files and description are empty', async () => {
      await tracker.recordCodeChange([], '');

      // Force flush — no pending changes should mean no entity creation
      await tracker.flushPendingCodeChanges('manual');

      expect(mcp.memory.createEntities).not.toHaveBeenCalled();
    });

    it('should aggregate multiple file changes within the window', async () => {
      await tracker.recordCodeChange(['src/a.ts'], 'Change A');
      await tracker.recordCodeChange(['src/b.ts'], 'Change B');

      // Manually flush (simulates what the timer would trigger)
      await tracker.flushPendingCodeChanges('idle-window');

      // Only one entity created (aggregated)
      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
      const call = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const observations: string[] = call.entities[0].observations;
      expect(observations.some(o => o.includes('src/a.ts'))).toBe(true);
      expect(observations.some(o => o.includes('src/b.ts'))).toBe(true);
    });

    it('should produce a code_change entity when manually flushed with idle-window reason', async () => {
      await tracker.recordCodeChange(['src/app.ts'], 'Initial');

      await tracker.flushPendingCodeChanges('idle-window');

      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
      const call = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.entities[0].entityType).toBe('code_change');
    });

    it('should not flush when only a description is provided (no files)', async () => {
      await tracker.recordCodeChange([], 'Description only');

      // Force flush
      await tracker.flushPendingCodeChanges('manual');

      expect(mcp.memory.createEntities).not.toHaveBeenCalled();
    });
  });

  // ── flushPendingCodeChanges ──────────────────────────────────────────────────

  describe('flushPendingCodeChanges()', () => {
    it('should be a no-op when no pending changes exist', async () => {
      await tracker.flushPendingCodeChanges('test-complete');

      expect(mcp.memory.createEntities).not.toHaveBeenCalled();
    });

    it('should create a code_change entity when pending files exist', async () => {
      await tracker.recordCodeChange(['src/api.ts'], 'API change');
      await tracker.flushPendingCodeChanges('test-complete');

      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
      const entity = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0];
      expect(entity.entityType).toBe('code_change');
    });

    it('should include the reason in observations', async () => {
      await tracker.recordCodeChange(['src/api.ts'], 'Some change');
      await tracker.flushPendingCodeChanges('commit');

      const entity = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0];
      const observations: string[] = entity.observations;
      expect(observations.some(o => o.includes('Reason: commit'))).toBe(true);
    });

    it('should clear pending state after flush', async () => {
      await tracker.recordCodeChange(['src/a.ts'], 'Change');
      await tracker.flushPendingCodeChanges('test-complete');
      vi.clearAllMocks();

      // Second flush should be a no-op
      await tracker.flushPendingCodeChanges('test-complete');
      expect(mcp.memory.createEntities).not.toHaveBeenCalled();
    });

    it('should skip creation when a recent NORMAL memory covers the same files', async () => {
      await tracker.recordCodeChange(['src/a.ts'], 'First change');
      await tracker.flushPendingCodeChanges('idle-window');

      vi.clearAllMocks();

      // Same file again within 5-minute merge window — should be deduplicated
      await tracker.recordCodeChange(['src/a.ts'], 'Second change');
      await tracker.flushPendingCodeChanges('idle-window');

      expect(mcp.memory.createEntities).not.toHaveBeenCalled();
    });

    it('should allow CRITICAL priority flush to override a prior NORMAL flush', async () => {
      await tracker.recordCodeChange(['src/a.ts'], 'First change');
      await tracker.flushPendingCodeChanges('idle-window'); // NORMAL priority

      vi.clearAllMocks();

      await tracker.recordCodeChange(['src/a.ts'], 'Critical change');
      await tracker.flushPendingCodeChanges('test-complete'); // CRITICAL priority

      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
    });

    it('should include multiple files in observations', async () => {
      const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
      await tracker.recordCodeChange(files, 'Multi-file change');
      await tracker.flushPendingCodeChanges('commit');

      const entity = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0];
      const observations: string[] = entity.observations;
      expect(observations.some(o => o.includes('Files modified: 3'))).toBe(true);
    });
  });

  // ── recordTaskStart ──────────────────────────────────────────────────────────

  describe('recordTaskStart()', () => {
    it('should create a task_start entity with required fields', async () => {
      await tracker.recordTaskStart({
        task_description: 'Implement login feature',
        goal: 'Allow users to log in',
      });

      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
      const entity = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0];
      expect(entity.entityType).toBe('task_start');
      expect(entity.observations.some((o: string) => o.includes('GOAL: Allow users to log in'))).toBe(true);
      expect(entity.observations.some((o: string) => o.includes('TASK: Implement login feature'))).toBe(true);
    });

    it('should include optional reason and expected_outcome when provided', async () => {
      await tracker.recordTaskStart({
        task_description: 'Fix bug',
        goal: 'Eliminate null pointer',
        reason: 'Production crash',
        expected_outcome: 'No more crashes',
      });

      const observations = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0].observations as string[];
      expect(observations.some(o => o.includes('REASON: Production crash'))).toBe(true);
      expect(observations.some(o => o.includes('EXPECTED: No more crashes'))).toBe(true);
    });

    it('should include priority when provided', async () => {
      await tracker.recordTaskStart({
        task_description: 'Critical hotfix',
        goal: 'Fix crash',
        priority: 'P0',
      });

      const observations = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0].observations as string[];
      expect(observations.some(o => o.includes('PRIORITY: P0'))).toBe(true);
    });

    it('should truncate long goal in entity name to 50 characters', async () => {
      const longGoal = 'A'.repeat(100);
      await tracker.recordTaskStart({
        task_description: 'Task',
        goal: longGoal,
      });

      const entity = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0];
      // Name format: "Task Started: <goal[0:50]> - <date>"
      const nameGoalPart = entity.name.replace('Task Started: ', '').split(' - ')[0];
      expect(nameGoalPart.length).toBe(50);
    });
  });

  // ── recordDecision ───────────────────────────────────────────────────────────

  describe('recordDecision()', () => {
    it('should create a decision entity with required fields', async () => {
      await tracker.recordDecision({
        decision_description: 'Choose a database',
        context: 'Need persistent storage',
        chosen_option: 'PostgreSQL',
        rationale: 'Best fit for relational data',
      });

      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
      const entity = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0];
      expect(entity.entityType).toBe('decision');
      const obs = entity.observations as string[];
      expect(obs.some(o => o.includes('DECISION: Choose a database'))).toBe(true);
      expect(obs.some(o => o.includes('CHOSEN: PostgreSQL'))).toBe(true);
      expect(obs.some(o => o.includes('RATIONALE: Best fit for relational data'))).toBe(true);
    });

    it('should include options_considered when provided', async () => {
      await tracker.recordDecision({
        decision_description: 'Framework choice',
        context: 'New project',
        options_considered: ['React', 'Vue', 'Svelte'],
        chosen_option: 'React',
        rationale: 'Team familiarity',
      });

      const obs = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0].observations as string[];
      expect(obs.some(o => o.includes('OPTIONS CONSIDERED: React, Vue, Svelte'))).toBe(true);
    });

    it('should include trade_offs and confidence when provided', async () => {
      await tracker.recordDecision({
        decision_description: 'Caching strategy',
        context: 'Performance issue',
        chosen_option: 'Redis',
        rationale: 'Fast in-memory cache',
        trade_offs: 'Extra infrastructure cost',
        confidence: 'high',
      });

      const obs = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0].observations as string[];
      expect(obs.some(o => o.includes('TRADE-OFFS: Extra infrastructure cost'))).toBe(true);
      expect(obs.some(o => o.includes('CONFIDENCE: high'))).toBe(true);
    });

    it('should skip options_considered when array is empty', async () => {
      await tracker.recordDecision({
        decision_description: 'No options',
        context: 'Context',
        options_considered: [],
        chosen_option: 'Option A',
        rationale: 'Only one',
      });

      const obs = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0].observations as string[];
      expect(obs.every(o => !o.includes('OPTIONS CONSIDERED'))).toBe(true);
    });
  });

  // ── recordProgressMilestone ──────────────────────────────────────────────────

  describe('recordProgressMilestone()', () => {
    it('should create a progress_milestone entity with required fields', async () => {
      await tracker.recordProgressMilestone({
        milestone_description: 'MVP released',
        significance: 'First public version',
      });

      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
      const entity = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0];
      expect(entity.entityType).toBe('progress_milestone');
      const obs = entity.observations as string[];
      expect(obs.some(o => o.includes('MILESTONE: MVP released'))).toBe(true);
      expect(obs.some(o => o.includes('SIGNIFICANCE: First public version'))).toBe(true);
    });

    it('should include optional impact, learnings, and next_steps when provided', async () => {
      await tracker.recordProgressMilestone({
        milestone_description: 'Auth complete',
        significance: 'Core feature done',
        impact: 'Users can log in',
        learnings: 'JWT is complex',
        next_steps: 'Add 2FA',
      });

      const obs = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0].observations as string[];
      expect(obs.some(o => o.includes('IMPACT: Users can log in'))).toBe(true);
      expect(obs.some(o => o.includes('LEARNINGS: JWT is complex'))).toBe(true);
      expect(obs.some(o => o.includes('NEXT STEPS: Add 2FA'))).toBe(true);
    });
  });

  // ── recordError ──────────────────────────────────────────────────────────────

  describe('recordError()', () => {
    it('should create an error_resolution entity with required fields', async () => {
      await tracker.recordError({
        error_type: 'TypeError',
        error_message: 'Cannot read properties of undefined',
        context: 'Login handler',
        resolution: 'Added null check',
      });

      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
      const entity = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0];
      expect(entity.entityType).toBe('error_resolution');
      const obs = entity.observations as string[];
      expect(obs.some(o => o.includes('ERROR TYPE: TypeError'))).toBe(true);
      expect(obs.some(o => o.includes('MESSAGE: Cannot read properties of undefined'))).toBe(true);
      expect(obs.some(o => o.includes('RESOLUTION: Added null check'))).toBe(true);
    });

    it('should include optional root_cause and prevention when provided', async () => {
      await tracker.recordError({
        error_type: 'NetworkError',
        error_message: 'Connection refused',
        context: 'API call',
        resolution: 'Retry with backoff',
        root_cause: 'Service was down',
        prevention: 'Add health check',
      });

      const obs = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0].observations as string[];
      expect(obs.some(o => o.includes('ROOT CAUSE: Service was down'))).toBe(true);
      expect(obs.some(o => o.includes('PREVENTION: Add health check'))).toBe(true);
    });
  });

  // ── recordTestResult ─────────────────────────────────────────────────────────

  describe('recordTestResult()', () => {
    it('should create a test_result entity with PASS status when no failures', async () => {
      await tracker.recordTestResult({ passed: 10, failed: 0, total: 10, failures: [] });

      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
      const entity = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0];
      expect(entity.entityType).toBe('test_result');
      expect(entity.observations.some((o: string) => o.includes('Status: PASS'))).toBe(true);
    });

    it('should create a test_result entity with FAIL status when failures exist', async () => {
      await tracker.recordTestResult({
        passed: 8,
        failed: 2,
        total: 10,
        failures: ['Auth test failed', 'Login test failed'],
      });

      const obs = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0].observations as string[];
      expect(obs.some(o => o.includes('Status: FAIL'))).toBe(true);
      expect(obs.some(o => o.includes('Tests failed: 2'))).toBe(true);
      expect(obs.some(o => o.includes('Auth test failed'))).toBe(true);
    });

    it('should include passed/total counts in observations', async () => {
      await tracker.recordTestResult({ passed: 5, failed: 0, total: 5, failures: [] });

      const obs = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0].observations as string[];
      expect(obs.some(o => o.includes('Tests passed: 5/5'))).toBe(true);
    });

    it('should flush pending code changes before recording test result', async () => {
      await tracker.recordCodeChange(['src/feature.ts'], 'Feature added');
      await tracker.recordTestResult({ passed: 3, failed: 0, total: 3, failures: [] });

      // Two createEntities calls: one for code_change, one for test_result
      expect(mcp.memory.createEntities).toHaveBeenCalledTimes(2);
      const entityTypes = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[][]) => (c[0] as { entities: Array<{ entityType: string }> }).entities[0].entityType
      );
      expect(entityTypes).toContain('code_change');
      expect(entityTypes).toContain('test_result');
    });
  });

  // ── recordCommit ─────────────────────────────────────────────────────────────

  describe('recordCommit()', () => {
    it('should create a commit entity', async () => {
      await tracker.recordCommit({ message: 'feat: add login' });

      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
      const entity = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0];
      expect(entity.entityType).toBe('commit');
    });

    it('should include message in observations when provided', async () => {
      await tracker.recordCommit({ message: 'fix: resolve null crash' });

      const obs = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0].observations as string[];
      expect(obs.some(o => o.includes('Message: fix: resolve null crash'))).toBe(true);
    });

    it('should include command in observations when provided', async () => {
      await tracker.recordCommit({ command: 'git commit -m "chore: update deps"' });

      const obs = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0].observations as string[];
      expect(obs.some(o => o.includes('Command: git commit'))).toBe(true);
    });

    it('should include truncated output (first 5 lines) when provided', async () => {
      const output = 'line1\nline2\nline3\nline4\nline5\nline6\nline7';
      await tracker.recordCommit({ output });

      const obs = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0].observations as string[];
      expect(obs.some(o => o.includes('line1'))).toBe(true);
      expect(obs.some(o => o.includes('more lines'))).toBe(true);
    });

    it('should flush pending code changes before recording commit', async () => {
      await tracker.recordCodeChange(['src/fix.ts'], 'Bug fix');
      await tracker.recordCommit({ message: 'fix: bug' });

      const entityTypes = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[][]) => (c[0] as { entities: Array<{ entityType: string }> }).entities[0].entityType
      );
      expect(entityTypes).toContain('code_change');
      expect(entityTypes).toContain('commit');
    });
  });

  // ── recordWorkflowCheckpoint ─────────────────────────────────────────────────

  describe('recordWorkflowCheckpoint()', () => {
    it('should create a workflow_checkpoint entity', async () => {
      await tracker.recordWorkflowCheckpoint('test-complete');

      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
      const entity = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0];
      expect(entity.entityType).toBe('workflow_checkpoint');
    });

    it('should include checkpoint name in observations', async () => {
      await tracker.recordWorkflowCheckpoint('commit-ready');

      const obs = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0].observations as string[];
      expect(obs.some(o => o.includes('Checkpoint: commit-ready'))).toBe(true);
    });

    it('should include extra details when provided', async () => {
      await tracker.recordWorkflowCheckpoint('build-complete', ['Build time: 5s', 'Artifacts: 3']);

      const obs = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0].observations as string[];
      expect(obs.some(o => o.includes('Build time: 5s'))).toBe(true);
      expect(obs.some(o => o.includes('Artifacts: 3'))).toBe(true);
    });

    it('should work with empty details array (default)', async () => {
      await expect(tracker.recordWorkflowCheckpoint('code-written')).resolves.toBeUndefined();
    });
  });

  // ── Hook factory methods ─────────────────────────────────────────────────────

  describe('createFileChangeHook()', () => {
    it('should return a function that records code changes when flushed', async () => {
      const hook = tracker.createFileChangeHook();
      await hook(['src/index.ts'], 'Initial commit');

      // Flush manually to verify the data was recorded
      await tracker.flushPendingCodeChanges('idle-window');

      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
    });

    it('should return a function (hook) not the result directly', () => {
      const hook = tracker.createFileChangeHook();
      expect(typeof hook).toBe('function');
    });
  });

  describe('createTestResultHook()', () => {
    it('should return a function that records test results', async () => {
      const hook = tracker.createTestResultHook();
      await hook({ passed: 5, failed: 0, total: 5, failures: [] });

      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
      const entity = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls[0][0].entities[0];
      expect(entity.entityType).toBe('test_result');
    });

    it('should return a function (hook) not the result directly', () => {
      const hook = tracker.createTestResultHook();
      expect(typeof hook).toBe('function');
    });
  });

  describe('createTokenHook()', () => {
    it('should return a function that adds tokens', async () => {
      const hook = tracker.createTokenHook();
      await hook(5000);

      expect(tracker.getCurrentTokenCount()).toBe(5000);
    });

    it('should trigger snapshot when accumulated tokens exceed threshold', async () => {
      const hook = tracker.createTokenHook();
      await hook(10000);

      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
      expect(tracker.getCurrentTokenCount()).toBe(0);
    });
  });

  // ── CheckpointPriority enum ──────────────────────────────────────────────────

  describe('CheckpointPriority', () => {
    it('should have NORMAL < IMPORTANT < CRITICAL ordering', () => {
      expect(CheckpointPriority.NORMAL).toBeLessThan(CheckpointPriority.IMPORTANT);
      expect(CheckpointPriority.IMPORTANT).toBeLessThan(CheckpointPriority.CRITICAL);
    });

    it('should export all three priority levels', () => {
      expect(CheckpointPriority.NORMAL).toBeDefined();
      expect(CheckpointPriority.IMPORTANT).toBeDefined();
      expect(CheckpointPriority.CRITICAL).toBeDefined();
    });
  });

  // ── Deduplication / merge window ─────────────────────────────────────────────

  describe('Memory deduplication (merge window)', () => {
    it('should allow flush when merge window has expired', async () => {
      await tracker.recordCodeChange(['src/a.ts'], 'First');
      await tracker.flushPendingCodeChanges('idle-window');

      // Advance real time past 5-minute merge window using Date mock
      const futureMs = Date.now() + 6 * 60 * 1000;
      vi.spyOn(Date, 'now').mockReturnValue(futureMs);
      vi.clearAllMocks();

      await tracker.recordCodeChange(['src/a.ts'], 'Second');
      await tracker.flushPendingCodeChanges('idle-window');

      vi.spyOn(Date, 'now').mockRestore();
      expect(mcp.memory.createEntities).toHaveBeenCalledOnce();
    });

    it('should deduplicate when same files are flushed twice within window at equal priority', async () => {
      await tracker.recordCodeChange(['src/shared.ts'], 'Change 1');
      await tracker.flushPendingCodeChanges('idle-window'); // NORMAL

      const firstCallCount = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls.length;

      await tracker.recordCodeChange(['src/shared.ts'], 'Change 2');
      await tracker.flushPendingCodeChanges('idle-window'); // NORMAL again

      const secondCallCount = (mcp.memory.createEntities as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(secondCallCount).toBe(firstCallCount); // No new call
    });

    it('should not deduplicate when files are different', async () => {
      await tracker.recordCodeChange(['src/a.ts'], 'Change A');
      await tracker.flushPendingCodeChanges('idle-window');

      await tracker.recordCodeChange(['src/b.ts'], 'Change B');
      await tracker.flushPendingCodeChanges('idle-window');

      expect(mcp.memory.createEntities).toHaveBeenCalledTimes(2);
    });
  });
});
