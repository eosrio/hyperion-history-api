"""Verify retained emission, control pilot and protected-process receipts without services."""
import collections, hashlib, io, json, pathlib, tarfile, sys
sys.dont_write_bytecode = True
from common import CASES, HEAD, VirtualPath, bounded_file, parsed, verifier_arguments, worker_context
PACKAGE_ROOT, OUT = verifier_arguments(__doc__)
case_payload, publication, files = worker_context(PACKAGE_ROOT)
CASE, CONTROL = CASES
for name in ['h1-before-d95d797.stdout','postflight-pilot-pair-d95d797.json']:
    files[name]=bounded_file(PACKAGE_ROOT/'receipts'/name)
for name in ['node22-count.json','node22-timing.json','node24-count.json','node24-timing.json']:
    files['kernel252-d95d797-native/'+name]=bounded_file(PACKAGE_ROOT/'kernel'/name)
files['spec-measured-pilot-audit.json']=bounded_file(PACKAGE_ROOT/'audits/worker-audit-original.json')
files['retained-emission-'+HEAD+'-receipt.json']=bounded_file(PACKAGE_ROOT/'retained-emission-receipt.json')
files['retained-emission-'+HEAD+'.tar.gz']=bounded_file(PACKAGE_ROOT/'retained-emission.tar.gz')
ROOT = VirtualPath(files)
DEST = ROOT/'measured-pilot-regular-files'
RUN = DEST/CASE
sha = lambda data: hashlib.sha256(data).hexdigest()
read = lambda file: parsed(file.read_bytes())
r = read(RUN/'report.json')
audit = read(ROOT / 'spec-measured-pilot-audit.json')
name = 'retained-emission-' + HEAD
receipt = read(ROOT / (name + '-receipt.json'))
archive_bytes = (ROOT / (name + '.tar.gz')).read_bytes()
assert len(archive_bytes) == receipt['bytes'] == 1025212
assert sha(archive_bytes) == receipt['sha256'] == '1b5c31062319386fc981d184f7904a0a9f9b7276bb76d166e737d9c15e3275e6'
payload = {}
with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode='r:gz') as archive:
    members = archive.getmembers(); assert len(members) == 613
    names = set()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        assert member.isfile() and not member.issym() and not member.islnk()
        assert not path.is_absolute() and '..' not in path.parts and '\\' not in member.name
        assert member.name.casefold() not in names and 0 < member.size <= 16 * 1024 * 1024
        names.add(member.name.casefold())
        data = archive.extractfile(member).read(member.size + 1); assert len(data) == member.size
        payload[member.name] = data
pre_run_bytes = (DEST / ('source-emission-pins-' + HEAD + '.json')).read_bytes()
assert payload.pop('pre-run-pins.json') == pre_run_bytes
assert sha(pre_run_bytes) == receipt['preRunManifest']['sha256'] == 'f151a3ba11dd9c024229733f2c07742f688ec139bf35c9f9aef2af21d5fb0763'
pre_run = json.loads(pre_run_bytes)
assert pre_run['head'] == HEAD and pre_run['preparedAt'] == 1792637371.0692828
assert receipt['retainedAfterPilotsAt'] > pre_run['preparedAt']
manifest = {row['path']:row for row in pre_run['members']}
extras = {row['path']:row for row in receipt['additionalKernelWitnesses']}
assert len(manifest) == 607 and len(extras) == 5 and not (manifest.keys() & extras.keys())
assert set(payload) == manifest.keys() | extras.keys()
assert len(payload) == receipt['totalPayloadFiles'] == 612
assert sum(map(len,payload.values())) == receipt['payloadBytes'] == 4563569
for path,row in {**manifest,**extras}.items():
    assert len(payload[path]) == row['bytes'] and sha(payload[path]) == row['sha256'], path
kernel_paths = []
for runtime in ['node22','node24']:
    for mode in ['count','timing']:
        file = ROOT / 'kernel252-d95d797-native' / (runtime + '-' + mode + '.json')
        k = read(file); kernel_paths.append({'path':file.name,'sha256':sha(file.read_bytes())})
        assert k['provenance']['gitHead'] == HEAD and k['provenance']['bson']['available']
        witnesses = k['provenance']['code'] + [k['provenance']['bson'][dep][kind] for dep in ['mongodb','bson'] for kind in ['entry','package']]
        by_path = {row['path']:row for row in witnesses}
        for path,row in extras.items():
            assert path in by_path and by_path[path]['sha256'] == row['sha256'] and by_path[path]['bytes'] == row['bytes']
        assert k['mode'] == mode and k['status'] == 'measured'
