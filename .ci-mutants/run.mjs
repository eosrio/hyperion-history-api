// Throwaway CI runner. Control must pass, then each mutant must be caught by a failing test.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
const P='src/indexer/protocol/';
const fast=[['node',['--test','tests/unit/protocol-store-request-rules.test.mjs','tests/unit/protocol-abi-round-trips.test.mjs','tests/unit/protocol-abi-history-progress.test.mjs','tests/native/protocol-index-metadata.test.mjs']],
    ['bun',['test','tests/unit/protocol-abi-coordinator.test.ts','tests/unit/protocol-abi-frontier-store.test.ts','tests/unit/protocol-abi-observation-store.test.ts']]];
const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:512*1024*1024});return {ok:r.status===0,out:(r.stdout??'')+(r.stderr??'')};};
const build=()=>{const r=run('npm',['run','build']);if(!r.ok)return r;return {ok:true};};
const failures=out=>[...new Set(out.split('\n').filter(line=>/^\s*(✖|\(fail\)|not ok)/.test(line)&&!/failing tests/.test(line)).map(line=>line.trim().replace(/\s*\[?\(?[0-9.]+ ?ms\)?\]?$/,'').slice(0,110)))];

import {mutants} from './list.mjs';

const report={control:{},mutants:[]};
if(!build().ok)throw new Error('Control build failed');
const native=readFileSync('.ci-mutants/native-tests.txt','utf8').split('\n').filter(Boolean);
for(const [name,cmd,args] of [['unit','bun',['test','./tests/unit']],['native','node',['--test','--test-concurrency=1',...native]],...fast.map(([c,a],i)=>['fast'+i,c,a])]) {
    const r=run(cmd,args);report.control[name]={ok:r.ok,failures:failures(r.out).slice(0,40)};
    console.log('CONTROL',name,r.ok?'pass':'FAIL',JSON.stringify(report.control[name].failures));
    writeFileSync('control-'+name+'.log',r.out);
}
if(!report.control.fast0.ok||!report.control.fast1.ok)console.log('CONTROL fast set is not green: mutant results below are not meaningful');
for(const [name,file,from,to] of mutants) {
    const original=readFileSync(file,'utf8');
    if(original.split(from).length!==2){report.mutants.push({name,result:'NOT APPLIED'});console.log('MUTANT',name,'NOT APPLIED');continue;}
    writeFileSync(file,original.replace(from,()=>to));
    let result;
    const built=build();
    if(!built.ok)result={name,result:'build-failed',detail:built.out.slice(-400)};
    else {
        const caught=[];
        for(const [cmd,args] of fast){const r=run(cmd,args);if(!r.ok)caught.push(...failures(r.out));}
        result={name,result:caught.length?'caught':'SURVIVED',by:caught.slice(0,3)};
    }
    writeFileSync(file,original);report.mutants.push(result);
    console.log('MUTANT',JSON.stringify(result));
}
build();
writeFileSync('mutants.json',JSON.stringify(report,null,2));
const bad=report.mutants.filter(m=>m.result!=='caught');
console.log('SUMMARY',report.mutants.length-bad.length,'of',report.mutants.length,'caught',JSON.stringify(bad.map(m=>m.name+': '+m.result)));
