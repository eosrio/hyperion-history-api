import { check, formatAmount, formatAsset, int64Value } from './codec.js';
import { PROJECTION_ID, balanceKey, holdersKind } from './token-projection.js';
function window(request, fallbackLimit, fallbackMaximum) {
    const number = (value, fallback) => {
        const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]{1,9}$/.test(value) ? Number(value) : NaN;
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
    };
    const maximum = request.configuredLimit ?? fallbackMaximum;
    return { skip: number(request.query.skip, 0), limit: Math.min(number(request.query.limit, 0) || fallbackLimit, maximum) };
}
/** Legacy clients do arithmetic on `amount`; `balance` keeps the exact asset text alongside it. */
function legacyAmount(amount, precision) {
    return Number(formatAmount(amount, precision));
}
export function tokenRoutes(options) {
    const ranked = new Set(options.ranked.map(item => holdersKind(item.contract, item.symbol)));
    return {
        get_tokens: { projectionId: PROJECTION_ID, read: 'keyed',
            compose: async (reader, request) => {
                const account = String(request.query.account ?? '');
                const { skip, limit } = window(request, 50, 100);
                const holdings = await reader.get('holdings', account);
                const tokens = [];
                if (holdings.status === 'present')
                    for (const { contract, symbol } of holdings.value.tokens.slice(skip, skip + limit)) {
                        const row = await reader.get('balance', balanceKey(contract, account, symbol));
                        check(row.status === 'present', 'Holdings list a balance that is absent');
                        const amount = int64Value(row.value.amount), precision = row.value.precision;
                        tokens.push({ symbol, precision, amount: legacyAmount(amount, precision), contract,
                            balance: formatAsset(amount, precision, symbol) });
                    }
                return { account, tokens };
            } },
        get_top_holders: { projectionId: PROJECTION_ID, read: 'complete-kind',
            validate: (request) => {
                const { contract, symbol } = request.query;
                if (typeof contract !== 'string' || !options.contracts.includes(contract))
                    return `Token holders are projected only for ${options.contracts.join(', ')}`;
                if (typeof symbol !== 'string' || !symbol)
                    return 'symbol is required';
                if (!ranked.has(holdersKind(contract, symbol)))
                    return `Holders of ${symbol} on ${contract} are not ranked by this provider`;
                return undefined;
            },
            compose: async (reader, request) => {
                const contract = request.query.contract, symbol = request.query.symbol;
                const { skip, limit } = window(request, 50, 500);
                const rows = (await reader.all(holdersKind(contract, symbol))).map(row => ({ owner: row.key,
                    amount: int64Value(row.value.amount), precision: row.value.precision, block_num: row.value.block_num }));
                // Largest first; equal amounts by owner, so pages are stable.
                rows.sort((a, b) => a.amount === b.amount ? (a.owner < b.owner ? -1 : 1) : a.amount > b.amount ? -1 : 1);
                return { contract, symbol, holders: rows.slice(skip, skip + limit).map(row => ({ owner: row.owner,
                        amount: legacyAmount(row.amount, row.precision), symbol, updated_on: row.block_num,
                        balance: formatAsset(row.amount, row.precision, symbol) })) };
            } },
    };
}
