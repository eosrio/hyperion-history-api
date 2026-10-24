"""Publish/verify the frozen #297 capture. Raw configuration and console files are never exported."""
import argparse
import collections
import csv
import gzip
import hashlib
import io
import json
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

RAW_SHA = '98f5370fd4c47a751a2d2229c3eadd32f633108009d5ac898ab7cd11a4b4c48b'
REVISION = '3febe95e9faf52067f96350b9f9df0dd2e2a2678'
REPLAY = 'hapi297-node24-profile-v2-replay/'
PRIVATE_ROOT = '/var/tmp/hyperion-qualification/hapi288-20261023T1845Z'
PUBLIC_ROOT = '/qualification/run'
LIMIT = 512 * 1024 * 1024
SENSITIVE = re.compile(rb'/var/tmp/|127\.0\.0\.1|192\.168\.|100\.87\.|https?://[^\s"\']*:[^\s"\']*@|Basic [A-Za-z0-9+/=]+|Bearer [A-Za-z0-9._-]+|"(?:password|passwd|api_key|apiKey)"\s*:')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()


def ordinary_name(name):
    p = PurePosixPath(name)
    if not name or p.is_absolute() or any(v in ('', '.', '..') for v in name.split('/')) or '\\' in name or ':' in name:
        raise ValueError('Nonordinary archive member')
    return name


def read_archive(path):
    files, aliases, total, names = {}, {}, 0, set()
    if path.stat().st_size > 64 * 1024 * 1024:
        raise ValueError('Compressed evidence exceeds bound')
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive:
            ordinary_name(member.name)
            if member.name in names or len(names) >= 10000:
                raise ValueError('Duplicate/excess archive members')
            names.add(member.name)
            if member.isdir():
                continue
            if member.issym():
                ordinary_name(member.linkname)
                aliases[member.name] = str(PurePosixPath(member.name).parent / member.linkname)
                continue
            if not member.isfile() or member.size > 32 * 1024 * 1024 or total + member.size > LIMIT:
                raise ValueError('Nonordinary/excess evidence file')
            data = archive.extractfile(member).read(member.size + 1)
            if len(data) != member.size:
                raise ValueError('Incomplete evidence file')
            total += len(data)
            files[member.name] = data
    return files, aliases


def relocate(value, replacements):
    if isinstance(value, str):
        for original, replacement in replacements:
            value = value.replace(original, replacement)
        return value
    if isinstance(value, list):
        return [relocate(v, replacements) for v in value]
    if isinstance(value, dict):
        result = {relocate(k, replacements): relocate(v, replacements) for k, v in value.items()}
        if len(result) != len(value):
            raise ValueError('Redaction would collapse distinct metadata keys')
        return result
    return value


def redact(value):
    return relocate(value, [(PRIVATE_ROOT + '/source', '/qualification/source'), (PRIVATE_ROOT, PUBLIC_ROOT)])


def scan(data):
    if SENSITIVE.search(data):
        raise ValueError('Private path, endpoint or credential marker in publication')


def observation_treatment(name):
    if name.startswith(('bulk/', 'prefixes/')) or re.fullmatch(r'observer/(api|master)/native-[0-9]+\.jsonl', name):
        return 'verbatim'
    if re.fullmatch(r'observer/(api|master)/worker-[0-9]+\.cpuprofile', name):
        return 'profile-urls-redacted'
    if re.fullmatch(r'observer/(api|master)/worker-[0-9]+\.jsonl', name):
        return 'observation-paths-redacted'
    return None


def publish_observations(raw, prefix, redactor):
    published, entries = {}, []
    for name, data in sorted(raw.items()):
        if not name.startswith(prefix):
            continue
        relative = name[len(prefix):]
        treatment = observation_treatment(relative)
        if treatment is None:
            continue
        if treatment == 'verbatim':
            content = data
        elif treatment == 'profile-urls-redacted':
            value = json.loads(data)
            for node in value['nodes']:
                node['callFrame']['url'] = redactor(node['callFrame']['url'])
            content = encoded(value)
        else:
            content = b''.join(encoded(redactor(json.loads(line))) for line in data.splitlines())
        scan(content); published[relative] = content
        entries.append({'path': relative, 'sourcePath': name, 'sourceBytes': len(data), 'sourceSha256': sha(data),
            'bytes': len(content), 'sha256': sha(content), 'treatment': treatment})
    return published, entries


