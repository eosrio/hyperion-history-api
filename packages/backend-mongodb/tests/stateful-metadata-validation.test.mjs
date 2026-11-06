import test from 'node:test';
import assert from 'node:assert/strict';
import {hex} from '../dist/stateful-contract.js';
import {ownerMetadata} from '../dist/stateful-owner-v2-contract.js';
import {setup,physical,admit,execute,retire} from './stateful-owner-v2-fixture.mjs';

const valid = '0123456789abcdef'.repeat(4);
const invalid = error => error.code === 'stateful.invalid-contract' && error.message === 'Expected SHA-256';
test('SHA-256 validation agrees with an independent exhaustive UTF-16 character oracle', () => {
    for (let code = 0; code <= 0xffff; code++) {
        const value = valid.slice(0,31) + String.fromCharCode(code) + valid.slice(32);
        const accepted = (code >= 48 && code <= 57) || (code >= 97 && code <= 102);
        if (accepted) assert.doesNotThrow(() => hex(value));
        else assert.throws(() => hex(value), invalid);
    }
    // Every ASCII position includes beginning/end anchors and invalid control characters.
    for (let position = 0; position < 64; position++) for (let code = 0; code < 128; code++) {
        const value = valid.slice(0,position) + String.fromCharCode(code) + valid.slice(position + 1);
        if ((code >= 48 && code <= 57) || (code >= 97 && code <= 102)) hex(value);
        else assert.throws(() => hex(value), invalid);
    }
});

test('SHA-256 type and exact length checks never coerce values or accept suffixes', () => {
    let calls = 0;
    const object = new Proxy(new String(valid), {get() {calls++; throw new Error('must not coerce');}});
    for (const value of [null,undefined,0,64n,true,Symbol('hex'),{},object,()=>valid]) assert.throws(() => hex(value), invalid);
    for (let length = 0; length <= 128; length++) {
        const value = 'a'.repeat(length);
        if (length === 64) hex(value); else assert.throws(() => hex(value), invalid);
    }
    for (const suffix of ['\n','\r','\r\n','\u2028','\u2029','\0',' ']) assert.throws(() => hex(valid + suffix), invalid);
    assert.equal(calls,0);
});

test('actual adapter-produced owner metadata revalidates root, undo and receipt digests on each call', async () => {
    const s = await setup(), target = await admit(s,1);
    await execute(s,target,async()=>{}); await retire(s,target);
    const original = structuredClone(physical(s));
    const policy = structuredClone(original.policy);
    assert.equal(await ownerMetadata(s.declaration,policy,original),original);
    const paths = [['etag'],['revision'],['undo',0,'digest'],['undo',0,'sourceDigest'],['undo',0,'imagesHash'],
        ['undo',0,'block','blockId'],['undo',0,'block','previousBlockId'],['receipts',0,'blockId'],
        ['receipts',0,'sourceDigest'],['receipts',0,'candidateDigest']];
    for (const path of paths) {
        const value = structuredClone(original);
        assert.equal(await ownerMetadata(s.declaration,policy,value),value);
        const parent = path.slice(0,-1).reduce((object,key)=>object[key],value), key = path.at(-1), prior = parent[key];
        parent[key] = 'g' + prior.slice(1);
        await assert.rejects(ownerMetadata(s.declaration,policy,value),invalid);
        parent[key] = prior;
        assert.equal(await ownerMetadata(s.declaration,policy,value),value);
    }
    const changedPolicy = structuredClone(original); changedPolicy.policy.maxBlocks--;
    await assert.rejects(ownerMetadata(s.declaration,policy,changedPolicy),error=>error.code === 'stateful.invalid-contract');
});
