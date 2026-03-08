#!/usr/bin/env node

/**
 * PreToolUse Hook - Modular Handler Architecture
 *
 * Triggered before each tool execution in Claude Code.
 *
 * Handlers (each returns partial response or null):
 * 1. codeReviewHandler  — git commit → review reminder
 * 2. routingHandler     — Task → model/background selection
 * 3. planningHandler    — Task(Plan)/EnterPlanMode → SDD+BDD template
 * 4. dryRunGateHandler  — Task → untested code warning
 *
 * Response Merger combines all handler outputs into a single JSON response:
 * - updatedInput: deep-merged
 * - additionalContext: concatenated
 * - permissionDecision: most-restrictive-wins
 */

import {
  HOME_DIR,
  STATE_DIR,
  readJSONFile,
  readStdin,
  logError,
} from './hook-utils.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ============================================================================
// Constants
// ============================================================================

const CURRENT_SESSION_FILE = path.join(STATE_DIR, 'current-session.json');
const ROUTING_CONFIG_FILE = path.join(HOME_DIR, '.memesh', 'routing-config.json');
const ROUTING_AUDIT_LOG = path.join(HOME_DIR, '.memesh', 'routing-audit.log');
const PLANNING_TEMPLATE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'templates',
  'planning-template.md'
);

// ============================================================================
// Response Merger
// ============================================================================

/**
 * Deep-merge two objects (shallow for top-level, recursive for nested).
 * Later values override earlier ones.
 */
