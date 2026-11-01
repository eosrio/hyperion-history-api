import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {indexedEngineeringFacadeV1} from './stateful-indexed-engineering-internal.js';
import type {MongoDbStatefulIndexedAdapterV1} from './stateful-indexed-v1.js';
import {requireState} from './stateful-contract.js';

export const MONGODB_INDEXED_ENGINEERING_PROFILE_V1='indexed-schema-sdk49-native2bf-engineering-v1' as const;
const sdkPin='git+https://github.com/eosrio/hyperion-sdk.git#dc20a03f2b60ba05a3369d677222a9cf0d65d299';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function inventory(root:string) {
    const files:{path:string;bytes:number;sha256:string}[]=[];let total=0;
    const visit=(directory:string)=>{for(const name of readdirSync(directory).sort()){
        const path=join(directory,name),stat=lstatSync(path);requireState(!stat.isSymbolicLink(),'Engineering assembly refuses symlinks');
        if(stat.isDirectory())visit(path);else{requireState(stat.isFile()&&files.length<1024&&(total+=stat.size)<=64*1024*1024,'Engineering assembly file bound');
            const bytes=readFileSync(path);requireState(bytes.length===stat.size,'Engineering assembly changed while reading');
            files.push({path:relative(root,path).replaceAll('\\','/'),bytes:bytes.length,sha256:sha(bytes)});
        }
    }};visit(root);return files;
}
/** Explicit source/SDK/driver/emission-pinned engineering opt-in only. No production default or SQL equivalence. */
export function selectMongoDbIndexedEngineeringAssemblyV1(adapter:MongoDbStatefulIndexedAdapterV1,
    profile:typeof MONGODB_INDEXED_ENGINEERING_PROFILE_V1):MongoDbStatefulIndexedAdapterV1 {
    requireState(profile===MONGODB_INDEXED_ENGINEERING_PROFILE_V1,'Explicit indexed engineering assembly required');
    const root=fileURLToPath(new URL('../',import.meta.url)),manifest=JSON.parse(readFileSync(join(root,'INDEXED-ENGINEERING.json'),'utf8'));
    requireState(manifest.schemaVersion===1&&manifest.profile===profile&&manifest.qualificationOnly===true
        &&manifest.sourceBase==='2bf8afdc073c12f750441008513abd5f4b3140d2'
        &&manifest.sdkRevision==='dc20a03f2b60ba05a3369d677222a9cf0d65d299'
        &&manifest.nativeMongoDB==='pending'&&manifest.AtomicSQL==='pending'&&manifest.managedHTTP==='pending','Indexed engineering assembly declaration differs');
    const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
    requireState(pkg.devDependencies['@eosrio/hyperion-sdk']===sdkPin&&pkg.dependencies.mongodb==='7.2.0','Indexed engineering source pins differ');
    requireState(JSON.stringify(inventory(join(root,'dist')))===JSON.stringify(manifest.nativeDist),'Indexed engineering native emissions differ');
    const sdkRoot=dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-sdk'))));
    requireState(JSON.stringify(inventory(join(sdkRoot,'dist')))===JSON.stringify(manifest.sdkDist),'Indexed engineering SDK emissions differ');
    return indexedEngineeringFacadeV1(adapter);
}
