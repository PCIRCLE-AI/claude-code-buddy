#!/usr/bin/env node

/**
 * Hook Utilities - Shared functions for Claude Code hooks
 *
 * This module provides common utilities used across all hooks:
 * - File I/O (JSON read/write)
 * - SQLite queries with SQL injection protection
 * - Path constants
 * - Time utilities
 *
 * All hooks should import from this module to avoid code duplication.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

// ============================================================================
// Constants
// ============================================================================

/** Home directory with fallback */
export const HOME_DIR = process.env.HOME || os.homedir();

/** State directory for hook data */
export const STATE_DIR = path.join(HOME_DIR, '.claude', 'state');

/** MeMesh knowledge graph database path (mirrors PathResolver logic from src/utils/PathResolver.ts) */
function resolveMemeshDbPath() {
  const primaryDir = path.join(HOME_DIR, '.memesh');
  const legacyDir = path.join(HOME_DIR, '.claude-code-buddy');

  if (fs.existsSync(path.join(primaryDir, 'knowledge-graph.db'))) {
    return path.join(primaryDir, 'knowledge-graph.db');
  }
  if (fs.existsSync(path.join(legacyDir, 'knowledge-graph.db'))) {
    return path.join(legacyDir, 'knowledge-graph.db');
  }
  return path.join(primaryDir, 'knowledge-graph.db');
}

export const MEMESH_DB_PATH = resolveMemeshDbPath();

/** Hook error log file */
export const ERROR_LOG_PATH = path.join(STATE_DIR, 'hook-errors.log');

/** Memory saves log file */
export const MEMORY_LOG_PATH = path.join(STATE_DIR, 'memory-saves.log');

// Time constants (in milliseconds)
export const TIME = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
};

// Threshold constants
export const THRESHOLDS = {
  /** Token threshold for auto-saving key points */
  TOKEN_SAVE: 250_000,
  /** Days to retain session key points */
  RETENTION_DAYS: 30,
  /** Days to recall key points on session start */
  RECALL_DAYS: 30,
  /** Slow execution threshold (ms) */
  SLOW_EXECUTION: 5000,
  /** High token usage threshold */
  HIGH_TOKENS: 10_000,
  /** Quota warning percentage */
  QUOTA_WARNING: 0.8,
  /** Heartbeat validity duration (ms) */
  HEARTBEAT_VALIDITY: 5 * 60 * 1000,
  /** Maximum number of archived sessions to keep */
  MAX_ARCHIVED_SESSIONS: 30,
};

// ============================================================================
// File I/O Utilities
// ============================================================================

/**
 * Ensure a directory exists, creating it if necessary
 * @param {string} dirPath - Directory path to ensure exists
 */
export function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Read JSON file with error handling
 * @param {string} filePath - Path to JSON file
 * @param {*} defaultValue - Default value if file doesn't exist or is invalid
 * @returns {*} Parsed JSON or default value
 */
export function readJSONFile(filePath, defaultValue = {}) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    logError(`Read error ${path.basename(filePath)}`, error);
  }
  return defaultValue;
}

/**
 * Write JSON file with error handling
 * @param {string} filePath - Path to JSON file
 * @param {*} data - Data to write
 * @returns {boolean} True if successful
 */
export function writeJSONFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (error) {
    logError(`Write error ${path.basename(filePath)}`, error);
    return false;
  }
}

// ============================================================================
// Logging Utilities
// ============================================================================

/**
 * Log error to error log file (silent - no console output)
 * @param {string} context - Error context description
 * @param {Error|string} error - Error object or message
 */