def summarize_profile(profile, rows):
    nodes = {v['id']: v for v in profile['nodes']}
    if len(nodes) != len(profile['nodes']) or len(nodes) > 200000:
        raise ValueError('Invalid profile nodes')
    parents = {}
    for node in nodes.values():
        for child in node.get('children', []):
            if child not in nodes or child in parents:
                raise ValueError('Invalid profile tree')
            parents[child] = node['id']
    if len(nodes) - len(parents) != 1:
        raise ValueError('Invalid profile root')
    samples = profile['samples']
    if not samples or len(samples) != len(profile['timeDeltas']) or len(samples) > 1000000:
        raise ValueError('Invalid profile sample intervals')
    hits, self_counts, inclusive = collections.Counter(samples), collections.Counter(), collections.Counter()
    fsync, observer_fsync = 0, 0
    for ident, count in hits.items():
        stack, visited = [], set()
        current = ident
        while current in nodes:
            if current in visited or len(visited) > 4096:
                raise ValueError('Cyclic/excess profile depth')
            visited.add(current)
            frame = nodes[current]['callFrame']
            stack.append((frame['url'], frame['functionName'], frame['lineNumber'], frame['columnNumber']))
            current = parents.get(current)
        if not stack:
            raise ValueError('Unknown sampled node')
        self_counts[stack[0]] += count
        # Recursive appearances of one source location count once per sampled stack.
        for frame in set(stack):
            inclusive[frame] += count
        if stack[0][1] == 'fsync':
            fsync += count
            if any(url.endswith('/scripts/qualification/portable-state-worker-native-observer.mjs') and name == 'record'
                   for url, name, _, _ in stack):
                observer_fsync += count
    resources = [r for r in rows if r['kind'] == 'sample']
    if len(resources) < 2 or any(r['elapsedMs'] <= 0 for r in resources):
        raise ValueError('Missing process resource interval')
    for row in resources:
        if any(not isinstance(row['cpuDeltaMicros'][kind], int) or row['cpuDeltaMicros'][kind] < 0 for kind in ('user', 'system')):
            raise ValueError('Invalid process CPU delta')
    for previous, current in zip(resources, resources[1:]):
        if current['monotonicMs'] <= previous['monotonicMs']:
            raise ValueError('Unordered resource samples')
        for kind in ('user', 'system'):
            if current['cpuTotalMicros'][kind] - previous['cpuTotalMicros'][kind] != current['cpuDeltaMicros'][kind]:
                raise ValueError('CPU counters do not reconcile')
    def frames(counts):
        return [{'url': k[0], 'function': k[1], 'line': k[2] + 1, 'column': k[3] + 1, 'samples': v}
                for k, v in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:20]]
    return {'resourceSamples': len(resources), 'resourceElapsedMs': sum(r['elapsedMs'] for r in resources),
        'cpuUserMicros': sum(r['cpuDeltaMicros']['user'] for r in resources),
        'cpuSystemMicros': sum(r['cpuDeltaMicros']['system'] for r in resources),
        'peakRssBytes': max(r['memory']['rss'] for r in resources),
        'peakHeapUsedBytes': max(r['memory']['heapUsed'] for r in resources),
        'lastRssBytes': resources[-1]['memory']['rss'], 'lastHeapUsedBytes': resources[-1]['memory']['heapUsed'],
        'profileSamples': len(samples), 'idleSamples': sum(v for k, v in self_counts.items() if k[1] == '(idle)'),
        'fsyncLeafSamples': fsync, 'nativeObserverFsyncLeafSamples': observer_fsync,
        'topSelfLocations': frames(self_counts), 'topInclusiveLocations': frames(inclusive)}


