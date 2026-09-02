export interface HostEntryStream {
    write(chunk: string): unknown;
}
export declare function runHostEntry(binary: string, run: () => Promise<void>, stderr?: HostEntryStream): Promise<number>;
//# sourceMappingURL=entry.d.ts.map