export declare const MEMORY_ROOT = "/memories";
export type MemoryCommand = {
    command: 'view';
    path: string;
    view_range?: [number, number];
} | {
    command: 'create';
    path: string;
    file_text: string;
} | {
    command: 'str_replace';
    path: string;
    old_str: string;
    new_str?: string;
} | {
    command: 'insert';
    path: string;
    insert_line: number;
    insert_text: string;
} | {
    command: 'delete';
    path: string;
} | {
    command: 'rename';
    old_path: string;
    new_path: string;
};
export interface MemoryToolResult {
    content: string;
    isError: boolean;
}
export declare function handleMemoryCommand(input: unknown): MemoryToolResult;
export declare const MEMORY_TOOL_DEFINITION: {
    readonly type: "memory_20250818";
    readonly name: "memory";
};
//# sourceMappingURL=memory-tool.d.ts.map