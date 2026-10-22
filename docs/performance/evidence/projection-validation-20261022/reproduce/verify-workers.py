"""Replay the independent worker span/state audit over public retained bytes; no services."""
import collections, hashlib, json, sys
sys.dont_write_bytecode = True
from common import CASES, HEAD, VirtualPath, bounded_file, encoded, parsed, verifier_arguments, worker_context
PACKAGE_ROOT, OUT = verifier_arguments(__doc__)
payload, publication, files = worker_context(PACKAGE_ROOT)
CASE = CASES[0]
ROOT = VirtualPath(files)
DEST = ROOT/'measured-pilot-regular-files'
RUN = DEST/CASE
sha = lambda data: hashlib.sha256(data).hexdigest()
read = lambda file: parsed(file.read_bytes())
source = next(row for row in publication['sourceArchives'] if row['case']==CASE)
EXPECTED_ARCHIVE = source['sha256']
members = source['members']
member_manifest = [{key:row[key] for key in ['path','bytes','sha256']} for row in members if row['type']=='file']
links = [{'path':row['path'],'target':row['linkTarget']} for row in members if row['type']=='symlink']
total_bytes = source['regularBytes']
r = read(RUN / 'report.json')
invocation = read(DEST / (CASE + '-invocation.json'))
pins = read(DEST / ('source-emission-pins-' + HEAD + '.json'))
assert r['gitHead'] == invocation['head'] == pins['head'] == HEAD
assert r['status'] == 'profiled-prefix' and r['errors'] == [] and r.get('error') is None
assert r['profileOnly'] and r['finality'] == invocation['finality'] == 'reversible'
assert invocation['projectionMeasurements'] == 'on' and invocation['profileCpu'] == 'off'
assert invocation['exitCode'] == 0 and invocation['samplingErrors'] == []
assert invocation['profilePrefix'] == 288 and invocation['heldHeadMs'] == 10000
assert invocation['limits'] == {'nativeCpuQuota':'600%', 'nativeMemoryMax':'8G', 'tasksMax':512, 'deadlineSeconds':1000}
p = r['profiling']; measurement = p['projectionMeasurements']
assert p['prefix'] == 288 and p['completed'] and p['stable']
assert not p['fullRecoveryScenarioExecuted'] and p['emptyTargetTablePrefix']
assert p['cpuProfiles'] == [] and not p['cpuCapture']['enabled'] and p['cpuCapture']['verified']
assert measurement['enabled'] and measurement['completed'] and not measurement['preciseV8Coverage']
assert measurement['heldHeadMs'] == 10000
assert r['runtime']['node'] == 'v24.19.0'
assert r['runtime']['sha256'] == 'bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12'
assert p['pins']['trackedDiffBytes'] == 0 and p['pins']['trackedDiffSha256'] == sha(b'')
assert p['sourceReauditHashes'] == r['inputHashes'] and len(r['inputHashes']) == 1484
assert invocation['planSha256'] == r['planSha256']
manifest = {row['path']: row for row in pins['members']}
profile_pins = {row['path']: row for row in p['pins']['files']}
assert len(manifest) == 607 and len(profile_pins) == 513
overlap = manifest.keys() & profile_pins.keys()
for path in overlap:
    assert manifest[path] == profile_pins[path], path

observer_events = []
for file in (RUN / 'observer').glob('*/*.jsonl'):
    observer_events += [json.loads(line) for line in file.read_bytes().splitlines()]
