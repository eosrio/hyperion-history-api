"""Read-only verification of frozen native kernel evidence; writes only beside this file."""
from pathlib import Path
import base64
import collections
import copy
import gzip
import hashlib
import json
import math
import re
import struct

import tarfile

import sys
sys.dont_write_bytecode = True
from common import archive_files, bounded_file, parsed, require, safe_name, sha, verifier_arguments
PACKAGE_ROOT, HERE = verifier_arguments('Independently verify four frozen native kernel reports; no services or validators')
INPUT = PACKAGE_ROOT/'kernel'
ROOT = PACKAGE_ROOT/'receipts'
EMISSION = archive_files(PACKAGE_ROOT/'retained-emission.tar.gz')
WITNESSES = parsed(bounded_file(PACKAGE_ROOT/'source-witnesses/receipt.json'))
require({row['path'] for row in WITNESSES['files']}=={'packages/backend-mongodb/src/contract.ts','packages/backend-mongodb/src/rollback-contract.ts'},'Unexpected source witness paths')
SOURCE = {row['path']:bounded_file(PACKAGE_ROOT/'source-witnesses'/safe_name(row['path'])) for row in WITNESSES['files']}
for row in WITNESSES['files']:
    require(len(SOURCE[row['path']])==row['bytes'] and sha(SOURCE[row['path']])==row['sha256'],'Source witness differs')
HEAD = 'd95d797fc3de8c695e2817a2952eedebeb4b3241'
CARDINALITIES = [0,1,32,64,128,256]
EXPECTED = {
 'node22-count.json':'d513341457a858ca4025a5e0cefaab330a6f7190d54e1627d90516525dbe185a',
 'node22-timing.json':'4308b3f23ca731ebf5e5f60b76b6f3928ac4a68f1d56bded0106b48675978fa7',
 'node24-count.json':'462d0688c3924dc0e8c1d0c2b9dab51e90bd18b5e939282fa5e43ace9de8bd87',
 'node24-timing.json':'4fea13b786db6f7ab5f4d364a425eef5cc1e69f95ec0b323539533f9b5668ba6',
}
assert PACKAGE_ROOT.is_dir()

def sha(data):
    return hashlib.sha256(data).hexdigest()

def jsjson(value):
    return json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode('utf-8')

def encoded(value):
    return (json.dumps(value,sort_keys=True,indent=2,ensure_ascii=True,allow_nan=False)+'\n').encode('ascii')

def load(path):
    return parsed(bounded_file(path))

def git_bytes(name):
    return EMISSION[name] if name in EMISSION else SOURCE[name]

def member_bytes(archive,name):
    member=archive.getmember(name)
    assert member.isfile() and member.size<16*1024**2
    data=archive.extractfile(member).read()
    assert len(data)==member.size
    return data

# Independent BSON encoder/decoder for these documents' ordinary JSON value subset.
# No BSON/native package or validator implementation is imported by this audit.
def bson_document(value,array=False):
    rows=enumerate(value) if array else value.items()
    pieces=[]
    for key,item in rows:
        key=str(key).encode('utf-8')+b'\0'
        if item is None: tag,body=0x0a,b''
        elif isinstance(item,bool): tag,body=0x08,bytes([int(item)])
        elif isinstance(item,str):
            raw=item.encode('utf-8')+b'\0';tag,body=0x02,struct.pack('<i',len(raw))+raw
        elif isinstance(item,dict): tag,body=0x03,bson_document(item)
        elif isinstance(item,list): tag,body=0x04,bson_document(item,True)
        elif isinstance(item,int) and -2**31<=item<2**31: tag,body=0x10,struct.pack('<i',item)
        elif isinstance(item,(int,float)): tag,body=0x01,struct.pack('<d',item)
        else: raise AssertionError(type(item))
        pieces.append(bytes([tag])+key+body)
    body=b''.join(pieces)+b'\0'
    return struct.pack('<i',len(body)+4)+body

