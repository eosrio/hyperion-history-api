/** Service-free measurement of the existing projection validators; importing this module does no I/O. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants, createReadStream} from 'node:fs';
import {lstat, open, readFile, realpath} from 'node:fs/promises';
import * as nodeModule from 'node:module';
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {PerformanceObserver, performance} from 'node:perf_hooks';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';

export const limits=Object.freeze({fixtureBytes:256*1024,metadataBytes:256*1024,codeBytes:16*1024*1024,
    outputBytes:8*1024*1024,warmup:10,iterations:30,gcEntries:10000,durationMs:120000});
export const cardinalities=Object.freeze([0,1,32,64,128,256]);
const repository=fileURLToPath(new URL('../..',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value));
const cp=({blockNum,blockId})=>({blockNum,blockId});
const hex=/^[a-f0-9]{64}$/;
const portableName=/^[a-z0-9][a-z0-9.-]{0,100}\.json$/;
const deviceName=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/;

export function parseOptions(args) {
    assert.ok(Array.isArray(args)&&args.length<=12,'Bounded CLI arguments required');
    const values={};
    for(let i=0;i<args.length;i+=2) {
        const key=args[i];assert.ok(['--mode','--out','--warmup','--iterations','--order'].includes(key),'Unknown option');
        assert.ok(!Object.hasOwn(values,key)&&typeof args[i+1]==='string'&&args[i+1].length>0&&args[i+1].length<=4096,'Duplicate or missing option value');
        values[key]=args[i+1];
    }
    assert.ok(['count','timing'].includes(values['--mode']),'--mode count|timing is required');
    assert.ok(values['--out'],'--out is required');
    const mode=values['--mode'];
    if(mode==='count')assert.ok(!['--warmup','--iterations','--order'].some(key=>Object.hasOwn(values,key)),'Timing options cannot enter count capture');
    function number(key,fallback,minimum,maximum) {
        const raw=values[key]??String(fallback);assert.match(raw,/^(?:0|[1-9][0-9]*)$/,'Expected a bounded integer');
        const value=Number(raw);assert.ok(Number.isSafeInteger(value)&&value>=minimum&&value<=maximum,'Numeric option outside hard bound');return value;
    }
    const order=values['--order']??'both';assert.ok(['forward','reverse','both'].includes(order),'Invalid order');
    return {mode,out:values['--out'],warmup:number('--warmup',2,0,limits.warmup),
        iterations:number('--iterations',5,1,limits.iterations),order};
}

export function assertNativeRuntime(runtime=process) {
    assert.ok(!runtime.versions?.bun&&runtime.release?.name==='node'&&/^v(?:22|24)\./.test(runtime.version),'Execute measurements with native Node 22 or 24');
}

export function validateOutputArgument(value) {
    assert.ok(typeof value==='string'&&value.length>0&&value.length<=4096&&!value.includes('\0'),'Invalid output path');
    assert.ok(!/^[a-z]:[^/\\]/i.test(value)&&!/^[a-z]:$/i.test(value),'Drive-relative output is not allowed');
    const leaf=value.replaceAll('\\','/').split('/').at(-1);
    assert.ok(portableName.test(leaf)&&!deviceName.test(leaf),'Output filename must be portable lowercase JSON');
    return value;
}

export async function freshOutput(value) {
    validateOutputArgument(value);
    if(process.platform!=='win32')assert.ok(!/^[a-z]:/i.test(value)&&!value.includes('\\'),'Foreign Windows output path');
    const requested=resolve(value),parent=dirname(requested),parentInfo=await lstat(parent);
    assert.ok(parentInfo.isDirectory()&&!parentInfo.isSymbolicLink(),'Output parent must be an existing ordinary directory');
    const target=join(await realpath(parent),basename(requested));
    try{await lstat(target);throw new Error('Output must be fresh, including dangling links');}catch(error){if(error.code!=='ENOENT')throw error;}
    return target;
}

async function bounded(path,maximum) {
    const before=await lstat(path);assert.ok(before.isFile()&&!before.isSymbolicLink()&&before.size>0&&before.size<=maximum,'Nonordinary or oversized input');
    const bytes=await readFile(path),after=await lstat(path);
    assert.ok(bytes.length===before.size&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'Input changed during read');return bytes;
}

export function decodeMetadata(base64,origin) {
    assert.equal(origin?.schemaVersion,1);assert.equal(origin.kind,'exact-public-engineering-metadata');
    for(const entry of [origin.publicArchive,origin.originalArchive,origin.stage,origin.emissionArchive,origin.metadata])assert.match(entry?.sha256,hex);
    assert.equal(origin.metadata.encoding,'gzip+base64');
    assert.ok(Number.isSafeInteger(origin.metadata.bytes)&&origin.metadata.bytes>0&&origin.metadata.bytes<=limits.metadataBytes);
    assert.ok(Number.isSafeInteger(origin.metadata.gzipBytes)&&origin.metadata.gzipBytes>0&&origin.metadata.gzipBytes<=limits.fixtureBytes);
    assert.match(origin.metadata.gzipSha256,hex);
    const text=base64.toString('utf8').trim();assert.ok(text.length>0&&text.length<=limits.fixtureBytes);
    const compressed=Buffer.from(text,'base64');assert.equal(compressed.toString('base64'),text,'Noncanonical base64');
    assert.equal(compressed.length,origin.metadata.gzipBytes);assert.equal(hash(compressed),origin.metadata.gzipSha256);
    const bytes=gunzipSync(compressed,{maxOutputLength:limits.metadataBytes});
    assert.equal(bytes.length,origin.metadata.bytes);assert.equal(hash(bytes),origin.metadata.sha256);
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}

export function buildFixtures(original) {
    assert.equal(original.checkpoint.blockNum,288);assert.equal(original.undo.length,256);assert.equal(original.receipts.length,256);
    assert.equal(original.policy.maxBlocks,256);assert.equal(original.coverageFloor.blockNum,32);
    const receipts=new Map([original.floorReceipt,...original.receipts].map(row=>[row.blockNum,row]));
    assert.equal(receipts.size,257);let previous=original.coverageFloor;
    for(const descriptor of original.undo) {
        assert.equal(descriptor.block.blockNum,previous.blockNum+1);assert.equal(descriptor.block.previousBlockId,previous.blockId);
        const receipt=receipts.get(descriptor.block.blockNum);assert.equal(descriptor.block.blockId,receipt.blockId);assert.equal(descriptor.digest,receipt.digest);
        assert.equal(descriptor.count,0);assert.equal(descriptor.imageBytes,0);assert.equal(descriptor.imagesHash,hash(Buffer.from('[]')));previous=cp(descriptor.block);
    }
    assert.deepEqual(previous,cp(original.checkpoint));
    return cardinalities.map(descriptors=>{
        const state=structuredClone(original);state.checkpoint=cp(original.checkpoint);state.undo=descriptors?state.undo.slice(-descriptors):[];
        state.coverageFloor=descriptors?{blockNum:state.undo[0].block.blockNum-1,blockId:state.undo[0].block.previousBlockId}:cp(state.checkpoint);
        state.floorReceipt=structuredClone(receipts.get(state.coverageFloor.blockNum));assert.deepEqual(cp(state.floorReceipt),state.coverageFloor);
        return {descriptors,state};
    });
}

export function negativeInputs(fixtures,original) {
    const cases=[];
    function add(name,n,mutate,entry='state') {
        const fixture=fixtures.find(row=>row.descriptors===n),input=structuredClone(fixture[entry]);mutate(input);cases.push({name,descriptors:n,entry,input});
    }
    add('non-positive policy',0,x=>x.policy.maxBlocks=0);
    add('undo exceeds positive policy',32,x=>x.policy.maxBlocks=1);
    add('empty undo without floor advance',0,x=>{x.coverageFloor=structuredClone(original.coverageFloor);x.floorReceipt=structuredClone(original.floorReceipt);});
    add('wrong floor receipt identity',32,x=>x.floorReceipt.blockId='0'.repeat(64));
    add('matching receipt around broken floor link',32,x=>{x.coverageFloor.blockId='0'.repeat(64);x.floorReceipt.blockId='0'.repeat(64);});
    add('broken first descriptor predecessor',32,x=>x.undo[0].block.previousBlockId='0'.repeat(64));
    add('suffix does not reach checkpoint',32,x=>x.undo.pop());
    add('missing replay receipts',0,x=>x.receipts=[]);
    add('unordered replay receipts',32,x=>[x.receipts[0],x.receipts[1]]=[x.receipts[1],x.receipts[0]]);
    add('final replay receipt differs',32,x=>x.receipts.at(-1).blockId='0'.repeat(64));
    add('zero-image byte mismatch',32,x=>x.undo[0].imageBytes=1);
    add('malformed image hash',32,x=>x.undo[0].imagesHash='g'.repeat(64));
    add('stored revision fence mismatch',32,x=>x.checkpoint.revision='0'.repeat(64),'metadata');return cases;
}

/** Node's backend-anchored ESM lookup handles nested dependencies and import-only exports. */
export async function resolveBackendSdk(backendFile) {
    assert.equal(typeof nodeModule.findPackageJSON,'function','Node must provide findPackageJSON (tested on 22.23.3/24.19.0)');
    const packageFile=nodeModule.findPackageJSON('@eosrio/hyperion-sdk/projection',pathToFileURL(backendFile));
    assert.ok(packageFile,'Backend SDK package was not resolved');
    const bytes=await bounded(packageFile,64*1024),pkg=JSON.parse(bytes),target=pkg.exports?.['./projection'];
    assert.equal(pkg.name,'@eosrio/hyperion-sdk');assert.equal(pkg.type,'module');
    assert.ok(target&&typeof target.import==='string'&&Object.keys(target).every(key=>['types','import'].includes(key)),'Unsupported SDK conditional export; do not guess');
    assert.ok(target.import.startsWith('./')&&!target.import.includes('\\'),'Invalid SDK import target');
    const root=dirname(await realpath(packageFile)),file=await realpath(resolve(root,target.import)),part=relative(root,file);
    assert.ok(part&&!part.startsWith('..')&&!isAbsolute(part),'SDK import escaped its package');
    return {file,packageFile:await realpath(packageFile),packageSha256:hash(bytes),version:pkg.version,importTarget:target.import};
}

