"""Verify the frozen #286 local qualification archive using only Python's standard library."""
import hashlib
import json
import zipfile
from collections import Counter, defaultdict
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
ZIP_SHA = '15f6173004016f9dd4e2693714b668a6d234d88379834417d61ef09e70a572bd'
INDEX_SHA = 'd1a433d1c3bacab768c1bceb824ab7527d80152ec992b4f95f488e88daa832eb'
MANIFEST_SHA = '4cb26682f3d2aefff4bcdc7ad2307ca94073dd088d0c3b351a5f40e3dd0e635b'

def digest(data):
    return hashlib.sha256(data).hexdigest()

archive = (HERE / 'qualification.zip').read_bytes()
index_bytes = (HERE / 'index.json').read_bytes()
manifest_bytes = (HERE / 'transport-manifest.json').read_bytes()
assert digest(archive) == ZIP_SHA and len(archive) == 6299757
assert digest(index_bytes) == INDEX_SHA
assert digest(manifest_bytes) == MANIFEST_SHA
index = json.loads(index_bytes)
manifest = json.loads(manifest_bytes)
assert manifest['archiveSha256'] == ZIP_SHA and manifest['indexSha256'] == INDEX_SHA

with zipfile.ZipFile(HERE / 'qualification.zip') as z:
    members = z.infolist()
    expected = {item['path']: item for item in index['members']}
    expected['index.json'] = {'bytes': len(index_bytes), 'sha256': INDEX_SHA}
    patch = z.read('tests.patch')
    expected['tests.patch'] = {'bytes': len(patch), 'sha256': index['patchSha256']}
    assert len(members) == 454 and len(expected) == 454
    assert len({item.filename.casefold() for item in members}) == 454
    assert set(expected) == {item.filename for item in members}
    assert sum(item.file_size for item in members) < 128 * 1024 * 1024
    for item in members:
        name = item.filename
        assert not PurePosixPath(name).is_absolute() and '..' not in PurePosixPath(name).parts
        assert ':' not in name and '\\' not in name
        data = z.read(name)
        assert len(data) == expected[name]['bytes'] and digest(data) == expected[name]['sha256'], name
    assert z.read('index.json') == index_bytes
    assert digest(patch) == manifest['patchSha256'] and len(patch) == index['patchBytes']

    packet_bytes = z.read(index['qualificationPacket'])
    assert digest(packet_bytes) == index['qualificationPacketSha256'] == manifest['finalPacketSha256']
    packet = json.loads(packet_bytes)
    assert packet['productHead'] == index['qualifiedCompositeHead'] == manifest['base']
    assert len(packet['canonicalProductSources']) == 16 and len(index['tests']) == 4
    prefix = 'evidence/final-ee8b1d65/'
    for item in packet['canonicalProductSources']:
        source = z.read(prefix + 'product/' + item['path'])
        assert digest(source.replace(b'\r\n', b'\n')) == item['canonicalSha256']
    for item in index['tests']:
        source = z.read(prefix + item['path'])
        assert digest(source.replace(b'\r\n', b'\n')) == item['canonicalSha256']

    assert len(packet['commands']) == 5
    for command in packet['commands']:
        assert command['exitCode'] == 0 and command['sourceBefore'] == command['sourceAfter']
        assert digest(z.read(prefix + command['log'])) == command['logSha256']
    for emission in packet['emissions'].values():
        assert digest(z.read(prefix + emission['manifest'])) == emission['sha256']

    matrix_bytes = z.read(index['caseMatrix'])
    assert digest(matrix_bytes) == packet['caseMatrixSha256']
    matrix = json.loads(matrix_bytes)
    assert len(matrix) == 46
    assert Counter(item['runtime'] for item in matrix) == {'v22.23.3': 23, 'v24.19.0': 23}
    assert Counter(item['runtime'] for item in matrix for _ in item['cases']) == {
        'v22.23.3': 65, 'v24.19.0': 65
    }
    observed_cache = {}
    for entry in matrix:
        raw = z.read(prefix + entry['stdout'])
        assert digest(raw) == entry['stdoutSha256']
        stderr = entry['stdout'].replace('.stdout.log', '.stderr.log')
        assert digest(z.read(prefix + stderr)) == entry['stderrSha256']
        observed = json.loads(raw.decode('utf8').strip().splitlines()[-1])
        assert observed['passed'] and observed['native'] == entry['runtime']
        assert observed['mode'] == entry['mode'] and len(observed['cases']) == len(entry['cases'])
        for actual, claimed in zip(observed['cases'], entry['cases']):
            assert all(actual[key] == value for key, value in claimed.items())
        if entry['mode'] == 'wire-cache':
            observed_cache[entry['runtime']] = observed['cases'][0]

    def grouped(case):
        values = defaultdict(lambda: [0, 0, 0, 0])
        for row in case['reads']:
            value = values[row['stage'], row['index'], row['family']]
            value[0] += 1
            value[1] += row['returnedJsonBytes']
            value[2] += row['errorMetaJsonBytes']
            value[3] += not row['succeeded']
        declared = {
            (row['stage'], row['index'], row['family']): [
                row['getCalls'], row['successfulReturnedJsonBytes'], row['failedErrorMetaJsonBytes'], row['failedCalls']
            ] for row in case['summary']
        }
        assert dict(values) == declared
        return declared

    for native in ('22', '24'):
        runtime = 'v' + native + ('.23.3' if native == '22' else '.19.0')
        current = observed_cache[runtime]
        baseline = json.loads(z.read(f'evidence/cache-baseline-f80/node{native}.measurement.json'))
        assert grouped(current) == grouped(baseline)
        selected = [row for row in current['reads'] if row['stage'] == 'ds-same-cargo']
        assert len(selected) == 238 and sum(row['returnedJsonBytes'] for row in selected) == 10565575
        assert current['outputNames'] == ['setcode', 'setabi', 'setcode', 'setabi']
        assert current['acknowledgments'] == 2

print('Verified #286 archive: 454 files, 5 successful commands, 46 wrappers, 130 case observations; controlled Wire36 cache deltas zero.')
