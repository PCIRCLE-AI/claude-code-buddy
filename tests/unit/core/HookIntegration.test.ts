/**
 * HookIntegration Tests
 *
 * Tests for the Claude Code Hooks bridge that monitors tool execution and
 * automatically triggers workflow checkpoints.
 *
 * Test coverage:
 * - Constructor / initialization
 * - detectCheckpointFromToolUse: Write, Edit, Bash (test/git), null cases
 * - processToolUse: checkpoint triggering, callbacks, project memory recording
 * - onButlerTrigger: callback registration and execution
 * - setProjectMemory: late initialization guard
 * - Token tracking via processToolUse
 * - Error auto-detection from command output
 * - Edge cases (failed tools, missing args, non-checkpoint tools)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HookIntegration } from '../../../src/core/HookIntegration.js';
import { CheckpointDetector } from '../../../src/core/CheckpointDetector.js';
import { ProjectAutoTracker } from '../../../src/memory/ProjectAutoTracker.js';
import type { ToolUseData, CheckpointContext } from '../../../src/core/HookIntegration.js';
import type { MCPToolInterface } from '../../../src/core/MCPToolInterface.js';

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockMcp(): MCPToolInterface {
  return {
    memory: {
      createEntities: vi.fn().mockResolvedValue(undefined),
      searchNodes: vi.fn().mockResolvedValue([]),
    },
  } as unknown as MCPToolInterface;
}

function createMockDetector(): CheckpointDetector {
  const detector = new CheckpointDetector();
  // Register all checkpoints that HookIntegration may trigger
  const checkpoints = ['code-written', 'test-complete', 'commit-ready', 'committed'];
  for (const name of checkpoints) {
    detector.registerCheckpoint(name, async () => ({ success: true }));
  }
  return detector;
}

function createMockTracker(): ProjectAutoTracker {
  const mcp = createMockMcp();
  return new ProjectAutoTracker(mcp);
}

// ─── Common ToolUseData fixtures ─────────────────────────────────────────────

const writeToolData: ToolUseData = {
  toolName: 'Write',
  arguments: { file_path: 'src/api/users.ts', content: 'export const foo = 1;' },
  success: true,
  duration: 120,
  tokensUsed: 800,
};

const editToolData: ToolUseData = {
  toolName: 'Edit',
  arguments: { file_path: 'src/utils.ts', old_string: 'old', new_string: 'new' },
  success: true,
  duration: 80,
};

const testBashData: ToolUseData = {
  toolName: 'Bash',
  arguments: { command: 'npx vitest run' },
  success: true,
  output: '10 passed, 0 failed',
};

const gitAddBashData: ToolUseData = {
  toolName: 'Bash',
  arguments: { command: 'git add .' },
  success: true,
};

const gitCommitBashData: ToolUseData = {
  toolName: 'Bash',
  arguments: { command: 'git commit -m "feat: add users"' },
  success: true,
  output: '[main abc1234] feat: add users',
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('HookIntegration', () => {
  let detector: CheckpointDetector;
  let hooks: HookIntegration;

  beforeEach(() => {
    detector = createMockDetector();
    hooks = new HookIntegration(detector);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Constructor ─────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should instantiate without errors when only detector is provided', () => {
      expect(() => new HookIntegration(detector)).not.toThrow();
    });

    it('should instantiate without errors when projectAutoTracker is provided', () => {
      const tracker = createMockTracker();
      expect(() => new HookIntegration(detector, tracker)).not.toThrow();
    });
  });

  // ── detectCheckpointFromToolUse ──────────────────────────────────────────────

  describe('detectCheckpointFromToolUse()', () => {
    describe('Write tool', () => {
      it('should detect code-written checkpoint for Write tool', async () => {
        const result = await hooks.detectCheckpointFromToolUse(writeToolData);

        expect(result).not.toBeNull();
        expect(result!.name).toBe('code-written');
      });

      it('should include the file path in checkpoint data', async () => {
        const result = await hooks.detectCheckpointFromToolUse(writeToolData);

        expect(result!.data.files).toEqual(['src/api/users.ts']);
      });

      it('should set type to new-file for Write tool', async () => {
        const result = await hooks.detectCheckpointFromToolUse(writeToolData);

        expect(result!.data.type).toBe('new-file');
      });

      it('should mark test files with hasTests = true', async () => {
        const testFileData: ToolUseData = {
          toolName: 'Write',
          arguments: { file_path: 'src/api.test.ts', content: '' },
          success: true,
        };

        const result = await hooks.detectCheckpointFromToolUse(testFileData);

        expect(result!.data.hasTests).toBe(true);
      });

      it('should mark non-test files with hasTests = false', async () => {
        const result = await hooks.detectCheckpointFromToolUse(writeToolData);
        expect(result!.data.hasTests).toBe(false);
      });
    });

    describe('Edit tool', () => {
      it('should detect code-written checkpoint for Edit tool', async () => {
        const result = await hooks.detectCheckpointFromToolUse(editToolData);

        expect(result).not.toBeNull();
        expect(result!.name).toBe('code-written');
      });

      it('should set type to modification for Edit tool', async () => {
        const result = await hooks.detectCheckpointFromToolUse(editToolData);

        expect(result!.data.type).toBe('modification');
      });

      it('should include the file path in Edit checkpoint data', async () => {
        const result = await hooks.detectCheckpointFromToolUse(editToolData);

        expect(result!.data.files).toEqual(['src/utils.ts']);
      });
    });

    describe('Bash tool — test commands', () => {
      it('should detect test-complete for npm test command', async () => {
        const data: ToolUseData = {
          toolName: 'Bash',
          arguments: { command: 'npm test' },
          success: true,
          output: '5 passed',
        };

        const result = await hooks.detectCheckpointFromToolUse(data);

        expect(result).not.toBeNull();
        expect(result!.name).toBe('test-complete');
      });

      it('should detect test-complete for vitest command', async () => {
        const result = await hooks.detectCheckpointFromToolUse(testBashData);

        expect(result!.name).toBe('test-complete');
      });

      it('should detect test-complete for jest command', async () => {
        const data: ToolUseData = {
          toolName: 'Bash',
          arguments: { command: 'jest --coverage' },
          success: true,
          output: '3 passed',
        };

        const result = await hooks.detectCheckpointFromToolUse(data);

        expect(result!.name).toBe('test-complete');
      });

      it('should include parsed test counts in checkpoint data', async () => {
        const data: ToolUseData = {
          toolName: 'Bash',
          arguments: { command: 'npm test' },
          success: true,
          output: '34 tests passed, 2 tests failed',
        };

        const result = await hooks.detectCheckpointFromToolUse(data);

        expect(result!.data.total).toBe(36);
        expect(result!.data.passed).toBe(34);
        expect(result!.data.failed).toBe(2);
      });

      it('should handle empty test output gracefully (zero counts)', async () => {
        const data: ToolUseData = {
          toolName: 'Bash',
          arguments: { command: 'npm test' },
          success: true,
          output: '',
        };

        const result = await hooks.detectCheckpointFromToolUse(data);

        expect(result!.name).toBe('test-complete');
        expect(result!.data.total).toBe(0);
      });
    });

    describe('Bash tool — git commands', () => {
      it('should detect commit-ready for git add command', async () => {
        const result = await hooks.detectCheckpointFromToolUse(gitAddBashData);

        expect(result).not.toBeNull();
        expect(result!.name).toBe('commit-ready');
      });

      it('should detect committed for git commit command', async () => {
        const result = await hooks.detectCheckpointFromToolUse(gitCommitBashData);

        expect(result).not.toBeNull();
        expect(result!.name).toBe('committed');
      });

      it('should extract commit message from git commit command', async () => {
        const result = await hooks.detectCheckpointFromToolUse(gitCommitBashData);

        expect(result!.data.message).toBe('feat: add users');
      });

      it('should include the git commit command in checkpoint data', async () => {
        const result = await hooks.detectCheckpointFromToolUse(gitCommitBashData);

        expect(result!.data.command).toContain('git commit');
      });

      it('should detect committed before test-complete when git commit also triggers test patterns', async () => {
        // git commit takes priority over test pattern check
        const data: ToolUseData = {
          toolName: 'Bash',
          arguments: { command: 'git commit -m "test: add coverage"' },
          success: true,
        };

        const result = await hooks.detectCheckpointFromToolUse(data);

        expect(result!.name).toBe('committed');
      });
    });

    describe('null / no-checkpoint cases', () => {
      it('should return null for failed tool execution', async () => {
        const failedTool: ToolUseData = {
          toolName: 'Write',
          arguments: { file_path: 'src/api.ts', content: '' },
          success: false,
        };

        const result = await hooks.detectCheckpointFromToolUse(failedTool);

        expect(result).toBeNull();
      });

      it('should return null for Read tool (non-checkpoint)', async () => {
        const readTool: ToolUseData = {
          toolName: 'Read',
          arguments: { file_path: 'README.md' },
          success: true,
        };

        const result = await hooks.detectCheckpointFromToolUse(readTool);

        expect(result).toBeNull();
      });

      it('should return null for Bash tool with non-checkpoint command', async () => {
        const data: ToolUseData = {
          toolName: 'Bash',
          arguments: { command: 'ls -la' },
          success: true,
        };

        const result = await hooks.detectCheckpointFromToolUse(data);

        expect(result).toBeNull();
      });

      it('should return null when arguments are missing', async () => {
        const data: ToolUseData = {
          toolName: 'Write',
          success: true,
        };

        const result = await hooks.detectCheckpointFromToolUse(data);

        expect(result).toBeNull();
      });

      it('should return null when arguments is a non-object primitive', async () => {
        const data: ToolUseData = {
          toolName: 'Write',
          arguments: 'string-arg' as unknown,
          success: true,
        };

        const result = await hooks.detectCheckpointFromToolUse(data);

        expect(result).toBeNull();
      });

      it('should return null for unknown tool names', async () => {
        const data: ToolUseData = {
          toolName: 'UnknownTool',
          arguments: { something: 'value' },
          success: true,
        };

        const result = await hooks.detectCheckpointFromToolUse(data);

        expect(result).toBeNull();
      });
    });
  });

  // ── processToolUse ────────────────────────────────────────────────────────────

  describe('processToolUse()', () => {
    it('should trigger checkpoint through detector for Write tool', async () => {
      const triggerSpy = vi.spyOn(detector, 'triggerCheckpoint');

      await hooks.processToolUse(writeToolData);

      expect(triggerSpy).toHaveBeenCalledWith('code-written', expect.any(Object));
    });

    it('should trigger checkpoint through detector for Bash git commit', async () => {
      const triggerSpy = vi.spyOn(detector, 'triggerCheckpoint');

      await hooks.processToolUse(gitCommitBashData);

      expect(triggerSpy).toHaveBeenCalledWith('committed', expect.any(Object));
    });

    it('should not trigger checkpoint for failed tool', async () => {
      const triggerSpy = vi.spyOn(detector, 'triggerCheckpoint');
      const failedData: ToolUseData = { ...writeToolData, success: false };

      await hooks.processToolUse(failedData);

      expect(triggerSpy).not.toHaveBeenCalled();
    });

    it('should not trigger checkpoint for non-checkpoint tool', async () => {
      const triggerSpy = vi.spyOn(detector, 'triggerCheckpoint');
      const readData: ToolUseData = {
        toolName: 'Read',
        arguments: { file_path: 'README.md' },
        success: true,
      };

      await hooks.processToolUse(readData);

      expect(triggerSpy).not.toHaveBeenCalled();
    });

    it('should execute all registered onButlerTrigger callbacks when checkpoint fires', async () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      hooks.onButlerTrigger(callback1);
      hooks.onButlerTrigger(callback2);

      await hooks.processToolUse(writeToolData);

      expect(callback1).toHaveBeenCalledOnce();
      expect(callback2).toHaveBeenCalledOnce();
    });

    it('should pass correct CheckpointContext to callbacks', async () => {
      let capturedContext: CheckpointContext | null = null;

      hooks.onButlerTrigger((ctx) => {
        capturedContext = ctx;
      });

      await hooks.processToolUse(writeToolData);

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.checkpoint).toBe('code-written');
      expect(capturedContext!.toolName).toBe('Write');
      expect(capturedContext!.data).toHaveProperty('files');
    });

    it('should not call callbacks when no checkpoint is detected', async () => {
      const callback = vi.fn();
      hooks.onButlerTrigger(callback);

      const readData: ToolUseData = {
        toolName: 'Read',
        arguments: { file_path: 'docs.md' },
        success: true,
      };

      await hooks.processToolUse(readData);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should track token usage via project memory when provided', async () => {
      const tracker = createMockTracker();
      const tokenHookSpy = vi.spyOn(tracker, 'createTokenHook');
      const hooksWithMemory = new HookIntegration(detector, tracker);

      await hooksWithMemory.processToolUse({
        ...writeToolData,
        tokensUsed: 1200,
      });

      expect(tokenHookSpy).toHaveBeenCalled();
    });

    it('should not call addTokens when no tokensUsed field provided', async () => {
      const tracker = createMockTracker();
      const addTokensSpy = vi.spyOn(tracker, 'addTokens');
      const hooksWithMemory = new HookIntegration(detector, tracker);

      await hooksWithMemory.processToolUse({
        toolName: 'Read',
        arguments: { file_path: 'README.md' },
        success: true,
        // No tokensUsed
      });

      expect(addTokensSpy).not.toHaveBeenCalled();
    });

    it('should record code change to project memory on code-written checkpoint', async () => {
      const tracker = createMockTracker();
      const fileChangeHookSpy = vi.spyOn(tracker, 'createFileChangeHook');
      const hooksWithMemory = new HookIntegration(detector, tracker);

      await hooksWithMemory.processToolUse(writeToolData);

      expect(fileChangeHookSpy).toHaveBeenCalled();
    });

    it('should record test results to project memory on test-complete checkpoint', async () => {
      const tracker = createMockTracker();
      const testResultHookSpy = vi.spyOn(tracker, 'createTestResultHook');
      const hooksWithMemory = new HookIntegration(detector, tracker);

      await hooksWithMemory.processToolUse(testBashData);

      expect(testResultHookSpy).toHaveBeenCalled();
    });

    describe('Error auto-detection from output', () => {
      it('should attempt error recording when output contains "error:" pattern', async () => {
        const tracker = createMockTracker();
        const recordErrorSpy = vi.spyOn(tracker, 'recordError');
        const hooksWithMemory = new HookIntegration(detector, tracker);

        await hooksWithMemory.processToolUse({
          toolName: 'Bash',
          arguments: { command: 'npm run build' },
          success: true,
          output: 'TypeError: Cannot read property "foo" of undefined',
        });

        expect(recordErrorSpy).toHaveBeenCalled();
      });

      it('should not attempt error recording when output has no error patterns', async () => {
        const tracker = createMockTracker();
        const recordErrorSpy = vi.spyOn(tracker, 'recordError');
        const hooksWithMemory = new HookIntegration(detector, tracker);

        await hooksWithMemory.processToolUse({
          toolName: 'Bash',
          arguments: { command: 'ls -la' },
          success: true,
          output: 'total 48\ndrwxr-xr-x  5 user group 160',
        });

        expect(recordErrorSpy).not.toHaveBeenCalled();
      });

      it('should not record error when projectAutoTracker is absent', async () => {
        const hooksWithoutTracker = new HookIntegration(detector);

        // Should not throw even with error output and no tracker
        await expect(hooksWithoutTracker.processToolUse({
          toolName: 'Bash',
          arguments: { command: 'npm run build' },
          success: true,
          output: 'Build failed: error in module',
        })).resolves.toBeUndefined();
      });
    });
  });

  // ── onButlerTrigger ──────────────────────────────────────────────────────────

  describe('onButlerTrigger()', () => {
    it('should register a callback and invoke it on checkpoint', async () => {
      const callback = vi.fn();
      hooks.onButlerTrigger(callback);

      await hooks.processToolUse(writeToolData);

      expect(callback).toHaveBeenCalledOnce();
    });

    it('should allow multiple callbacks to be registered', async () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const cb3 = vi.fn();

      hooks.onButlerTrigger(cb1);
      hooks.onButlerTrigger(cb2);
      hooks.onButlerTrigger(cb3);

      await hooks.processToolUse(writeToolData);

      expect(cb1).toHaveBeenCalledOnce();
      expect(cb2).toHaveBeenCalledOnce();
      expect(cb3).toHaveBeenCalledOnce();
    });

    it('should fire callbacks for every checkpoint triggered', async () => {
      const callback = vi.fn();
      hooks.onButlerTrigger(callback);

      await hooks.processToolUse(writeToolData);     // code-written
      await hooks.processToolUse(testBashData);      // test-complete
      await hooks.processToolUse(gitCommitBashData); // committed

      expect(callback).toHaveBeenCalledTimes(3);
    });

    it('should include checkpoint name in each callback context', async () => {
      const names: string[] = [];
      hooks.onButlerTrigger(ctx => names.push(ctx.checkpoint));

      await hooks.processToolUse(writeToolData);
      await hooks.processToolUse(testBashData);
      await hooks.processToolUse(gitAddBashData);

      expect(names).toContain('code-written');
      expect(names).toContain('test-complete');
      expect(names).toContain('commit-ready');
    });
  });

  // ── setProjectMemory ─────────────────────────────────────────────────────────

  describe('setProjectMemory()', () => {
    it('should set project memory when not already set', () => {
      const tracker = createMockTracker();
      hooks.setProjectMemory(tracker);
      // No throw = success; internal state verified via token tracking
      expect(() => hooks.setProjectMemory(tracker)).not.toThrow();
    });

    it('should not overwrite already-set project memory', async () => {
      const tracker1 = createMockTracker();
      const tracker2 = createMockTracker();

      const hooksWithTracker = new HookIntegration(detector, tracker1);

      // Try to override — should be ignored
      hooksWithTracker.setProjectMemory(tracker2);

      // The original tracker1 should be used for token tracking
      const addTokens1 = vi.spyOn(tracker1, 'addTokens');
      const addTokens2 = vi.spyOn(tracker2, 'addTokens');

      await hooksWithTracker.processToolUse({ ...writeToolData, tokensUsed: 100 });

      expect(addTokens1).toHaveBeenCalled();
      expect(addTokens2).not.toHaveBeenCalled();
    });
  });

  // ── Checkpoint detector integration ──────────────────────────────────────────

  describe('CheckpointDetector integration', () => {
    it('should throw when triggered checkpoint is not registered in detector', async () => {
      const emptyDetector = new CheckpointDetector();
      const hooksWithEmptyDetector = new HookIntegration(emptyDetector);

      await expect(hooksWithEmptyDetector.processToolUse(writeToolData)).rejects.toThrow();
    });

    it('should succeed when all required checkpoints are registered', async () => {
      await expect(hooks.processToolUse(writeToolData)).resolves.toBeUndefined();
    });
  });
});