async function codeReceipt(root,path) {
    const file=await realpath(path),bytes=await bounded(file,limits.codeBytes);
    return {file,path:relative(root,file).replaceAll('\\','/'),url:pathToFileURL(file).href,bytes:bytes.length,sha256:hash(bytes)};
}

export const bsonOptions=Object.freeze({
    serialize:Object.freeze({checkKeys:false,serializeFunctions:false,ignoreUndefined:true}),
    calculateObjectSize:Object.freeze({serializeFunctions:false,ignoreUndefined:true}),
    deserialize:Object.freeze({promoteValues:true,promoteLongs:true,promoteBuffers:false,useBigInt64:false,
        bsonRegExp:false,allowObjectSmallerThanBufferSize:false,validation:Object.freeze({utf8:true})}),
});

/** Match the backend's `import { BSON } from 'mongodb'`, including a driver-nested BSON. */
export async function resolveBackendBson(root,backendFile) {
    const backendRequest=nodeModule.createRequire(pathToFileURL(backendFile));
    const mongodbFile=await realpath(backendRequest.resolve('mongodb'));
    const driverRequest=nodeModule.createRequire(pathToFileURL(mongodbFile));
    const bsonFile=await realpath(driverRequest.resolve('bson'));
    const BSON=backendRequest('mongodb').BSON;
    assert.equal(BSON,driverRequest('bson').BSON,'MongoDB BSON export differs from driver-resolved BSON');
    for(const name of ['serialize','deserialize','calculateObjectSize'])assert.equal(typeof BSON?.[name],'function','Required BSON API unavailable: '+name);
    async function dependency(name,anchor,file) {
        const packageFile=nodeModule.findPackageJSON(name,pathToFileURL(anchor));
        assert.ok(packageFile,'Actual dependency package was not resolved');
        const entry=await codeReceipt(root,file),pkgReceipt=await codeReceipt(root,packageFile);
        const packageBytes=await bounded(pkgReceipt.file,64*1024);
        assert.equal(hash(packageBytes),pkgReceipt.sha256,'Dependency package changed during receipt construction');
        const pkg=JSON.parse(packageBytes);
        assert.equal(pkg.name,name);assert.ok(typeof pkg.version==='string'&&pkg.version.length<=128);
        const part=relative(dirname(pkgReceipt.file),entry.file);
        assert.ok(part&&!part.startsWith('..')&&!isAbsolute(part),'Dependency entry escaped its package');
        return {entry,package:{...pkgReceipt,name:pkg.name,version:pkg.version}};
    }
    const mongodb=await dependency('mongodb',backendFile,mongodbFile),bson=await dependency('bson',mongodbFile,bsonFile);
    return {BSON,files:[mongodb.entry,mongodb.package,bson.entry,bson.package],
        receipt:{available:true,backendAnchor:relative(root,backendFile).replaceAll('\\','/'),
            resolution:'backend require(mongodb) -> MongoDB require(bson); mongodb.BSON export identity verified',
            mongodb,bson,options:bsonOptions,phase:'setup before either count or timing capture',
            scope:'Serialized validator input documents; excludes database commands, wire framing, compression, indexes and before images. Unspecified library options retain the pinned installed defaults.'}};
}