export function logError(context, error) {
  const message = error instanceof Error ? error.message : String(error);
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${context}: ${message}\n`;

  try {
    ensureDir(STATE_DIR);
    fs.appendFileSync(ERROR_LOG_PATH, logLine);
  } catch (logErr) {
    process.stderr.write(`[logError FAILED] ${context}: ${message} (log error: ${logErr.message})\n`);
  }
}

/**
 * Log memory save event
 * @param {string} message - Log message
 */
export function logMemorySave(message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;

  try {
    ensureDir(STATE_DIR);
    fs.appendFileSync(MEMORY_LOG_PATH, logLine);
  } catch (logErr) {
    process.stderr.write(`[logMemorySave FAILED] ${message} (log error: ${logErr.message})\n`);
  }
}

// ============================================================================
// SQLite Utilities (SQL Injection Safe)
// ============================================================================

/**
 * Escape a value for safe SQL string interpolation.
 * Numbers are returned unquoted; strings are quoted with single-quote escaping.
 * @param {*} value - Value to escape
 * @returns {string} Escaped SQL literal
 */
export function escapeSQL(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  // Numbers don't need quoting in SQL
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  // Booleans as integers
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  // Everything else: coerce to string and escape single quotes
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Execute SQLite query with parameterized values (SQL injection safe)
 *
 * Uses placeholder replacement for safe parameter binding.
 * Parameters are escaped by doubling single quotes.
 *
 * @param {string} dbPath - Path to SQLite database
 * @param {string} query - SQL query with ? placeholders
 * @param {Array} params - Parameter values to substitute
 * @param {Object} options - Query options
 * @param {number} options.timeout - Timeout in ms (default: 5000)
 * @param {boolean} options.json - Use JSON output mode (default: false)
 * @returns {string|null} Query result as string, or null on error
 *
 * @example
 * // Basic query
 * sqliteQuery(dbPath, 'SELECT * FROM users WHERE id = ?', [userId]);
 *
 * // JSON output mode
 * sqliteQuery(dbPath, 'SELECT * FROM users', [], { json: true });
 */
export function sqliteQuery(dbPath, query, params = [], options = {}) {
  const { timeout = 5000, json = false } = options;

  try {
    let finalQuery = query;

    // Replace ? placeholders with escaped values
    if (params.length > 0) {
      let paramIndex = 0;
      finalQuery = query.replace(/\?/g, () => {
        if (paramIndex < params.length) {
          return escapeSQL(params[paramIndex++]);
        }
        return '?';
      });
    }

    const args = json ? ['-json', dbPath, finalQuery] : [dbPath, finalQuery];

    const result = execFileSync('sqlite3', args, {
      encoding: 'utf-8',
      timeout,
    });
    return result.trim();
  } catch (error) {
    logError('sqliteQuery', error);
    return null;
  }
}

/**
 * Execute SQLite query and parse JSON result
 *
 * @param {string} dbPath - Path to SQLite database
 * @param {string} query - SQL query with ? placeholders
 * @param {Array} params - Parameter values to substitute
 * @param {Object} options - Query options
 * @returns {Array|null} Parsed JSON array, empty array for no rows, or null on error
 */
export function sqliteQueryJSON(dbPath, query, params = [], options = {}) {
  const result = sqliteQuery(dbPath, query, params, { ...options, json: true });

  // sqliteQuery returns null on error — propagate to caller
  if (result === null) {
    return null;
  }

  // Empty string means no matching rows
  if (result === '') {
    return [];
  }

  try {
    return JSON.parse(result);
  } catch (error) {
    logError('sqliteQueryJSON parse', error);
    return null;
  }
}

// ============================================================================
// Time Utilities
// ============================================================================

/**
 * Get human-readable time ago string
 * @param {Date} date - Date to compare
 * @returns {string} Human-readable time difference
 */
export function getTimeAgo(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / TIME.MINUTE);
  const diffHours = Math.floor(diffMs / TIME.HOUR);
  const diffDays = Math.floor(diffMs / TIME.DAY);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minutes ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString();
}

/**
 * Calculate duration string from start time
 * @param {string} startTime - ISO timestamp string
 * @returns {string} Duration string (e.g., "5m 30s")
 */
export function calculateDuration(startTime) {
  const start = new Date(startTime);
  const end = new Date();
  const durationMs = end - start;
  const minutes = Math.floor(durationMs / TIME.MINUTE);
  const seconds = Math.floor((durationMs % TIME.MINUTE) / TIME.SECOND);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Get ISO date string (YYYY-MM-DD)
 * @param {Date} date - Date object (default: now)
 * @returns {string} Date string
 */
export function getDateString(date = new Date()) {
  return date.toISOString().split('T')[0];
}

// ============================================================================
// Stdin Utilities
// ============================================================================

/**
 * Read stdin with timeout protection
 * Properly removes event listeners to prevent memory leaks
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<string>} Stdin content
 */
export function readStdin(timeout = 3000) {
  return new Promise((resolve, reject) => {
    // Fast path: stdin already closed/ended — avoids 3s timeout hang
    if (process.stdin.readableEnded || process.stdin.destroyed) {
      return resolve('');
    }

    let data = '';

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Stdin read timeout'));
    }, timeout);

    const onData = (chunk) => {
      data += chunk;
    };

    const onEnd = () => {
      clearTimeout(timer);
      cleanup();
      resolve(data);
    };

    const onError = (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    };

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}

// ============================================================================
// Batch SQLite Operations
// ============================================================================

/**
 * Execute multiple SQLite statements in a single process spawn.
 * Wraps all statements in BEGIN/COMMIT for atomicity.
 *
 * Performance: 1 process spawn instead of N, saving ~100ms per avoided spawn.
 *
 * @param {string} dbPath - Path to SQLite database
 * @param {Array<{query: string, params?: Array}>} statements - SQL statements
 * @param {Object} options - Options
 * @param {number} options.timeout - Timeout in ms (default: 10000)
 * @param {number} options.chunkSize - Max statements per batch (default: 50)
 * @returns {string|null} Combined output, or null on error
 */
export function sqliteBatch(dbPath, statements, options = {}) {
  const { timeout = 10000, chunkSize = 50 } = options;

  if (!statements || statements.length === 0) return '';

  try {
    const chunks = [];
    for (let i = 0; i < statements.length; i += chunkSize) {
      chunks.push(statements.slice(i, i + chunkSize));
    }

    let output = '';
    for (const chunk of chunks) {
      const batchSQL = ['BEGIN TRANSACTION;'];

      for (const stmt of chunk) {
        let finalQuery = stmt.query;
        if (stmt.params && stmt.params.length > 0) {
          let paramIndex = 0;
          finalQuery = stmt.query.replace(/\?/g, () => {
            if (paramIndex < stmt.params.length) {
              return escapeSQL(stmt.params[paramIndex++]);
            }
            return '?';
          });
        }
        if (!finalQuery.trim().endsWith(';')) {
          finalQuery += ';';
        }
        batchSQL.push(finalQuery);
      }

      batchSQL.push('COMMIT;');

      // Pipe SQL via stdin to avoid E2BIG on large batches
      const result = execFileSync('sqlite3', [dbPath], {
        encoding: 'utf-8',
        timeout,
        input: batchSQL.join('\n'),
      });
      if (result.trim()) {
        output += result.trim() + '\n';
      }
    }

    return output.trim();
  } catch (error) {
    logError('sqliteBatch', error);
    return null;
  }
}

/**
 * Insert entity + observations + tags in minimal spawns.
 * Common pattern used by post-commit and stop hooks.
 *
 * Uses a three-step approach:
 *   1. INSERT entity (1 spawn)
 *   2. SELECT entity ID (1 spawn)
 *   3. Batch INSERT all observations + tags (1 spawn)
 *
 * Total: 3 spawns (was N+2 before batching).
 *
 * @param {string} dbPath - Path to SQLite database
 * @param {Object} entity - Entity to insert
 * @param {string} entity.name - Entity name (must be unique)
 * @param {string} entity.type - Entity type
 * @param {string} entity.metadata - JSON metadata string
 * @param {Array<string>} observations - Observation content strings
 * @param {Array<string>} tags - Tag strings
 * @returns {number|null} Entity ID, or null on failure
 */
export function sqliteBatchEntity(dbPath, entity, observations = [], tags = []) {
  try {
    const now = new Date().toISOString();

    // Step 1: Insert entity (need the ID for subsequent inserts)
    const insertResult = sqliteQuery(
      dbPath,
      'INSERT INTO entities (name, type, created_at, metadata) VALUES (?, ?, ?, ?)',
      [entity.name, entity.type, now, entity.metadata || '{}']
    );
    if (insertResult === null) return null;

    const entityIdResult = sqliteQuery(
      dbPath,
      'SELECT id FROM entities WHERE name = ?',
      [entity.name]
    );
    if (entityIdResult === null) return null;
    const entityId = parseInt(entityIdResult, 10);
    if (isNaN(entityId)) return null;

    // Step 2: Batch all observations and tags in one spawn
    const statements = [];

    for (const obs of observations) {
      statements.push({
        query: 'INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)',
        params: [entityId, obs, now],
      });
    }

    for (const tag of tags) {
      statements.push({
        query: 'INSERT INTO tags (entity_id, tag) VALUES (?, ?)',
        params: [entityId, tag],
      });
    }

    if (statements.length > 0) {
      const batchResult = sqliteBatch(dbPath, statements);
      if (batchResult === null) {
        // Clean up orphaned entity — batch failed so observations/tags rolled back
        logError('sqliteBatchEntity', new Error(`Batch failed for entity ${entity.name}, cleaning up orphan`));
        sqliteQuery(dbPath, 'DELETE FROM entities WHERE id = ?', [entityId]);
        return null;
      }
    }

    return entityId;
  } catch (error) {
    logError('sqliteBatchEntity', error);
    return null;
  }
}

// ============================================================================
// Async File I/O
// ============================================================================

/**
 * Write JSON file asynchronously (non-blocking).
 * Returns a promise so callers can await if needed.
 * @param {string} filePath - Path to JSON file
 * @param {*} data - Data to write
 * @returns {Promise<boolean>} True if successful
 */
export function writeJSONFileAsync(filePath, data) {
  return new Promise((resolve) => {
    const content = JSON.stringify(data, null, 2);
    fs.writeFile(filePath, content, 'utf-8', (err) => {
      if (err) {
        logError(`Async write error ${path.basename(filePath)}`, err);
      }
      resolve(!err);
    });
  });
}

// Ensure state directory exists on module load
ensureDir(STATE_DIR);

// ============================================================================
// Plan-Aware Memory Hooks (Beta)
// ============================================================================

/** File path patterns that indicate a plan file (requires docs/ context) */
const PLAN_PATTERNS = [
  /docs\/plans\/.*\.md$/,
  /docs\/.*-design\.md$/,
  /docs\/.*-plan\.md$/,
];

/**
 * Check if a file path matches plan file patterns.
 * @param {string} filePath - File path to check
 * @returns {boolean}
 */
export function isPlanFile(filePath) {
  if (!filePath) return false;
  return PLAN_PATTERNS.some(p => p.test(filePath));
}

/** Common English stop words to filter from tokenization */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'because', 'but', 'and', 'or', 'if', 'while', 'that', 'this', 'these',
  'those', 'it', 'its', 'up', 'set',
]);

/**
 * Tokenize text into lowercase meaningful words.
 * Removes punctuation, stop words, and words shorter than 3 characters.
 * @param {string} text - Input text
 * @returns {string[]} Array of meaningful words
 */
export function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Extract module/file hints from a step description.
 * Returns words that could match file paths or module names.
 * @param {string} description - Step description text
 * @returns {string[]} Module hint words
 */
export function extractModuleHints(description) {
  return tokenize(description);
}

/**
 * Derive a human-readable plan name from a file path.
 * Strips date prefixes (YYYY-MM-DD-) and .md extension.
 * @param {string} filePath - File path
 * @returns {string} Plan name
 */
export function derivePlanName(filePath) {
  let name = path.basename(filePath, '.md');
  // Remove date prefix (YYYY-MM-DD-)
  name = name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  return name;
}

/**
 * Parse plan steps from markdown content.
 * Supports checkbox format (- [ ] ...) and heading format (## Step N: ...).
 * @param {string} content - Markdown file content
 * @returns {Array<{number: number, description: string, completed: boolean}>}
 */
export function parsePlanSteps(content) {
  if (!content) return [];

  const steps = [];
  const lines = content.split('\n');
  let inCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track code fence boundaries (``` with optional language tag)
    if (/^`{3,}/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    // Format A: Checkbox "- [ ] Step N: description" or "- [ ] description"
    const checkboxMatch = trimmed.match(/^-\s+\[([ xX])\]\s+(?:(?:Step|Task)\s+\d+\s*[:.]\s*)?(.+)/);
    if (checkboxMatch) {
      steps.push({
        number: steps.length + 1,
        description: checkboxMatch[2].trim(),
        completed: checkboxMatch[1].toLowerCase() === 'x',
      });
      continue;
    }

    // Format B: Heading "## Step N: description" or "### Task N: description"
    const headingStepMatch = trimmed.match(/^#{2,4}\s+(?:Step|Task)\s+(\d+)\s*[:.]\s*(.+)/);
    if (headingStepMatch) {
      steps.push({
        number: parseInt(headingStepMatch[1], 10),
        description: headingStepMatch[2].trim(),
        completed: false,
      });
      continue;
    }

    // Format C: Numbered heading "### 1. description"
    const numberedMatch = trimmed.match(/^#{2,4}\s+(\d+)\.\s+(.+)/);
    if (numberedMatch) {
      steps.push({
        number: parseInt(numberedMatch[1], 10),
        description: numberedMatch[2].trim(),
        completed: false,
      });
      continue;
    }
  }

  return steps;
}

/**
 * Match a commit to the best matching uncompleted plan step.
 * Uses keyword overlap + file path hints. Threshold: 0.3.
 * @param {{ subject: string, filesChanged: string[] }} commitInfo
 * @param {Array<{ number: number, description: string, completed: boolean }>} planSteps
 * @returns {{ step: object, confidence: number } | null}
 */
export function matchCommitToStep(commitInfo, planSteps) {
  if (!planSteps || planSteps.length === 0) return null;
  if (!commitInfo || !commitInfo.subject) return null;

  const commitWords = tokenize(commitInfo.subject);
  if (commitWords.length === 0) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const step of planSteps) {
    if (step.completed) continue;

    const stepWords = tokenize(step.description);
    if (stepWords.length === 0) continue;

    // Keyword overlap score (0~1)
    const overlap = commitWords.filter(w => stepWords.includes(w));
    let score = overlap.length / stepWords.length;

    // File path bonus (+0.3)
    const moduleHints = extractModuleHints(step.description);
    const filesChanged = commitInfo.filesChanged || [];
    const fileMatch = filesChanged.some(f =>
      moduleHints.some(hint => f.toLowerCase().includes(hint))
    );
    if (fileMatch) score += 0.3;

    if (score > bestScore && score > 0.3) {
      bestScore = score;
      bestMatch = step;
    }
  }

  if (!bestMatch) return null;

  // Return step + confidence (capped at 1.0)
  return { step: bestMatch, confidence: Math.min(bestScore, 1.0) };
}

/**
 * Render a full Style B timeline visualization.
 * @param {Object} plan - Plan entity with metadata.stepsDetail
 * @param {number} [highlightStep] - Step number to highlight (just matched)
 * @returns {string} Multi-line timeline string
 */
export function renderTimeline(plan, highlightStep = null) {
  const { stepsDetail, totalSteps, completed = 0 } = plan.metadata;
  if (!stepsDetail || stepsDetail.length === 0 || !totalSteps) return '';

  const pct = Math.round((completed / totalSteps) * 100);
  const planName = plan.name.replace('Plan: ', '');
  const nextStep = stepsDetail.find(st => !st.completed);

  // Node symbols: ◉ highlighted (just-matched), ● completed, ◉ next, ○ pending
  const nodes = stepsDetail.map(s => {
    if (s.number === highlightStep) return '\u25c9';
    if (s.completed) return '\u25cf';
    if (nextStep && s.number === nextStep.number) return '\u25c9';
    return '\u25cb';
  }).join(' \u2500\u2500\u2500\u2500 ');

  // Step numbers row
  const numbers = stepsDetail.map(s =>
    String(s.number).padEnd(6)
  ).join('');

  const separator = '\u2501'.repeat(40);

  const lines = [
    `  \ud83d\udccb ${planName}`,
    `  ${separator}`,
    `  ${nodes}`,
    `  ${numbers}   ${pct}% done`,
    `  ${separator}`,
  ];

  if (highlightStep) {
    const commitRef = plan._lastCommit || '';
    const confidence = plan._matchConfidence || 1.0;
    const marker = confidence < 0.6 ? ' (?)' : '';
    lines.push(`  \u2705 Step ${highlightStep} matched${marker} \u2190 ${commitRef}`);
  }

  if (nextStep && completed < totalSteps) {
    lines.push(`  \u25b6 Next: Step ${nextStep.number} - ${nextStep.description}`);
  }

  if (completed === totalSteps) {
    lines.push(`  \ud83c\udf89 Plan complete!`);
  }

  return lines.join('\n');
}

/**
 * Render a compact Style B timeline for session-start display.
 * @param {Object} plan - Plan entity with metadata.stepsDetail
 * @returns {string} 3-line compact timeline string
 */
export function renderTimelineCompact(plan) {
  const { stepsDetail, totalSteps, completed = 0 } = plan.metadata;
  if (!stepsDetail || stepsDetail.length === 0 || !totalSteps) return '';

  const pct = Math.round((completed / totalSteps) * 100);
  const planName = plan.name.replace('Plan: ', '');

  const nodes = stepsDetail.map(s =>
    s.completed ? '\u25cf' : '\u25cb'
  ).join(' \u2500\u2500\u2500\u2500 ');

  const next = stepsDetail.find(s => !s.completed);

  return [
    `  \ud83d\udccb ${planName}`,
    `  ${nodes}    ${pct}%`,
    next ? `  \u25b6 Next: ${next.description}` : `  \ud83c\udf89 Complete`,
  ].join('\n');
}

// ============================================================================
// Plan DB Operations
// ============================================================================

/**
 * Query active plan entities from KG.
 * @param {string} dbPath - Path to SQLite database
 * @returns {Array<{name: string, metadata: object}>}
 */
export function queryActivePlans(dbPath) {
  try {
    if (!fs.existsSync(dbPath)) return [];

    const rows = sqliteQueryJSON(dbPath,
      `SELECT e.name, e.metadata FROM entities e
       JOIN tags t ON t.entity_id = e.id
       WHERE e.type = ? AND t.tag = ?`,
      ['workflow_checkpoint', 'active']
    );

    if (!rows) return [];

    return rows.map(row => ({
      name: row.name,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : row.metadata,
    }));
  } catch (error) {
    logError('queryActivePlans', error);
    return [];
  }
}

/**
 * Add an observation to an existing entity.
 * @param {string} dbPath - Path to SQLite database
 * @param {string} entityName - Entity name
 * @param {string} content - Observation content
 * @returns {boolean}
 */
export function addObservation(dbPath, entityName, content) {
  const result = sqliteQuery(dbPath,
    `INSERT INTO observations (entity_id, content, created_at)
     SELECT id, ?, ? FROM entities WHERE name = ?`,
    [content, new Date().toISOString(), entityName]
  );
  return result !== null;
}

/**
 * Update an entity's metadata JSON.
 * @param {string} dbPath - Path to SQLite database
 * @param {string} entityName - Entity name
 * @param {object} metadata - New metadata object
 * @returns {boolean}
 */
export function updateEntityMetadata(dbPath, entityName, metadata) {
  const result = sqliteQuery(dbPath,
    'UPDATE entities SET metadata = ? WHERE name = ?',
    [JSON.stringify(metadata), entityName]
  );
  return result !== null;
}

/**
 * Replace a tag on an entity.
 * @param {string} dbPath - Path to SQLite database
 * @param {string} entityName - Entity name
 * @param {string} oldTag - Tag to replace
 * @param {string} newTag - New tag value
 * @returns {boolean}
 */
export function updateEntityTag(dbPath, entityName, oldTag, newTag) {
  const result = sqliteQuery(dbPath,
    `UPDATE tags SET tag = ? WHERE tag = ? AND entity_id = (SELECT id FROM entities WHERE name = ?)`,
    [newTag, oldTag, entityName]
  );
  return result !== null;
}

/**
 * Create a relation between two entities.
 * @param {string} dbPath - Path to SQLite database
 * @param {string} fromName - Source entity name
 * @param {string} toName - Target entity name
 * @param {string} relationType - Relation type (e.g. 'depends_on')
 * @returns {boolean}
 */
export function createRelation(dbPath, fromName, toName, relationType) {
  const result = sqliteQuery(dbPath,
    `INSERT OR IGNORE INTO relations (from_entity_id, to_entity_id, relation_type, created_at)
     SELECT f.id, t.id, ?, ?
     FROM entities f, entities t
     WHERE f.name = ? AND t.name = ?`,
    [relationType, new Date().toISOString(), fromName, toName]
  );
  return result !== null;
}
