export interface LanguageProfile {
    code: string;
    name: string;
    nativeName: string;
    tokenMultiplier: number;
    detectionPatterns: RegExp[];
    confidence: number;
}
export declare const SUPPORTED_LANGUAGES: {
    readonly ENGLISH: {
        readonly code: "en";
        readonly multiplier: 1;
    };
    readonly SPANISH: {
        readonly code: "es";
        readonly multiplier: 1.7;
    };
    readonly FRENCH: {
        readonly code: "fr";
        readonly multiplier: 1.8;
    };
    readonly GERMAN: {
        readonly code: "de";
        readonly multiplier: 1.6;
    };
    readonly CHINESE: {
        readonly code: "zh";
        readonly multiplier: 2;
    };
    readonly JAPANESE: {
        readonly code: "ja";
        readonly multiplier: 2.5;
    };
    readonly KOREAN: {
        readonly code: "ko";
        readonly multiplier: 2.3;
    };
    readonly ARABIC: {
        readonly code: "ar";
        readonly multiplier: 3;
    };
    readonly TAMIL: {
        readonly code: "ta";
        readonly multiplier: 4.5;
    };
    readonly HINDI: {
        readonly code: "hi";
        readonly multiplier: 3.5;
    };
    readonly RUSSIAN: {
        readonly code: "ru";
        readonly multiplier: 1.9;
    };
    readonly PORTUGUESE: {
        readonly code: "pt";
        readonly multiplier: 1.7;
    };
    readonly THAI: {
        readonly code: "th";
        readonly multiplier: 4;
    };
    readonly VIETNAMESE: {
        readonly code: "vi";
        readonly multiplier: 1.5;
    };
    readonly INDONESIAN: {
        readonly code: "id";
        readonly multiplier: 1.4;
    };
};
export interface ToonifyMCPResponse {
    content: {
        type: 'text';
        text: string;
    }[];
}
export interface OptimizeContentRequest {
    content: string;
    toolName?: string;
    force_optimization?: boolean;
}
export interface GetStatsRequest {
}
export interface ToonifyStats {
    totalOptimizations: number;
    totalTokensSaved: number;
    averageSavingsPercent: number;
    cacheHitRate: number;
    lastReset: string;
}
//# sourceMappingURL=toonify.d.ts.map