/** Static input bookkeeping only; callers run this before either measurement mode. */
export function bsonInputReceipt(input,BSON,backendDefaultSize) {
    const before=json(input),calculatedBytes=BSON.calculateObjectSize(input,bsonOptions.calculateObjectSize);
    assert.ok(Number.isSafeInteger(calculatedBytes)&&calculatedBytes>=5&&calculatedBytes<=limits.metadataBytes,'BSON input size outside bound');
    const bytes=BSON.serialize(input,bsonOptions.serialize);
    assert.ok(Buffer.isBuffer(bytes),'BSON serializer did not return native bytes');
    assert.equal(bytes.length,calculatedBytes,'BSON serialization differs from calculated size');
    assert.equal(bytes.readInt32LE(0),bytes.length,'BSON length prefix differs');assert.equal(bytes.at(-1),0);
    const defaultCalculatedBytes=backendDefaultSize(input);
    assert.equal(defaultCalculatedBytes,bytes.length,'Explicit BSON options differ from backend default size for this input');
    const decoded=BSON.deserialize(bytes,bsonOptions.deserialize);assert.deepEqual(decoded,input,'BSON round-trip changed input');
    assert.deepEqual(BSON.serialize(decoded,bsonOptions.serialize),bytes,'BSON round-trip changed serialized bytes');
    assert.deepEqual(json(input),before,'BSON bookkeeping mutated input');
    return {available:true,bytes:bytes.length,sha256:hash(bytes),calculatedBytes,defaultCalculatedBytes,
        roundTripInputEqual:true,roundTripBytesEqual:true};
}

