"""Publish and independently recompute the frozen #301 proof/logger capture; no services run."""
import argparse
import collections
import copy
import csv
import importlib.util
import io
import json
import re
from pathlib import Path, PurePosixPath

_spec = importlib.util.spec_from_file_location('profile_evidence', Path(__file__).with_name('native-wire-profile-evidence.py'))
profiles = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(profiles)
RAW_SHA = '54c256368959b6849626a7573c497befe3405788c5e89755f599bcb1480d77ae'
RAW_BYTES = 31280502
REVISION = '7b2fefc0f4d9a79ee73eb23da5e9b37e811d9389'
NAME = 'hapi301-node24-metrics-v1'
COUNTERS = ['immutableGets', 'bundleReads', 'commitValidationCalls', 'httpGetAttempts', 'httpCompleted', 'httpErrors',
    'httpNonSuccess', 'compressedBodyBytes', 'utf8ReencodedBodyBytes', 'unknownBodySizes']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def integer(value):
    return type(value) is int and 0 <= value <= 2**53 - 1


def nanos(value):
    require(isinstance(value, str) and re.fullmatch(r'0|[1-9][0-9]*', value), 'Invalid nanosecond integer')
    return int(value)


def histogram(value):
    require(integer(value['count']) and len(value['buckets']) == 64 and all(integer(n) for n in value['buckets']), 'Invalid histogram shape')
    require(sum(value['buckets']) == value['count'], 'Histogram count differs')
    total, maximum = nanos(value['totalNs']), nanos(value['maximumNs'])
    if value['count']:
        minimum = nanos(value['minimumNs'])
        require(minimum <= maximum and minimum * value['count'] <= total <= maximum * value['count'], 'Histogram totals differ')
        occupied = [i for i, count in enumerate(value['buckets']) if count]
        require(min(63, minimum.bit_length()) == occupied[0] and min(63, maximum.bit_length()) == occupied[-1], 'Histogram extremes differ from buckets')
        lower = sum(count * (0 if i == 0 else 2**(i - 1)) for i, count in enumerate(value['buckets']))
        upper = sum(count * (maximum if i == 63 else 2**i - 1) for i, count in enumerate(value['buckets']))
        require(lower <= total <= upper, 'Histogram bucket totals differ')
    else:
        require(value['minimumNs'] is None and total == maximum == 0, 'Nonempty zero-count histogram')


