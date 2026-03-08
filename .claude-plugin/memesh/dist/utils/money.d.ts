export type MicroDollars = number & {
    readonly __brand: 'MicroDollars';
};
export declare function toMicroDollars(dollars: number): MicroDollars;
export declare function toDollars(microDollars: MicroDollars): number;
export declare function formatMoney(microDollars: MicroDollars, decimals?: number): string;
export declare function calculateTokenCost(tokens: number, pricePerMillionTokens: number): MicroDollars;
export declare function addCosts(...costs: MicroDollars[]): MicroDollars;
export declare function calculateBudgetPercentage(spent: MicroDollars, budget: MicroDollars): number;
//# sourceMappingURL=money.d.ts.map