export async function loadKernel(root=repository) {
    root=await realpath(root);const fixtureDirectory=join(root,'tests/fixtures/projection-validation');
    const originBytes=await bounded(join(fixtureDirectory,'origin.json'),64*1024),origin=JSON.parse(originBytes);
    const packed=await bounded(join(fixtureDirectory,'metadata.json.gz.base64'),limits.fixtureBytes),original=decodeMetadata(packed,origin);
    const backendFile=await realpath(join(root,'packages/backend-mongodb/dist/rollback-contract.js'));
    const sdkResolution=await resolveBackendSdk(backendFile);
    const code=await Promise.all([backendFile,join(root,'packages/backend-mongodb/dist/contract.js'),sdkResolution.file].map(path=>codeReceipt(root,path)));
    const backend=await import(pathToFileURL(backendFile).href),sdk=await import(pathToFileURL(sdkResolution.file).href);
    const fixtures=buildFixtures(original).map(row=>({...row,metadata:backend.storedRollbackMetadata(row.state)}));
    for(const fixture of fixtures)for(const entry of ['state','metadata']) {
        const input=fixture[entry],before=hash(json(input)),value=backend[entry==='state'?'validateRollbackState':'validateRollbackMetadata'](input,input.binding,input.policy);
        assert.deepEqual(value,fixture.state);assert.equal(hash(json(input)),before,'Validation mutated input');
    }
    assert.deepEqual(fixtures.at(-1).metadata,original);
    const negatives=negativeInputs(fixtures,original).map(row=>{
        let failure;try{backend[row.entry==='state'?'validateRollbackState':'validateRollbackMetadata'](row.input,row.input.binding,row.input.policy);}catch(error){failure=error;}
        assert.equal(failure?.code,'projection.invalid-contract',row.name+' must reject');
        return {name:row.name,descriptors:row.descriptors,entry:row.entry,inputSha256:hash(json(row.input)),code:failure.code};
    });
    const files=[];
    for(const name of ['package-lock.json','packages/backend-mongodb/package-lock.json','packages/backend-mongodb/src/contract.ts','packages/backend-mongodb/src/rollback-contract.ts']) {
        const bytes=await bounded(join(root,name),limits.codeBytes);files.push({path:name,bytes:bytes.length,sha256:hash(bytes)});
    }
    let gitHead=null;try{gitHead=execFileSync('git',['-C',root,'rev-parse','HEAD'],{timeout:5000,maxBuffer:4096,encoding:'utf8',windowsHide:true}).trim();}catch{}
    const bson=await resolveBackendBson(root,backendFile);
    const dependencies=[{name:'mongodb',...bson.receipt.mongodb.entry},{name:'bson',...bson.receipt.bson.entry}];
    const fixtureReceipts=fixtures.map(row=>({descriptors:row.descriptors,checkpoint:row.state.checkpoint,coverageFloor:row.state.coverageFloor,floorReceipt:row.state.floorReceipt,
        replayReceipts:row.state.receipts.length,policy:row.state.policy,stateSha256:hash(json(row.state)),metadataSha256:hash(json(row.metadata)),
        stateJsonBytes:json(row.state).length,metadataJsonBytes:json(row.metadata).length,
        stateBson:bsonInputReceipt(row.state,bson.BSON,backend.bsonBytes),metadataBson:bsonInputReceipt(row.metadata,bson.BSON,backend.bsonBytes)}));
    return {root,backend,sdk,fixtures,code,sdkResolution,bsonFiles:bson.files,fixtureFiles:[{file:join(fixtureDirectory,'origin.json'),sha256:hash(originBytes)},
        {file:join(fixtureDirectory,'metadata.json.gz.base64'),sha256:hash(packed)}],
        receipt:{gitHead,gitHeadAvailability:gitHead?'observed':'unavailable',origin,originArchiveVerification:'Committed origin pins retained; original archives are not reread by each harness run.',
            fixtureSha256:hash(packed),originSha256:hash(originBytes),code,files,dependencies,sdkResolution,bson:bson.receipt,
            originCodeMatches:code.map(entry=>{
                const expected=origin.code.find(row=>basename(row.path)===basename(entry.file));
                assert.ok(expected,'Measured module has no original code pin');
                return {path:entry.path,originPath:expected.path,sha256:entry.sha256,matches:entry.sha256===expected.sha256};
            }),
            validity:{positiveCases:12,negativeCases:negatives.length,negatives},
            fixtures:fixtureReceipts}};
}

