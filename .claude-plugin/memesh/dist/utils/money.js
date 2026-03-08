const MICRO_DOLLARS_PER_DOLLAR = 1_000_000;
export function toMicroDollars(dollars) {
    return Math.round(dollars * MICRO_DOLLARS_PER_DOLLAR);
}
export function toDollars(microDollars) {
    return microDollars / MICRO_DOLLARS_PER_DOLLAR;
}
export function formatMoney(microDollars, decimals = 6) {
    const dollars = toDollars(microDollars);
    return `$${dollars.toFixed(decimals)}`;
}
export function calculateTokenCost(tokens, pricePerMillionTokens) {
    const priceInMicroDollars = toMicroDollars(pricePerMillionTokens);
    const costInMicroDollars = Math.round((tokens * priceInMicroDollars) / 1_000_000);
    return costInMicroDollars;
}
export function addCosts(...costs) {
    return costs.reduce((sum, cost) => sum + cost, 0);
}
export function calculateBudgetPercentage(spent, budget) {
    if (budget === 0)
        return 0;
    return (spent / budget) * 100;
}
//# sourceMappingURL=money.js.map