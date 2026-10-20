import {expect, test} from 'bun:test';

test('Antelope providers and SHiP sessions keep independent native ABI contexts', async () => {
    const entry = new URL('../../build/indexer/protocol/antelope.js', import.meta.url).href;
    const worker = new URL('../../build/indexer/workers/state-reader.js', import.meta.url).href;
    const native = new URL('../../node_modules/@eosrio/node-abieos/dist/abieos.js', import.meta.url).href;
    const script = `
        import assert from 'node:assert/strict';
        import {registerHooks} from 'node:module';
        import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
        import {join} from 'node:path'; import {tmpdir} from 'node:os';
        let forbidNative = true;
        registerHooks({resolve(specifier, context, next) {
            if (forbidNative && specifier.includes('node-abieos')) throw new Error('premature-native-import');
            return next(specifier, context);
        }});
        const previous = process.cwd(); const directory = mkdtempSync(join(tmpdir(), 'hyperion-provider-'));
        try {
            mkdirSync(join(directory, 'config'));
            writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain: 'provider-test'}, indexer: {}}));
            writeFileSync(join(directory, 'config/connections.json'), '{}');
            process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
            await import(${JSON.stringify(worker)});
            const {createAntelopeProvider} = await import(${JSON.stringify(entry)});
            forbidNative = false;
            const a = await createAntelopeProvider(); const b = await createAntelopeProvider();
            const abi = wide => ({version:'eosio::abi/1.2', types:[], structs:[{name:'record',base:'',fields:[
                {name:'value',type:wide?'uint64':'uint32'}]}], actions:[{name:'record',type:'record',ricardian_contract:''}],
                tables:[], ricardian_clauses:[], error_messages:[], abi_extensions:[], variants:[]});
            const four = Uint8Array.from([7,0,0,0]); const eight = Uint8Array.from([9,0,0,0,0,0,0,0]);
            assert(a.decoder.loadAbi('sameaccount', abi(false))); assert(b.decoder.loadAbi('sameaccount', abi(true)));
            for (let attempt = 0; attempt < 3; attempt++) {
                assert.deepEqual(a.decoder.binToJson('sameaccount','record',four), {value:7});
                assert.deepEqual(b.decoder.hexToJson('sameaccount','record',Buffer.from(eight).toString('hex')), {value:'9'});
            }
            assert(a.decoder.deleteContract('sameaccount'));
            assert.deepEqual(b.decoder.binToJson('sameaccount','record',eight), {value:'9'});
            assert(a.decoder.loadAbi('sameaccount', abi(false)));
            assert.equal(a.decoder.getTypeForAction('sameaccount','record'),'record');
            try { a.decoder.loadAbi('sameaccount','{'); } catch {}
            assert.throws(()=>a.decoder.binToJson('sameaccount','record',four));
            assert.deepEqual(b.decoder.binToJson('sameaccount','record',eight),{value:'9'});
            assert(a.decoder.loadAbi('sameaccount',abi(false)));
            const handshake = wide => ({...abi(wide), structs:[{name:'signed_block',base:'',fields:[{name:'value',type:wide?'uint64':'uint32'}]}]});
            const first = a.provider.createShipSession(handshake(false));
            const second = a.provider.createShipSession(handshake(true));
            const other = b.provider.createShipSession(handshake(false));
            assert.deepEqual(first.decodeBlock(four),{value:7});
            assert.deepEqual(second.decodeBlock(eight),{value:'9'});
            assert.deepEqual(other.decodeRow('signed_block',four),{value:7});
            assert.deepEqual(first.decodeRow('signed_block',four),{value:7});
            assert.deepEqual(a.decoder.binToJson('sameaccount','record',four),{value:7});
            const {Abieos} = await import(${JSON.stringify(native)}); const baseline = Abieos.getInstance();
            const ownedContexts = baseline.getLoadedAbis().length;
            for (let i=0;i<100;i++) {
                const session = a.provider.createShipSession(handshake(false));
                session.close(); session.close();
                assert.throws(()=>session.decodeBlock(four),/closed/);
            }
            assert.equal(baseline.getLoadedAbis().length,ownedContexts,'closed SHiP sessions leaked native contexts');
            first.close();
            assert.throws(()=>first.decodeRow('signed_block',four),/closed/);
            assert.deepEqual(second.decodeBlock(eight),{value:'9'});
            baseline.loadAbi('bench',abi(false));
            const count = 2000; const start = process.hrtime.bigint();
            for (let i=0;i<count;i++) baseline.binToJson('bench','record',four);
            const middle = process.hrtime.bigint();
            for (let i=0;i<count;i++) a.decoder.binToJson('sameaccount','record',four);
            const end = process.hrtime.bigint();
            assert.equal(Number(end-middle)>0,true); assert.equal(Number(middle-start)>0,true);
            console.log(JSON.stringify({nativeImport:'lazy',providers:'isolated',sessions:'isolated',
                observation:{count,nativeNs:Number(middle-start),adapterNs:Number(end-middle),qualification:false}}));
        } finally { process.chdir(previous); rmSync(directory,{recursive:true,force:true}); }
    `;
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', '--input-type=module', '--eval', script],
        {stdout:'pipe',stderr:'pipe',timeout:15000});
    const [code, stdout, stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({code,stderr}).toEqual({code:0,stderr:''});
    const result = JSON.parse(stdout.trim());
    expect(result).toMatchObject({nativeImport:'lazy',providers:'isolated',sessions:'isolated',observation:{count:2000,qualification:false}});
},20000);