starts = [row for row in observer_events if row['kind'] == 'start']
start_by_pid = {row['pid']: row for row in starts}
assert len(start_by_pid) == len(starts)
results, operation_rows, span_rows = [], [], []
for receipt in measurement['reports']:
    data = (RUN / receipt['file']).read_bytes()
    assert len(data) == receipt['bytes'] and sha(data) == receipt['sha256']
    v = json.loads(data); pid = v['pid']; role = v['role']
    assert v['node'] == r['runtime']['node'] and v['runtime'] == {'platform':'linux', 'arch':'x64'}
    assert v['sealed'] and not v['sealTimedOut'] and v['errors'] == [] and v['droppedSpans'] == 0 and v['inFlight'] == []
    assert v['sessionHooks']['limitExceeded'] == 0
    assert 0 <= v['sessionHooks']['weakReferenceSlots'] <= v['sessionHooks']['maximum'] <= 50000
    assert len(v['attachments']) == 1 and v['attachments'][0]['initialPublicOperationUnobserved'] == (role == 'api')
    event = start_by_pid[pid]
    assert event['parentPid'] == v['parentPid'] and event['runtime']['version'] == v['node']
    if role == 'projection':
        assert event['role'] == 'projection' and event['parentPid'] in start_by_pid
    else:
        assert role == 'api' and event['argv'][-1].endswith('/build/api/server.js')
    for module in v['modules']:
        path = module['path'].split('/hyperion-history-api/')[1]
        assert module['sha256'] == manifest[path]['sha256']
        assert module['sha256'] == profile_pins[path]['sha256']
    observer_path = v['observer']['path'].split('/hyperion-history-api/')[1]
    assert v['observer']['sha256'] == manifest[observer_path]['sha256'] == profile_pins[observer_path]['sha256']
    phase_names = ['prefix','held-head','verification','shutdown']
    assert [row['phase'] for row in v['phases']] == phase_names
    phase_times = {row['phase']:int(row['atNs']) for row in v['phases']}
    assert list(phase_times.values()) == sorted(phase_times.values())
    for number, phase in enumerate(v['phases'], 1):
        assert phase['sequence'] == number
        parent_phase = next(row for row in measurement['phases'] if row['phase'] == phase['phase'])
        parent_receipt = next(row for row in parent_phase['receipts'] if row['acknowledgment']['pid'] == pid)
        ack = parent_receipt['acknowledgment']
        assert ack['requestId'] == phase['requestId'] and ack['phase'] == phase['phase']
        assert ack['attached'] and 'error' not in ack and ack['parentPid'] == v['parentPid'] and ack['role'] == role
        if role == 'projection': assert ack['viaParentPid'] == v['parentPid']
        else: assert 'viaParentPid' not in ack
        assert 1 <= parent_receipt['sendAttempts'] <= 100
        assert parent_receipt['retryIntervalMS'] == (100 if number == 1 else None)
        if number == 1: assert parent_receipt['receivedAt'] <= p['firstReleaseAt']
    grouped = collections.defaultdict(list)
    span_map = {row['id']:row for row in v['spans']}
    assert len(span_map) == len(v['spans']) and len(span_map) <= 50000
    order = ['startup', *phase_names]
    for span in v['spans']:
        key = (span['kind'],span['name'],span['operation'],span['startPhase'])
        grouped[key].append(span)
        assert int(span['durationNs']) == int(span['endNs'])-int(span['startNs']) >= 0
        assert order.index(span['startPhase']) <= order.index(span['endPhase'])
        root = span_map[span['rootId']]
        assert root['parentId'] is None and root['rootId'] == root['id']
        if span['parentId'] is not None:
            parent = span_map[span['parentId']]
            assert parent['id'] < span['id'] and parent['rootId'] == root['id']
            assert int(parent['startNs']) <= int(span['startNs'])
        if span['kind'] in ('load','validation'):
            assert span['undoDescriptorCount'] is None or 0 <= span['undoDescriptorCount'] <= 256
        if span['startPhase'] != 'startup': assert int(span['startNs']) >= phase_times[span['startPhase']]
    assert len(grouped) == len(v['counters'])
    for counter in v['counters']:
        key = (counter['kind'],counter['name'],counter['operation'],counter['phase'])
        spans = grouped[key]; durations = [int(span['durationNs']) for span in spans]
        assert counter['started'] == counter['settled'] == len(spans)
        assert counter['failed'] == sum(span['outcome'] in ('rejected','threw') for span in spans)
        assert int(counter['totalDurationNs']) == sum(durations)
        assert int(counter['minimumDurationNs']) == min(durations) and int(counter['maximumDurationNs']) == max(durations)
        if counter['kind'] in ('load','validation'):
            counts = [span['undoDescriptorCount'] for span in spans]
            assert counter['undoDescriptorVisits'] == sum(value for value in counts if value is not None)
            assert counter['undoCardinalityAvailable'] == sum(value is not None for value in counts)
            assert counter['undoCardinalityUnavailable'] == sum(value is None for value in counts)
    for phase in ['startup',*phase_names]:
        selected = [span for span in v['spans'] if span['startPhase'] == phase]
        if not selected: continue
        counts = collections.Counter(span['kind'] for span in selected)
        operations = collections.Counter(span['name'] for span in selected if span['kind'] == 'operation')
        operation_rows.append({'role':role,'phase':phase,'operations':dict(sorted(operations.items()))})
        for kind in ['operation','load','validation','metadata-read','transaction','transaction-start','commit','abort']:
            selected_kind = [span for span in selected if span['kind'] == kind]
            if not selected_kind: continue
            span_rows.append({'role':role,'phase':phase,'kind':kind,'entries':len(selected_kind),
                'failed':sum(span['outcome'] in ('rejected','threw') for span in selected_kind),
                'inclusiveElapsedNs':sum(int(span['durationNs']) for span in selected_kind),
                **({'undoDescriptorVisits':sum(span['undoDescriptorCount'] for span in selected_kind if span['undoDescriptorCount'] is not None),
                    'unavailableCardinality':sum(span['undoDescriptorCount'] is None for span in selected_kind)} if kind in ('load','validation') else {})})
        if phase == 'held-head':
            assert (counts == {'operation':144,'load':144,'metadata-read':144,'validation':144,'session-create':144}) if role == 'projection' else not counts
    samples = [row for row in observer_events if row['pid'] == pid and row['kind'] == 'sample']
    assert samples
    last = samples[-1]
    results.append({'role':role,'pid':pid,'parentPid':v['parentPid'],'spans':len(v['spans']),
        'sessionHooks':v['sessionHooks'],'clockOrigin':v['clockOrigin'],
        'lastResourceSample':{key:last[key] for key in ['monotonicMs','reason','cpuTotalMicros','memory','resourceUsage']}})
