export interface SignalInput {
    type: string;
    name: string;
    observations: string[];
    tags?: string[];
}
export declare function computeSignalScore(input: SignalInput): number;
//# sourceMappingURL=signal-scorer.d.ts.map