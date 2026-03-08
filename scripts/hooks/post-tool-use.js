#!/usr/bin/env node

/**
 * PostToolUse Hook - Claude Code Event-Driven Hooks
 *
 * Triggered after each tool execution in Claude Code.
 *
 * Features (Silent Observer):
 * - Reads tool execution data from stdin
 * - Detects patterns (READ_BEFORE_EDIT, Git workflows, Frontend work, Search patterns)
 * - Detects anomalies (slow execution, high tokens, failures, quota warnings)
 * - Updates recommendations.json incrementally
 * - Updates current-session.json
 * - Auto-saves key points to MeMesh when token threshold reached
 * - Runs silently (no console output - non-intrusive)
 */

import {
  STATE_DIR,
  MEMESH_DB_PATH,
  THRESHOLDS,
  readJSONFile,
  writeJSONFile,
  writeJSONFileAsync,
  sqliteBatchEntity,
  readStdin,
  logError,
  logMemorySave,
  getDateString,
  isPlanFile,
  parsePlanSteps,
  derivePlanName,
  sqliteQueryJSON,
  updateEntityMetadata,
  addObservation,
} from './hook-utils.js';
import { isTestCommand, extractTestFailureContext, buildTestFailureQuery, buildErrorQuery } from './post-tool-use-recall-utils.js';
import fs from 'fs';
import path from 'path';

// ============================================================================
// File Paths
// ============================================================================

const RECOMMENDATIONS_FILE = path.join(STATE_DIR, 'recommendations.json');
const CURRENT_SESSION_FILE = path.join(STATE_DIR, 'current-session.json');
const SESSION_CONTEXT_FILE = path.join(STATE_DIR, 'session-context.json');

// ============================================================================
// Pattern Detection
// ============================================================================

/**
 * Pattern Detector - Analyzes tool usage patterns
 */
class PatternDetector {
  constructor() {
    this.recentTools = [];
  }

  /**
   * Add a tool call to the recent tools list
   * @param {Object} toolData - Tool execution data
   */
  addToolCall(toolData) {
    this.recentTools.push({
      toolName: toolData.toolName,
      args: toolData.arguments,
      timestamp: new Date().toISOString(),
    });

    // Keep only last 10 (using slice instead of shift for better performance)
    if (this.recentTools.length > 10) {
      this.recentTools = this.recentTools.slice(-10);
    }
  }

  /**
   * Detect patterns in recent tool usage
   * @param {Object} currentTool - Current tool execution data
   * @returns {Array} Detected patterns
   */
  detectPatterns(currentTool) {
    const patterns = [];

    if (!currentTool || !currentTool.toolName) {
      return patterns;
    }

    const toolArgs = currentTool.arguments || {};

    // Pattern 1: READ_BEFORE_EDIT
    if (currentTool.toolName === 'Edit') {
      const filePath = toolArgs.file_path;
      if (filePath) {
        const recentReads = this.recentTools.filter(t =>
          t.toolName === 'Read' && t.args?.file_path === filePath
        );
        if (recentReads.length > 0) {
          patterns.push({
            type: 'READ_BEFORE_EDIT',
            description: 'Read before Edit - correct behavior',
            severity: 'info',
          });
        } else {
          patterns.push({
            type: 'EDIT_WITHOUT_READ',
            description: `Edit ${path.basename(filePath)} without prior Read`,
            severity: 'warning',
          });
        }
      }
    }

    // Pattern 2: Git Workflow
    const gitCommands = ['git add', 'git commit', 'git push', 'git branch', 'git checkout'];
    if (currentTool.toolName === 'Bash' && toolArgs.command) {
      const cmd = toolArgs.command;
      if (gitCommands.some(gitCmd => cmd.includes(gitCmd))) {
        const recentGitOps = this.recentTools.filter(t =>
          t.toolName === 'Bash' && gitCommands.some(gc => t.args?.command?.includes(gc))
        ).length;

        if (recentGitOps >= 2) {
          patterns.push({
            type: 'GIT_WORKFLOW',
            description: `Git workflow detected (${recentGitOps + 1} operations)`,
            severity: 'info',
            suggestion: 'Consider loading devops-git-workflows skill',
          });
        }
      }
    }

    // Pattern 3: Frontend Work
    const frontendExtensions = ['.tsx', '.jsx', '.vue', '.svelte', '.css', '.scss'];
    if (['Edit', 'Write', 'Read'].includes(currentTool.toolName)) {
      const filePath = toolArgs.file_path;
      if (filePath && frontendExtensions.some(ext => filePath.endsWith(ext))) {
        const recentFrontendOps = this.recentTools.filter(t =>
          ['Edit', 'Write', 'Read'].includes(t.toolName) &&
          frontendExtensions.some(ext => t.args?.file_path?.endsWith(ext))
        ).length;

        if (recentFrontendOps >= 2) {
          patterns.push({
            type: 'FRONTEND_WORK',
            description: `Frontend work detected (${recentFrontendOps + 1} files)`,
            severity: 'info',
            suggestion: 'Consider loading frontend-design skill',
          });
        }
      }
    }

    // Pattern 4: Intensive Search
    if (['Grep', 'Glob'].includes(currentTool.toolName)) {
      const recentSearches = this.recentTools.filter(t =>
        ['Grep', 'Glob'].includes(t.toolName)
      ).length;

      if (recentSearches >= 3) {
        patterns.push({
          type: 'INTENSIVE_SEARCH',
          description: `Multiple search operations (${recentSearches + 1} times)`,
          severity: 'info',
        });
      }
    }

    return patterns;
  }
}