def summarize_native(data, expected_pid, expected_role):
    require(data.endswith(b'\n') and len(data) <= 24 * 1024 * 1024, 'Incomplete/excess native log')
    lines = data.splitlines(keepends=True)
    rows = [json.loads(line) for line in lines]
    require(len(rows) >= 3 and rows[0]['event'] == 'start' and rows[-1]['event'] == 'exit', 'Missing native lifecycle')
    require([r['sequence'] for r in rows] == list(range(1, len(rows) + 1)), 'Native sequence differs')
    for row in rows:
        require(row['kind'] == 'native_boundary' and row['pid'] == expected_pid and row['role'] == expected_role, 'Native identity differs')
    clocks = [nanos(r['monotonicNs']) for r in rows]
    require(all(a <= b for a, b in zip(clocks, clocks[1:])), 'Unordered native clock')
    require([i for i, r in enumerate(rows) if r['event'] == 'observer_metrics'] == [len(rows) - 2], 'Missing/duplicated observer summary')
    meta, before = rows[-2], len(rows) - 2
    require(meta['coverage'] == 'before-this-row', 'Unknown observer coverage')
    io = meta['io']
    for name in ['writeElapsed', 'syncElapsed']:
        histogram(io[name]); require(io[name]['count'] == before, 'Observer call count differs from durable records')
    require(io['attemptedBytes'] == io['writtenBytes'] == sum(map(len, lines[:before])), 'Observer bytes differ from original records')
    require(io['writeFailures'] == io['syncFailures'] == 0, 'Observer I/O failed')
    require(meta['proofs']['reportFailures'] == 0, 'Proof reports were dropped')
    final, pending = {}, set()
    for row in rows:
        if row['event'] == 'proof_open_finished':
            require(integer(row['openId']) and row['openId'] > 0 and row['openId'] not in final, 'Duplicate/invalid proof ID')
            final[row['openId']] = row
            if row['operationsInFlight']:
                pending.add(row['openId'])
        elif row['event'] == 'proof_open_late_operation':
            ident, value = row['openId'], row['accounting']
            require(ident in pending and value['openId'] == ident, 'Late operation has no pending original open')
            previous = final[ident]
            require(all(value.get(k) == previous.get(k) for k in ['source', 'selectionId', 'outcome', 'openElapsedNs']), 'Late operation changed original identity/outcome')
            require(all(value[k] >= previous[k] for k in COUNTERS), 'Late counter moved backwards')
            final[ident] = value
            if value['operationsInFlight'] == 0:
                pending.remove(ident)
    count = meta['proofs']['started']
    require(count == meta['proofs']['settled'] == len(final) and set(final) == set(range(1, count + 1)) and not pending,
        'Unsettled or missing proof accounting')
    sums = {key: 0 for key in COUNTERS}
    spans, failures, outcomes = {}, collections.Counter(), collections.Counter()
    maximum = None
    for row in final.values():
        require(row['operationsInFlight'] == 0, 'Outstanding proof operations')
        source = row['source']
        require(integer(source['blockNum']) and source['blockNum'] > 0
            and all(isinstance(source[k], str) and re.fullmatch('[0-9a-f]{64}', source[k]) for k in ['chainId', 'blockId']), 'Invalid requested source')
        for authority in [row.get('firstAuthority'), row.get('lastAuthority')]:
            if authority is not None:
                require(isinstance(authority['generation'], str) and 0 < len(authority['generation']) <= 256
                    and integer(authority['headBlockNum']) and authority['headBlockNum'] > 0
                    and re.fullmatch('[0-9a-f]{64}', authority['headBlockId']), 'Invalid observed authority')
        if row['outcome'] == 'returned':
            first, last = row.get('firstAuthority'), row.get('lastAuthority')
            require(first is not None and last is not None and first['generation'] == last['generation']
                and last['headBlockNum'] >= first['headBlockNum'] >= source['blockNum']
                and row['commitValidationCalls'] == first['headBlockNum'] - source['blockNum'] + 1, 'Returned proof ancestry differs')
        for key in COUNTERS:
            require(integer(row[key]), 'Invalid proof counter'); sums[key] += row[key]
        require(row['httpGetAttempts'] == row['httpCompleted'] + row['httpErrors'], 'HTTP attempt accounting differs')
        require(row['httpNonSuccess'] <= row['httpCompleted'] and row['httpErrors'] <= row['unknownBodySizes'] <= row['httpGetAttempts'], 'HTTP result/unknown body accounting differs')
        require(row['httpCompleted'] > 0 or row['compressedBodyBytes'] == row['utf8ReencodedBodyBytes'] == 0,
            'Body bytes were invented for incomplete responses')
        for name, value in row['timings'].items():
            histogram(value)
            target = spans.setdefault(name, {'count': 0, 'totalNs': 0, 'buckets': [0] * 64})
            target['count'] += value['count']; target['totalNs'] += nanos(value['totalNs'])
            target['buckets'] = [a + b for a, b in zip(target['buckets'], value['buckets'])]
        for counter, stage in [('immutableGets', 'get'), ('bundleReads', 'read'), ('commitValidationCalls', 'validateCommit')]:
            require(row[counter] == row['timings'].get(stage, {}).get('count', 0), 'Stage count differs')
        require(row['httpGetAttempts'] == row['timings'].get('connectionRequest', {}).get('count', 0), 'Connection timing count differs')
        for name, value in row['stageFailures'].items():
            require(integer(value) and value <= row['timings'].get(name, {}).get('count', 0), 'Invalid stage failure count')
            failures[name] += value
        outcomes[row['outcome']] += 1
        nanos(row['openElapsedNs'])
        if maximum is None or row['httpGetAttempts'] > maximum['httpGetAttempts']:
            maximum = {k: row.get(k) for k in ['openId', 'source', 'selectionId', 'firstAuthority', 'lastAuthority',
                'outcome', 'immutableGets', 'bundleReads', 'commitValidationCalls', 'httpGetAttempts', 'openElapsedNs']}
    for value in spans.values():
        value['totalNs'] = str(value['totalNs'])
    return {'pid': expected_pid, 'role': expected_role, 'nativeRecords': len(rows), 'proofOpens': len(final),
        'lateOperationRecords': sum(r['event'] == 'proof_open_late_operation' for r in rows),
        'outcomes': dict(outcomes), 'stageFailures': dict(failures), **sums, 'nestedElapsed': spans,
        'observerIo': io, 'maximumHttpOpen': maximum, 'observerSummaryCoverage': 'before-this-row',
        'allProofsSettled': True, 'reportFailures': 0}