def bson_decode(raw,array=False):
    end=struct.unpack_from('<i',raw)[0]
    assert end==len(raw) and raw[-1]==0
    offset=4;result={}
    while offset<end-1:
        tag=raw[offset];offset+=1
        stop=raw.index(0,offset);key=raw[offset:stop].decode();offset=stop+1
        if tag==0x0a: value=None
        elif tag==0x08: value=bool(raw[offset]);offset+=1
        elif tag==0x02:
            length=struct.unpack_from('<i',raw,offset)[0];offset+=4
            assert raw[offset+length-1]==0
            value=raw[offset:offset+length-1].decode();offset+=length
        elif tag in [0x03,0x04]:
            length=struct.unpack_from('<i',raw,offset)[0]
            value=bson_decode(raw[offset:offset+length],tag==0x04);offset+=length
        elif tag==0x10: value=struct.unpack_from('<i',raw,offset)[0];offset+=4
        elif tag==0x01: value=struct.unpack_from('<d',raw,offset)[0];offset+=8
        else: raise AssertionError(tag)
        assert key not in result
        result[key]=value
    assert offset==end-1
    if array:
        assert list(result)==[str(i) for i in range(len(result))]
        return list(result.values())
    return result

origin_bytes=EMISSION['tests/fixtures/projection-validation/origin.json'];origin=json.loads(origin_bytes)
packed_bytes=EMISSION['tests/fixtures/projection-validation/metadata.json.gz.base64']
compressed=base64.b64decode(packed_bytes.strip(),validate=True)
metadata_bytes=gzip.decompress(compressed)
assert origin_bytes==git_bytes('tests/fixtures/projection-validation/origin.json')
assert packed_bytes==git_bytes('tests/fixtures/projection-validation/metadata.json.gz.base64')
assert sha(origin_bytes)=='b55332ee9b86aee69c0b3c04bb113a42495f594f649f5da6288df884dab50bfb'
assert sha(packed_bytes)=='9e222f65e2ec9e6e3724c5147fb91a2cbaaee556fd707279c1bc7609e9a1e269'
assert len(compressed)==origin['metadata']['gzipBytes'] and sha(compressed)==origin['metadata']['gzipSha256']
assert len(metadata_bytes)==origin['metadata']['bytes'] and sha(metadata_bytes)==origin['metadata']['sha256']
original=json.loads(metadata_bytes)
assert metadata_bytes==jsjson(original)
code_bytes={}
for code in origin['code']:
    data=EMISSION[code['path']]
    assert len(data)==code['bytes'] and sha(data)==code['sha256']
    code_bytes[code['path']]=data
emission_path=PACKAGE_ROOT/'retained-emission.tar.gz'
harness_bytes=EMISSION['scripts/qualification/projection-validation-kernel.mjs']
assert harness_bytes==git_bytes('scripts/qualification/projection-validation-kernel.mjs')
assert sha(harness_bytes)=='080301c3739d83d98c0f14f32bf8c5a0821f4c03bdd77b008f0df314e8c15caa'

# Independently reconstruct the six suffix fixtures; replay receipts remain fixed at 256.
point=lambda value:{'blockNum':value['blockNum'],'blockId':value['blockId']}
receipts={item['blockNum']:item for item in [original['floorReceipt']]+original['receipts']}
fixtures=[]
for n in CARDINALITIES:
    state=copy.deepcopy(original)
    state['checkpoint']=point(original['checkpoint'])
    state['undo']=state['undo'][-n:] if n else []
    state['coverageFloor']=({'blockNum':state['undo'][0]['block']['blockNum']-1,
                            'blockId':state['undo'][0]['block']['previousBlockId']} if n else point(state['checkpoint']))
    state['floorReceipt']=copy.deepcopy(receipts[state['coverageFloor']['blockNum']])
    metadata=copy.deepcopy(state)
    metadata['checkpoint']={**point(state['checkpoint']),'revision':state['revision']}
    fixtures.append({'descriptors':n,'state':state,'metadata':metadata})
assert fixtures[-1]['metadata']==original

negative_inputs=[]
def negative(name,n,mutate,entry='state'):
    value=copy.deepcopy(next(item for item in fixtures if item['descriptors']==n)[entry]);mutate(value)
    negative_inputs.append({'name':name,'descriptors':n,'entry':entry,'inputSha256':sha(jsjson(value)),
                            'code':'projection.invalid-contract'})