// ============================================================================
// Anomaly Detection
// ============================================================================

/**
 * Detect anomalies in tool execution
 * @param {Object} toolData - Tool execution data
 * @param {Object} sessionContext - Session context with quota info
 * @returns {Array} Detected anomalies
 */
function detectAnomalies(toolData, sessionContext) {
  const anomalies = [];

  // Anomaly 1: Slow Execution
  if (toolData.duration && toolData.duration > THRESHOLDS.SLOW_EXECUTION) {
    anomalies.push({
      type: 'SLOW_EXECUTION',
      description: `${toolData.toolName} took ${(toolData.duration / 1000).toFixed(1)}s (slow)`,
      severity: 'warning',
    });
  }

  // Anomaly 2: High Token Usage
  if (toolData.tokensUsed && toolData.tokensUsed > THRESHOLDS.HIGH_TOKENS) {
    anomalies.push({
      type: 'HIGH_TOKENS',
      description: `${toolData.toolName} used ${toolData.tokensUsed} tokens (high usage)`,
      severity: 'warning',
    });
  }

  // Anomaly 3: Execution Failure
  if (toolData.success === false) {
    anomalies.push({
      type: 'EXECUTION_FAILURE',
      description: `${toolData.toolName} execution failed`,
      severity: 'error',
    });
  }

  // Anomaly 4: Quota Warning
  if (sessionContext.tokenQuota) {
    const quotaUsed = sessionContext.tokenQuota.used + (toolData.tokensUsed || 0);
    const quotaPercentage = quotaUsed / sessionContext.tokenQuota.limit;

    if (quotaPercentage > THRESHOLDS.QUOTA_WARNING) {
      anomalies.push({
        type: 'QUOTA_WARNING',
        description: `Token quota at ${(quotaPercentage * 100).toFixed(1)}%`,
        severity: 'warning',
      });
    }
  }

  return anomalies;
}

// ============================================================================
// Recommendations Update
// ============================================================================

/**
 * Update recommendations based on detected patterns and anomalies
 * @param {Array} patterns - Detected patterns
 * @param {Array} anomalies - Detected anomalies
 */
