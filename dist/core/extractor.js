import fs from 'fs';
import path from 'path';
import { getProjectName } from './paths.js';
export function parseTranscript(transcriptPath) {
    const filesEdited = new Set();
    const bashCommands = [];
    const errorsEncountered = [];
    let toolCallCount = 0;
    try {
        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
                    for (const block of entry.message.content) {
                        if (block.type !== 'tool_use')
                            continue;
                        toolCallCount++;
                        if (block.name === 'Write' || block.name === 'Edit') {
                            const fp = (block.input?.['file_path'] ?? block.input?.['path']);
                            if (fp && typeof fp === 'string')
                                filesEdited.add(path.basename(fp));
                        }
                        if (block.name === 'Bash') {
                            const cmd = block.input?.['command'] ?? '';
                            if (typeof cmd === 'string' && cmd.length > 10 && !cmd.startsWith('ls') && !cmd.startsWith('cd')) {
                                bashCommands.push(cmd.slice(0, 100));
                            }
                        }
                    }
                }
                if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
                    for (const block of entry.message.content) {
                        if (block.type !== 'tool_result')
                            continue;
                        if (block.is_error !== true)
                            continue;
                        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                        errorsEncountered.push(text.slice(0, 200));
                    }
                }
                if (entry.type === 'tool_use' || entry.tool_name) {
                    toolCallCount++;
                    if (entry.tool_name === 'Write' || entry.tool_name === 'Edit') {
                        const input = entry.tool_input ?? {};
                        const filePath = (input['file_path'] ?? input['path']);
                        if (filePath && typeof filePath === 'string')
                            filesEdited.add(path.basename(filePath));
                    }
                    if (entry.tool_name === 'Bash') {
                        const cmd = entry.tool_input?.['command'] ?? '';
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
            }
            catch {
            }
        }
    }
    catch (err) {
        const nodeErr = err;
        if (nodeErr?.code !== 'ENOENT') {
            const msg = err instanceof Error ? err.message : String(err);
            try {
                process.stderr.write(`[memesh extractor] transcript ${transcriptPath} unreadable (${msg}); ` +
                    `session knowledge extraction skipped this run.\n`);
            }
            catch { }
        }
    }
    return {
        filesEdited: [...filesEdited],
        bashCommands,
        errorsEncountered,
        toolCallCount,
    };
}
export class RuleBasedExtractor {
    extract(context) {
        const memories = [];
        const projectName = getProjectName(context.cwd);
        const sessionTag = `session:${context.sessionId}`;
        const baseTags = ['source:auto-capture', sessionTag, `project:${projectName}`];
        if (context.stopReason === 'user_interrupt')
            return memories;
        if (!context.wasAgenticLoop)
            return memories;
        if (!context.transcriptPath)
            return memories;
        const transcript = parseTranscript(context.transcriptPath);
        if (transcript.toolCallCount < 3)
            return memories;
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
//# sourceMappingURL=extractor.js.map