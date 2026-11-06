/** Constructed Antelope source, written independently of the codecs under test.
 * Field order follows the pinned Leap SHiP ABI; no Wire input or decoder is used.
 * Regeneration is explicit, not part of tests. This is not a signed live-chain capture.
 */
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {createAntelopeProvider} from '../../../build/indexer/protocol/antelope.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const abiBytes = readFileSync(new URL('./ship.abi.json', import.meta.url));
const {provider} = await createAntelopeProvider();
class Bytes {
    parts = [];
    raw(value) {this.parts.push(Buffer.from(value)); return this;}
    unsigned(value, size) {
        let n = BigInt(value); const bytes = Buffer.alloc(size);
        for (let i = 0; i < size; i++) {bytes[i] = Number(n & 255n); n >>= 8n;}
        if (n !== 0n) throw new Error('Integer overflow'); return this.raw(bytes);
    }
    varuint(value) {
        let n = BigInt(value);
        do {const byte = Number(n & 127n); n >>= 7n; this.unsigned(byte | (n ? 128 : 0), 1);} while (n);
        return this;
    }
    name(value) {
        const alphabet = '.12345abcdefghijklmnopqrstuvwxyz'; let n = 0n;
        if (value.length > 12) throw new Error('Fixture names are at most twelve characters');
        for (let i = 0; i < 12; i++) {
            const digit = i < value.length ? alphabet.indexOf(value[i]) : 0;
            if (digit < 0) throw new Error('Invalid name');
            n = (n << 5n) | BigInt(digit);
        }
        return this.unsigned(n << 4n, 8);
    }
    hex(value) {return this.raw(Buffer.from(value, 'hex'));}
    vector(bytes) {return this.varuint(bytes.length).raw(bytes);}
    done() {return Buffer.concat(this.parts);}
}
const chainId = hash('constructed-antelope-worker-source-v1');
const previousBlockId = '0000000b' + 'a'.repeat(56);
const timestamp = '2026-10-25T00:00:00.000', blockNum = 12;
const header = new Bytes().unsigned((Date.parse(timestamp + 'Z') - Date.UTC(2000, 0, 1)) / 500, 4)
    .name('producer').unsigned(1, 2).hex(previousBlockId).hex('b'.repeat(64)).hex('c'.repeat(64))
    .unsigned(1, 4).unsigned(0, 1).varuint(0).done();
const idBytes = Buffer.from(hash(header), 'hex'); idBytes.writeUInt32BE(blockNum);
const blockId = idBytes.toString('hex');
// K1 type tag and 65 zero signature bytes are ABI-valid, explicitly not consensus-valid.
const blockBytes = new Bytes().raw(header).unsigned(0, 1).raw(Buffer.alloc(65)).varuint(0).varuint(0).done();
const transactionId = '3'.repeat(64), actionHex = '0100000000000080';
const contractAbi = {version: 'eosio::abi/1.2', types: [], structs: [{name: 'setvalue', base: '',
    fields: [{name: 'value', type: 'uint64'}]}], actions: [{name: 'setvalue', type: 'setvalue', ricardian_contract: ''}],
    tables: [], ricardian_clauses: [], error_messages: [], abi_extensions: [], variants: [], action_results: []};
const contractAbiHex = Buffer.from(provider.contractCodec.encodeAbi(contractAbi)).toString('hex');
// transaction_trace_v0 with one action_trace_v1 and one action_receipt_v0.
const traces = new Bytes().varuint(1).varuint(0).hex(transactionId).unsigned(0, 1).unsigned(15, 4)
    .varuint(2).unsigned(7, 8).unsigned(16, 8).unsigned(0, 1).varuint(1)
    .varuint(1).varuint(1).varuint(0).unsigned(1, 1).varuint(0).name('counter').hex('d'.repeat(64))
    .unsigned('9007199254740995', 8).unsigned('9223372036854775808', 8).varuint(1)
    .name('alice').unsigned('18446744073709551615', 8).varuint(2).varuint(3)
    .name('counter').name('counter').name('setvalue').varuint(1).name('alice').name('active')
    .vector(Buffer.from(actionHex, 'hex')).unsigned(0, 1).unsigned(0, 8).varuint(0).varuint(0)
    .unsigned(0, 1).unsigned(0, 1).vector(Buffer.from('beef', 'hex'))
    .unsigned(0, 1).unsigned(0, 1).unsigned(0, 1).unsigned(0, 1).unsigned(0, 1).done();
function frame(traceBytes) {
    const value = new Bytes().varuint(1).unsigned(blockNum, 4).hex(blockId)
        .unsigned(11, 4).hex(previousBlockId).unsigned(1, 1).unsigned(blockNum, 4).hex(blockId)
        .unsigned(1, 1).unsigned(11, 4).hex(previousBlockId).unsigned(1, 1).vector(blockBytes);
    if (traceBytes === null) value.unsigned(0, 1); else value.unsigned(1, 1).vector(traceBytes);
    return value.unsigned(1, 1).vector(Buffer.from([0])).done();
}
const frames = Object.fromEntries([['handoff', traces], ['empty', Buffer.from([0])], ['missing', null]]
    .map(([name, bytes]) => {const value = frame(bytes); return [name, {hex: value.toString('hex'), sha256: hash(value), bytes: value.length}];}));
const statusBytes = new Bytes().varuint(0).unsigned(blockNum, 4).hex(blockId).unsigned(11, 4).hex(previousBlockId)
    .unsigned(1, 4).unsigned(13, 4).unsigned(1, 4).unsigned(13, 4).hex(chainId).done();
const fixture = {schemaVersion: 1, constructed: true, consensusSignatureValid: false,
    protocolId: 'antelope', profileId: 'antelope-default-v1',
    upstream: {repository: 'AntelopeIO/leap', tag: 'v5.0.3', revision: 'd133c6413ce8ce2e96096a0513ec25b4a8dbe837',
        path: 'libraries/state_history/abi.cpp', blob: 'd778d0c7fc40c96a070b860400f9d9244f1cba1b',
        extractedAbiSha256: hash(abiBytes)},
    generator: {node: process.version, sourceSha256: hash(readFileSync(new URL(import.meta.url)))},
    source: {chainId, blockNum, blockId, previousBlockId, producer: 'producer', timestamp, traceOrdinal: 0,
        transactionId, actionOrdinal: 1, receiptOrdinal: 0},
    contract: {account: 'counter', abiDeployment: {blockNum: 7, blockId: '00000007' + '7'.repeat(56), abiSequence: 3},
        abi: contractAbi, abiHex: contractAbiHex, abiSha256: hash(Buffer.from(contractAbiHex, 'hex')), actionHex},
    expected: {account: 'counter', name: 'setvalue', receiver: 'counter', authorization: [{actor: 'alice', permission: 'active'}],
        data: {value: '9223372036854775809'}, globalSequence: '9007199254740995', receiverSequence: '9223372036854775808',
        authSequence: '18446744073709551615', codeSequence: 2, abiSequence: 3, returnValue: 'beef'},
    status: {hex: statusBytes.toString('hex'), sha256: hash(statusBytes), bytes: statusBytes.length}, frames};
writeFileSync(new URL('./source.json', import.meta.url), JSON.stringify(fixture, null, 2) + '\n');
console.log(JSON.stringify({constructed: true, frames: Object.fromEntries(Object.entries(frames).map(([k,v]) => [k,{sha256:v.sha256,bytes:v.bytes}]))}));
