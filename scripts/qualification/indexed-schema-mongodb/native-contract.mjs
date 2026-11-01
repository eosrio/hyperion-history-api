// Pure fixture contracts and literal oracles. No client, controller, timer or process lifecycle.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const sha=value=>createHash('sha256').update(value).digest('hex');
export const hex=n=>n.toString(16).padStart(64,'0');
export const plain=value=>JSON.parse(JSON.stringify(value));
export const PLAN=freeze({schemaVersion:1,scope:'synthetic-native-indexed-schema',
 profile:'indexed-schema-mongodb-sdk49-2da-linux-gha-v1',assembly:'indexed-schema-sdk49-native2bf-engineering-v1',
 product:'28f31a21e817a1ada684c4bb3b843c70e2580b17',base:'2da0d8fa44b447134261128d75d3ada100e9a59b',
 sdk:'dc20a03f2b60ba05a3369d677222a9cf0d65d299',driver:'7.2.0',server:'8.0.34',comparison:'mongodb-simple-utf8-v1',
 operationMS:5000,transactionMS:15000,traceEvents:16384,evidenceBytes:32*1024*1024,runtimeVersions:['v24.22.1','v26.4.0'],
 fixture:{server:'8.0.34',image:'docker.io/library/mongo@sha256:4c7d0fb8fde0681e2ae443b0b09371ec9c31a81caab05af9579458bfcb30d656',nanoCPUs:2000000000,memoryBytes:1073741824,childDeadlineMS:300000,graceMS:10000,terminalMS:10000},
 limits:{readAttempts:12,responseRecords:8,responseBytes:65536,queryBytes:8192,predicates:12,orderTerms:8,setValues:16},
 cases:['default-profile-and-genuine-binding','genesis-index-and-coverage','typed-transactional-materialization',
 'page-count-and-model-dispatch','windows-order-and-int64','sealed-explain','update-delete-and-canonical-fork',
 'reopen-and-generation-refusal','cumulative-and-receiving-budgets','native-failure-deadline-and-cleanup','owner-source-and-publication-fences'],
 acceptance:{nativeMongoDB:'pending-until-run',AtomicSQL:'pending',managedHTTP:'pending',WireAuthority:'none',productionOffers:'empty'}});
export function failure(error,depth=0){return {name:String(error?.name??'Error').slice(0,64),code:error?.code??null,
 message:String(error?.message??error).slice(0,512),...(depth<2&&error?.cause?{cause:failure(error.cause,depth+1)}:{})};}