function updateRecommendations(patterns, anomalies) {
  const recommendations = readJSONFile(RECOMMENDATIONS_FILE, {
    recommendedSkills: [],
    detectedPatterns: [],
    warnings: [],
    lastUpdated: null,
  });

  // Add new skills based on patterns
  patterns.forEach(pattern => {
    if (pattern.suggestion && pattern.suggestion.includes('skill')) {
      const skillMatch = pattern.suggestion.match(/loading\s+(.+?)\s+skill/);
      if (skillMatch) {
        const skillName = skillMatch[1];
        const existing = recommendations.recommendedSkills.find(s => s.name === skillName);
        if (!existing) {
          recommendations.recommendedSkills.push({
            name: skillName,
            reason: pattern.description,
            priority: 'medium',
          });
        }
      }
    }
  });

  // Add detected patterns (keep last 10)
  patterns.forEach(pattern => {
    if (pattern && pattern.description) {
      recommendations.detectedPatterns.unshift({
        description: pattern.description,
        suggestion: pattern.suggestion || '',
        timestamp: new Date().toISOString(),
      });
    }
  });
  recommendations.detectedPatterns = recommendations.detectedPatterns.slice(0, 10);

  // Add warnings from anomalies (keep last 5)
  anomalies
    .filter(a => a.severity === 'warning' || a.severity === 'error')
    .forEach(anomaly => {
      recommendations.warnings.unshift(anomaly.description);
    });
  recommendations.warnings = recommendations.warnings.slice(0, 5);

  recommendations.lastUpdated = new Date().toISOString();

  // Async write — non-blocking, caller awaits via pendingWrites
  return writeJSONFileAsync(RECOMMENDATIONS_FILE, recommendations);
}

// ============================================================================
// Session Update
// ============================================================================

/**
 * Update current session with tool call data
 * @param {Object} toolData - Tool execution data
 * @param {Array} patterns - Detected patterns
 * @param {Array} anomalies - Detected anomalies
 */
function updateCurrentSession(toolData, patterns, anomalies) {
  const currentSession = readJSONFile(CURRENT_SESSION_FILE, {
    startTime: new Date().toISOString(),
    toolCalls: [],
    patterns: [],
  });

  // Add tool call record
  currentSession.toolCalls.push({
    timestamp: new Date().toISOString(),
    toolName: toolData.toolName,
    arguments: toolData.arguments,
    duration: toolData.duration,
    success: toolData.success,
    tokenUsage: toolData.tokensUsed,
  });

  // Cap toolCalls to prevent unbounded growth in long sessions
  const MAX_TOOL_CALLS = 1000;
  if (currentSession.toolCalls.length > MAX_TOOL_CALLS) {
    currentSession.toolCalls = currentSession.toolCalls.slice(-MAX_TOOL_CALLS);
  }

  // Track file modifications and test executions (for dry-run gate)
  trackFileModifications(toolData, currentSession);
  trackTestExecutions(toolData, currentSession);

  // Update pattern counts
  patterns.forEach(pattern => {
    const existing = currentSession.patterns.find(p => p.type === pattern.type);
    if (!existing) {
      currentSession.patterns.push({
        type: pattern.type,
        count: 1,
        firstDetected: new Date().toISOString(),
      });
    } else {
      existing.count++;
    }
  });

  // Async write — session file is read on next call, eventual consistency is fine
  // Return promise so caller can track it in pendingWrites
  const writePromise = writeJSONFileAsync(CURRENT_SESSION_FILE, currentSession);

  return { session: currentSession, writePromise };
}

/**
 * Update session context (quota tracking)
 * @param {Object} toolData - Tool execution data
 * @returns {{ sessionContext: Object, writePromise: Promise<boolean> }}
 */
function updateSessionContext(toolData) {
  const sessionContext = readJSONFile(SESSION_CONTEXT_FILE, {
    tokenQuota: { used: 0, limit: 200000 },
    learnedPatterns: [],
    lastSessionDate: null,
    lastSaveTokens: 0,
  });

  // Update token usage
  if (toolData.tokensUsed) {
    sessionContext.tokenQuota.used += toolData.tokensUsed;
  }

  sessionContext.lastSessionDate = new Date().toISOString();

  const writePromise = writeJSONFileAsync(SESSION_CONTEXT_FILE, sessionContext);

  return { sessionContext, writePromise };
}

// ============================================================================
// MeMesh Key Points Auto-Save
// ============================================================================

/**
 * Extract key points from session state
 * @param {Object} sessionState - Current session state
 * @returns {Array<string>} Extracted key points
 */
