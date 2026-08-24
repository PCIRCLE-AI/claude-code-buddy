export interface RepoState {
    branch: string | null;
    uncommitted: number;
    lastTag: string | null;
    commitsSinceTag: number | null;
    declaredVersion: string | null;
    declaredVersionIsTagged: boolean | null;
}
export declare function readRepoState(cwdInput?: string | null): RepoState | null;
export declare function repoStateLines(state: RepoState | null): string[];
//# sourceMappingURL=repo-state.d.ts.map