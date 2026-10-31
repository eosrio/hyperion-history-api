import test from 'node:test';
import assert from 'node:assert/strict';
import {fields, requireState} from '../dist/stateful-contract.js';

const invalid = error => error?.code === 'stateful.invalid-contract';

test('native data fields preserve undefined/null values and own properties on custom prototypes', () => {
    for (const value of [{owner: undefined, raw: null}, Object.assign(Object.create(null), {owner: undefined, raw: null}),
        Object.assign(Object.create({inherited: true}), {owner: undefined, raw: null})]) {
        fields(value, ['owner', 'raw']);
    }
    fields(Object.defineProperty({}, '__proto__', {value: null, enumerable: true}), ['__proto__']);
    fields({}, []);
});

test('native data field checks refuse symbols, nonenumerable/missing/extra fields and inherited substitutes', () => {
    for (const value of [undefined, null, [], true, 'record', {owner: 1}, {owner: 1, raw: null, extra: 1},
        {owner: 1, raw: null, [Symbol('extra')]: true}, Object.create({owner: 1, raw: null}),
        Object.assign(Object.create({owner: 1}), {raw: null}),
        Object.defineProperty({owner: 1, raw: null}, 'raw', {value: null, enumerable: false}),
        Object.defineProperty({owner: 1, raw: null}, 'hidden', {value: true, enumerable: false})]) {
        assert.throws(() => fields(value, ['owner', 'raw']), invalid);
    }
});

test('refusing a native accessor never evaluates its getter or setter', () => {
    let calls = 0;
    const value = {owner: 1, get raw() {calls++; throw new Error('untrusted getter evaluated');}};
    assert.throws(() => fields(value, ['owner', 'raw']), invalid);
    const setter = Object.defineProperty({owner: 1}, 'raw', {set() {calls++;}, enumerable: true});
    assert.throws(() => fields(setter, ['owner', 'raw']), invalid);
    assert.equal(calls, 0);
});

// Verbatim head54 guard is the differential oracle for observable Proxy reflection.
function originalFields(value, names) {
    requireState(typeof value === 'object' && value !== null && !Array.isArray(value), 'Expected data record');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    requireState(Object.getOwnPropertySymbols(value).length === 0 && Object.keys(descriptors).length === names.length &&
        names.every(n => descriptors[n]?.enumerable && Object.hasOwn(descriptors[n], 'value')), 'Unexpected fields/accessors');
}

test('mutable proxies preserve the original ownKeys/descriptor traps, refusals and thrown errors', () => {
    for (const mode of ['stable', 'missing-descriptor', 'delete-during-reflection', 'new-symbol', 'descriptor-throws', 'second-ownKeys-throws']) {
        const check = validator => {
            const events = [], target = {owner: 1, raw: null};
            if (mode === 'descriptor-throws') target.extra = true;
            let keys = 0;
            const proxy = new Proxy(target, {
                ownKeys(value) {
                    events.push('ownKeys');
                    if (++keys === 2 && mode === 'second-ownKeys-throws') throw new Error('second ownKeys failed');
                    return Reflect.ownKeys(value);
                },
                getOwnPropertyDescriptor(value, key) {
                    events.push(typeof key === 'symbol' ? 'symbol' : key);
                    if (mode === 'descriptor-throws' && key === 'extra') throw new Error('extra descriptor failed');
                    if (key === 'owner' && mode === 'delete-during-reflection') delete value.raw;
                    if (key === 'owner' && mode === 'new-symbol') value[Symbol('late')] = true;
                    if (key === 'raw' && mode === 'missing-descriptor') return undefined;
                    return Reflect.getOwnPropertyDescriptor(value, key);
                },
                get() {throw new Error('property value must not be read');},
            });
            try {validator(proxy, ['owner', 'raw']); return {valid: true, events};}
            catch (error) {return {valid: false, events, name: error.name, code: error.code, message: error.message};}
        };
        assert.deepEqual(check(fields), check(originalFields), mode);
    }
});
