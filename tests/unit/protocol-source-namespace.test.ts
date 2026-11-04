import {test,expect} from 'bun:test';
import {protocolSourceNamespace} from '../../src/indexer/protocol/source-namespace.js';
import {PortableProjectionSource} from '../../src/indexer/projection/source.js';
import {prepared} from './portable-state-source-fixture.mjs';

test('default protocol source namespace is unchanged and explicit namespaces reject ambiguous syntax',()=>{
    expect(protocolSourceNamespace('wire')).toBe('wire');
    expect(protocolSourceNamespace('wire','rebuild-1')).toBe('wire-psrc-rebuild-1');
    for(const suffix of ['', '../history', 'UPPER', 'a_b', 'a'.repeat(33)])
        expect(()=>protocolSourceNamespace('wire',suffix)).toThrow();
    expect(()=>protocolSourceNamespace('wire/other','new')).toThrow();
    expect(()=>protocolSourceNamespace('wire-psrc-existing','new')).toThrow();
    expect(()=>protocolSourceNamespace('w'.repeat(115),'new')).toThrow();
});

test('alternate canonical source uses its own records and mismatched consumers fail closed',async()=>{
    const namespace=protocolSourceNamespace('portable-source-fixture','rebuild-1');
    const p=await prepared({},1,undefined,{namespace});
    const head=await p.source.head();expect(head.blockNum).toBe(1);
    const wrong=new PortableProjectionSource({...p.options,chain:'portable-source-fixture'});
    await expect(wrong.head()).rejects.toThrow();
    const keys=[...p.memory.documents.keys()];
    expect(keys.some(key=>key.startsWith(namespace+'-protocol-abi-frontier-v1\0'))).toBe(true);
    expect(keys.some(key=>key.startsWith('portable-source-fixture-protocol-abi-frontier-v1\0'))).toBe(false);
    expect(keys.some(key=>key.includes('-action-')||key.includes('-block-'))).toBe(false);
});