function extractKeyPoints(sessionState) {
  const keyPoints = [];

  if (!sessionState?.toolCalls?.length) {
    return keyPoints;
  }

  // 1. Identify completed file operations
  const fileOps = {};
  sessionState.toolCalls.forEach(tc => {
    if (['Edit', 'Write'].includes(tc.toolName) && tc.arguments?.file_path) {
      const filePath = tc.arguments.file_path;
      fileOps[filePath] = (fileOps[filePath] || 0) + 1;
    }
  });

  const modifiedFiles = Object.keys(fileOps);
  if (modifiedFiles.length > 0) {
    const summary = modifiedFiles.length > 5
      ? `${modifiedFiles.slice(0, 5).map(f => path.basename(f)).join(', ')} (+${modifiedFiles.length - 5} more)`
      : modifiedFiles.map(f => path.basename(f)).join(', ');
    keyPoints.push(`[TASK] Modified files: ${summary}`);
  }

  // 2. Identify failures
  const failures = sessionState.toolCalls.filter(tc => tc.success === false);
  if (failures.length > 0) {
    const failedTools = [...new Set(failures.map(f => f.toolName))];
    keyPoints.push(`[PROBLEM] ${failures.length} tool failures: ${failedTools.join(', ')}`);
  }

  // 3. Git operations
  const gitCommits = sessionState.toolCalls.filter(tc =>
    tc.toolName === 'Bash' && tc.arguments?.command?.includes('git commit')
  );
  if (gitCommits.length > 0) {
    keyPoints.push(`[DECISION] Made ${gitCommits.length} git commit(s)`);
  }

  // 4. Detected patterns
  if (sessionState.patterns?.length > 0) {
    const patternSummary = sessionState.patterns
      .filter(p => p.count > 2)
      .map(p => `${p.type}(${p.count})`)
      .join(', ');
    if (patternSummary) {
      keyPoints.push(`[PATTERN] Recurring patterns: ${patternSummary}`);
    }
  }

  // 5. Work scope indicator
  const toolCounts = {};
  sessionState.toolCalls.forEach(tc => {
    toolCounts[tc.toolName] = (toolCounts[tc.toolName] || 0) + 1;
  });
  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tool, count]) => `${tool}:${count}`)
    .join(', ');
  keyPoints.push(`[SCOPE] Tool usage: ${topTools}, total: ${sessionState.toolCalls.length}`);

  return keyPoints;
}

/**
 * Save conversation key points to MeMesh knowledge graph.
 * Uses sqliteBatchEntity for performance (3 spawns instead of N).
 * @param {Object} sessionState - Current session state
 * @param {Object} sessionContext - Session context
 * @returns {boolean} True if saved successfully
 */
function saveConversationKeyPoints(sessionState, sessionContext) {
  try {
    if (!fs.existsSync(MEMESH_DB_PATH)) {
      logError('saveConversationKeyPoints', `MeMesh DB not found: ${MEMESH_DB_PATH}`);
      return false;
    }

    const keyPoints = extractKeyPoints(sessionState);
    if (keyPoints.length === 0) {
      return false;
    }

    const entityName = `session_keypoints_${Date.now()}`;

    const metadata = JSON.stringify({
      tokensSaved: sessionContext.tokenQuota?.used || 0,
      toolCount: sessionState.toolCalls?.length || 0,
      saveReason: 'token_threshold',
    });

    const tags = ['auto_saved', 'token_trigger', getDateString()];

    const entityId = sqliteBatchEntity(
      MEMESH_DB_PATH,
      { name: entityName, type: 'session_keypoint', metadata },
      keyPoints,
      tags
    );

    if (entityId === null) {
      return false;
    }

    logMemorySave(`🧠 MeMesh: Saved ${keyPoints.length} key points (tokens: ${sessionContext.tokenQuota?.used})`);

    return true;
  } catch (error) {
    logError('saveConversationKeyPoints', error);
    return false;
  }
}

/**
 * Check if token threshold reached and save key points
 * @param {Object} sessionState - Current session state
 * @param {Object} sessionContext - Session context
 * @returns {boolean} True if saved
 */
