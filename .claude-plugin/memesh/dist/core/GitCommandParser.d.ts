export declare class GitCommandParser {
    private static readonly TEST_FILE_PATTERNS;
    private static readonly TEST_COMMAND_PATTERNS;
    static isGitAdd(command: string): boolean;
    static isGitCommit(command: string): boolean;
    static extractCommitMessage(command: string): string | null;
    static isTestFile(filePath: string): boolean;
    static isTestCommand(command: string): boolean;
    static findGitCommitSegment(command: string): string | null;
}
//# sourceMappingURL=GitCommandParser.d.ts.map