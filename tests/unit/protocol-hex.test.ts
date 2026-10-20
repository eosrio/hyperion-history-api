import {expect,it} from 'bun:test';
import {isProtocolHex} from '../../src/indexer/protocol/hex.js';
import {protocolBytes} from '../../src/indexer/protocol/contract-cache.js';

it('validates large retained hex bytes without the repeated-pair regex engine limit',()=>{
    const encoded='ab'.repeat(16*1024*1024);
    expect(isProtocolHex(encoded)).toBe(true);
    const decoded=protocolBytes(encoded);expect(decoded.byteLength).toBe(16*1024*1024);
    expect(decoded[0]).toBe(171);expect(decoded.at(-1)).toBe(171);
    expect(isProtocolHex(encoded+'0')).toBe(false);expect(isProtocolHex(encoded+'zz')).toBe(false);
    expect(isProtocolHex('AB')).toBe(false);expect(isProtocolHex('AB',true)).toBe(true);
    expect(Buffer.from(protocolBytes('AB')).toString('hex')).toBe('ab');
    expect(isProtocolHex('')).toBe(true);expect(isProtocolHex(null)).toBe(false);
});