function checkAndSaveKeyPoints(sessionState, sessionContext) {
  try {
    const lastSaveTokens = sessionContext.lastSaveTokens || 0;
    const currentTokens = sessionContext.tokenQuota?.used || 0;
    const tokensSinceLastSave = currentTokens - lastSaveTokens;

    if (tokensSinceLastSave >= THRESHOLDS.TOKEN_SAVE) {
      const saved = saveConversationKeyPoints(sessionState, sessionContext);

      if (saved) {
        sessionContext.lastSaveTokens = currentTokens;
        writeJSONFile(SESSION_CONTEXT_FILE, sessionContext);
      }

      return saved;
    }

    return false;
  } catch (error) {
    logError('checkAndSaveKeyPoints', error);
    return false;
  }
}

// ============================================================================
// File Modification & Test Tracking (for dry-run gate in pre-tool-use.js)
// ============================================================================

/**
 * Track file modifications from Write/Edit tool calls.
 * Stores modified file paths in session state.
 * @param {Object} toolData - Normalized tool data
 * @param {Object} currentSession - Current session state (mutated in place)
 */
function trackFileModifications(toolData, currentSession) {
  if (!['Edit', 'Write'].includes(toolData.toolName)) return;

  const filePath = toolData.arguments?.file_path;
  if (!filePath) return;

  if (!currentSession.modifiedFiles) {
    currentSession.modifiedFiles = [];
  }

  const MAX_MODIFIED_FILES = 100;
  if (!currentSession.modifiedFiles.includes(filePath)) {
    if (currentSession.modifiedFiles.length >= MAX_MODIFIED_FILES) {
      currentSession.modifiedFiles.shift(); // Remove oldest entry
    }
    currentSession.modifiedFiles.push(filePath);
  }
}

/** Patterns that indicate test execution in a Bash command */
const TEST_PATTERNS = [
  /vitest\s+(run|watch)?/,
  /jest\b/,
  /npm\s+test/,
  /npm\s+run\s+test/,
  /npx\s+vitest/,
  /npx\s+jest/,
  /tsc\s+--noEmit/,
  /node\s+--check\s/,
  /bun\s+test/,
  /pytest\b/,
];

/**
 * Track test executions from Bash tool calls.
 * Marks tested files/directories in session state.
 * @param {Object} toolData - Normalized tool data
 * @param {Object} currentSession - Current session state (mutated in place)
 */
function trackTestExecutions(toolData, currentSession) {
  if (toolData.toolName !== 'Bash') return;
  if (!toolData.success) return;

  const cmd = toolData.arguments?.command || '';
  const isTest = TEST_PATTERNS.some(pattern => pattern.test(cmd));
  if (!isTest) return;

  if (!currentSession.testedFiles) {
    currentSession.testedFiles = [];
  }

  currentSession.lastTestRun = new Date().toISOString();

  // Extract test target path if provided
  // e.g., "vitest run src/auth" → mark all modified files under src/auth/ as tested
  const pathMatch = cmd.match(/(?:vitest|jest|node\s+--check)\s+(?:run\s+)?(\S+)/);
  const testTarget = pathMatch ? pathMatch[1] : null;

  if (testTarget && currentSession.modifiedFiles) {
    // Mark files under the test target directory/path as tested
    // Use path-prefix match: "src/auth" matches "src/auth/middleware.ts" but NOT "src/auth-utils/helper.ts"
    for (const modFile of currentSession.modifiedFiles) {
      const isMatch = modFile === testTarget ||
        modFile.startsWith(testTarget + '/') ||
        modFile.startsWith(testTarget + path.sep);
      if (isMatch && !currentSession.testedFiles.includes(modFile)) {
        currentSession.testedFiles.push(modFile);
      }
    }
  } else if (!testTarget && currentSession.modifiedFiles) {
    // Full test run (no specific target) — mark all modified files as tested
    for (const modFile of currentSession.modifiedFiles) {
      if (!currentSession.testedFiles.includes(modFile)) {
        currentSession.testedFiles.push(modFile);
      }
    }
  }
}

// ============================================================================
// Code Review Tracking
// ============================================================================

/**
 * Check if this tool call is a code review invocation.
 * Detects both Skill tool usage and Task tool dispatching code reviewers.
 * @param {Object} toolData - Normalized tool data
 * @returns {boolean}
 */
