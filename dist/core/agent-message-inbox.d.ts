interface InboxDb {
    prepare(sql: string): {
        get(...params: unknown[]): unknown;
    };
}
export declare function unreadDeliveryCount(db: InboxDb, project: string, recipient?: string): number;
export declare function recipientEverSeen(db: InboxDb, project: string, recipient: string): boolean | undefined;
export declare function unreadInboxLines(count: number, project: string, recipient?: string, everSeen?: boolean): string[];
export {};
//# sourceMappingURL=agent-message-inbox.d.ts.map