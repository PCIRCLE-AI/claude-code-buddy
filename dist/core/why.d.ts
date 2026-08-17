import type { MemeshDatabase } from '../storage/sqlite.js';
export type WhyAbstention = 'git_unavailable' | 'not_a_git_repo' | 'file_not_tracked' | 'history_unreadable' | 'line_out_of_range' | 'line_uncommitted' | 'no_commits_supplied' | 'no_commit_entity' | 'no_session_link';
export interface WhyGitCommit {
    hash: string;
    subject?: string;
    date?: string;
}
export interface WhyEntityRef {
    id: number;
    name: string;
    type: string;
    title: string | null;
    created_at: string;
}
export interface WhyCommitAttribution {
    commit: WhyGitCommit;
    entity: (WhyEntityRef & {
        observations: string[];
    }) | null;
    session: {
        session_id: string;
        entities: WhyEntityRef[];
        truncated: boolean;
    } | null;
    abstentions: WhyAbstention[];
}
export interface WhyResult {
    file: string;
    basename: string;
    project: string | null;
    commits: WhyCommitAttribution[];
    file_memories: {
        basis: 'file-tag';
        entities: WhyEntityRef[];
    };
    abstentions: WhyAbstention[];
}
export interface ResolveCommitsResult {
    commits: WhyGitCommit[];
    abstention: WhyAbstention | null;
}
export declare function resolveFileCommits(repoDir: string, file: string, opts?: {
    line?: number;
    limit?: number;
}): ResolveCommitsResult;
export declare function basenameOf(file: string): string;
export declare function explainCommits(db: MemeshDatabase, input: {
    file: string;
    commits?: WhyGitCommit[];
    project?: string | null;
    limit?: number;
    abstentions?: WhyAbstention[];
}): WhyResult;
//# sourceMappingURL=why.d.ts.map