function isCodeReviewInvocation(toolData) {
  // Skill tool with code review
  if (toolData.toolName === 'Skill') {
    const name = toolData.arguments?.name || toolData.arguments?.skill_name || '';
    return /code.?review|comprehensive.?code.?review/i.test(name);
  }

  // Task tool dispatching code reviewer subagent
  if (toolData.toolName === 'Task') {
    const subagentType = toolData.arguments?.subagent_type || '';
    return /code.?review/i.test(subagentType);
  }

  return false;
}

/**
 * Mark code review as done in session state.
 * This flag is checked by pre-tool-use.js before git commits.
 */
function markCodeReviewDone() {
  const session = readJSONFile(CURRENT_SESSION_FILE, {});
  session.codeReviewDone = true;
  session.codeReviewTimestamp = new Date().toISOString();
  writeJSONFile(CURRENT_SESSION_FILE, session);
}

// ============================================================================
// Tool Data Normalization
// ============================================================================

/**
 * Normalize tool data from Claude Code format
 * @param {Object} raw - Raw tool data from stdin
 * @returns {Object} Normalized tool data
 */
function normalizeToolData(raw) {
  return {
    toolName: raw.tool_name || raw.toolName || 'unknown',
    arguments: raw.tool_input || raw.arguments || {},
    duration: raw.duration_ms || raw.duration || 0,
    success: raw.success !== false,
    tokensUsed: raw.tokens_used || raw.tokensUsed || 0,
    _raw: raw,
  };
}

// ============================================================================
// Plan File Detection (Beta)
// ============================================================================

/**
 * Detect plan file creation and save to KG.
 * Triggered when Write tool targets a plan file path.
 * @param {Object} toolData - Normalized tool data
 */
function detectPlanFile(toolData) {
  if (toolData.toolName !== 'Write') return;

  const filePath = toolData.arguments?.file_path;
  if (!isPlanFile(filePath)) return;

  try {
    // Read the file content
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');

    const steps = parsePlanSteps(content);
    if (steps.length === 0) return;

    if (!fs.existsSync(MEMESH_DB_PATH)) return;

    const planName = derivePlanName(filePath);
    const entityName = `Plan: ${planName}`;

    const newMetadata = {
      sourceFile: filePath,
      totalSteps: steps.length,
      completed: steps.filter(s => s.completed).length,
      status: 'active',
      stepsDetail: steps,
    };

    // Check if plan entity already exists (re-save scenario)
    const existing = sqliteQueryJSON(MEMESH_DB_PATH,
      'SELECT id FROM entities WHERE name = ?', [entityName]);

    if (existing && existing.length > 0) {
      // Upsert: update metadata and add observation for the re-save
      updateEntityMetadata(MEMESH_DB_PATH, entityName, newMetadata);
      addObservation(MEMESH_DB_PATH, entityName,
        `Plan re-saved: ${steps.length} steps (${steps.filter(s => s.completed).length} completed)`);
      logMemorySave(`Plan updated: ${planName} (${steps.length} steps)`);
    } else {
      // First save: create entity with observations and tags
      const observations = steps.map(s => `Step ${s.number}: ${s.description}`);
      const tags = ['plan', 'active', `plan:${planName}`, 'scope:project'];

      sqliteBatchEntity(MEMESH_DB_PATH,
        { name: entityName, type: 'workflow_checkpoint', metadata: JSON.stringify(newMetadata) },
        observations, tags
      );
      logMemorySave(`Plan detected: ${planName} (${steps.length} steps)`);
    }
  } catch (error) {
    logError('detectPlanFile', error);
  }
}

// ============================================================================
// Proactive Recall on Test Failure / Error Detection
// ============================================================================

/**
 * Trigger proactive recall on test failure or error detection.
 * Writes results to proactive-recall.json for HookToolHandler.
 * @param {Object} toolData - Normalized tool data
 */