def analyze(files, metadata):
    result = []
    for receipt in metadata['profiles']:
        profile = json.loads(files[receipt['file']])
        rows = [json.loads(v) for v in files[receipt['file'].replace('.cpuprofile', '.jsonl')].splitlines()]
        result.append({'component': receipt['component'], 'pid': receipt['pid'], 'role': receipt['role'],
            **summarize_profile(profile, rows)})
    return result


def audit_with_node(files, metadata, node, mode):
    with tempfile.TemporaryDirectory(prefix='hyperion-profile-census-') as directory:
        root = Path(directory)
        for name, data in files.items():
            if name.startswith('observer/') and '/worker-' in name:
                target = root / ordinary_name(name)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        meta = root / 'audit-metadata.json'
        meta.write_bytes(encoded(metadata))
        command = [node, '--experimental-strip-types', str(Path(__file__).with_name('audit-native-wire-profile-evidence.mjs')),
            str(root), str(meta), mode]
        completed = subprocess.run(command, capture_output=True, timeout=60)
        if completed.returncode != 0:
            raise ValueError('Existing profile auditor rejected evidence: ' + completed.stderr.decode(errors='replace')[-2000:])
        result = json.loads(completed.stdout)
        if result.get('processes') != 14 or result.get('passed') is not True:
            raise ValueError('Incomplete profile census')


def tar_bytes(files):
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode='wb', filename='', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w') as archive:
            for name, data in sorted(files.items()):
                info = tarfile.TarInfo(ordinary_name(name))
                info.size, info.mode, info.mtime = len(data), 0o644, 0
                archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


def resource_csv(analysis):
    handle = io.StringIO(newline='')
    columns = ['component', 'pid', 'role', 'resourceSamples', 'resourceElapsedMs', 'cpuUserMicros', 'cpuSystemMicros',
        'peakRssBytes', 'peakHeapUsedBytes', 'lastRssBytes', 'lastHeapUsedBytes', 'profileSamples', 'idleSamples',
        'fsyncLeafSamples', 'nativeObserverFsyncLeafSamples']
    writer = csv.DictWriter(handle, fieldnames=columns, extrasaction='ignore', lineterminator='\n')
    writer.writeheader()
    writer.writerows(analysis)
    return handle.getvalue().encode()


