import fs from 'fs';
import path from 'path';
import { getProjectName } from './paths.js';

// =============================================================================
// Extractor Interface (pluggable — rule-based now, LLM-based later)
// =============================================================================

export interface SessionContext {
  sessionId: string;
  transcriptPath?: string;
  cwd: string;
  stopReason: string;
  wasAgenticLoop: boolean;
}

export interface ExtractedMemory {
  name: string;
  type: string;
  observations: string[];
  tags: string[];
}

export interface Extractor {
  extract(context: SessionContext): ExtractedMemory[];
}

// =============================================================================
// Transcript Parsing
// =============================================================================

interface TranscriptEntry {
  // Current format: assistant/user wrapper entries
  type?: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      name?: string;
      input?: Record<string, unknown>;
      content?: unknown;
      // Claude Code marks failed tool calls explicitly. Trust this flag
      // instead of substring-matching the result text.
      is_error?: boolean;
    }>;
  };
  // Legacy format: flat top-level tool entries
  role?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
}

/**
 * Parse a JSONL transcript file and extract tool usage information.
 * Returns arrays of files edited, bash commands run, and errors encountered.
 * Defensive: never throws — malformed lines are silently skipped.
 */
export function parseTranscript(transcriptPath: string): {
  filesEdited: string[];
  bashCommands: string[];
  errorsEncountered: string[];
  toolCallCount: number;
} {
  const filesEdited = new Set<string>();
  const bashCommands: string[] = [];
  const errorsEncountered: string[] = [];
  let toolCallCount = 0;

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as TranscriptEntry;

        // Current format: assistant entries wrap tool_use blocks in message.content
        if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const block of entry.message.content) {
            if (block.type !== 'tool_use') continue;
            toolCallCount++;
            if (block.name === 'Write' || block.name === 'Edit') {
              const fp = (block.input?.['file_path'] ?? block.input?.['path']) as string | undefined;
              if (fp && typeof fp === 'string') filesEdited.add(path.basename(fp));
            }
            if (block.name === 'Bash') {
              const cmd = (block.input?.['command'] as string | undefined) ?? '';
              if (typeof cmd === 'string' && cmd.length > 10 && !cmd.startsWith('ls') && !cmd.startsWith('cd')) {
                bashCommands.push(cmd.slice(0, 100));
              }
            }
          }
        }

        // Current format: user entries wrap tool_result blocks in message.content.
        //
        // Use the explicit `is_error` flag (the same signal Claude Code
        // itself uses) instead of substring matching the result text. The
        // old text-match treated any Read/Bash output containing "Error"
        // (READMEs, CHANGELOG, source comments) as a real error, which
        // poisoned downstream analyzeFailure() with hundreds of fake errors
        // per session. See session-summary.js for the matching fix.
        if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
          for (const block of entry.message.content) {
            if (block.type !== 'tool_result') continue;
            if (block.is_error !== true) continue;
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            errorsEncountered.push(text.slice(0, 200));
          }
        }

        // Legacy format: flat top-level tool_use / tool_result entries
        if (entry.type === 'tool_use' || entry.tool_name) {
          toolCallCount++;
          if (entry.tool_name === 'Write' || entry.tool_name === 'Edit') {
            const input = entry.tool_input ?? {};
            const filePath = (input['file_path'] ?? input['path']) as string | undefined;
            if (filePath && typeof filePath === 'string') filesEdited.add(path.basename(filePath));
          }
          if (entry.tool_name === 'Bash') {
            const cmd = (entry.tool_input?.['command'] as string | undefined) ?? '';
            if (typeof cmd === 'string' && cmd.length > 10 && !cmd.startsWith('ls') && !cmd.startsWith('cd')) {
              bashCommands.push(cmd.slice(0, 100));
            }
          }
        }
        if (entry.type === 'tool_result' && entry.content != null) {
          if (entry.is_error === true) {
            const text = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);
            errorsEncountered.push(text.slice(0, 200));
          }
        }
      } catch {
        // Skip malformed JSONL lines — one bad line must not abort the
        // whole transcript. Benign and per-line, so deliberately not traced.
      }
    }
  } catch (err) {
    // The transcript file itself could not be read, which stops ALL session
    // knowledge extraction (files edited, errors, tool counts) — the input to
    // auto-capture, failure analysis and lessons. An absent file is the normal
    // "not written yet" case; anything else (permission, I/O) is a real fault
    // worth a trace, since it silently empties every downstream write flow.
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code !== 'ENOENT') {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        process.stderr.write(
          `[memesh extractor] transcript ${transcriptPath} unreadable (${msg}); ` +
            `session knowledge extraction skipped this run.\n`,
        );
      } catch { /* stderr must never throw the caller */ }
    }
  }

  return {
    filesEdited: [...filesEdited],
    bashCommands,
    errorsEncountered,
    toolCallCount,
  };
}

// =============================================================================
// Rule-Based Extractor
// =============================================================================

export class RuleBasedExtractor implements Extractor {
  extract(context: SessionContext): ExtractedMemory[] {
    const memories: ExtractedMemory[] = [];
    const projectName = getProjectName(context.cwd);
    const sessionTag = `session:${context.sessionId}`;
    const baseTags = ['source:auto-capture', sessionTag, `project:${projectName}`];

    // Skip sessions that were interrupted or non-agentic
    if (context.stopReason === 'user_interrupt') return memories;
    if (!context.wasAgenticLoop) return memories;

    // Require a transcript to extract anything
    if (!context.transcriptPath) return memories;

    const transcript = parseTranscript(context.transcriptPath);

    // Skip sessions with very little activity
    if (transcript.toolCallCount < 3) return memories;

    // Rule 1: File editing session summary
    if (transcript.filesEdited.length > 0) {
      memories.push({
        name: `session-${context.sessionId}-files`,
        type: 'session-insight',
        observations: [
          `Session edited ${transcript.filesEdited.length} file(s): ${transcript.filesEdited.join(', ')}`,
          `Total tool calls: ${transcript.toolCallCount}`,
        ],
        tags: baseTags,
      });
    }

    // Rule 2: Error → Fix pattern detection
    if (transcript.errorsEncountered.length > 0 && transcript.filesEdited.length > 0) {
      memories.push({
        name: `session-${context.sessionId}-fixes`,
        type: 'session-insight',
        observations: [
          `Fixed ${transcript.errorsEncountered.length} error(s) by editing ${transcript.filesEdited.join(', ')}`,
          ...transcript.errorsEncountered.slice(0, 3).map(e => `Error: ${e.slice(0, 100)}`),
        ],
        tags: [...baseTags, 'type:bugfix'],
      });
    }

    // Rule 3: Heavy session summary (20+ tool calls = significant work)
    if (transcript.toolCallCount >= 20) {
      memories.push({
        name: `session-${context.sessionId}-summary`,
        type: 'session-insight',
        observations: [
          `Significant session: ${transcript.toolCallCount} tool calls, ${transcript.filesEdited.length} files edited`,
          ...transcript.bashCommands.slice(0, 3).map(c => `Command: ${c}`),
        ],
        tags: [...baseTags, 'type:heavy-session'],
      });
    }

    return memories;
  }
}
