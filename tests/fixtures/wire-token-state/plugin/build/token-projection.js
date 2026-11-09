import { check, decodeScopedKey, int64Text, int64Value, nameFromUint64, parseAsset, symbolCodeFromUint64 } from './codec.js';
export const STATEFUL_FAMILY = 'stateful-projection-recovery';
export const PROJECTION_ID = 'wire-token-balances-v1';
/**
 * Token-shaped contracts whose row layout was checked against real Wire rows and the node:
 * `accounts` keys are the owner name then the symbol code, big-endian. `stat` keys are either the
 * symbol code as scope then the symbol code (sysio.token), or the symbol code alone. Each ABI is
 * pinned by hash: a redeployment needs its layout checked again before it can be reduced.
 */
export const VERIFIED_TOKEN_CONTRACTS = Object.freeze({
    'sysio.token': Object.freeze(['ec6463bed0462df885c37f216508ac08c6bc441bbf2ad52c308fbf466e3a5dfa']),
    'sysio.liq': Object.freeze(['90872d56fdfd17b4a67731cff0c7ea3852ae41973176131c31563e79dbc419d1']),
    'sysio.swap': Object.freeze(['9976866ef44866bddaf4ec9fd5f35099f592658dcbc28c3bee9865a969e3c94f']),
});
const NAME = /^[.1-5a-z]{1,13}$/, SYMBOL = /^[A-Z]{1,7}$/;
export const balanceKey = (contract, owner, symbol) => JSON.stringify([contract, owner, symbol]);
export const symbolKey = (contract, symbol) => JSON.stringify([contract, symbol]);
export const holdersKind = (contract, symbol) => `holders:${contract}:${symbol}`;
export function resolveTokenProjectionOptions(input = {}) {
    const contracts = input.contracts ?? Object.keys(VERIFIED_TOKEN_CONTRACTS);
    check(Array.isArray(contracts) && contracts.length > 0 && contracts.length <= 4 && new Set(contracts).size === contracts.length
        && contracts.every(contract => typeof contract === 'string' && NAME.test(contract)), 'contracts must list one to four distinct token contracts');
    const extra = input.verifiedAbis ?? {};
    check(extra && typeof extra === 'object' && !Array.isArray(extra), 'verifiedAbis must map contracts to ABI hashes');
    const verifiedAbis = {};
    for (const contract of contracts) {
        const added = extra[contract] ?? [];
        check(Array.isArray(added) && added.every(hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)), `verifiedAbis.${contract} must list ABI hashes`);
        const hashes = [...new Set([...(VERIFIED_TOKEN_CONTRACTS[contract] ?? []), ...added])].sort();
        check(hashes.length, `${contract} has no verified token ABI; list its checked ABI hash in verifiedAbis`);
        verifiedAbis[contract] = Object.freeze(hashes);
    }
    const ranked = input.rankedSymbols ?? [];
    check(Array.isArray(ranked) && ranked.length <= 12, 'rankedSymbols must list at most twelve contract symbols');
    const seen = new Set(), selected = [];
    for (const item of ranked) {
        const { contract, symbol } = (item ?? {});
        check(typeof contract === 'string' && contracts.includes(contract) && typeof symbol === 'string' && SYMBOL.test(symbol), 'rankedSymbols entries need a configured contract and an uppercase symbol');
        check(!seen.has(holdersKind(contract, symbol)), 'rankedSymbols lists a symbol twice');
        seen.add(holdersKind(contract, symbol));
        selected.push(Object.freeze({ contract, symbol }));
    }
    return Object.freeze({ contracts: Object.freeze([...contracts].sort()), verifiedAbis: Object.freeze(verifiedAbis),
        ranked: Object.freeze(selected.sort((a, b) => holdersKind(a.contract, a.symbol) < holdersKind(b.contract, b.symbol) ? -1 : 1)) });
}
const exact = (path) => ({ path: [path], type: 'int64', vector: false });
/** Logical selection only; HAPI fills each selector's ABI epoch from the canonical source. */
export function tokenProjectionDefinition(options) {
    return { family: STATEFUL_FAMILY, interfaceVersion: 1, id: PROJECTION_ID,
        selectors: options.contracts.flatMap(contract => [
            { id: `${contract}:accounts`, kind: 'table', contract, name: 'accounts' },
            { id: `${contract}:stat`, kind: 'table', contract, name: 'stat' }
        ]),
        records: [
            { kind: 'balance', integers: [exact('amount')] },
            { kind: 'holdings', integers: [] },
            { kind: 'stat', integers: [exact('supply')] },
            { kind: 'circulating', integers: [exact('amount')] },
            ...options.ranked.map(item => ({ kind: holdersKind(item.contract, item.symbol), integers: [exact('amount')] })),
        ] };
}
function storedBalance(read, contract, owner, symbol) {
    if (read.status !== 'present')
        return null;
    const value = read.value;
    check(value.contract === contract && value.owner === owner && value.symbol === symbol && Number.isSafeInteger(value.precision), 'Stored balance does not match its key');
    return { amount: int64Value(value.amount), precision: value.precision };
}
function storedStat(read, contract, symbol) {
    if (read.status !== 'present')
        return null;
    const value = read.value;
    check(value.contract === contract && value.symbol === symbol && Number.isSafeInteger(value.precision), 'Stored stat does not match its key');
    return { supply: int64Value(value.supply), precision: value.precision, record: value };
}
const sameBalance = (a, b) => a === b || (!!a && !!b && a.amount === b.amount && a.precision === b.precision);
/** One block of token rows. Every changed key is written once, and the block fails closed when a touched
 * symbol's balances no longer add up to its supply. */
