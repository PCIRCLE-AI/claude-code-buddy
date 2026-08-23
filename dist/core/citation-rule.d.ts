import fs from 'fs';
export declare const CITATION_RULE_MARKER = "<!-- managed-by: memesh -->";
export declare const CITATION_RULE_FILENAME = "memesh-citations.md";
export declare const CITATION_RULE_BODY = "<!-- managed-by: memesh -->\n# MeMesh memory citations\n\nMeMesh injects relevant memories at session start and before file edits. Every\ninjected line ends with a handle: `[mem:42]`.\n\nWhen an injected memory genuinely informs your work \u2014 you used the fact, the\nlesson changed what you did, the decision answered a question you were about to\nre-ask \u2014 cite it inline once as `[mem:42]`, in the sentence it affected.\n\nDo not cite a memory you only read past, and never invent an id. An uncited\nmemory is recorded as unused: that is how MeMesh learns which memories are\nworth the tokens they cost you.\n";
export type CitationRuleScope = 'user' | 'project';
export declare function citationRuleDir(scope: CitationRuleScope, home: string, cwd: string): string;
export declare function citationRulePath(scope: CitationRuleScope, home: string, cwd: string): string;
export type CitationRuleAction = 'created' | 'updated' | 'unchanged' | 'foreign-file';
export interface CitationRuleResult {
    path: string;
    action: CitationRuleAction;
}
export declare function writeCitationRule(scope: CitationRuleScope, home: string, cwd: string, fsImpl?: Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'mkdirSync'>): CitationRuleResult;
export type CitationRuleRemoval = 'removed' | 'absent' | 'foreign-file';
export declare function removeCitationRule(scope: CitationRuleScope, home: string, cwd: string, fsImpl?: Pick<typeof fs, 'readFileSync' | 'rmSync'>): {
    path: string;
    action: CitationRuleRemoval;
};
export type CitationRuleState = 'current' | 'stale' | 'missing' | 'foreign-file';
export declare function citationRuleState(scope: CitationRuleScope, home: string, cwd: string, fsImpl?: Pick<typeof fs, 'readFileSync'>): {
    path: string;
    state: CitationRuleState;
};
//# sourceMappingURL=citation-rule.d.ts.map