def analyze(files, metadata):
    process_rows = profiles.analyze(files, metadata)
    for row in process_rows:
        name = f"observer/{row['component']}/native-{row['pid']}.jsonl"
        row['proofIo'] = summarize_native(files[name], row['pid'], row['role'])
    expected = {f"observer/{p['component']}/native-{p['pid']}.jsonl" for p in process_rows}
    require({n for n in files if re.fullmatch(r'observer/(api|master)/native-[0-9]+\.jsonl', n)} == expected, 'Native/process census differs')
    return process_rows


def validate_run(run):
    require(run['sourceRevision'] == REVISION and run['status'] == 'failed' and run['profilingStatus'] == 'captured', 'Frozen capture identity/result differs')
    require(run['successfulHeldPrefixes'] == [1, 33, 122, 256, 397] and run['releasedThrough'] == 685, 'Source gates changed')
    require(run['sourceLastSentBlock'] == 661 and run['sourceLastAckBlock'] == 653 and run['sourceSendCount'] == 661 and run['sourceAckCount'] == 653,
        'Released source was substituted for actual coverage')
    require('projection cursor 685 did not complete' in run['error'] and run['wholeSourceReplayPassed'] is False and run['releaseQualified'] is False, 'Failed replay was promoted')
    require(run['incumbentsPreserved'] is True and run['incumbentsBefore'] and all(v in run['incumbentsAfter'] for v in run['incumbentsBefore']), 'Incumbent preservation failed')
    require(len(run['cleanup']) == 9 and {v['name'] for v in run['cleanup']} == {'api', 'master', 'replay', 'rpc', 'bulk',
        'redis', 'mongo-client', 'elasticsearch', 'owned-mongodb'} and all(v['ok'] is True for v in run['cleanup']), 'Cleanup differs')
    require(len(run['driverSteps']) == 11 and {v['name']: v['exitCode'] for v in run['driverSteps']} == {'bundle-verify': 0, 'bundle-fetch': 0, 'source-worktree': 0,
        'npm-ci': 0, 'typecheck': 0, 'build': 0, 'qualification-check': 0, 'native-metrics-tests': 0, 'services': 0,
        'replay': 1, 'services-cleanup': 0}, 'Original pipeline lifecycle changed')