export function tokenReducer(options) {
    const contracts = new Set(options.contracts), ranked = new Set(options.ranked.map(item => holdersKind(item.contract, item.symbol)));
    return async (port) => {
        const blockNum = port.source.block.blockNum;
        const balances = new Map(), stats = new Map();
        for (const input of port.source.inputs) {
            check(input?.kind === 'table' && contracts.has(input.contract), 'Unexpected input for the token projection');
            check(options.verifiedAbis[input.contract]?.includes(input.abiSha256), `${input.contract} ABI ${String(input.abiSha256).slice(0, 64)} has no verified token key layout`);
            // A secondary index row (sysio.liq indexes stat by token) holds keys only; its primary row carries the state.
            if (input.identity?.kind === 'kv-secondary') {
                check(input.data === null && typeof input.identity.primaryKeyHex === 'string', 'A secondary index row carries a value');
                continue;
            }
            check(input.identity?.kind === 'kv-primary', `${input.contract} ${input.name} rows must be original KV rows`);
            if (input.name === 'accounts') {
                const key = decodeScopedKey(input.identity.keyHex), owner = nameFromUint64(key.scope), symbol = symbolCodeFromUint64(key.primary);
                check(owner.length, 'A balance row has an empty owner');
                const id = balanceKey(input.contract, owner, symbol);
                let change = balances.get(id);
                if (!change) {
                    const before = storedBalance(await port.get('balance', id), input.contract, owner, symbol);
                    change = { contract: input.contract, symbol, owner, before, after: before };
                    balances.set(id, change);
                }
                if (input.present) {
                    const asset = parseAsset(input.data?.balance);
                    check(asset.symbol === symbol, `Balance symbol ${asset.symbol} differs from its row key ${symbol}`);
                    check(asset.amount >= 0n, 'A balance is negative');
                    change.after = { amount: asset.amount, precision: asset.precision };
                }
                else {
                    check(change.after, 'A removed balance row was never projected');
                    change.after = null;
                }
            }
            else if (input.name === 'stat') {
                const keyHex = input.identity.keyHex;
                let symbol;
                if (typeof keyHex === 'string' && keyHex.length === 16)
                    symbol = symbolCodeFromUint64(BigInt('0x' + keyHex));
                else {
                    const key = decodeScopedKey(keyHex);
                    check(key.scope === key.primary, 'A scoped stat row must be scoped by its own symbol code');
                    symbol = symbolCodeFromUint64(key.primary);
                }
                const id = symbolKey(input.contract, symbol);
                let change = stats.get(id);
                if (!change) {
                    const before = storedStat(await port.get('stat', id), input.contract, symbol);
                    change = { contract: input.contract, symbol, before, after: before };
                    stats.set(id, change);
                }
                check(input.present, 'A token contract removed a stat row');
                const supply = parseAsset(input.data?.supply);
                check(supply.symbol === symbol && supply.amount >= 0n, `Stat supply does not match symbol ${symbol}`);
                check(!change.before || change.before.precision === supply.precision, `${symbol} changed precision`);
                const record = { contract: input.contract, symbol, precision: supply.precision,
                    supply: int64Text(supply.amount), block_num: blockNum };
                if (input.data?.max_supply !== undefined) {
                    const maximum = parseAsset(input.data.max_supply);
                    check(maximum.symbol === symbol && maximum.precision === supply.precision && supply.amount <= maximum.amount, `${symbol} supply is outside its maximum`);
                    record.max_supply = maximum.amount.toString();
                }
                if (input.data?.issuer !== undefined) {
                    check(typeof input.data.issuer === 'string' && NAME.test(input.data.issuer), 'Stat issuer is not a name');
                    record.issuer = input.data.issuer;
                }
                change.after = { supply: supply.amount, precision: supply.precision, record };
            }
            else
                check(false, `Unexpected ${input.contract} table ${input.name}`);
        }
        // Supply check for every touched symbol, against the stat as of the end of this block.
        const touched = new Map();
        for (const change of [...balances.values(), ...stats.values()])
            touched.set(symbolKey(change.contract, change.symbol), change);
        for (const [id, { contract, symbol }] of touched) {
            const stat = stats.get(id)?.after ?? storedStat(await port.get('stat', id), contract, symbol);
            check(stat, `${contract} ${symbol} balances changed without a stat row`);
            const stored = await port.get('circulating', id);
            const before = stored.status === 'present' ? int64Value(stored.value.amount) : 0n;
            let after = before;
            for (const change of balances.values()) {
                if (change.contract !== contract || change.symbol !== symbol)
                    continue;
                after += (change.after?.amount ?? 0n) - (change.before?.amount ?? 0n);
                check(!change.after || change.after.precision === stat.precision, `${contract} ${symbol} balance precision differs from its stat`);
            }
            check(after === stat.supply, `${contract} ${symbol} balances add up to ${after}, but its supply is ${stat.supply}`);
            if (stored.status !== 'present' || after !== before)
                port.put('circulating', id, { contract, symbol, amount: int64Text(after), block_num: blockNum });
        }
        // A stat delta means the row was written in this block; one put records its final value.
        for (const [id, change] of stats)
            port.put('stat', id, change.after.record);
        const holdings = new Map();
        for (const [id, change] of balances) {
            if (sameBalance(change.before, change.after))
                continue;
            const owner = change.owner, kind = holdersKind(change.contract, change.symbol);
            if (change.after) {
                const record = { contract: change.contract, owner, symbol: change.symbol, precision: change.after.precision,
                    amount: int64Text(change.after.amount), block_num: blockNum };
                port.put('balance', id, record);
                if (ranked.has(kind))
                    port.put(kind, owner, { owner, precision: record.precision, amount: record.amount, block_num: blockNum });
            }
            else {
                port.delete('balance', id);
                if (ranked.has(kind))
                    port.delete(kind, owner);
            }
            if (!change.before === !change.after)
                continue;
            const entry = holdings.get(owner) ?? { added: [], removed: new Set() };
            if (change.after)
                entry.added.push({ contract: change.contract, symbol: change.symbol });
            else
                entry.removed.add(symbolKey(change.contract, change.symbol));
            holdings.set(owner, entry);
        }
        for (const [owner, entry] of holdings) {
            const stored = await port.get('holdings', owner);
            const current = stored.status === 'present' ? stored.value.tokens : [];
            check(Array.isArray(current), 'Stored holdings are malformed');
            const tokens = new Map(current.map(token => [symbolKey(token.contract, token.symbol), token]));
            for (const key of entry.removed)
                check(tokens.delete(key), 'A removed balance was missing from its holdings');
            for (const token of entry.added) {
                check(!tokens.has(symbolKey(token.contract, token.symbol)), 'A new balance was already in its holdings');
                tokens.set(symbolKey(token.contract, token.symbol), token);
            }
            if (!tokens.size)
                port.delete('holdings', owner);
            else
                port.put('holdings', owner, { owner, tokens: [...tokens.entries()].sort(([a], [b]) => a < b ? -1 : 1)
                        .map(([, token]) => ({ contract: token.contract, symbol: token.symbol })) });
        }
    };
}