function deepMerge(target, source) {
  if (!source) return target;
  if (!target) return source;

  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      typeof result[key] === 'object' && result[key] !== null &&
      typeof source[key] === 'object' && source[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Get the most restrictive permission decision.
 * Priority: deny > ask > allow > undefined
 */
function mostRestrictive(decisions) {
  const priority = { deny: 3, ask: 2, allow: 1 };
  let result = undefined;
  let maxPriority = 0;

  for (const d of decisions) {
    if (d && priority[d] > maxPriority) {
      maxPriority = priority[d];
      result = d;
    }
  }
  return result;
}

/**
 * Merge multiple handler responses into a single hook output.
 * @param {Array<Object|null>} responses - Handler responses
 * @returns {Object|null} Merged response or null if all handlers returned null
 */
function mergeResponses(responses) {
  const valid = responses.filter(Boolean);
  if (valid.length === 0) return null;

  let mergedInput = undefined;
  const contextParts = [];
  const decisions = [];

  for (const r of valid) {
    if (r.updatedInput) {
      mergedInput = deepMerge(mergedInput, r.updatedInput);
    }
    if (r.additionalContext) {
      contextParts.push(r.additionalContext);
    }
    if (r.permissionDecision) {
      decisions.push(r.permissionDecision);
    }
  }

  const merged = {};
  if (mergedInput) merged.updatedInput = mergedInput;
  if (contextParts.length > 0) merged.additionalContext = contextParts.join('\n\n');

  const decision = mostRestrictive(decisions);
  if (decision) merged.permissionDecision = decision;

  return Object.keys(merged).length > 0 ? merged : null;
}

// ============================================================================
// Routing Config
// ============================================================================

/** Module-level cache for routing config (30-second TTL) */
let _routingConfigCache = null;
let _routingConfigTimestamp = 0;
const ROUTING_CONFIG_TTL_MS = 30_000;

/**
 * Load routing config with fallback defaults.
 * Creates default config if file doesn't exist.
 * Results are cached for 30 seconds to avoid repeated file I/O.
 */
function loadRoutingConfig() {
  const now = Date.now();
  if (_routingConfigCache && (now - _routingConfigTimestamp) < ROUTING_CONFIG_TTL_MS) {
    return _routingConfigCache;
  }
  const defaults = {
    version: 1,
    modelRouting: {
      rules: [
        { subagentType: 'Explore', model: 'haiku', reason: 'Fast codebase search' },
      ],
      default: null,
    },
    backgroundRules: [
      { subagentType: 'Explore', forceBackground: false },
    ],
    planningEnforcement: {
      enabled: true,
      triggerSubagents: ['Plan'],
      triggerEnterPlanMode: true,
    },
    dryRunGate: {
      enabled: true,
      skipSubagents: ['Explore', 'Plan', 'claude-code-guide'],
    },
    auditLog: true,
  };

  try {
    if (fs.existsSync(ROUTING_CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(ROUTING_CONFIG_FILE, 'utf-8'));
      const merged = { ...defaults, ...config };
      _routingConfigCache = merged;
      _routingConfigTimestamp = now;
      return merged;
    }
  } catch (error) {
    logError('loadRoutingConfig', error);
  }

  // Create default config on first run
  try {
    const dir = path.dirname(ROUTING_CONFIG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(ROUTING_CONFIG_FILE, JSON.stringify(defaults, null, 2), 'utf-8');
  } catch {
    // Non-critical — works with in-memory defaults
  }

  _routingConfigCache = defaults;
  _routingConfigTimestamp = now;
  return defaults;
}

// ============================================================================
// Audit Log
// ============================================================================

/**
 * Append an entry to the routing audit log.
 * @param {string} entry - Log entry
 * @param {Object} config - Routing config
 */
const AUDIT_LOG_MAX_BYTES = 1_048_576; // 1 MB
const AUDIT_LOG_KEEP_LINES = 500;

function auditLog(entry, config) {
  if (!config.auditLog) return;

  try {
    // Rotate if log exceeds 1 MB: keep only the last 500 lines
    if (fs.existsSync(ROUTING_AUDIT_LOG)) {
      const stat = fs.statSync(ROUTING_AUDIT_LOG);
      if (stat.size > AUDIT_LOG_MAX_BYTES) {
        const content = fs.readFileSync(ROUTING_AUDIT_LOG, 'utf-8');
        const lines = content.split('\n');
        const truncated = lines.slice(-AUDIT_LOG_KEEP_LINES).join('\n');
        fs.writeFileSync(ROUTING_AUDIT_LOG, truncated);
      }
    }

    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${entry}\n`;
    fs.appendFileSync(ROUTING_AUDIT_LOG, line);
  } catch {
    // Non-critical
  }
}

// ============================================================================
// Handler 1: Code Review (existing behavior)
// ============================================================================

function codeReviewHandler(toolName, toolInput, _session) {
  // Only applies to git commit commands
  if (toolName !== 'Bash') return null;

  const cmd = toolInput?.command || '';
  if (!/git\s+commit\s/.test(cmd) || cmd.includes('--amend')) return null;

  // Check if code review was done this session
  const session = readJSONFile(CURRENT_SESSION_FILE, {});
  if (session.codeReviewDone === true) return null;

  return {
    additionalContext: [
      '<user-prompt-submit-hook>',
      'PRE-COMMIT REVIEW REMINDER:',
      'No comprehensive code review was detected in this session.',
      'Before committing significant changes, run: @comprehensive-code-review',
      '',
      'The review checks for:',
      '- Ripple Map: unsynchronized cross-file changes',
      '- Reality Check: phantom imports, ghost methods, schema drift',
      '- Cross-boundary Sync: type parity, client parity, route-SDK match',
      '- Security, concurrency, error handling, and 7 other dimensions',
      '',
      'Skip only for trivial changes (typo fixes, formatting, comments).',
      '</user-prompt-submit-hook>',
    ].join('\n'),
  };
}

// ============================================================================
// Handler 2: Model Routing
// ============================================================================

function routingHandler(toolName, toolInput, _session, config) {
  if (toolName !== 'Task') return null;

  const subagentType = toolInput?.subagent_type || '';
  if (!subagentType) return null;

  const result = { updatedInput: {} };
  let applied = false;

  // Model routing
  const modelRules = config.modelRouting?.rules || [];
  for (const rule of modelRules) {
    if (!rule.subagentType) continue;
    if (subagentType.toLowerCase() === rule.subagentType.toLowerCase()) {
      // Never override user's explicit model choice
      if (toolInput.model) {
        auditLog(`Task(${subagentType}) → user override preserved (model: ${toolInput.model})`, config);
        break;
      }
      result.updatedInput.model = rule.model;
      auditLog(`Task(${subagentType}) → model: ${rule.model} (${rule.reason})`, config);
      applied = true;
      break;
    }
  }

  // Background routing
  const bgRules = config.backgroundRules || [];
  for (const rule of bgRules) {
    if (!rule.subagentType) continue;
    if (subagentType.toLowerCase() === rule.subagentType.toLowerCase()) {
      // Only force background if not explicitly set by user/Claude
      if (rule.forceBackground && toolInput.run_in_background === undefined) {
        result.updatedInput.run_in_background = true;
        auditLog(`Task(${subagentType}) → background: true`, config);
        applied = true;
      }
      break;
    }
  }

  if (!applied && !toolInput.model) {
    auditLog(`Task(${subagentType}) → no override (no matching rule)`, config);
  }

  return Object.keys(result.updatedInput).length > 0 ? result : null;
}

// ============================================================================
// Handler 3: Planning Enforcer
// ============================================================================

function planningHandler(toolName, toolInput, _session, config) {
  const planConfig = config.planningEnforcement;
  if (!planConfig?.enabled) return null;

  // Case 1: Task tool dispatching a Plan subagent
  if (toolName === 'Task') {
    const subagentType = toolInput?.subagent_type || '';
    const triggerSubagents = planConfig.triggerSubagents || ['Plan'];

    if (triggerSubagents.some(t => subagentType.toLowerCase() === t.toLowerCase())) {
      const template = loadPlanningTemplate();
      if (!template) return null;

      auditLog(`Task(${subagentType}) → planning template injected`, config);

      // Append template to the subagent's prompt via updatedInput.prompt
      const originalPrompt = toolInput?.prompt || '';
      return {
        updatedInput: {
          prompt: originalPrompt + '\n\n---\n\n' + template,
        },
      };
    }
  }

  // Case 2: EnterPlanMode — inject into main Claude's context
  if (toolName === 'EnterPlanMode' && planConfig.triggerEnterPlanMode) {
    auditLog('EnterPlanMode → planning template context injected', config);

    return {
      additionalContext: [
        'PLANNING MODE ACTIVATED — Use this template for your plan:',
        '',
        loadPlanningTemplate() || '(Planning template not found)',
        '',
        'IMPORTANT: Present the completed plan to the user and wait for',
        'explicit approval before proceeding to implementation.',
      ].join('\n'),
    };
  }

  return null;
}

/**
 * Load the planning template from file.
 * @returns {string|null}
 */
function loadPlanningTemplate() {
  try {
    if (fs.existsSync(PLANNING_TEMPLATE_FILE)) {
      return fs.readFileSync(PLANNING_TEMPLATE_FILE, 'utf-8');
    }
  } catch (error) {
    logError('loadPlanningTemplate', error);
  }
  return null;
}

// ============================================================================
// Handler 4: Dry-Run Gate
// ============================================================================

function dryRunGateHandler(toolName, toolInput, _session, config) {
  const gateConfig = config.dryRunGate;
  if (!gateConfig?.enabled) return null;

  // Only applies to Task dispatches (heavy operations)
  if (toolName !== 'Task') return null;

  const subagentType = toolInput?.subagent_type || '';
  const skipTypes = gateConfig.skipSubagents || ['Explore', 'Plan', 'claude-code-guide'];

  // Skip for research/planning agents that don't need tested code
  if (skipTypes.some(t => subagentType.toLowerCase().includes(t.toLowerCase()))) {
    return null;
  }

  // Read session state for file tracking
  const session = readJSONFile(CURRENT_SESSION_FILE, {});
  const modifiedFiles = session.modifiedFiles || [];
  const testedFiles = session.testedFiles || [];

  if (modifiedFiles.length === 0) return null;

  // Find untested files
  const untestedFiles = modifiedFiles.filter(f => !testedFiles.includes(f));

  if (untestedFiles.length === 0) return null;

  // Build warning (advisory only — never deny)
  const fileList = untestedFiles.length <= 5
    ? untestedFiles.map(f => path.basename(f)).join(', ')
    : `${untestedFiles.slice(0, 5).map(f => path.basename(f)).join(', ')} (+${untestedFiles.length - 5} more)`;

  auditLog(`Task(${subagentType}) → dry-run warning: ${untestedFiles.length} untested files`, config);

  return {
    additionalContext: [
      'UNTESTED CODE WARNING:',
      `${untestedFiles.length} modified file(s) have not been tested yet: ${fileList}`,
      '',
      'Consider running tests before dispatching this task:',
      '- node --check <file>  (syntax verification)',
      '- vitest run <test>    (unit tests)',
      '- tsc --noEmit         (type checking)',
      '',
      'This is advisory — proceed if you are confident the code is correct.',
    ].join('\n'),
  };
}

// ============================================================================
// Hook Response Output
// ============================================================================

/**
 * Output hook response as JSON to stdout.
 */
function respond(hookOutput) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      ...hookOutput,
    },
  }));
}

// ============================================================================
// Main
// ============================================================================

async function preToolUse() {
  try {
    const input = await readStdin(3000);
    if (!input || input.trim() === '') {
      process.exit(0);
    }

    const data = JSON.parse(input);
    const toolName = data.tool_name || data.toolName || '';
    const toolInput = data.tool_input || data.arguments || {};

    // Load config once for all handlers
    const config = loadRoutingConfig();

    // Load session state once for handlers that need it
    const session = readJSONFile(CURRENT_SESSION_FILE, {});

    // Run all handlers
    const responses = [
      codeReviewHandler(toolName, toolInput, session),
      routingHandler(toolName, toolInput, session, config),
      planningHandler(toolName, toolInput, session, config),
      dryRunGateHandler(toolName, toolInput, session, config),
    ];

    // Merge all responses
    const merged = mergeResponses(responses);

    // If any handler produced output, send the merged response
    if (merged) {
      respond(merged);
    }

    process.exit(0);
  } catch (error) {
    logError('PreToolUse', error);
    process.exit(0); // Never block on hook errors
  }
}

preToolUse();