def publish(source, output, node):
    if source.stat().st_size != 15548790 or sha(source.read_bytes()) != RAW_SHA:
        raise ValueError('Not the frozen #297 capture')
    raw, aliases = read_archive(source)
    manifest_name = 'hapi297-node24-profile-v2-raw-manifest.json'
    original = json.loads(raw[manifest_name])
    inventory = {v['path']: v for v in original['files']}
    if len(inventory) != len(original['files']) or len(inventory) != 8040 or set(raw) != set(inventory) | {manifest_name}:
        raise ValueError('Raw manifest coverage differs')
    for name, entry in inventory.items():
        if len(raw[name]) != entry['bytes'] or sha(raw[name]) != entry['sha256']:
            raise ValueError('Raw manifest bytes differ')
    if aliases != {v['path']: v['target'] for v in original['aliases']} or len(aliases) != 1 or any(v not in raw for v in aliases.values()):
        raise ValueError('Raw log alias differs')
    report = json.loads(raw[REPLAY + 'report.json'])
    if report['gitHead'] != REVISION or report['status'] != 'failed' or report['profiling']['status'] != 'captured':
        raise ValueError('Capture/replay status differs')
    job = json.loads(raw['hapi297-node24-profile-v2-report.json'])
    steps = [{k: step[k] for k in ('name', 'startedAt', 'pid', 'procStart', 'exitCode', 'completedAt')} for step in job['steps']]
    if {step['name']: step['exitCode'] for step in steps} != {'services': 0, 'replay': 1, 'services-cleanup': 0}:
        raise ValueError('Original service lifecycle differs')
    profiles = []
    for component in report['profiling']['components']:
        for item in component['processes']:
            profiles.append({k: item[k] for k in ['component', 'pid', 'role', 'file', 'samples', 'durationMicros']}
                | {'sourceSha256': item['sha256'], 'sourceBytes': item['bytes']})
    metadata = {'sourceRevision': REVISION, 'primaryPids': {'api': report['apiPid'], 'master': report['masterPid']},
        'logRoot': PRIVATE_ROOT + '/' + REPLAY.rstrip('/'), 'profiles': profiles}
    original_observers = {name[len(REPLAY):]: data for name, data in raw.items() if name.startswith(REPLAY + 'observer/')}
    audit_with_node(original_observers, metadata, node, 'original')
    published, entries = publish_observations(raw, REPLAY, redact)
    for item in profiles:
        entry = next(v for v in entries if v['path'] == item['file'])
        item.update({'publishedSha256': entry['sha256'], 'publishedBytes': entry['bytes']})
    metadata['logRoot'] = PUBLIC_ROOT + '/' + REPLAY.rstrip('/')
    provenance = redact(json.loads(raw['hapi297-node24-profile-v2-provenance.json']))
    source_identity = report['source']
    source_sessions = report['replay']['sessions']
    run = {'sourceRevision': REVISION, 'status': report['status'], 'profilingStatus': report['profiling']['status'],
        'startedAt': report['startedAt'], 'completedAt': report['completedAt'], 'runtime': redact(report['runtime']),
        'successfulHeldPrefixes': [v['through'] for v in report['prefixes']], 'error': redact(report['error']),
        'releasedThrough': report['replay']['through'],
        'sourceLastSentBlock': max((v for session in source_sessions for v in session['sent']), default=None),
        'sourceLastAckBlock': max((v for session in source_sessions for v in session['acknowledged']), default=None),
        'sourceSendCount': sum(len(v['sent']) for v in source_sessions),
        'sourceAckCount': sum(len(v['acknowledged']) for v in source_sessions), 'bulkRequests': report['bulkCapture']['recordedRequests'],
        'cleanup': report['cleanup'], 'driverSteps': steps,
        'masterExit': report['masterExit'], 'apiExit': report['apiExit'],
        'masterShutdown': report['masterShutdown'], 'apiShutdown': report['apiShutdown'],
        'limits': report['limits'], 'planSha256': report['planSha256'],
        'oracleHashes': report['oracleHashes'], 'captureHostOs': 'linux', 'captureHostCpuTopology': None,
        'hostCpuTopologyNote': 'Not recorded in this archived capture; no host-capacity comparison.',
        'wholeSourceReplayPassed': False, 'releaseQualified': False}
    run = redact(run)
    run['serviceImages'] = {name: {'configuredImage': value['Config']['Image'], 'imageId': value['Image']}
        for name, value in report['inspections'].items()}
    run['serviceImages']['mongodb'] = {'configuredImage': report['mongo']['container']['Config']['Image'],
        'imageId': report['mongo']['container']['Image']}
    for name, data in [('provenance.json', encoded(provenance)), ('source.json', encoded(source_identity)),
            ('run.json', encoded(run)), ('source-replay.json', encoded(report['replay'])),
            ('recovery-final.json', encoded(report['lastRecovery']))]:
        scan(data)
        published[name] = data
        entries.append({'path': name, 'bytes': len(data), 'sha256': sha(data), 'treatment': 'derived-metadata'})
    analysis = analyze(published, metadata)
    audit_with_node(published, metadata, node, 'published')
    archive = tar_bytes(published)
    manifest = {'schemaVersion': 1, 'rawArchiveSha256': RAW_SHA, 'rawArchiveBytes': 15548790,
        'rawManifestFilesVerified': 8040, 'rawManifestSelfFiles': 1, 'rawAliasesVerified': 1,
        'rawVerifiedUncompressedBytes': sum(map(len, raw.values())), 'rawCensusAuditedAtPublication': True,
        'publishedArchive': {'file': 'evidence.tar.gz', 'bytes': len(archive), 'sha256': sha(archive)},
        'profileAudit': metadata, 'files': entries}
    summary_bytes = encoded({'run': run, 'processes': analysis})
    for data in (encoded(manifest), summary_bytes, resource_csv(analysis)):
        scan(data)
    if output.exists():
        raise ValueError('Publication directory must be new')
    output.mkdir(parents=True)
    (output / 'evidence.tar.gz').write_bytes(archive)
    (output / 'manifest.json').write_bytes(encoded(manifest))
    (output / 'summary.json').write_bytes(summary_bytes)
    (output / 'resources.csv').write_bytes(resource_csv(analysis))
    print(json.dumps({'publishedFiles': len(published), 'profiles': len(profiles), 'archiveBytes': len(archive),
        'archiveSha256': sha(archive), 'replayPassed': False}))


