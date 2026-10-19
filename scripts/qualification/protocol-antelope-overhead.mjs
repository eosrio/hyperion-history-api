import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {cpus,release} from 'node:os';
import {resolve} from 'node:path';
import {Abieos} from '@eosrio/node-abieos';
import {createAntelopeProvider} from '../../build/indexer/protocol/antelope.js';

if(process.versions.node.split('.')[0]!=='24')throw new Error('This observation requires the Node 24 control runtime');
const output=process.argv[2];
if(process.argv.length>3)throw new Error('Usage: node protocol-antelope-overhead.mjs [output.json]');
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourcePaths=['scripts/qualification/protocol-antelope-overhead.mjs','src/indexer/protocol/antelope.ts',
    'src/indexer/protocol/contract-cache.ts','build/indexer/protocol/antelope.js','build/indexer/protocol/contract-cache.js',
    'package.json','package-lock.json','node_modules/@eosrio/node-abieos/dist/abieos.js'];
const sourceFiles=sourcePaths.map(path=>({path,sha256:sha256(readFileSync(resolve(root,path)))}));
const addonRequire=createRequire(import.meta.resolve('@eosrio/node-abieos'));
const nativeBinaries=Object.keys(addonRequire.cache).filter(path=>path.endsWith('.node'))
    .map(path=>({name:path.split(/[\\/]/).at(-1),sha256:sha256(readFileSync(path))}));
const direct=Abieos.getInstance();
const {decoder}=await createAntelopeProvider();
const abi={version:'eosio::abi/1.2',types:[],structs:[{name:'record',base:'',fields:[
    {name:'sequence',type:'uint64'},{name:'owner',type:'name'},{name:'quantity',type:'asset'},{name:'memo',type:'string'}]}],
    actions:[{name:'record',type:'record',ricardian_contract:''}],tables:[],variants:[]};
const expected={sequence:'18446744073709551600',owner:'alice',quantity:'1.0000 SYS',memo:'bounded ABI-correct native-adapter fixture'};
const contract='h45profile';
assert(direct.loadAbi(contract,abi));assert(decoder.loadAbi(contract,abi));
const bytes=Buffer.from(direct.jsonToHex(contract,'record',expected),'hex');
const operations={direct:()=>direct.binToJson(contract,'record',bytes),alias:()=>decoder.binToJson(contract,'record',bytes)};
const validate=()=>{assert.deepEqual(operations.direct(),expected);assert.deepEqual(operations.alias(),expected);};
const warmup=5000,iterations=20000;
const trials=[];
try {
    validate();
    for(let index=0;index<warmup;index++){operations.direct();operations.alias();}
    for(let pair=0;pair<5;pair++) {
        for(const mode of pair%2===0?['direct','alias']:['alias','direct']) {
            validate();let observed=0;const memoryBefore=process.memoryUsage();const cpuBefore=process.cpuUsage();
            const start=process.hrtime.bigint();
            for(let index=0;index<iterations;index++){const value=operations[mode]();observed+=value.memo.length+value.sequence.length;}
            const elapsedNs=Number(process.hrtime.bigint()-start);
            const cpuMicros=process.cpuUsage(cpuBefore);const memoryAfter=process.memoryUsage();
            assert.equal(observed,iterations*(expected.memo.length+expected.sequence.length));validate();
            trials.push({pair,mode,iterations,elapsedNs,nsPerDecode:elapsedNs/iterations,cpuMicros,memoryBefore,memoryAfter});
        }
    }
    const manifest=JSON.parse(readFileSync(fileURLToPath(new URL('../../node_modules/@eosrio/node-abieos/package.json',import.meta.url))));
    const report={schemaVersion:1,createdAt:new Date().toISOString(),kind:'local-native-adapter-observation',qualification:false,
        runtime:{node:process.versions.node,v8:process.versions.v8,platform:process.platform,arch:process.arch,
            osRelease:release(),cpuModel:cpus()[0]?.model,logicalCpuCount:cpus().length,
            executableSha256:sha256(readFileSync(process.execPath))},
        source:{head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
            trackedDiffSha256:sha256(execFileSync('git',['diff','--binary','HEAD'],{cwd:root})),files:sourceFiles},
        dependency:{name:manifest.name,version:manifest.version,nativeBinaries},fixture:{abi,expected,hex:bytes.toString('hex'),
            sha256:createHash('sha256').update(bytes).digest('hex')},warmup,iterations,trials,
        limits:['One bounded fixture on a shared workstation; CPU usage deltas and memory snapshots are observations, not sampled CPU or allocation profiles.',
            'Alternating warmed trials observe native decoding plus JSON parsing and the private alias lookup.',
            'Host scheduling, process noise and JIT variation remain uncontrolled; no throughput or runtime qualification claim.']};
    const text=JSON.stringify(report,null,2)+'\n';
    if(output)writeFileSync(output,text);else process.stdout.write(text);
} finally {decoder.deleteContract(contract);direct.deleteContract(contract);}
