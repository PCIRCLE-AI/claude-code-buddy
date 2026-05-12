import type Database from 'better-sqlite3';
export interface ProjectInfo {
    name: string;
    count: number;
    types: string[];
    source: 'tag' | 'heuristic' | 'mixed';
}
export declare function extractProjectFromName(name: string): string | null;
export declare function extractProjectFromEntity(tags: string[] | null | undefined, name: string): {
    project: string | null;
    source: 'tag' | 'heuristic' | null;
};
export declare function computeProjects(db: Database.Database): ProjectInfo[];
//# sourceMappingURL=projects.d.ts.map