def verify(directory, node):
    for name in ('manifest.json', 'summary.json', 'resources.csv'):
        scan((directory / name).read_bytes())
    manifest = json.loads((directory / 'manifest.json').read_bytes())
    if manifest['rawArchiveSha256'] != RAW_SHA or manifest['profileAudit']['sourceRevision'] != REVISION:
        raise ValueError('Evidence source identity differs')
    blob = directory / ordinary_name(manifest['publishedArchive']['file'])
    if blob.stat().st_size != manifest['publishedArchive']['bytes'] or sha(blob.read_bytes()) != manifest['publishedArchive']['sha256']:
        raise ValueError('Published archive hash/size differs')
    files, aliases = read_archive(blob)
    expected = {v['path']: v for v in manifest['files']}
    if aliases or len(expected) != len(manifest['files']) or set(files) != set(expected):
        raise ValueError('Published manifest coverage differs')
    for name, data in files.items():
        entry = expected[name]
        if len(data) != entry['bytes'] or sha(data) != entry['sha256']:
            raise ValueError('Published evidence bytes differ')
        if entry['treatment'] == 'verbatim' and (entry['sha256'] != entry['sourceSha256'] or entry['bytes'] != entry['sourceBytes']):
            raise ValueError('Original native/prefix/bulk bytes changed')
        scan(data)
    summary = json.loads((directory / 'summary.json').read_bytes())
    if summary['run'] != json.loads(files['run.json']) or summary['processes'] != analyze(files, manifest['profileAudit']):
        raise ValueError('Derived summary differs from archived observations')
    if (directory / 'resources.csv').read_bytes() != resource_csv(summary['processes']):
        raise ValueError('Resource table differs from archived observations')
    source = json.loads(files['source-replay.json'])
    sessions = source['sessions']
    for field, actual in [('releasedThrough', source['through']), ('sourceSendCount', sum(len(v['sent']) for v in sessions)),
            ('sourceAckCount', sum(len(v['acknowledged']) for v in sessions)),
            ('sourceLastSentBlock', max((v for session in sessions for v in session['sent']), default=None)),
            ('sourceLastAckBlock', max((v for session in sessions for v in session['acknowledged']), default=None))]:
        if summary['run'][field] != actual:
            raise ValueError('Replay progress differs from actual session records')
    if summary['run']['status'] != 'failed' or summary['run']['profilingStatus'] != 'captured' or summary['run']['releaseQualified'] is not False:
        raise ValueError('Failure/qualification boundary changed')
    if {v['name']: v['exitCode'] for v in summary['run']['driverSteps']} != {'services': 0, 'replay': 1, 'services-cleanup': 0}:
        raise ValueError('Original service lifecycle differs')
    audit_with_node(files, manifest['profileAudit'], node, 'published')
    print(json.dumps({'verifiedFiles': len(files), 'profiles': len(manifest['profileAudit']['profiles']),
        'verbatimFiles': sum(v['treatment'] == 'verbatim' for v in expected.values()), 'replayPassed': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['publish', 'verify'])
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path, nargs='?')
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    if args.mode == 'publish':
        if args.output is None:
            parser.error('publish requires a new output directory')
        publish(args.input, args.output, args.node)
    else:
        if args.output is not None:
            parser.error('verify does not accept an output directory')
        verify(args.input, args.node)