export function argumentsFor(argv,environment){
 if(argv.length===1&&argv[0]==='--validate-plan')return null;
 assert.equal(argv.length,12);assert.deepEqual(argv.filter((_,i)=>i%2===0),['--profile','--run','--database','--output','--source','--assembly-sha256']);
 assert.equal(argv[1],PLAN.profile);assert.equal(argv[3],'--allow-failpoints');assert.match(argv[5],/^h45_indexed_[a-f0-9]{12}$/);
 assert.ok(argv[7]);assert.match(argv[9],/^[a-f0-9]{40}$/);assert.match(argv[11],/^[a-f0-9]{64}$/);
 const uri=environment.HYPERION_INDEXED_MONGO_URI,parsed=new URL(uri);assert.equal(parsed.protocol,'mongodb:');assert.equal(parsed.hostname,'127.0.0.1');
 assert.equal(parsed.username+parsed.password+parsed.hash,'');assert.ok(parsed.pathname===''||parsed.pathname==='/');
 assert.ok(Number.isInteger(Number(parsed.port))&&Number(parsed.port)>=1024&&Number(parsed.port)<=65535&&parsed.port!=='27017');
 assert.deepEqual([...parsed.searchParams.keys()].sort(),['directConnection','replicaSet']);assert.equal(parsed.searchParams.get('directConnection'),'true');
 const replicaSet=parsed.searchParams.get('replicaSet');assert.match(replicaSet,/^h45rs_[a-f0-9]{32}$/);
 return {uri,database:argv[5],output:argv[7],source:argv[9],assemblySha256:argv[11],replicaSet,member:'hyp-projection-'+replicaSet.slice(6)+'-replica:27017'};
}
export async function dispatchCases(handlers,runCase){
 assert.deepEqual(Object.keys(handlers),PLAN.cases,'Every declared native case must have one concrete handler in order');
 for(const name of PLAN.cases){assert.equal(typeof handlers[name],'function');await runCase(name,handlers[name]);}
}
export function assertNativeCompletion(terminal,report,assemblySha256){
 assert.deepEqual(terminal,{code:0,signal:null,timedOut:false,terminal:true,streamsClosed:true});
 assert.equal(report.status,'passed-native-indexed-only');assert.equal(report.plan.profile,PLAN.profile);assert.equal(report.source.observationSha256,assemblySha256);
 assert.deepEqual(report.cases.map(row=>row.name),PLAN.cases);assert(report.cases.every(row=>row.status==='pass'));
 assert.equal(report.server.version,PLAN.server);assert(Number.isSafeInteger(report.traceEvents)&&report.traceEvents>0&&report.traceEvents<=PLAN.traceEvents);
 assert(Array.isArray(report.successfulQueryAttestations)&&report.successfulQueryAttestations.length>0);
 assert.equal(report.cases.reduce((sum,row)=>sum+row.successfulQueries,0),report.successfulQueryAttestations.length);
 for(const row of report.cases)if(![PLAN.cases[0],PLAN.cases[9]].includes(row.name))assert(Number.isSafeInteger(row.successfulQueries)&&row.successfulQueries>0,'Missing independently attested successful case query');
 for(const name of ['managedClientsClosed','sessionsEnded','readsClosed','cursorsClosed','failpointDisabled','databaseDropped','adminClosed'])assert.equal(report.cleanup[name],true,name);
 assert.equal(report.acceptance.AtomicSQL,'pending');assert.equal(report.acceptance.managedHTTP,'pending');assert.equal(report.acceptance.productionOffers,'empty');
}
export function projectionDefinition(stateful,database,generation='fresh-indexed-generation'){
 return {family:stateful.STATEFUL_FAMILY,interfaceVersion:1,id:'native-indexed-qualification',
 binding:{chainId:hex(10),backendId:database,generation,mappingRevision:hex(11),hookArtifact:sha(JSON.stringify(PLAN)),hookRevision:hex(13),codecRevision:hex(14),normalizerRevision:hex(15)},
 selectors:[{id:'synthetic',kind:'action',contract:'fixture',name:'change',abiDeployment:'synthetic-no-chain-authority',abiSha256:hex(16)}],
 records:[{kind:'schema',integers:[{path:['created_at_time'],type:'int64',vector:false}]},{kind:'collection',integers:[]},
 {kind:'schema-asset-count',integers:[{path:['assets'],type:'int64',vector:false}]}]};
}
export function projectionLimits(){return {value:{depth:16,nodes:256,fields:32,arrayElements:32,stringBytes:1024,recordBytes:4096,integerFields:4,pathSegments:8},
 envelope:{depth:32,nodes:8192,fields:64,arrayElements:128,stringBytes:65536,recordBytes:262144,integerFields:4,pathSegments:8},
 selectors:1,recordKinds:3,inputOccurrences:0,inputBytes:0,keyBytes:128,readKeys:32,readAttempts:64,mutations:32,candidateBytes:262144,responseRecords:32,responseBytes:262144};}
