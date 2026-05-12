export interface ExternalCheck {
    pass: boolean;
    summary?: string;
}
export interface VerifyAgentWorkInput {
    agent_id: string;
    workdir: string;
    base?: string;
    claim?: {
        expected_files?: number;
    };
    report?: {
        pass: boolean;
        typecheck?: ExternalCheck;
        tests?: ExternalCheck;
        lint?: ExternalCheck;
        build?: ExternalCheck;
        summary?: string;
    };
}
export interface RealityCheckResult {
    files_changed: number;
    expected_files: number | null;
    match: boolean | null;
    base: string | null;
    pass: boolean;
    summary: string;
}
export interface VerifyAgentWorkResult {
    entity_name: string;
    pass: boolean;
    reality_check: RealityCheckResult;
    external_report: VerifyAgentWorkInput['report'] | null;
    timestamp: string;
}
export declare function verifyAgentWork(input: VerifyAgentWorkInput): VerifyAgentWorkResult;
//# sourceMappingURL=verifier.d.ts.map