export function selectCounter(scripts,selector,sources) {
    const matches=scripts.filter(row=>row.url===selector.url).flatMap(script=>
        script.functions.filter(row=>row.functionName===selector.name).map(fn=>({script,fn})));
    if(matches.length!==1)return {available:false,reason:matches.length?'ambiguous named entries':'no named entry returned',matches:matches.length};
    const {script,fn}=matches[0];assert.equal(fn.ranges.length,1,'Function-only coverage contains block ranges');const range=fn.ranges[0],source=sources.get(script.scriptId);
    assert.ok(source&&Number.isSafeInteger(range.count)&&range.count>=0&&Number.isSafeInteger(range.startOffset)&&Number.isSafeInteger(range.endOffset)&&range.startOffset>=0&&range.endOffset>=range.startOffset&&range.endOffset<=source.utf16Length,'Invalid function coverage');
    assert.equal(fn.isBlockCoverage,false);
    return {available:true,scriptId:script.scriptId,url:script.url,functionName:selector.name,sourceSha256:source.sha256,range,isBlockCoverage:false};
}

function expectCalls(capture,name,expected) {
    const metric=capture.metrics[name];
    if(expected===0&&!metric.available){assert.equal(metric.reason,'no named entry returned');return;}
    assert.equal(metric.available,true,name+' unavailable');assert.equal(metric.range.count,expected,name+' known-call calibration failed');
}

let sink=0;
function knownCounter(){sink++;}
function recursiveCounter(depth){sink++;return depth===0?1:recursiveCounter(depth-1)+1;}