assert {row['role'] for row in results} == {'projection','api'}

stages = []
for receipt in r['stages']:
    data = (RUN / receipt['file']).read_bytes(); assert sha(data) == receipt['sha256']
    stage = json.loads(data)
    assert stage['through'] == 288 and stage['branch'] == 'A' and len(stage['physical']) == len(stage['responses']) == 3
    assert stage['control']['phase'] == 'following' and stage['control']['head']['blockNum'] == 288
    assert stage['control']['gap'] is None and stage['control']['pending'] == []
    for physical,response,binding in zip(stage['physical'],stage['responses'],r['bindings']):
        m = physical['metadata']; body = response['body']; headers = response['headers']
        assert m['binding'] == binding and body['view']['binding'] == binding
        assert m['checkpoint']['blockNum'] == 288 and m['checkpoint']['blockId'] == stage['control']['head']['blockId']
        assert m['checkpoint']['revision'] == m['revision'] == body['view']['revision']
        assert len(m['revision']) == 64 and all(c in '0123456789abcdef' for c in m['revision'])
        assert m['initialized'] and m['pending'] is None and m['gap'] is None and m['rollback'] is None
        assert physical['rows'] == body['rows'] == [] and body['count'] == {'value':0,'exact':True}
        assert body['view']['checkpoint'] == {key:m['checkpoint'][key] for key in ('blockNum','blockId')}
        assert response['status'] == 200 and headers['hyperion-state-block-num'] == '288'
        assert headers['hyperion-state-block-id'] == m['checkpoint']['blockId'] and headers['hyperion-state-finality'] == 'reversible'
        assert headers['hyperion-state-last-valid'] == 'false' and headers['cache-control'] == 'no-store'
        assert len(m['undo']) == len(m['receipts']) == 256 and m['coverageFloor']['blockNum'] == 32
        assert m['floorReceipt']['blockNum'] == 32 and m['floorReceipt']['blockId'] == m['coverageFloor']['blockId']
        receipts_by_block = {item['blockNum']:item for item in m['receipts']}
        assert set(receipts_by_block) == set(range(33,289))
        previous = m['coverageFloor']
        for number,undo in enumerate(m['undo'],33):
            block = undo['block']; assert block['blockNum'] == number and block['previousBlockId'] == previous['blockId']
            replay_receipt = receipts_by_block[number]
            assert block['blockId'] == replay_receipt['blockId'] and undo['digest'] == replay_receipt['digest']
            assert undo['count'] == undo['imageBytes'] == 0 and undo['imagesHash'] == sha(b'[]')
            previous = block
        assert previous['blockId'] == m['checkpoint']['blockId']
    stages.append(stage)