def credential_values(raw, report):
    values = set()
    def collect(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key.lower() in ['password', 'pass', 'token', 'secret', 'api_key', 'apikey', 'private_key', 'privatekey', 'authorization']:
                    if isinstance(item, str) and len(item) >= 8: values.add(item.encode())
                collect(item)
        elif isinstance(value, list):
            for item in value: collect(item)
    collect(report.get('connections', {}))
    for name, data in raw.items():
        if name.endswith('.json') and (name.startswith(('fixture/', 'capture/config/')) or name == 'capture/config.json' or name.endswith('/connections.json')):
            collect(json.loads(data))
    return values


def publish(source, output, node):
    require(source.stat().st_size == RAW_BYTES and profiles.sha(source.read_bytes()) == RAW_SHA, 'Not the frozen #301 capture')
    raw, aliases = profiles.read_archive(source)
    original = json.loads(raw['manifest.json']); inventory = {v['path']: v for v in original['files']}
    require(len(inventory) == len(original['files']) == 8077 and set(raw) == set(inventory) | {'manifest.json'}, 'Raw inventory differs')
    require(profiles.sha(raw['manifest.json']) == 'f2b4e9b9ce5990ab6ce6a51fa1dc97832655829487a18c7ce73d5ad87ab17ddd', 'Raw manifest differs')
    for name, entry in inventory.items():
        require(len(raw[name]) == entry['bytes'] and profiles.sha(raw[name]) == entry['sha256'], 'Raw bytes differ')
    require(aliases == {v['path']: v['target'] for v in original['aliases']} and len(aliases) == 1 and all(v in raw for v in aliases.values()), 'Raw alias differs')
    require(sum(len(raw[n]) for n in inventory) == 135908854, 'Raw size coverage differs')
    report, job = json.loads(raw['capture/report.json']), json.loads(raw['supervisor/report.json'])
    require(report['gitHead'] == job['sourceRevision'] == REVISION, 'Loaded source differs')
    private_source = job['source']; private_root = str(PurePosixPath(private_source).parent)
    replacements = [(private_source, '/qualification/source'), (private_root, profiles.PUBLIC_ROOT)]
    redact = lambda value: profiles.relocate(value, replacements)
    receipts = [copy.deepcopy(item) for component in report['profiling']['components'] for item in component['processes']]
    metadata = {'sourceRevision': REVISION, 'primaryPids': {'api': report['apiPid'], 'master': report['masterPid']},
        'logRoot': job['output'], 'profiles': [{k: p[k] for k in ['component', 'pid', 'role', 'file', 'samples', 'durationMicros']}
            | {'sourceSha256': p['sha256'], 'sourceBytes': p['bytes']} for p in receipts]}
    original_observers = {name[8:]: data for name, data in raw.items() if name.startswith('capture/observer/')}
    profiles.audit_with_node(original_observers, metadata, node, 'original')
    published, entries = profiles.publish_observations(raw, 'capture/', redact)
    for item in metadata['profiles']:
        entry = next(e for e in entries if e['path'] == item['file'])
        item.update({'publishedSha256': entry['sha256'], 'publishedBytes': entry['bytes']})
    metadata['logRoot'] = redact(metadata['logRoot'])
    sessions = report['replay']['sessions']
    run = {'sourceRevision': REVISION, 'status': report['status'], 'profilingStatus': report['profiling']['status'],
        'startedAt': report['startedAt'], 'completedAt': report['completedAt'], 'runtime': redact(report['runtime']),
        'successfulHeldPrefixes': [v['through'] for v in report['prefixes']], 'error': redact(report['error']),
        'releasedThrough': report['replay']['through'], 'sourceLastSentBlock': max(v for s in sessions for v in s['sent']),
        'sourceLastAckBlock': max(v for s in sessions for v in s['acknowledged']), 'sourceSendCount': sum(len(s['sent']) for s in sessions),
        'sourceAckCount': sum(len(s['acknowledged']) for s in sessions), 'cleanup': report['cleanup'],
        'driverSteps': [{k: s[k] for k in ['name', 'startedAt', 'pid', 'exitCode', 'completedAt']} for s in job['steps']],
        'incumbentsPreserved': job['incumbentsPreserved'], 'incumbentsBefore': job['incumbentsBefore'], 'incumbentsAfter': job['incumbentsAfter'],
        'masterExit': report['masterExit'], 'apiExit': report['apiExit'],
        'masterShutdown': redact(report['masterShutdown']), 'apiShutdown': redact(report['apiShutdown']),
        'limits': report['limits'], 'planSha256': report['planSha256'], 'oracleHashes': report['oracleHashes'],
        'wholeSourceReplayPassed': False, 'releaseQualified': False, 'bulkRequests': report['bulkCapture']['recordedRequests']}
    run = redact(run)
    validate_run(run)
    provenance = redact({k: job[k] for k in ['sourceRevision', 'planSha256', 'jobSha256', 'bundleSha256', 'provenance', 'hostBefore', 'hostAfter']})
    for name, value in [('run.json', run), ('source.json', report['source']), ('source-replay.json', report['replay']),
            ('recovery-final.json', report['lastRecovery']), ('provenance.json', provenance)]:
        content = profiles.encoded(redact(value))
        try:
            profiles.scan(content)
        except ValueError as error:
            raise ValueError('Private marker in derived ' + name) from error
        published[name] = content
        entries.append({'path': name, 'bytes': len(content), 'sha256': profiles.sha(content), 'treatment': 'derived-metadata'})
    analysis = analyze(published, metadata)
    profiles.audit_with_node(published, metadata, node, 'published')
    archive = profiles.tar_bytes(published)
    manifest = {'schemaVersion': 1, 'rawArchiveSha256': RAW_SHA, 'rawArchiveBytes': RAW_BYTES,
        'rawManifestFilesVerified': 8077, 'rawManifestSelfFiles': 1, 'rawAliasesVerified': 1,
        'rawVerifiedUncompressedBytes': 135908854, 'publishedArchive': {'file': 'evidence.tar.gz', 'bytes': len(archive), 'sha256': profiles.sha(archive)},
        'profileAudit': metadata, 'files': entries}
    summary = profiles.encoded({'run': run, 'processes': analysis})
    values = {'evidence.tar.gz': archive, 'manifest.json': profiles.encoded(manifest), 'summary.json': summary,
        'resources.csv': profiles.resource_csv(analysis), 'proof-io.csv': proof_csv(analysis)}
    require(not output.exists(), 'Publication directory must be new')
    for name, value in values.items():
        if name != 'evidence.tar.gz': profiles.scan(value)
    secret_values = credential_values(raw, report)
    for value in list(published.values()) + [values[n] for n in values if n != 'evidence.tar.gz']:
        require(all(secret not in value for secret in secret_values), 'A literal fixture credential escaped publication')
    output.mkdir(parents=True)
    for name, value in values.items(): (output / name).write_bytes(value)
    print(json.dumps({'publishedFiles': len(published), 'profiles': len(metadata['profiles']), 'archiveBytes': len(archive),
        'archiveSha256': profiles.sha(archive), 'replayPassed': False}))


def verify(directory, node):
    manifest = json.loads((directory / 'manifest.json').read_bytes())
    require(manifest['rawArchiveSha256'] == RAW_SHA and manifest['rawArchiveBytes'] == RAW_BYTES, 'Raw identity differs')
    require([manifest[k] for k in ['rawManifestFilesVerified', 'rawManifestSelfFiles', 'rawAliasesVerified', 'rawVerifiedUncompressedBytes']]
        == [8077, 1, 1, 135908854], 'Raw coverage claims differ')
    archive = directory / 'evidence.tar.gz'; receipt = manifest['publishedArchive']
    require(archive.stat().st_size == receipt['bytes'] and profiles.sha(archive.read_bytes()) == receipt['sha256'], 'Publication archive differs')
    files, aliases = profiles.read_archive(archive)
    require(not aliases, 'Published links are forbidden')
    expected = {v['path']: v for v in manifest['files']}
    require(len(expected) == len(manifest['files']) == 8045 and set(files) == set(expected), 'Publication inventory differs')
    for name, data in files.items():
        entry = expected[name]; profiles.scan(data)
        require(len(data) == entry['bytes'] and profiles.sha(data) == entry['sha256'], 'Publication bytes differ')
        treatment = profiles.observation_treatment(name)
        if treatment is None:
            require(name in ['run.json', 'source.json', 'source-replay.json', 'recovery-final.json', 'provenance.json'], 'Unapproved publication member')
            treatment = 'derived-metadata'
        require(entry['treatment'] == treatment and (treatment == 'derived-metadata' or entry['sourcePath'] == 'capture/' + name), 'Source/treatment claims differ')
        if entry['treatment'] == 'verbatim':
            require(entry['sourceBytes'] == len(data) and entry['sourceSha256'] == profiles.sha(data), 'Unchanged bytes claim differs')
    metadata = manifest['profileAudit']; require(metadata['sourceRevision'] == REVISION, 'Profile source differs')
    summary = json.loads((directory / 'summary.json').read_bytes())
    require(summary['run'] == json.loads(files['run.json']), 'Run summary differs'); validate_run(summary['run'])
    replay = json.loads(files['source-replay.json'])
    require(replay['through'] == 685 and sorted(v for s in replay['sessions'] for v in s['sent']) == list(range(1, 662))
        and sorted(v for s in replay['sessions'] for v in s['acknowledged']) == list(range(1, 654)), 'Actual source sessions differ')
    actual = analyze(files, metadata)
    require(summary['processes'] == actual, 'Recomputed I/O/CPU summary differs')
    require((directory / 'resources.csv').read_bytes() == profiles.resource_csv(actual), 'Resource CSV differs')
    require((directory / 'proof-io.csv').read_bytes() == proof_csv(actual), 'Proof I/O CSV differs')
    profiles.audit_with_node(files, metadata, node, 'published')
    print(json.dumps({'verifiedFiles': len(files), 'profiles': len(actual), 'proofOpens': sum(p['proofIo']['proofOpens'] for p in actual),
        'verbatimFiles': sum(v['treatment'] == 'verbatim' for v in expected.values()), 'replayPassed': False}))


def proof_csv(processes):
    handle = io.StringIO(newline='')
    columns = ['component', 'pid', 'role', 'proofOpens', *COUNTERS, 'observerWriteCalls', 'observerSyncCalls', 'observerWriteNs', 'observerSyncNs']
    writer = csv.DictWriter(handle, fieldnames=columns, lineterminator='\n'); writer.writeheader()
    for process in processes:
        value = process['proofIo']; observer = value['observerIo']
        writer.writerow({k: process[k] for k in ['component', 'pid', 'role']} | {k: value[k] for k in ['proofOpens', *COUNTERS]}
            | {'observerWriteCalls': observer['writeElapsed']['count'], 'observerSyncCalls': observer['syncElapsed']['count'],
                'observerWriteNs': observer['writeElapsed']['totalNs'], 'observerSyncNs': observer['syncElapsed']['totalNs']})
    return handle.getvalue().encode()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['publish', 'verify']); parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path, nargs='?'); parser.add_argument('--node', default='node')
    args = parser.parse_args()
    if args.mode == 'publish':
        if args.output is None: parser.error('publish requires a new output directory')
        publish(args.input, args.output, args.node)
    else:
        if args.output is not None: parser.error('verify does not accept output')
        verify(args.input, args.node)