function triggerProactiveRecall(toolData) {
  try {
    const recallFile = path.join(STATE_DIR, 'proactive-recall.json');
    let query = null;
    let trigger = null;

    // Test failure detection
    if (toolData.toolName === 'Bash' && toolData.arguments?.command) {
      if (isTestCommand(toolData.arguments.command) && !toolData.success) {
        const ctx = extractTestFailureContext(toolData._raw?.output || '');
        if (ctx) {
          query = buildTestFailureQuery(ctx.testName, ctx.errorMessage);
          trigger = 'test-failure';
        }
      }
    }

    // Error detection (non-test failures)
    if (!trigger && !toolData.success && toolData._raw?.output) {
      const errorMatch = toolData._raw.output.match(/(\w*Error):\s*(.+)/);
      if (errorMatch) {
        query = buildErrorQuery(errorMatch[1], errorMatch[2]);
        trigger = 'error-detection';
      }
    }

    if (!query || !trigger) return;

    // Build FTS5 query
    const ftsTokens = query.split(/\s+/)
      .filter(t => t.length > 2)
      .slice(0, 8)
      .map(t => `"${t.replace(/"/g, '""')}"*`)
      .join(' OR ');

    if (!ftsTokens) return;

    const sql = `
      SELECT e.name,
        (SELECT json_group_array(content) FROM observations o WHERE o.entity_id = e.id) as observations_json
      FROM entities e
      JOIN entities_fts ON entities_fts.rowid = e.id
      WHERE entities_fts MATCH ?
      ORDER BY bm25(entities_fts, 10.0, 5.0)
      LIMIT 3
    `;

    const result = sqliteQueryJSON(MEMESH_DB_PATH, sql, [ftsTokens]);
    if (!result || result.length === 0) return;

    const recallData = {
      trigger,
      query,
      timestamp: Date.now(),
      results: result.map(r => ({
        name: r.name,
        observations: JSON.parse(r.observations_json || '[]').filter(Boolean).slice(0, 2),
      })),
    };

    writeJSONFile(recallFile, recallData);
  } catch (error) {
    logError('proactive-recall-trigger', error);
  }
}

// ============================================================================
// Main PostToolUse Logic
// ============================================================================

async function postToolUse() {
  try {
    // Read stdin with timeout
    const input = await readStdin(3000);

    if (!input || input.trim() === '') {
      process.exit(0);
    }

    // Parse and normalize tool data
    const rawData = JSON.parse(input);
    const toolData = normalizeToolData(rawData);

    // Track code review invocations (for pre-commit enforcement)
    if (isCodeReviewInvocation(toolData)) {
      markCodeReviewDone();
    }

    // Detect plan file creation (beta)
    detectPlanFile(toolData);

    // Initialize pattern detector
    const detector = new PatternDetector();

    // Load recent tools from current session
    const currentSession = readJSONFile(CURRENT_SESSION_FILE, { toolCalls: [] });
    currentSession.toolCalls.slice(-10).forEach(tc => {
      detector.addToolCall({
        toolName: tc.toolName,
        arguments: tc.arguments || {},
      });
    });

    // Add current tool
    detector.addToolCall(toolData);

    // Detect patterns
    const patterns = detector.detectPatterns(toolData);

    // Update session context (for quota tracking) — returns sync data + async write promise
    const { sessionContext, writePromise: contextWritePromise } = updateSessionContext(toolData);

    // Detect anomalies
    const anomalies = detectAnomalies(toolData, sessionContext);

    // Trigger proactive recall on test failure or error
    triggerProactiveRecall(toolData);

    // Fire async writes in parallel
    const pendingWrites = [contextWritePromise];

    // Update recommendations incrementally
    if (patterns.length > 0 || anomalies.length > 0) {
      pendingWrites.push(updateRecommendations(patterns, anomalies));
    }

    // Update current session (async write)
    const { session: updatedSession, writePromise: sessionWritePromise } =
      updateCurrentSession(toolData, patterns, anomalies);
    pendingWrites.push(sessionWritePromise);

    // Check token threshold and save key points if needed
    checkAndSaveKeyPoints(updatedSession, sessionContext);

    // Wait for all async writes to complete before exit
    await Promise.all(pendingWrites);

    // Silent exit
    process.exit(0);
  } catch (error) {
    logError('PostToolUse', error);
    process.exit(0); // Never block Claude Code on hook errors
  }
}

// ============================================================================
// Execute
// ============================================================================

postToolUse();
