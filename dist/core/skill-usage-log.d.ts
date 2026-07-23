export declare function logSkillEvent(event: string, path?: string): void;
export interface SkillUsageSummary {
    total_events: number;
    events_by_name: Record<string, number>;
    first_event?: string;
    last_event?: string;
    log_path: string;
    log_bytes: number;
}
export declare function summariseSkillUsage(path?: string): SkillUsageSummary;
//# sourceMappingURL=skill-usage-log.d.ts.map