negative('non-positive policy',0,lambda x:x['policy'].update(maxBlocks=0))
negative('undo exceeds positive policy',32,lambda x:x['policy'].update(maxBlocks=1))
negative('empty undo without floor advance',0,lambda x:x.update(coverageFloor=copy.deepcopy(original['coverageFloor']),floorReceipt=copy.deepcopy(original['floorReceipt'])))
negative('wrong floor receipt identity',32,lambda x:x['floorReceipt'].update(blockId='0'*64))
negative('matching receipt around broken floor link',32,lambda x:(x['coverageFloor'].update(blockId='0'*64),x['floorReceipt'].update(blockId='0'*64)))
negative('broken first descriptor predecessor',32,lambda x:x['undo'][0]['block'].update(previousBlockId='0'*64))
negative('suffix does not reach checkpoint',32,lambda x:x['undo'].pop())
negative('missing replay receipts',0,lambda x:x.update(receipts=[]))
negative('unordered replay receipts',32,lambda x:x['receipts'].__setitem__(slice(0,2),list(reversed(x['receipts'][:2]))))
negative('final replay receipt differs',32,lambda x:x['receipts'][-1].update(blockId='0'*64))
negative('zero-image byte mismatch',32,lambda x:x['undo'][0].update(imageBytes=1))
negative('malformed image hash',32,lambda x:x['undo'][0].update(imagesHash='g'*64))
negative('stored revision fence mismatch',32,lambda x:x['checkpoint'].update(revision='0'*64),'metadata')
assert len(negative_inputs)==13

inputs,all_reports={},{}
invocation=load(INPUT/'invocations.json')
assert invocation['head']==HEAD and len(invocation['runs'])==4
preparation=load(ROOT/'h1-preparation-receipt.json')
native_receipts={item['name']:item for item in preparation['after']['runtimes']}
assert preparation['after']['head']==HEAD
expected_exe_sha={'node22':'fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48',
                  'node24':'bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12'}