for observed in r['profiling']['projectionMeasurements']['reports']:
    v = read(RUN / observed['file'])
    for module in v['modules'] + [v['observer']]:
        path = module['path'].split('/hyperion-history-api/')[1]
        assert sha(payload[path]) == module['sha256']

control_source = next(row for row in publication['sourceArchives'] if row['case']==CONTROL)
control_archive_sha = control_source['sha256']
assert control_archive_sha == 'a5cf1466dacc3b96cb94784d63151d1da853936e38fb84aefd4c21435335cb05'
assert control_source['bytes'] == 5905863
needed = {CONTROL+'/report.json',CONTROL+'-invocation.json',CONTROL+'/stages/profile-prefix-288.json',
    CONTROL+'/stages/profile-held-head-288.json','source-emission-pins-'+HEAD+'.json'}
captured = {CONTROL+'/report.json':case_payload['cases/'+CONTROL+'/report.json'],
    CONTROL+'-invocation.json':case_payload['cases/'+CONTROL+'/invocation.json'],
    CONTROL+'/stages/profile-prefix-288.json':case_payload['cases/'+CONTROL+'/stages/profile-prefix-288.json'],
    CONTROL+'/stages/profile-held-head-288.json':case_payload['cases/'+CONTROL+'/stages/profile-held-head-288.json'],
    'source-emission-pins-'+HEAD+'.json':case_payload['cases/'+CONTROL+'/source-emission-pins.json']}
control_names = {row['path'] for row in control_source['members']}
control_links = [{'path':row['path'],'target':row['linkTarget']} for row in control_source['members'] if row['type']=='symlink']
control_regular, control_total = control_source['regularFiles'], control_source['regularBytes']
assert not any(row['path'].startswith(CONTROL+'/projection-observer/') and row['type']=='file' for row in control_source['members'])
assert not any(row['path'].endswith('.cpuprofile') for row in control_source['members'])
assert len(control_links) == 1 and set(captured) == needed
assert captured['source-emission-pins-'+HEAD+'.json'] == pre_run_bytes
c = json.loads(captured[CONTROL+'/report.json']); ci = json.loads(captured[CONTROL+'-invocation.json'])
assert c['gitHead'] == ci['head'] == HEAD and c['status'] == 'profiled-prefix' and c['errors'] == []
assert ci['exitCode'] == 0 and ci['samplingErrors'] == [] and ci['projectionMeasurements'] == 'off' and ci['profileCpu'] == 'off'
assert ci['limits'] == read(DEST/(CASE+'-invocation.json'))['limits']
assert c['runtime'] == r['runtime'] and c['inputHashes'] == r['inputHashes']
assert c['oracleHashes'] == r['oracleHashes'] and c['planSha256'] == r['planSha256']
assert c['source'] == r['source'] and not c['source']['nodeAuthenticated']
cp = c['profiling']; cm = cp['projectionMeasurements']
assert cp['prefix'] == cp['sourcePacingBlocks'] * 9 == 288 and cp['completed'] and cp['stable']
assert not cm['enabled'] and cm['completed'] and cm['reports'] == [] and cm['phases'] == []
assert cm['heldHeadMs'] == 10000 and cm['heldHead']['elapsedMonotonicMs'] >= 10000
assert not cp['cpuCapture']['enabled'] and cp['cpuCapture']['verified'] and cp['cpuProfiles'] == []
assert cp['pins'] == r['profiling']['pins'] and cp['sourceReauditHashes'] == c['inputHashes']
stages = []
for stage_receipt in c['stages']:
    file = CONTROL + '/' + stage_receipt['file']; data = captured[file]
    assert sha(data) == stage_receipt['sha256']; stage = json.loads(data); stages.append(stage)
    assert stage['through'] == 288 and stage['branch'] == 'A' and len(stage['physical']) == len(stage['responses']) == 3
    assert stage['control']['phase'] == 'following' and stage['control']['head']['blockNum'] == 288
    for physical,response,binding in zip(stage['physical'],stage['responses'],c['bindings']):
        m = physical['metadata']; body=response['body']; headers=response['headers']
        assert m['binding'] == body['view']['binding'] == binding
        assert m['initialized'] and m['pending'] is None and m['gap'] is None and m['rollback'] is None
        assert m['checkpoint']['revision'] == m['revision'] == body['view']['revision']
        assert m['checkpoint']['blockNum'] == 288 and m['checkpoint']['blockId'] == stage['control']['head']['blockId']
        assert body['view']['checkpoint'] == {k:m['checkpoint'][k] for k in ['blockNum','blockId']}
        assert physical['rows'] == body['rows'] == [] and body['count'] == {'value':0,'exact':True}
        assert response['status'] == 200 and headers['hyperion-state-block-num'] == '288'
        assert headers['hyperion-state-block-id'] == m['checkpoint']['blockId']
        assert headers['hyperion-state-finality'] == 'reversible' and headers['hyperion-state-last-valid'] == 'false'
        assert len(m['undo']) == len(m['receipts']) == 256 and m['coverageFloor']['blockNum'] == 32
