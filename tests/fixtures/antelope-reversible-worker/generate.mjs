/** Independent Leap SHiP byte construction. ABI-valid, unsigned, not a live-chain capture.
 * The frozen original Antelope fixture supplies the pinned schema and contract ABI, never a codec.
 * Run explicitly to regenerate; tests only read and check the saved bytes.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
const hash = value => createHash('sha256').update(value).digest('hex');
const originalBytes = readFileSync(new URL('../antelope-worker/source.json', import.meta.url));
const original = JSON.parse(originalBytes), schema = readFileSync(new URL('../antelope-worker/ship.abi.json', import.meta.url));
assert.equal(hash(schema), original.upstream.extractedAbiSha256);
class Bytes {
    parts = [];
    raw(value) {this.parts.push(Buffer.from(value)); return this;}
    u(value, size) {
        let n = BigInt(value); const bytes = Buffer.alloc(size);
        for (let i = 0; i < size; i++) {bytes[i] = Number(n & 255n); n >>= 8n;}
        assert.equal(n, 0n); return this.raw(bytes);
    }
    vu(value) {let n = BigInt(value); do {const b = Number(n & 127n); n >>= 7n; this.u(b | (n ? 128 : 0), 1);} while (n); return this;}
    name(value) {
        const alphabet = '.12345abcdefghijklmnopqrstuvwxyz'; let n = 0n;
        assert(value.length <= 12);
        for (let i = 0; i < 12; i++) {const d = i < value.length ? alphabet.indexOf(value[i]) : 0; assert(d >= 0); n = (n << 5n) | BigInt(d);}
        return this.u(n << 4n, 8);
    }
    hex(value) {return this.raw(Buffer.from(value, 'hex'));}
    vec(value) {return this.vu(value.length).raw(value);}
    text(value) {return this.vec(Buffer.from(value));}
    done() {return Buffer.concat(this.parts);}
}
const chainId = hash('constructed-antelope-reversible-workers-v1'), frames = [], expected = [];
let previous = '0'.repeat(64);
for (let number = 1; number <= 3; number++) {
    const slot = (Date.UTC(2026, 9, 25) - Date.UTC(2000, 0, 1)) / 500 + number;
    const header = new Bytes().u(slot, 4).name('producer').u(1, 2).hex(previous).hex('b'.repeat(64)).hex('c'.repeat(64))
        .u(1, 4).u(0, 1).vu(0).done();
    const id = Buffer.from(hash(header), 'hex'); id.writeUInt32BE(number); const blockId = id.toString('hex');
    // Zero K1 signature is only a framing fixture; it cannot certify consensus.
    const block = new Bytes().raw(header).u(0, 1).raw(Buffer.alloc(65)).vu(0).vu(0).done();
    let traces = Buffer.from([0]), deltas = Buffer.from([0]);
    if (number === 1) {
        const row = new Bytes().vu(0).name('counter').u(0, 4).vec(Buffer.from(original.contract.abiHex, 'hex')).done();
        deltas = new Bytes().vu(1).vu(0).text('account').vu(1).u(1, 1).vec(row).done();
    } else {
        const transactionId = String(number).repeat(64), value = 9223372036854775807n + BigInt(number);
        const action = new Bytes().u(value, 8).done(), sequence = 9007199254740993n + BigInt(number);
        traces = new Bytes().vu(1).vu(0).hex(transactionId).u(0, 1).u(15, 4).vu(2).u(7, 8).u(16, 8).u(0, 1).vu(1)
            .vu(1).vu(1).vu(0).u(1, 1).vu(0).name('counter').hex('d'.repeat(64))
            .u(sequence, 8).u(9223372036854775808n, 8).vu(1).name('alice').u(18446744073709551615n, 8).vu(2).vu(3)
            .name('counter').name('counter').name('setvalue').vu(1).name('alice').name('active').vec(action)
            .u(0, 1).u(0, 8).vu(0).vu(0).u(0, 1).u(0, 1).vec(Buffer.from('beef', 'hex'))
            .u(0, 1).u(0, 1).u(0, 1).u(0, 1).u(0, 1).done();
        expected.push({blockNum: number, blockId, transactionId, globalSequence: String(sequence),
            rawHex: action.toString('hex'), expectedValue: {value: String(value)}});
    }
    const frame = new Bytes().vu(1).u(number, 4).hex(blockId).u(0, 4).hex('0'.repeat(64))
        .u(1, 1).u(number, 4).hex(blockId).u(1, 1).u(number - 1, 4).hex(previous)
        .u(1, 1).vec(block).u(1, 1).vec(traces).u(1, 1).vec(deltas).done();
    frames.push({number, hex: frame.toString('hex'), sha256: hash(frame), bytes: frame.length,
        position: {chainId, blockNum: number, blockId, previousBlockId: number === 1 ? null : previous}});
    previous = blockId;
}
const status = new Bytes().vu(0).u(3, 4).hex(previous).u(0, 4).hex('0'.repeat(64))
    .u(1, 4).u(4, 4).u(1, 4).u(4, 4).hex(chainId).done();
const fixture = {schemaVersion: 1, constructed: true, consensusSignatureValid: false,
    protocolId: 'antelope', profileId: 'antelope-default-v1', chainId, upstream: original.upstream,
    originalFixtureSha256: hash(originalBytes), generatorSha256: hash(readFileSync(new URL(import.meta.url))),
    firstBlock: 1, selectedBlock: 2, continuationBlock: 3, frames, expected,
    status: {hex: status.toString('hex'), sha256: hash(status), bytes: status.length}};
writeFileSync(new URL('./source.json', import.meta.url), JSON.stringify(fixture, null, 2) + '\n');
console.log(JSON.stringify({frames: frames.length, sourceSha256: hash(JSON.stringify(fixture, null, 2) + '\n')}));