for filename,digest in EXPECTED.items():
    data=bounded_file(INPUT/filename);assert sha(data)==digest
    report=json.loads(data);runtime,mode=filename[:-5].split('-')
    log_bytes=bounded_file(INPUT/(filename[:-5]+'.log'));log=json.loads(log_bytes)
    assert log=={'status':'measured','mode':mode,'output':{'bytes':len(data),'sha256':digest}}
    inv=next(item for item in invocation['runs'] if item['runtime']==runtime and item['mode']==mode)
    assert inv['exitCode']==0 and inv['startedAt']<inv['endedAt']
    args=inv['argv'];assert args[:3]==['systemd-run','--scope','--quiet']
    assert args[4:10]==['--property=CPUQuota=600%','--property=MemoryMax=2G','--property=TasksMax=128','timeout','130',native_receipts[runtime]['path']]
    assert args[10:]==['scripts/qualification/projection-validation-kernel.mjs','--mode',mode,'--out',
                       '/tmp/hyp45-p246-20261021/kernel252-d95d797-native/'+filename]+([] if mode=='count' else ['--warmup','1','--iterations','1','--order','both'])
    assert report['runtime']['executable']==args[9]
    assert report['runtime']['binarySha256']==native_receipts[runtime]['sha256']==expected_exe_sha[runtime]
    assert report['runtime']['version']=={'node22':'v22.23.3','node24':'v24.19.0'}[runtime]
    assert report['runtime']['platform']=='linux' and report['runtime']['arch']=='x64'
    assert report['runtime']['execArgv']==[] and report['runtime']['nodeOptionsPresent'] is False
    assert report['status']=='measured' and report['schemaVersion']==1 and report['issue']==252 and report['mode']==mode
    assert report['harnessSha256']==sha(harness_bytes)
    provenance=report['provenance']
    assert provenance['gitHead']==HEAD and provenance['gitHeadAvailability']=='observed'
    assert provenance['origin']==origin and provenance['fixtureSha256']==sha(packed_bytes) and provenance['originSha256']==sha(origin_bytes)
    assert provenance['validity']=={'positiveCases':12,'negativeCases':13,'negatives':negative_inputs}
    assert len(provenance['originCodeMatches'])==3 and all(item['matches'] is True for item in provenance['originCodeMatches'])
    assert len(provenance['code'])==3
    for actual,match in zip(provenance['code'],provenance['originCodeMatches']):
        original_code=next(item for item in origin['code'] if item['path']==match['originPath'])
        assert actual['path']==match['path'] and actual['sha256']==match['sha256']==original_code['sha256']
        assert actual['bytes']==original_code['bytes']
        assert actual['file']=='/tmp/hyp45-p246-20261021/hyperion-history-api/'+actual['path']
        assert actual['url']=='file://'+actual['file']
    for file in provenance['files']:
        contents=git_bytes(file['path'])
        assert len(contents)==file['bytes'] and sha(contents)==file['sha256']
    sdk=provenance['sdkResolution']
    assert sdk['file']==provenance['code'][2]['file'] and sdk['importTarget']=='./dist/projection.js'
    with tarfile.open(emission_path) as archive:
        sdk_package=member_bytes(archive,'node_modules/@eosrio/hyperion-sdk/package.json')
        assert sdk['packageSha256']==sha(sdk_package) and sdk['version']==json.loads(sdk_package)['version']
    bson=provenance['bson']
    assert bson['available'] is True and bson['backendAnchor']=='packages/backend-mongodb/dist/rollback-contract.js'
    assert bson['mongodb']['package']['version']=='7.2.0' and bson['bson']['package']['version']=='7.3.3'
    assert bson['mongodb']['entry']['path']=='packages/backend-mongodb/node_modules/mongodb/lib/index.js'
    assert bson['bson']['entry']['path']=='packages/backend-mongodb/node_modules/bson/lib/bson.cjs'
    assert bson['options']=={'serialize':{'checkKeys':False,'serializeFunctions':False,'ignoreUndefined':True},
        'calculateObjectSize':{'serializeFunctions':False,'ignoreUndefined':True},
        'deserialize':{'promoteValues':True,'promoteLongs':True,'promoteBuffers':False,'useBigInt64':False,'bsonRegExp':False,
                       'allowObjectSmallerThanBufferSize':False,'validation':{'utf8':True}}}
    assert provenance['dependencies']==[{'name':'mongodb',**bson['mongodb']['entry']},{'name':'bson',**bson['bson']['entry']}]
    assert len(provenance['fixtures'])==6
    for fixture,receipt in zip(fixtures,provenance['fixtures']):
        n=fixture['descriptors'];state=fixture['state']
        assert receipt['descriptors']==n and receipt['checkpoint']==state['checkpoint'] and receipt['coverageFloor']==state['coverageFloor']
        assert receipt['floorReceipt']==state['floorReceipt'] and receipt['replayReceipts']==256 and receipt['policy']==state['policy']
        for entry in ['state','metadata']:
            document=fixture[entry];json_bytes=jsjson(document);bson_bytes=bson_document(document)
            assert receipt[entry+'Sha256']==sha(json_bytes) and receipt[entry+'JsonBytes']==len(json_bytes)
            assert receipt[entry+'Bson']=={'available':True,'bytes':len(bson_bytes),'sha256':sha(bson_bytes),
                'calculatedBytes':len(bson_bytes),'defaultCalculatedBytes':len(bson_bytes),'roundTripInputEqual':True,'roundTripBytesEqual':True}
            assert bson_decode(bson_bytes)==document and bson_document(bson_decode(bson_bytes))==bson_bytes
    inputs[filename]={'bytes':len(data),'sha256':digest,'logSha256':sha(log_bytes),'runtime':report['runtime'],
                       'invocationExitCode':inv['exitCode'],'positiveCases':12,'negativeCases':13}
    all_reports[(runtime,mode)]=report
assert all(report['provenance']==all_reports[('node22','count')]['provenance'] for report in all_reports.values())

selectors={'known':('harness','knownCounter'),'recursive':('harness','recursiveCounter'),
           'state':('rollback','validateRollbackState'),'metadata':('rollback','validateRollbackMetadata'),
           'validateMetadata':('contract','validateMetadata'),'definition':('sdk','validateProjectionDefinition'),
           'apply':('sdk','validateProjectionApply'),'validating':('sdk','validating'),'snapshot':('sdk','snapshot'),
           'string':('sdk','string'),'freeze':('sdk','freeze'),'canonical':('sdk','canonical'),'encoding':('encoding','encode')}