assert stages[0]['physical'] == stages[1]['physical']
sent = [item for session in c['sourceMetrics']['sessions'] for item in session['sent']]
acks = [item for session in c['sourceMetrics']['sessions'] for item in session['acknowledged']]
assert sent == acks and len(sent) == 288 and [x['blockNum'] for x in sent] == list(range(1,289))
assert all(x['branch'] == 'A' for x in sent) and all(x['outstanding'] == 0 for x in c['sourceMetrics']['sessions'])
assert all(x['ready'] == x['unacked'] == x['messages'] == 0 and x['ack'] == x['delivered'] for x in c['brokerAcks'])
assert c['mongoCleanup']['verified'] and all(x['ok'] for x in c['cleanup'])
for row in c['cleanup']:
    if 'shutdown' in row:
        s=row['shutdown']; assert s['success'] and s['children'] == s['exited']
        assert s['failedChildren'] == s['forced'] == s['unresolved'] == []
        assert all(x['code'] == 0 and x['signal'] is None for x in s['childExits'])
before = read(ROOT/'h1-before-d95d797.stdout')
after = read(ROOT/'postflight-pilot-pair-d95d797.json')
assert before['protected'] == after['protected'] and len(after['protected']) == 7
assert before['runtimes'] == after['runtimes'] and before['planSha256'] == after['planSha256'] == r['planSha256']
assert after['head'] == HEAD and not after['containers'] and not after['activeScopes']

supplement = {'status':'independent-emission-and-control-subset-verified',
    'emission':{'archiveSha256':receipt['sha256'],'preRunManifestSha256':sha(pre_run_bytes),
        'retainedAfterPilotsAt':receipt['retainedAfterPilotsAt'],'preRunPreparedAt':pre_run['preparedAt'],
        'payloadFiles':len(payload),'payloadBytes':sum(map(len,payload.values())),
        'matchingPreRunFiles':len(manifest),'matchingAdditionalPrePilotKernelWitnesses':len(extras),
        'kernelReports':kernel_paths,
        'limitation':'Payload was retained after both pilots and independently byte-checked against the unchanged pre-run607manifest and pre-pilot kernel witness receipts; full dependency trees/runtime binaries are not archived.'},
    'control':{'archiveSha256':control_archive_sha,'archiveMembers':len(control_names),'regularFiles':control_regular,'bytes':control_total,
        'skippedLinks':control_links,'status':c['status'],'sourceFramesAcknowledged':len(acks),
        'stableElapsedMs':cp['stableAt']-cp['firstReleaseAt'],'sourceReceiptHashCount':len(c['inputHashes']),
        'sameRuntimePlanInputOracleAndAllProfilePins':True,'emptyObserverOutputAndNoCpuProfile':True,
        'stagesAndCleanupVerified':True},
    'pairPostflight':{'sevenProtectedPidStartTicksUnchanged':True,'runtimeHashesUnchanged':True,'planHashUnchanged':True,
        'containers':0,'activeScopes':0},
    'limitation':'One measured pilot and one counter-off control, no repeated-control overhead or capacity conclusion.'}
(OUT/'audit.json').write_text(json.dumps(supplement,indent=2)+'\n',encoding='utf8')
print(json.dumps(supplement,indent=2))
