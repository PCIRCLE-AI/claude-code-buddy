export interface GuardSpec {
    tool: 'Bash' | 'Edit' | 'Write';
    pattern: string;
    message: string;
    should_match: string[];
    should_not_match: string[];
}
export interface ActiveGuard {
    lessonId: number;
    tool: string;
    pattern: string;
    message: string;
    action: string;
}
export declare const GUARD_TOOLS: Set<string>;
export declare const GUARD_BENIGN_PROBES: string[];
export declare function validateGuardSpec(spec: unknown): string[];
export declare function matchingGuards(guards: ActiveGuard[], tool: string, haystack: string): ActiveGuard[];
export declare function guardFromMetadata(lessonId: number, metadata: string | null): ActiveGuard | null;
//# sourceMappingURL=guards.d.ts.map