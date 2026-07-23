import type Database from 'better-sqlite3';
export interface ProjectTagCount {
    project: string;
    count: number;
}
export interface RenameProjectResult {
    fromTag: string;
    toTag: string;
    affectedEntities: number;
    merged: number;
    renamed: number;
    applied: boolean;
    affectedNames: string[];
}
export declare function listProjectTags(db?: Database.Database): ProjectTagCount[];
export declare function renameProjectTag(from: string, to: string, opts?: {
    apply?: boolean;
    db?: Database.Database;
}): RenameProjectResult;
//# sourceMappingURL=project-tags.d.ts.map