export async function countKernel(context) {
    assertNativeRuntime();
    const {Session}=await import('node:inspector/promises'),session=new Session();
    const backendURL=context.code[0].url,contractURL=context.code[1].url,sdkURL=context.code[2].url;
    const selector=(url,name)=>({url,name}),selectors={known:selector(import.meta.url,'knownCounter'),recursive:selector(import.meta.url,'recursiveCounter'),
        state:selector(backendURL,'validateRollbackState'),metadata:selector(backendURL,'validateRollbackMetadata'),validateMetadata:selector(contractURL,'validateMetadata'),
        definition:selector(sdkURL,'validateProjectionDefinition'),apply:selector(sdkURL,'validateProjectionApply'),validating:selector(sdkURL,'validating'),
        snapshot:selector(sdkURL,'snapshot'),string:selector(sdkURL,'string'),freeze:selector(sdkURL,'freeze'),canonical:selector(sdkURL,'canonical'),
        encoding:selector('node:internal/encoding','encode')};
    const urls=new Set(Object.values(selectors).map(row=>row.url)),sources=new Map(),captures=[],encoder=new TextEncoder();
    knownCounter();recursiveCounter(1);encoder.encode('seed');const deadline=performance.now()+limits.durationMs;let active=false;
    session.connect();
    try {
        await session.post('Debugger.enable');await session.post('Profiler.enable');
        await session.post('Profiler.startPreciseCoverage',{callCount:true,detailed:false});active=true;
        async function capture(label,invoke,repetitions,fields={}) {
            assert.ok(performance.now()<deadline,'Count duration bound exceeded');await session.post('Profiler.takePreciseCoverage');
            for(let i=0;i<repetitions;i++)invoke();
            const raw=await session.post('Profiler.takePreciseCoverage');assert.ok(raw.result.length<=4096);
            const scripts=raw.result.filter(row=>urls.has(row.url));
            for(const script of scripts)if(!sources.has(script.scriptId)) {
                const {scriptSource}=await session.post('Debugger.getScriptSource',{scriptId:script.scriptId});assert.ok(Buffer.byteLength(scriptSource)<=limits.codeBytes);
                const sha256=hash(Buffer.from(scriptSource)),expected=context.code.find(row=>row.url===script.url);
                if(expected)assert.equal(sha256,expected.sha256,'Actual V8 source differs from resolved module');
                sources.set(script.scriptId,{scriptId:script.scriptId,url:script.url,sha256,utf16Length:scriptSource.length});
            }
            const metrics=Object.fromEntries(Object.entries(selectors).map(([name,selector])=>[name,selectCounter(scripts,selector,sources)]));
            const row={label,repetitions,...fields,metrics,scripts,nativeEncodeUtf8StringNamedEntries:raw.result.reduce((sum,script)=>sum+script.functions.filter(fn=>fn.functionName==='encodeUtf8String').length,0)};
            captures.push(row);return row;
        }
        for(const n of [0,1,3,0])expectCalls(await capture('known-'+captures.length,knownCounter,n),'known',n);
        for(const n of [1,3])expectCalls(await capture('recursive-'+n,()=>recursiveCounter(4),n),'recursive',5*n);
        const encoding=[];
        for(const n of [0,1,3])encoding.push(await capture('encoding-'+n,()=>encoder.encode('bounded calibration'),n));
        const encodingCalibrated=encoding.every(row=>row.repetitions===0?
            row.metrics.encoding.available?row.metrics.encoding.range.count===0:row.metrics.encoding.reason==='no named entry returned':
            row.metrics.encoding.available&&row.metrics.encoding.range.count===row.repetitions);
        for(const fixture of context.fixtures)for(const entry of ['state','metadata'])for(const repetitions of [1,3]) {
            const input=fixture[entry],before=hash(json(input));
            const row=await capture('valid-'+fixture.descriptors+'-'+entry+'-'+repetitions,
                ()=>context.backend[entry==='state'?'validateRollbackState':'validateRollbackMetadata'](input,input.binding,input.policy),repetitions,
                {phase:'valid-count-only',descriptors:fixture.descriptors,entry,inputSha256:before});
            expectCalls(row,'state',repetitions);expectCalls(row,'metadata',entry==='metadata'?repetitions:0);
            assert.equal(hash(json(input)),before,'Validation mutated input');
        }
        assert.ok([...sources.values()].some(row=>row.url===sdkURL),'Resolved backend SDK source was not observed');
        await session.post('Profiler.stopPreciseCoverage');active=false;
        return {parameters:{callCount:true,detailed:false},knownCalls:[0,1,3,0],recursionEntriesPerCall:5,calibrated:true,encodingCalibrated,
            sources:[...sources.values()],captures,nativeEncodingCounter:'No native call count inferred from JS wrappers or absent named entries.',
            missingCounterConvention:'Missing entries remain absent. Known zero-call windows may omit a function; unknown absence is never coerced to zero.',
            countsAreNotCpuOrTiming:true};
    } finally {
        if(active)await session.post('Profiler.stopPreciseCoverage').catch(()=>{});
        await session.post('Profiler.disable').catch(()=>{});await session.post('Debugger.disable').catch(()=>{});session.disconnect();
    }
}