export function schemaModel(control=false){return {id:control?'schema-base-control':'schema-joined',base:{alias:'schema',kind:'schema'},
 joins:control?[]:[{alias:'collection',kind:'collection',mode:'inner-one',on:[{basePath:['contract'],joinedPath:['contract']},{basePath:['collection_name'],joinedPath:['collection_name']}]},
 {alias:'assets',kind:'schema-asset-count',mode:'left-one',on:[{basePath:['contract'],joinedPath:['contract']},{basePath:['collection_name'],joinedPath:['collection_name']},{basePath:['schema_name'],joinedPath:['schema_name']}]}],
 fields:[{id:'contract',alias:'schema',path:['contract'],type:'text',nullable:false,operators:['eq']},
 {id:'collection',alias:'schema',path:['collection_name'],type:'text',nullable:false,operators:['eq','in','not-in']},
 {id:'schema',alias:'schema',path:['schema_name'],type:'text',nullable:false,operators:['eq','in','not-in']},
 {id:'created',alias:'schema',path:['created_at_time'],type:'int64',nullable:false,operators:['eq','gte','gt','lt']},
 ...(control?[]:[{id:'authorized',alias:'collection',path:['authorized_accounts'],type:'text-vector',nullable:false,operators:[]},
 {id:'assets',alias:'assets',path:['assets'],type:'int64',nullable:true,operators:[]}])],textComparison:PLAN.comparison,
 orders:[[{field:'created',direction:'desc',nulls:'last'}],[{field:'schema',direction:'asc',nulls:'last'}]]};}
export const page=(changes={},control=false)=>({kind:'page',where:[{field:'contract',op:'eq',value:'atomicassets'}],order:schemaModel(control).orders[0],offset:'0',limit:2,
 select:control?['schema','created']:['schema','created','authorized','assets'],records:control?['schema']:['schema','collection','assets'],...changes});
export const count=(changes={})=>({kind:'count',exact:true,where:[{field:'contract',op:'eq',value:'atomicassets'}],...changes});
export function corpus(){
 const rows=[];for(const name of ['one','two'])rows.push({kind:'collection',key:'c:'+name,value:{contract:'atomicassets',collection_name:name,authorized_accounts:['alice','雪'],data:{name:'雪\n"\\'}}});
 for(const [key,collection,name,created,contract]of [['s:a','one','Alpha','9007199254740993','atomicassets'],['s:b','one','beta','9007199254740994','atomicassets'],
 ['s:c','two','alpha','9007199254740994','atomicassets'],['s:d','one','é','9007199254740995','atomicassets'],['s:e','one','雪','9007199254740992','atomicassets'],
 ['s:f','one','a"\\\n','9007199254740991','atomicassets'],['s:orphan','missing','orphan','9007199254740996','atomicassets'],['s:foreign','one','foreign','9007199254740997','foreign']])
 rows.push({kind:'schema',key,value:{contract,collection_name:collection,schema_name:name,created_at_time:created,format:[{name:'author',type:'string'}]}});
 for(const [key,schema,assets]of [['a:a','Alpha','0'],['a:b','beta','2'],['a:d','é','9007199254740993']])rows.push({kind:'schema-asset-count',key,value:{contract:'atomicassets',collection_name:'one',schema_name:schema,assets}});
 rows.push({kind:'collection',key:'c:foreign',value:{contract:'foreign',collection_name:'missing',authorized_accounts:['foreign'],data:{name:'foreign'}}},
  {kind:'schema-asset-count',key:'a:wrong-collection',value:{contract:'atomicassets',collection_name:'one',schema_name:'alpha',assets:'88'}},
  {kind:'schema-asset-count',key:'a:wrong-contract',value:{contract:'foreign',collection_name:'two',schema_name:'alpha',assets:'77'}});
 return rows;
}
export const ORACLE=freeze({joinedCount:'6',controlCount:'7',schemaAscending:['s:a','s:f','s:c','s:b','s:d','s:e'],
 createdGroups:[['s:d'],['s:b','s:c'],['s:a'],['s:e'],['s:f']],firstJoined:'s:d',firstControl:'s:orphan'});
export function assertCreatedPeers(rows){let position=0;for(const peers of ORACLE.createdGroups){assert.deepEqual(new Set(rows.slice(position,position+peers.length).map(row=>row.key)),new Set(peers));position+=peers.length;}assert.equal(rows.length,position);}
