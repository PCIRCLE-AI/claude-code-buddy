import type { MemeshDatabase } from '../storage/sqlite.js';
export interface PatternsResult {
    workSchedule: {
        hourDistribution: Array<{
            hour: number;
            count: number;
        }>;
        dayDistribution: Array<{
            dayNum: number;
            count: number;
        }>;
    };
    toolPreferences: Array<{
        tool: string;
        sessions: number;
    }>;
    focusAreas: Array<{
        type: string;
        count: number;
    }>;
    workflow: {
        avgSessionMinutes: number;
        commitsPerSession: number;
        totalSessions: number;
        totalCommits: number;
    };
    strengths: Array<{
        type: string;
        avgConfidence: number;
        count: number;
    }>;
    learningAreas: Array<{
        tag: string;
        count: number;
    }>;
}
export declare function computePatterns(db: MemeshDatabase, categories?: string[]): PatternsResult;
//# sourceMappingURL=patterns.d.ts.map