valid_capture_maps={};availability=collections.Counter();calibration=[]
for runtime in ['node22','node24']:
    report=all_reports[(runtime,'count')];measured=report['measured'];prov=report['provenance']
    assert measured['parameters']=={'callCount':True,'detailed':False} and measured['calibrated'] is True and measured['encodingCalibrated'] is True
    assert measured['countsAreNotCpuOrTiming'] is True and measured['knownCalls']==[0,1,3,0] and measured['recursionEntriesPerCall']==5
    captures=measured['captures'];sources={row['scriptId']:row for row in measured['sources']}
    assert len(captures)==len({row['label'] for row in captures})==33 and len(sources)==5
    urls={'harness':'file:///tmp/hyp45-p246-20261021/hyperion-history-api/scripts/qualification/projection-validation-kernel.mjs',
          'rollback':prov['code'][0]['url'],'contract':prov['code'][1]['url'],'sdk':prov['code'][2]['url'],'encoding':'node:internal/encoding'}
    source_bytes={'harness':harness_bytes,'rollback':code_bytes['packages/backend-mongodb/dist/rollback-contract.js'],
                  'contract':code_bytes['packages/backend-mongodb/dist/contract.js'],'sdk':code_bytes['node_modules/@eosrio/hyperion-sdk/dist/projection.js']}
    for category,raw in source_bytes.items():
        source_row=next(row for row in sources.values() if row['url']==urls[category])
        assert source_row['sha256']==sha(raw) and source_row['utf16Length']==len(raw.decode().encode('utf-16-le'))//2
    for capture in captures:
        assert set(capture['metrics'])==set(selectors)
        assert capture['nativeEncodeUtf8StringNamedEntries']==0
        for name,(category,function_name) in selectors.items():
            matches=[(script,function) for script in capture['scripts'] if script['url']==urls[category]
                     for function in script['functions'] if function['functionName']==function_name]
            metric=capture['metrics'][name]
            if len(matches)!=1:
                assert metric=={'available':False,'reason':'ambiguous named entries' if matches else 'no named entry returned','matches':len(matches)}
                availability[runtime+'-missing']+=1
            else:
                script,function=matches[0];ranges=function['ranges'];source=sources[script['scriptId']]
                assert len(ranges)==1 and function['isBlockCoverage'] is False
                span=ranges[0];assert 0<=span['startOffset']<=span['endOffset']<=source['utf16Length']
                assert isinstance(span['count'],int) and span['count']>=0
                assert metric=={'available':True,'scriptId':script['scriptId'],'url':script['url'],
                    'functionName':function_name,'sourceSha256':source['sha256'],'range':span,'isBlockCoverage':False}
                availability[runtime+'-available']+=1
    expected_calibration=[('known-'+str(i),'known',n,n) for i,n in enumerate([0,1,3,0])]
    expected_calibration += [('recursive-'+str(n),'recursive',n,5*n) for n in [1,3]]
    expected_calibration += [('encoding-'+str(n),'encoding',n,n) for n in [0,1,3]]
    assert [row['label'] for row in captures[:9]]==[row[0] for row in expected_calibration]
    for capture,(label,metric_name,repetitions,expected_count) in zip(captures,expected_calibration):
        assert capture['repetitions']==repetitions
        metric=capture['metrics'][metric_name]
        if expected_count==0 and not metric['available']:
            assert metric['reason']=='no named entry returned'
        else:
            assert metric['available'] is True and metric['range']['count']==expected_count
    valid=captures[9:];assert len(valid)==24
    assert [(row['descriptors'],row['entry'],row['repetitions']) for row in valid]==[(n,entry,repetitions) for n in CARDINALITIES for entry in ['state','metadata'] for repetitions in [1,3]]
    for row in valid:
        fixture=next(item for item in fixtures if item['descriptors']==row['descriptors'])
        assert row['phase']=='valid-count-only' and row['inputSha256']==sha(jsjson(fixture[row['entry']]))
    valid_capture_maps[runtime]={(row['descriptors'],row['entry'],row['repetitions']):row for row in valid}
    calibration.append({'runtime':runtime,'captures':33,'calibrationWindows':9,'validInputWindows':24,
        'knownCallSequence':[0,1,3,0],'recursiveEntries':[5,15],'jsEncoderCalibration':[0,1,3],
        'zeroWindowEntriesMayBeAbsent':True,'nativeEncodingCallsAvailable':False})

