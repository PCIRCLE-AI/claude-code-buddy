// tests/ui/MetricsStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetricsStore } from '../../src/ui/MetricsStore.js';
import type { AttributionMessage } from '../../src/ui/types.js';
import { ValidationError } from '../../src/errors/index.js';
import { existsSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

describe('MetricsStore', () => {
  const testStorePath = join(homedir(), '.memesh-test-metrics-store.json');
  let store: MetricsStore;

  beforeEach(() => {
    // Clean up test file
    if (existsSync(testStorePath)) {
      unlinkSync(testStorePath);
    }
    store = new MetricsStore(testStorePath);
  });

  afterEach(() => {
    // Clean up test file
    if (existsSync(testStorePath)) {
      unlinkSync(testStorePath);
    }
  });

  it('should initialize with new session', () => {
    const metrics = store.getCurrentSessionMetrics();
    expect(metrics.sessionId).toBeDefined();
    expect(metrics.tasksCompleted).toBe(0);
    expect(metrics.tasksFailed).toBe(0);
    expect(metrics.totalTimeSaved).toBe(0);
  });

  it('should record successful attribution', () => {
    const attribution: AttributionMessage = {
      id: 'attr-1',
      type: 'success',
      timestamp: new Date(),
      agentIds: ['bg-123'],
      taskDescription: 'Code review',
      metadata: {
        timeSaved: 15,
        tokensUsed: 5000,
      },
    };

    store.recordAttribution(attribution);

    const metrics = store.getCurrentSessionMetrics();
    expect(metrics.tasksCompleted).toBe(1);
    expect(metrics.totalTimeSaved).toBe(15);
    expect(metrics.totalTokensUsed).toBe(5000);
  });

  it('should record failed attribution', () => {
    const attribution: AttributionMessage = {
      id: 'attr-2',
      type: 'error',
      timestamp: new Date(),
      agentIds: ['bg-456'],
      taskDescription: 'Test execution',
      metadata: {
        error: {
          name: 'TestError',
          message: 'Timeout',
        },
      },
    };

    store.recordAttribution(attribution);

    const metrics = store.getCurrentSessionMetrics();
    expect(metrics.tasksFailed).toBe(1);
    expect(metrics.tasksCompleted).toBe(0);
  });

  it('should track agent usage breakdown', () => {
    const attr1: AttributionMessage = {
      id: 'attr-1',
      type: 'success',
      timestamp: new Date(),
      agentIds: ['code-reviewer'],
      taskDescription: 'Review 1',
    };

    const attr2: AttributionMessage = {
      id: 'attr-2',
      type: 'success',
      timestamp: new Date(),
      agentIds: ['code-reviewer'],
      taskDescription: 'Review 2',
    };

    const attr3: AttributionMessage = {
      id: 'attr-3',
      type: 'success',
      timestamp: new Date(),
      agentIds: ['test-automator'],
      taskDescription: 'Test',
    };

    store.recordAttribution(attr1);
    store.recordAttribution(attr2);
    store.recordAttribution(attr3);

    const metrics = store.getCurrentSessionMetrics();
    expect(metrics.agentUsageBreakdown['code-reviewer']).toBe(2);
    expect(metrics.agentUsageBreakdown['test-automator']).toBe(1);
  });

  it('should persist and load metrics', async () => {
    const attribution: AttributionMessage = {
      id: 'attr-1',
      type: 'success',
      timestamp: new Date(),
      agentIds: ['bg-123'],
      taskDescription: 'Task',
      metadata: { timeSaved: 10 },
    };

    store.recordAttribution(attribution);
    await store.persist();

    // Create new store instance (simulates restart)
    const newStore = new MetricsStore(testStorePath);
    await newStore.load();

    const metrics = newStore.getCurrentSessionMetrics();
    expect(metrics.tasksCompleted).toBe(1);
    expect(metrics.totalTimeSaved).toBe(10);
  });

  describe('path traversal protection', () => {
    it('should throw ValidationError when path is outside home directory', () => {
      expect(() => new MetricsStore('/etc/test-memesh-metrics.json')).toThrow(ValidationError);
    });

    it('should include path details in the ValidationError context', () => {
      let thrown: unknown;
      try {
        new MetricsStore('/etc/test-memesh-metrics.json');
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(ValidationError);
      const ve = thrown as ValidationError;
      expect(ve.message).toContain('home or data directory');
      expect(ve.context?.provided).toBe('/etc/test-memesh-metrics.json');
    });

    it('should throw ValidationError for path with .. traversal that escapes home', () => {
      const escapingPath = join(homedir(), '..', '..', 'etc', 'passwd');
      expect(() => new MetricsStore(escapingPath)).toThrow(ValidationError);
    });

    it('should accept a path within the home directory without throwing', () => {
      const validPath = join(homedir(), '.memesh-test-validation-check.json');
      expect(() => new MetricsStore(validPath)).not.toThrow();
    });
  });

  it('should generate daily summary report', async () => {
    const attr1: AttributionMessage = {
      id: 'attr-1',
      type: 'success',
      timestamp: new Date(),
      agentIds: ['code-reviewer'],
      taskDescription: 'Review',
      metadata: { timeSaved: 20 },
    };

    store.recordAttribution(attr1);

    const report = await store.generateDailyReport();

    expect(report).toContain('Daily Productivity Report');
    expect(report).toContain('**Tasks Completed:** 1');
    expect(report).toContain('**Time Saved:** 20 minutes');
  });
});
