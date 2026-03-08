#!/usr/bin/env node

/**
 * SubagentStop Hook - Capture Subagent Results to MeMesh Knowledge Graph
 *
 * Triggered when a subagent finishes execution.
 *
 * Features:
 * - Saves code review findings to MeMesh KG (high-value results)
 * - Tracks code review completion for pre-commit enforcement
 * - Updates session state with subagent activity
 * - Silent operation (no console output)
 */

import {
  STATE_DIR,
  MEMESH_DB_PATH,
  readJSONFile,
  writeJSONFile,
  sqliteBatchEntity,
  getDateString,
  readStdin,
  logError,
  logMemorySave,
} from './hook-utils.js';
import fs from 'fs';
import path from 'path';

// ============================================================================
// Constants
// ============================================================================

const CURRENT_SESSION_FILE = path.join(STATE_DIR, 'current-session.json');

/** Agent types that count as code review */
const CODE_REVIEWER_TYPES = [
  'code-reviewer',
  'code-review',
  'superpowers:code-reviewer',
  'pr-review-toolkit:code-reviewer',
  'feature-dev:code-reviewer',
];

// ============================================================================
// Code Review Detection
// ============================================================================

/**
 * Check if this subagent is a code reviewer
 * @param {string} agentType - Subagent type identifier
 * @returns {boolean}
 */
function isCodeReviewer(agentType) {
  if (!agentType) return false;
  const lower = agentType.toLowerCase();
  return CODE_REVIEWER_TYPES.some(t => lower.includes(t.toLowerCase()));
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
// MeMesh KG Save
// ============================================================================

/**
 * Save code review results to MeMesh knowledge graph.
 * Only saves code reviewer subagent results (high-value findings).
 *
 * @param {string} agentType - Subagent type
 * @param {string} lastMessage - Agent's final response
 * @returns {boolean} True if saved
 */
function saveSubagentToKG(agentType, lastMessage) {
  try {
    if (!fs.existsSync(MEMESH_DB_PATH)) return false;
    if (!lastMessage || lastMessage.length < 50) return false;

    // Truncate very long messages
    const shortMessage = lastMessage.length > 1000
      ? lastMessage.substring(0, 1000) + '...'
      : lastMessage;

    const entityName = `Code Review: ${getDateString()} ${Date.now()} ${agentType}`;
    const metadata = JSON.stringify({
      agentType,
      messageLength: lastMessage.length,
      source: 'subagent-stop-hook',
    });

    const tags = [
      'code-review',
      `agent:${agentType}`,
      `date:${getDateString()}`,
      'auto-tracked',
      'scope:project',
    ];

    const entityId = sqliteBatchEntity(
      MEMESH_DB_PATH,
      { name: entityName, type: 'code_review', metadata },
      [`[${agentType}] ${shortMessage}`],
      tags
    );

    if (entityId === null) return false;

    logMemorySave(`Code review saved: ${agentType} (${lastMessage.length} chars)`);
    return true;
  } catch (error) {
    logError('saveSubagentToKG', error);
    return false;
  }
}

// ============================================================================
// Session State Update
// ============================================================================

/**
 * Track subagent activity in session state
 * @param {string} agentType - Subagent type
 */
function trackSubagentInSession(agentType) {
  const session = readJSONFile(CURRENT_SESSION_FILE, { subagents: [] });
  if (!session.subagents) session.subagents = [];

  session.subagents.push({
    type: agentType,
    completedAt: new Date().toISOString(),
  });

  // Keep only last 20 subagent entries
  if (session.subagents.length > 20) {
    session.subagents = session.subagents.slice(-20);
  }

  writeJSONFile(CURRENT_SESSION_FILE, session);
}

// ============================================================================
// Main
// ============================================================================

async function subagentStop() {
  try {
    const input = await readStdin(3000);
    if (!input || input.trim() === '') {
      process.exit(0);
    }

    const data = JSON.parse(input);
    const agentType = data.agent_type || data.agentType || 'unknown';
    const lastMessage = data.last_assistant_message || data.lastAssistantMessage || '';

    // Track all subagent completions in session state
    trackSubagentInSession(agentType);

    // Track code review completion (for pre-commit enforcement)
    if (isCodeReviewer(agentType)) {
      markCodeReviewDone();
    }

    // Save code reviewer results to MeMesh KG (high-value findings)
    if (isCodeReviewer(agentType) && lastMessage.length > 50) {
      saveSubagentToKG(agentType, lastMessage);
    }

    process.exit(0);
  } catch (error) {
    logError('SubagentStop', error);
    process.exit(0); // Never block on hook errors
  }
}

subagentStop();
