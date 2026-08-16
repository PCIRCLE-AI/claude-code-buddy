export type HostId = 'claude-code' | 'codex' | 'gemini';
export interface RunResult {
    status: number | null;
    stderr: string;
}
export interface SetupSeams {
    home: () => string;
    isOnPath: (bin: string) => boolean;
    run: (cmd: string, args: string[]) => RunResult;
    installedPluginsPath?: string;
}
export interface WireAction {
    kind: 'run' | 'install-hooks';
    label: string;
    cmd?: string;
    args?: string[];
}
export interface HostStatus {
    host: HostId;
    title: string;
    present: boolean;
    presenceDetail: string;
    wired: boolean | null;
    wiredDetail: string;
    actions: WireAction[];
}
export declare function inspectHosts(seams: SetupSeams): HostStatus[];
export declare function allWired(statuses: HostStatus[]): boolean;
//# sourceMappingURL=setup.d.ts.map