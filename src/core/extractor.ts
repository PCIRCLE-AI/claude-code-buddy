import fs from 'fs';
import path from 'path';

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
  role?: string;
  type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  content?: unknown;
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

        // Count tool calls
        if (entry.type === 'tool_use' || entry.tool_name) {
          toolCallCount++;
        }

        // Track file edits (Write, Edit tools)
        if (entry.tool_name === 'Write' || entry.tool_name === 'Edit') {
          const input = entry.tool_input ?? {};
          const filePath = (input['file_path'] ?? input['path']) as string | undefined;
          if (filePath && typeof filePath === 'string') {
            filesEdited.add(path.basename(filePath));
          }
        }

        // Track bash commands — only meaningful ones
        if (entry.tool_name === 'Bash') {
          const cmd = (entry.tool_input?.['command'] as string | undefined) ?? '';
          if (
            typeof cmd === 'string' &&
            cmd.length > 10 &&
            !cmd.startsWith('ls') &&
            !cmd.startsWith('cd')
          ) {
            bashCommands.push(cmd.slice(0, 100));
          }
        }

        // Track errors from tool results
        if (entry.type === 'tool_result' && entry.content != null) {
          const text =
            typeof entry.content === 'string'
              ? entry.content
              : JSON.stringify(entry.content);
          if (text.includes('Error') || text.includes('FAIL') || text.includes('error:')) {
            errorsEncountered.push(text.slice(0, 200));
          }
        }
      } catch {
        // Skip malformed JSONL lines
      }
    }
  } catch {
    // Transcript unreadable — return empty results
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
    const projectName = path.basename(context.cwd);
    const sessionTag = `session:${context.sessionId.slice(0, 8)}`;
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
        name: `session-${context.sessionId.slice(0, 8)}-files`,
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
        name: `session-${context.sessionId.slice(0, 8)}-fixes`,
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
        name: `session-${context.sessionId.slice(0, 8)}-summary`,
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
