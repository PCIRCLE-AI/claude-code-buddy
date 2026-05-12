export interface SignalInput {
    type: string;
    name: string;
    observations: string[];
    tags?: string[];
}
export declare function computeSignalScore(input: SignalInput): number;
export declare const DEFAULT_SIGNAL_THRESHOLD = 0.4;
//# sourceMappingURL=signal-scorer.d.ts.map