for left,right in zip(all_reports[('node22','count')]['measured']['captures'],
                      all_reports[('node24','count')]['measured']['captures']):
    assert left['label']==right['label'] and left['repetitions']==right['repetitions']
    for metric_name in selectors:
        a,b=left['metrics'][metric_name],right['metrics'][metric_name]
        assert a['available']==b['available']
        if a['available']:
            assert a['range']['count']==b['range']['count']
        else:
            assert a['reason']==b['reason'] and a['matches']==b['matches']

table=[]
for n in CARDINALITIES:
    for entry in ['state','metadata']:
        metrics={}
        for metric_name in selectors:
            per_runtime={};available_flags=[]
            for runtime in ['node22','node24']:
                one=valid_capture_maps[runtime][(n,entry,1)]['metrics'][metric_name]
                three=valid_capture_maps[runtime][(n,entry,3)]['metrics'][metric_name]
                assert one['available']==three['available']
                available_flags.append(one['available'])
                if one['available']:
                    assert three['range']['count']==3*one['range']['count']
                    per_runtime[runtime]={'oneCall':one['range']['count'],'threeCalls':three['range']['count']}
                else:
                    assert one['reason']==three['reason'] and one['matches']==three['matches']
                    per_runtime[runtime]={'available':False,'reason':one['reason'],'matches':one['matches']}
            assert available_flags[0]==available_flags[1] and per_runtime['node22']==per_runtime['node24']
            if available_flags[0]:
                metrics[metric_name]={'available':True,'entriesPerCall':per_runtime['node22']['oneCall'],'rawCounts':per_runtime}
            else:
                metrics[metric_name]={'available':False,'entriesPerCall':None,'reason':per_runtime['node22']['reason'],'rawAvailability':per_runtime}
        table.append({'descriptors':n,'entry':'logical-state' if entry=='state' else 'stored-metadata','metrics':metrics})
        expected_counts={'state':1,'validateMetadata':1,'definition':n+2,'validating':2*n+5,'snapshot':39*n+89,
                         'string':70*n+159,'freeze':39*n+89,'canonical':39*n+89,'encoding':132*n+299}
        if entry=='metadata':expected_counts['metadata']=1
        if n:expected_counts['apply']=n
        for metric_name,value in expected_counts.items():assert metrics[metric_name]['entriesPerCall']==value
        assert metrics['metadata']['available'] is (entry=='metadata') and metrics['apply']['available'] is (n>0)

timing_checks=[]
for runtime in ['node22','node24']:
    measured=all_reports[(runtime,'timing')]['measured'];rows=measured['rows']
    assert measured['warmupPerStateAndEntryPerPass']==1 and measured['iterations']==1 and measured['order']=='both'
    assert measured['preciseCoverageRequested'] is False and len(rows)==24
    expected=[(direction,n,entry,0) for direction,ns in [('forward',CARDINALITIES),('reverse',CARDINALITIES[::-1])] for n in ns for entry in ['state','metadata']]
    assert [(row['direction'],row['descriptors'],row['entry'],row['iteration']) for row in rows]==expected
    gc=measured['gc'];assert gc['available'] is True and len(gc['entries'])<=10000
    for event in gc['entries']:assert event['startTime']>=0 and event['duration']>=0
    for row in rows:
        assert 0<row['startMs']<=row['endMs'] and math.isclose(row['endMs']-row['startMs'],row['elapsedMs'],abs_tol=1e-9)
        cpu=row['processCpuMicros'];assert cpu['user']>=0 and cpu['system']>=0 and cpu['total']==cpu['user']+cpu['system']
        assert row['rssBytes']['before']>0 and row['rssBytes']['after']>0
        overlapping=[event for event in gc['entries'] if event['startTime']<row['endMs'] and event['startTime']+event['duration']>row['startMs']]
        intervals=sorted((max(row['startMs'],event['startTime']),min(row['endMs'],event['startTime']+event['duration'])) for event in overlapping)
        overlap=0;right=row['startMs']
        for left,end in intervals:
            overlap+=max(0,end-max(left,right));right=max(right,end)
        assert row['gc']['available'] is True and row['gc']['events']==len(overlapping)
        assert math.isclose(row['gc']['overlapMs'],overlap,abs_tol=1e-9)
    assert measured['unavailable']=={'allocations':'No allocation profiler','nativeEncodingBytes':'No native encoding byte counter',
        'nativeEncodingCalls':'No native call counter','eventLoopDelay':'No event-loop histogram','actualWorkerFrequency':'Service-free kernel only'}
    timing_checks.append({'runtime':runtime,'rows':24,'warmup':1,'iterations':1,'order':'both','preciseCoverageRequested':False,
                          'gcRecords':len(gc['entries']),'gcClippingVerified':True,'interpretation':'Plumbing only; no timing rank or benefit inference.'})