assert stages[0]['physical'] == stages[1]['physical']
flatten = lambda stage: [item for session in stage['source']['sessions'] for item in session['sent']]
assert flatten(stages[0]) == flatten(stages[1])
sent = [item for session in r['sourceMetrics']['sessions'] for item in session['sent']]
acks = [item for session in r['sourceMetrics']['sessions'] for item in session['acknowledged']]
assert sent == acks and len(sent) == 288
assert all(item['branch'] == 'A' for item in sent) and [item['blockNum'] for item in sent] == list(range(1,289))
assert all(session['outstanding'] == 0 for session in r['sourceMetrics']['sessions'])
assert all(queue['ready'] == queue['unacked'] == queue['messages'] == 0 and queue['ack'] == queue['delivered'] for queue in r['brokerAcks'])
raw = next(queue for queue in r['brokerAcks'] if queue['name'].endswith(':live_blocks'))
assert raw['ack'] == raw['delivered'] == 288
assert r['mongoCleanup']['verified'] and all(row['ok'] for row in r['cleanup'])
for row in r['cleanup']:
    if 'shutdown' in row:
        s = row['shutdown']; assert s['success'] and s['children'] == s['exited']
        assert s['failedChildren'] == s['forced'] == s['unresolved'] == []
        assert all(exit['code'] == 0 and exit['signal'] is None for exit in s['childExits'])
assert measurement['heldHead']['elapsedMonotonicMs'] >= 10000

summary = {'status':'independently-verified-captured-pilot','head':HEAD,'archiveSha256':EXPECTED_ARCHIVE,
    'archive':{'members':len(members),'regularFiles':len(member_manifest),'bytes':total_bytes,'skippedLinks':links,
        'regularManifestSha256':sha(json.dumps(member_manifest,separators=(',',':')).encode())},
    'emissionInventory':{'preRunMembers':len(manifest),'runProfileMembers':len(profile_pins),'matchingOverlap':len(overlap),
        'limitation':'Original pilot archive did not include payload; companion public emission/control audit verifies the separately retained 612 files.'},
    'sourceReauditReceiptCount':len(r['inputHashes']), 'phaseStartTables':span_rows,'operationStartTables':operation_rows,
    'processes':results,'stableElapsedMs':p['stableAt']-p['firstReleaseAt'],'heldHead':measurement['heldHead'],
    'sourceFramesAcknowledged':len(acks),'rawBrokerAcknowledged':raw['ack'],
    'correctness':'Both captured stages have three equal empty physical/API projections, paired revisions, checkpoint288, undo256, floor32; all captured cleanup results pass.',
    'limitations':['One pilot, no overhead estimate or runtime/capacity comparison.','Descriptor counts/load wall spans/validation elapsed/processCPU have distinct units and overlapping scopes.',
        'Source re-audit equality and source/emission identities are captured receipts; original1484 source files are not present in this pilot archive.',
        'Full fork/restart/gap/finality and live Wire consensus remain unqualified.']}
(OUT/'audit.json').write_text(json.dumps(summary,indent=2)+'\n',encoding='utf8')
print(json.dumps({'status':summary['status'],'archive':summary['archive'],'emissionInventory':summary['emissionInventory'],
    'processes':[{k:v for k,v in row.items() if k not in ('lastResourceSample','clockOrigin')} for row in results],
    'phaseStartTables':span_rows,'operationStartTables':operation_rows,'stableElapsedMs':summary['stableElapsedMs']},indent=2))
