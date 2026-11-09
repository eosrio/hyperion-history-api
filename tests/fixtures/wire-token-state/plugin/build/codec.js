/** Exact Wire name, symbol and asset handling. Amounts stay bigint or decimal text; nothing goes through a float. */
const CHARMAP = '.12345abcdefghijklmnopqrstuvwxyz';
// Wire's own asset codec refuses amounts outside this range.
const ASSET_LIMIT = 2n ** 62n - 1n;
export class TokenProjectionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TokenProjectionError';
    }
}
export function check(value, message) {
    if (!value)
        throw new TokenProjectionError(message);
}
/** The 64-bit Wire name encoding: twelve 5-bit characters from the top, then one 4-bit character. */
export function nameFromUint64(value) {
    check(value >= 0n && value < 2n ** 64n, 'Name value outside uint64');
    let text = '';
    for (let i = 0; i < 13; i++) {
        const index = i === 12 ? value & 0x0fn : (value >> BigInt(59 - 5 * i)) & 0x1fn;
        text += CHARMAP[Number(index)];
    }
    return text.replace(/\.+$/, '');
}
/** A symbol code packs up to seven uppercase letters little-endian, zero-padded. */
export function symbolCodeFromUint64(value) {
    check(value > 0n && value < 2n ** 64n, 'Symbol code outside uint64');
    let text = '', rest = value, ended = false;
    for (let i = 0; i < 8; i++) {
        const byte = Number(rest & 0xffn);
        rest >>= 8n;
        if (byte === 0) {
            ended = true;
            continue;
        }
        check(!ended && byte >= 0x41 && byte <= 0x5a, 'Symbol code is not uppercase letters followed by zero padding');
        text += String.fromCharCode(byte);
    }
    check(text.length >= 1 && text.length <= 7, 'Symbol code length outside 1..7');
    return text;
}
/** Wire stores a scoped multi-index row under one KV key: the scope, then the primary key, both big-endian. */
export function decodeScopedKey(keyHex) {
    check(typeof keyHex === 'string' && /^[0-9a-f]{32}$/.test(keyHex), 'Token row key must be 16 bytes: scope and symbol code');
    return { scope: BigInt('0x' + keyHex.slice(0, 16)), primary: BigInt('0x' + keyHex.slice(16)) };
}
/** Parse the decoded asset text the Wire codec produces, for example "75323.350694444 WIRE". */
export function parseAsset(text) {
    check(typeof text === 'string', 'Asset must be decoded text');
    const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))? ([A-Z]{1,7})$/.exec(text);
    check(match, `Asset text is not canonical: ${text.slice(0, 64)}`);
    const [, sign = '', whole = '', fraction = '', symbol = ''] = match;
    const amount = BigInt(sign + whole + fraction);
    check(amount >= -ASSET_LIMIT && amount <= ASSET_LIMIT, 'Asset amount exceeds the Wire range');
    // Canonical text has exactly the precision's digits and no negative zero.
    check(!(sign && amount === 0n), 'Asset text is negative zero');
    return Object.freeze({ amount, precision: fraction.length, symbol });
}
export function formatAmount(amount, precision) {
    const negative = amount < 0n, digits = (negative ? -amount : amount).toString().padStart(precision + 1, '0');
    const text = precision ? `${digits.slice(0, -precision)}.${digits.slice(-precision)}` : digits;
    return (negative ? '-' : '') + text;
}
export function formatAsset(amount, precision, symbol) {
    return `${formatAmount(amount, precision)} ${symbol}`;
}
/** Stored integers use the SDK's exact int64 decimal text. */
export function int64Text(value) {
    check(value >= -(2n ** 63n) && value < 2n ** 63n, 'Value outside int64');
    return value.toString();
}
export function int64Value(text) {
    check(typeof text === 'string' && /^(0|-?[1-9][0-9]*)$/.test(text), 'Stored amount is not exact int64 text');
    return BigInt(text);
}