table_document={'schemaVersion':1,'issue':252,'sourceHead':HEAD,'reportSha256':EXPECTED,
    'counterKind':'Observed V8 function entry counts; not CPU weights, timing or worker call frequency.',
    'runtimes':['native Node 22.23.3 Linux x64','native Node 24.19.0 Linux x64'],
    'allAvailableCountersOneVsThreeLinear':True,'allMetricAvailabilityAndPerCallCountsAgreeAcrossRuntimes':True,
    'fixedReplayReceiptCount':256,'checkpointBlock':288,
    'counterDefinitions':{name:{'moduleRole':category,'functionName':function_name} for name,(category,function_name) in selectors.items()},
    'rows':table,
    'nativeEncodingCalls':{'available':False,'count':None,'reason':'No native call counter; zero named encodeUtf8String entries is not a zero-call measurement.'},
    'missingConvention':'Unavailable entries remain null/absent, including apply at N=0 and the stored wrapper for logical-state calls.',
    'scope':'One fixed empty-row engineering metadata object, suffix cardinalities only; no actual worker-frequency or optimization conclusion.'}
(HERE/'COUNTS.json').write_bytes(encoded(table_document))
results={'schemaVersion':1,'sourceHead':HEAD,'status':'verified','inputs':inputs,'invocationsSha256':sha(bounded_file(INPUT/'invocations.json')),
    'preparationReceiptSha256':sha(bounded_file(ROOT/'h1-preparation-receipt.json')),
    'fixtureSha256':sha(packed_bytes),'originSha256':sha(origin_bytes),'harnessSha256':sha(harness_bytes),
    'originArchivesIndependentlyRehashed':False, 'originArchiveVerification':'Captured origin pins only; original historical archives are outside this publication','originalMetadataAndThreeCodePinsIndependentlyVerified':True,
    'jsonAndBsonInputsIndependentlyReconstructed':12,'negativeInputHashesIndependentlyReconstructed':13,
    'allProvenanceObjectsAgreeAcrossFourReports':True,'calibration':calibration,'availabilityTotals':dict(availability),
    'countRows':12,'countMetricsPerRow':13,'crossRuntimeMetricsChecked':33*13,
    'timingChecks':timing_checks,'countsSha256':sha((HERE/'COUNTS.json').read_bytes()),'findings':[],
    'limits':['No H1 or service access; actual executable pins are cross-checked against retained remote preflight/invocation records, not reexecuted by this audit.',
        'Actual MongoDB/BSON entry and package bytes are retained as five pre-pilot kernel witnesses; full dependency trees and runtime binaries are not archived. Independent JSON-subset BSON reconstruction matches all twelve reported byte hashes.',
        'Negative-control input hashes and rejection records are checked against exact committed code; validators are not reexecuted by this evidence audit.',
        'Counter multiplicity is not CPU weighting, elapsed time, actual-worker call frequency or a production bottleneck conclusion.',
        'One timing iteration per pass and direction is plumbing evidence only; forward/reverse passes are not independent repetitions, runtime rankings, benefits or quantified overhead.']}
(HERE/'audit-results.json').write_bytes(encoded(results))
print(json.dumps({'status':'verified','reportCount':len(inputs),'jsonAndBsonInputs':12,'negativeInputs':13,'countRows':12,
    'captureCounts':[33,33],'timingRows':[24,24],'availability':dict(availability),'countsSha256':results['countsSha256'],
    'countsBytes':(HERE/'COUNTS.json').stat().st_size,'outputDirectory':str(HERE)},indent=2))