export function callOrder(order) {
    assert.ok(['forward','reverse','both'].includes(order));
    return (order==='both'?['forward','reverse']:[order]).map(direction=>({direction,cardinalities:direction==='forward'?[...cardinalities]:[...cardinalities].reverse()}));
}

export function gcOverlap(entries,start,end) {
    assert.ok(Number.isFinite(start)&&Number.isFinite(end)&&end>=start);
    assert.ok(Array.isArray(entries)&&entries.length<=limits.gcEntries);
    for(const row of entries)assert.ok(Number.isFinite(row.startTime)&&Number.isFinite(row.duration)&&row.startTime>=0&&row.duration>=0,'Invalid observed GC interval');
    const overlaps=entries.filter(row=>row.startTime<end&&row.startTime+row.duration>start);
    const intervals=overlaps.map(row=>[Math.max(start,row.startTime),Math.min(end,row.startTime+row.duration)]).sort((a,b)=>a[0]-b[0]);
    let overlapMs=0,right=start;
    for(const [left,end] of intervals){overlapMs+=Math.max(0,end-Math.max(left,right));right=Math.max(right,end);}
    return {events:overlaps.length,overlapMs};
}

export async function timeKernel(context,options) {
    assertNativeRuntime();assert.ok(Number.isSafeInteger(options.warmup)&&options.warmup>=0&&options.warmup<=limits.warmup);
    assert.ok(Number.isSafeInteger(options.iterations)&&options.iterations>=1&&options.iterations<=limits.iterations);
    const passes=callOrder(options.order),entries=[],rows=[];let overflow=false,observer;
    const gcSupported=PerformanceObserver.supportedEntryTypes.includes('gc');
    if(gcSupported) {
        observer=new PerformanceObserver(list=>{for(const entry of list.getEntries()) {
            if(entries.length>=limits.gcEntries){overflow=true;continue;}
            entries.push({startTime:entry.startTime,duration:entry.duration,kind:entry.detail?.kind??null,flags:entry.detail?.flags??null});
        }});observer.observe({entryTypes:['gc']});
    }
    const started=performance.now(),deadline=started+limits.durationMs,cpuBefore=process.cpuUsage();
    try {
        for(const pass of passes)for(const n of pass.cardinalities)for(const entry of ['state','metadata']) {
            const fixture=context.fixtures.find(row=>row.descriptors===n),input=fixture[entry],before=hash(json(input));
            const invoke=()=>context.backend[entry==='state'?'validateRollbackState':'validateRollbackMetadata'](input,input.binding,input.policy);
            for(let i=0;i<options.warmup;i++){assert.ok(performance.now()<deadline,'Timing duration bound exceeded');invoke();}
            for(let i=0;i<options.iterations;i++) {
                assert.ok(performance.now()<deadline,'Timing duration bound exceeded');
                const rssBefore=process.memoryUsage.rss(),cpu=process.cpuUsage(),start=performance.now();invoke();const end=performance.now();
                const delta=process.cpuUsage(cpu),rssAfter=process.memoryUsage.rss();
                rows.push({direction:pass.direction,descriptors:n,entry,iteration:i,startMs:start,endMs:end,elapsedMs:end-start,
                    processCpuMicros:{user:delta.user,system:delta.system,total:delta.user+delta.system},rssBytes:{before:rssBefore,after:rssAfter}});
            }
            assert.equal(hash(json(input)),before,'Validation mutated input');
        }
        await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
        if(observer)for(const entry of observer.takeRecords()) {
            if(entries.length>=limits.gcEntries){overflow=true;break;}
            entries.push({startTime:entry.startTime,duration:entry.duration,kind:entry.detail?.kind??null,flags:entry.detail?.flags??null});
        }
        assert.equal(overflow,false,'GC entry bound exceeded');const cpu=process.cpuUsage(cpuBefore);
        for(const row of rows)row.gc=gcSupported?{available:true,...gcOverlap(entries,row.startMs,row.endMs)}:{available:false,reason:'GC observer unsupported'};
        return {warmupPerStateAndEntryPerPass:options.warmup,iterations:options.iterations,order:options.order,rows,
            gc:{available:gcSupported,entries:gcSupported?entries:null,convention:'Observed GC intervals overlapping a call are clipped and unioned within its clock span; absence of observed events is not a proof of no GC.'},
            envelope:{elapsedMs:performance.now()-started,processCpuMicros:{user:cpu.user,system:cpu.system,total:cpu.user+cpu.system},
                scope:'Includes warmups, measurements, checks, clocks/counters and observer drain. Do not equate with summed kernel spans.'},
            processLifetimeMaxRSSKiB:process.resourceUsage().maxRSS,
            preciseCoverageRequested:false,perCallCpuScope:'Process counter envelope includes clocks/counter overhead and any native/helper-thread work; it is separate from elapsed call spans. Counter resolution can yield zero deltas for short calls.',
            rssScope:'Discrete before/after samples; maxRSS is a distinct process-lifetime high-water counter.',
            unavailable:{allocations:'No allocation profiler',nativeEncodingBytes:'No native encoding byte counter',nativeEncodingCalls:'No native call counter',eventLoopDelay:'No event-loop histogram',actualWorkerFrequency:'Service-free kernel only'}};
    } finally {observer?.disconnect();}
}

