interface InboxDb {
    prepare(sql: string): {
        get(...params: unknown[]): unknown;
    };
}
export declare function unreadDeliveryCount(db: InboxDb, project: string, recipient?: string): number;
export declare function unreadInboxLines(count: number, project: string, recipient?: string): string[];
export {};
//# sourceMappingURL=agent-message-inbox.d.ts.map