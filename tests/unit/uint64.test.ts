import {expect, test} from 'bun:test';
import {canonicalUint64, compatibleUint64, compareUint64, subtractUint64, Uint64ValueError} from '../../src/indexer/helpers/uint64.js';

const values = ['0', '1', '9', '10', '9007199254740991', '9007199254740992', '9007199254740993',
    '9223372036854775807', '9223372036854775808', '18446744073709551614', '18446744073709551615'];

test('uint64 values retain canonical decimal strings across all integer precision boundaries', () => {
    for (const value of values) {
        expect(canonicalUint64(value)).toBe(value);
        expect(JSON.parse(JSON.stringify({sequence: canonicalUint64(value)}))).toEqual({sequence: value});
    }
    for (const value of ['', '00', '01', '+1', '-1', '-0', ' 1', '1 ', '1.0', '1e3', '18446744073709551616',
        '999999999999999999999', 0, 1, 9007199254740992, null, undefined, true]) {
        expect(() => canonicalUint64(value)).toThrow(Uint64ValueError);
    }
});

test('explicit legacy compatibility accepts only canonical strings and safe nonnegative numeric values', () => {
    expect(compatibleUint64(0)).toBe('0');
    expect(compatibleUint64(1)).toBe('1');
    expect(compatibleUint64(9007199254740991)).toBe('9007199254740991');
    expect(compatibleUint64('18446744073709551615')).toBe('18446744073709551615');
    for (const value of [9007199254740992, 9223372036854775808, -1, 0.5, NaN, Infinity, '01', null]) {
        expect(() => compatibleUint64(value)).toThrow(Uint64ValueError);
    }
});

test('uint64 ordering follows numeric magnitude and distinguishes neighboring values', () => {
    for (let index = 0; index < values.length; index++) {
        expect(compareUint64(values[index], values[index])).toBe(0);
        if (index > 0) {
            expect(compareUint64(values[index - 1], values[index])).toBe(-1);
            expect(compareUint64(values[index], values[index - 1])).toBe(1);
        }
    }
    expect(() => compareUint64('01', '1')).toThrow(Uint64ValueError);
});

test('sequence subtraction returns exact decimal counts, including small deltas above the safe integer range', () => {
    expect(subtractUint64('9007199254740993', '9007199254740992')).toBe('1');
    expect(subtractUint64('18446744073709551615', '0')).toBe('18446744073709551615');
    expect(subtractUint64('18446744073709551615', '18446744073709551615')).toBe('0');
    expect(() => subtractUint64('9', '10')).toThrow(Uint64ValueError);
    expect(() => subtractUint64('18446744073709551616', '1')).toThrow(Uint64ValueError);
});