async function fileHash(path) {
    const value=createHash('sha256');for await(const chunk of createReadStream(path))value.update(chunk);return value.digest('hex');
}

export async function writeFreshReport(path,report) {
    const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');assert.ok(bytes.length<=limits.outputBytes,'Report byte bound exceeded');
    const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0));
    try{await handle.writeFile(bytes);}finally{await handle.close();}return {bytes:bytes.length,sha256:hash(bytes)};
}

export async function main(args=process.argv.slice(2)) {
    const options=parseOptions(args);assertNativeRuntime();
    assert.ok(!process.env.NODE_V8_COVERAGE,'Ambient V8 coverage must be disabled');
    const instrumentation=/(?:--(?:cpu-prof|heap-prof|prof(?:\b|-)|inspect|require|import|(?:experimental-)?loader|trace-|experimental-test-coverage)|(?:^|\s)-r(?:\s|=|$))/;
    assert.ok(!process.execArgv.some(arg=>instrumentation.test(arg))&&!instrumentation.test(process.env.NODE_OPTIONS??''),'Run a fresh process without ambient profiler/preload flags');
    const output=await freshOutput(options.out),context=await loadKernel();
    const runtime={version:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,executable:process.execPath,
        binarySha256:await fileHash(process.execPath),execArgv:process.execArgv,nodeOptionsPresent:Boolean(process.env.NODE_OPTIONS)};
    const measured=options.mode==='count'?await countKernel(context):await timeKernel(context,options);
    for(const entry of [...context.code,...context.fixtureFiles,...context.bsonFiles])assert.equal(hash(await bounded(entry.file,limits.codeBytes)),entry.sha256,'Measured code/fixture/dependency changed');
    const report={schemaVersion:1,status:'measured',issue:252,mode:options.mode,limits,runtime,
        harnessSha256:hash(await bounded(fileURLToPath(import.meta.url),limits.codeBytes)),provenance:context.receipt,
        measured,limitations:['Engineering empty-row metadata at fixed checkpoint/replay-receipt count; no full recovery, consensus or busy-chain qualification.',
            'Counts and timing are separate modes and processes. Precise coverage changes optimization behavior; count captures are not timing observations.',
            'Timing includes observation overhead and heap/order history; forward/reverse passes are not independent repetitions or quantified profiler overhead.',
            'No optimization, cache, runtime ranking or performance benefit is selected by this harness.']};
    return {status:'measured',mode:options.mode,output:await writeFreshReport(output,report)};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
    main().then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{
        process.stderr.write(JSON.stringify({status:'failed',error:String(error?.stack??error).slice(0,4096)})+'\n');process.exitCode=1;
    });
}
