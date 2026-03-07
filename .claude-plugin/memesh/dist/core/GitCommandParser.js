export class GitCommandParser {
    static TEST_FILE_PATTERNS = ['.test.', '.spec.', '/tests/'];
    static TEST_COMMAND_PATTERNS = ['npm test', 'npm run test', 'vitest', 'jest', 'mocha'];
    static isGitAdd(command) {
        return command.trim().startsWith('git add');
    }
    static isGitCommit(command) {
        return GitCommandParser.findGitCommitSegment(command) !== null;
    }
    static extractCommitMessage(command) {
        const segment = GitCommandParser.findGitCommitSegment(command);
        const source = segment ?? command;
        const messages = [];
        const regex = /-m\s+(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
        let match;
        while ((match = regex.exec(source)) !== null) {
            const message = match[1] ?? match[2] ?? match[3];
            if (message) {
                messages.push(message);
            }
        }
        return messages.length > 0 ? messages.join('\n') : null;
    }
    static isTestFile(filePath) {
        return GitCommandParser.TEST_FILE_PATTERNS.some(p => filePath.includes(p));
    }
    static isTestCommand(command) {
        return GitCommandParser.TEST_COMMAND_PATTERNS.some(p => command.includes(p));
    }
    static findGitCommitSegment(command) {
        const segments = command
            .split(/&&|;/)
            .map(segment => segment.trim())
            .filter(Boolean);
        for (const segment of segments) {
            if (/^git\s+commit(\s|$)/.test(segment)) {
                return segment;
            }
        }
        return null;
    }
}
//# sourceMappingURL=GitCommandParser.js.map