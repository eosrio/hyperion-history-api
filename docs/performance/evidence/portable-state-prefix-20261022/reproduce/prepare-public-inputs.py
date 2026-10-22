"""Select only SHA-pinned regular public inputs; never extract archive paths wholesale."""
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

if not __debug__:
    raise RuntimeError('Run this verification recipe without Python -O or PYTHONOPTIMIZE.')

HERE = Path(__file__).resolve().parent
ARCHIVE_SHA = '1e272c1f9c9bd10db3be5bcd11c67b98dbcef1f0f5fec53ef328d56720cef6b3'
MANIFEST_SHA = '22d25840359e6e271d759f23e4166240c3f49533f47d27e41a91f44e60e05ba9'
HEAD = '03dd3e9758473bc563bf8d7cbbbc0557232f17dc'
assert len(sys.argv) == 4, 'usage: python prepare-public-inputs.py ARCHIVE EXTERNAL_MANIFEST NEW_CHILD_FOLDER'
archive, external = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
name = sys.argv[3]
if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', name) or re.fullmatch(r'(?:con|prn|aux|nul|com[1-9]|lpt[1-9])', name):
    raise ValueError('Invalid portable child name')
target = HERE / name
if target.is_symlink() or target.exists():
    raise ValueError('Target must be fresh and not a symlink')
if target.resolve(strict=False).parent != HERE:
    raise ValueError('Target resolved parent must equal the helper folder')

def sha(value):
    return hashlib.sha256(value).hexdigest()

def bounded(path, maximum):
    assert path.is_file() and not path.is_symlink()
    before = path.stat()
    assert 0 < before.st_size <= maximum
    value = path.read_bytes()
    after = path.stat()
    assert len(value) == before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns
    return value

def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode()

def ordinary(name):
    p = PurePosixPath(name)
    assert isinstance(name, str) and '\\' not in name and not p.is_absolute() and str(p) == name
    assert all(part not in ('', '.', '..') for part in p.parts)
    return p

manifest_bytes = bounded(external, 32 * 1024 * 1024)
assert sha(manifest_bytes) == MANIFEST_SHA
manifest = json.loads(manifest_bytes)
assert archive.is_file() and not archive.is_symlink() and archive.stat().st_size == 24543244
with archive.open('rb') as handle:
    assert hashlib.file_digest(handle, 'sha256').hexdigest() == ARCHIVE_SHA
assert manifest['archive']['sha256'] == ARCHIVE_SHA
cases = ['profile24-prefix288-cpu-on', 'profile24-prefix288-cpu-off']
suffixes = {'report.public.json', 'invocation.public.json', 'runtimes.public.json', 'source-emission-pins.json',
            'archive-receipt.public.json', 'stages/profile-prefix-288.json'}
selected = {}
for entry in manifest['files']:
    for case in cases:
        prefix = 'cases/' + case + '/'
        if not entry['path'].startswith(prefix):
            continue
        part = entry['path'][len(prefix):]
        if part in suffixes or part.startswith('observer/') and part.endswith(('.jsonl', '.cpuprofile')):
            ordinary(entry['path'])
            assert entry['path'] not in selected and 0 < entry['bytes'] <= 32 * 1024 * 1024
            selected[entry['path']] = entry
assert len(selected) == 54 and sum(entry['bytes'] for entry in selected.values()) < 128 * 1024 * 1024
target.mkdir()
seen, count, declared = set(), 0, 0
with tarfile.open(archive, 'r|gz') as stream:
    for member in stream:
        count += 1
        declared += member.size
        assert count <= 20000 and declared <= 512 * 1024 * 1024
        if member.name not in selected:
            continue
        assert member.isfile() and not member.issym() and not member.islnk() and member.name not in seen
        entry = selected[member.name]
        assert member.size == entry['bytes']
        value = stream.extractfile(member).read(member.size + 1)
        assert len(value) == entry['bytes'] and sha(value) == entry['sha256']
        path = target.joinpath(*ordinary(member.name).parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as handle:
            handle.write(value)
        seen.add(member.name)
assert seen == set(selected)

def put(name, value):
    value = (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()
    with (target / name).open('xb') as handle:
        handle.write(value)
    return {'file': name, 'bytes': len(value), 'sha256': sha(value)}

recipes = []
for case in cases:
    prefix = 'cases/' + case
    report_name = prefix + '/report.public.json'
    public = json.loads(bounded(target / report_name, 16 * 1024 * 1024))
    assert public['gitHead'] == HEAD and public['status'] == 'profiled-prefix'
    omissions = public['publication']['omissions']
    omission = next(row for row in omissions if row['pointer'] == '/runtime/executable')
    assert omission['present'] is True and 'executable' not in public['runtime']
    starts = [row for group in public['profiling']['observerCompletion'] for row in group['events'] if row['kind'] == 'start']
    assert len(starts) == 14 and len({row['pid'] for row in starts}) == 14
    raw_starts = []
    for entry in selected.values():
        if entry['path'].startswith(prefix + '/observer/') and entry['path'].endswith('.jsonl'):
            rows = [json.loads(line) for line in bounded(target / entry['path'], 24 * 1024 * 1024).splitlines()]
            values = [row for row in rows if row['kind'] == 'start']
            assert len(values) == 1
            raw_starts.extend(values)
    assert sorted(starts, key=lambda row: row['pid']) == sorted(raw_starts, key=lambda row: row['pid'])
    executables = {row['executable'] for row in raw_starts}
    assert len(executables) == 1
    executable = next(iter(executables))
    assert sha(canonical(executable)) == omission['canonicalValueSha256'] and len(canonical(executable)) == omission['canonicalValueBytes']
    report = copy.deepcopy(public)
    report['runtime']['executable'] = executable
    files = report['profiling']['pins']['files']
    assert all(set(row) == {'path', 'bytes', 'sha256'} for row in files)
    # Recreate the originally pinned insertion order without changing any entry value.
    report['profiling']['pins']['files'] = [{'path': row['path'], 'bytes': row['bytes'], 'sha256': row['sha256']} for row in files]
    assert report['profiling']['pins']['files'] == public['profiling']['pins']['files']
    serialized = json.dumps(report['profiling']['pins']['files'], separators=(',', ':'), ensure_ascii=False).encode()
    assert sha(serialized) == report['profiling']['pins']['inventorySha256']
    source_pins = json.loads(bounded(target / (prefix + '/source-emission-pins.json'), 1024 * 1024))
    members = {row['path']: row for row in source_pins['members']}
    assert source_pins['head'] == HEAD
    assert all(members[row['path']] == row for row in files if row['path'] in members)
    report_pin = put(prefix + '/report.analysis-input.json', report)
    groups = []
    for entry in report['cleanup']:
        if 'shutdown' not in entry:
            continue
        shutdown = entry['shutdown']
        pids = sorted([shutdown['pid']] + [row['pid'] for row in shutdown['childExits']])
        directory = prefix + '/observer/' + entry['name']
        groups.append({'name': entry['name'], 'directory': directory,
                       'observers': [{'pid': pid, 'sha256': selected[directory + f'/worker-{pid}.jsonl']['sha256']} for pid in pids],
                       'profiles': [{'pid': pid, 'sha256': selected[directory + f'/worker-{pid}.cpuprofile']['sha256']} for pid in pids]
                       if report['profiling']['cpuCapture']['enabled'] else []})
    repository = next(row for row in raw_starts if row['role'] == 'projection')['repository']
    analysis = {'schemaVersion': 1, 'dataKind': 'actual-capture',
                'runReport': {'file': report_pin['file'], 'sha256': report_pin['sha256']},
                'phaseEvidence': {'file': prefix + '/stages/profile-prefix-288.json', 'sha256': selected[prefix + '/stages/profile-prefix-288.json']['sha256']},
                'classification': {'applicationRoots': [repository], 'observerFiles': [repository + '/scripts/qualification/es955-worker-observer.mjs', repository + '/scripts/qualification/portable-state-recovery-observer.mjs']},
                'groups': groups}
    mode = 'on' if case.endswith('-on') else 'off'
    recipe = put('analysis-manifest.' + mode + '.json', analysis)
    recipes.append({'case': case, 'publicReport': {key: selected[report_name][key] for key in ['path', 'bytes', 'sha256']},
                    'publicPublicationProvenance': public['publication'], 'analysisInputReport': report_pin,
                    'manifest': recipe, 'restoredExecutable': {'source': 'all 14 exact public raw start receipts, equal to report lifecycle starts',
                    'matchesPublishedOmissionDigest': True, 'canonicalSha256': omission['canonicalValueSha256']},
                    'inventoryChange': 'Original path,bytes,sha256 entry insertion order restored; values and array order unchanged; original inventory digest verified.',
                    'unchangedNamedOmissions': [row['pointer'] for row in omissions if row['pointer'] != '/runtime/executable'],
                    'reportInventoryEntriesAlsoInSourcePins': sum(row['path'] in members for row in files),
                    'reportOnlyInventoryPaths': [row['path'] for row in files if row['path'] not in members]})
receipt = {'archiveSha256': ARCHIVE_SHA, 'externalManifestSha256': MANIFEST_SHA, 'archiveMembersScanned': count,
           'archiveDeclaredBytes': declared, 'selectedRegularMembers': len(seen), 'selected': list(selected.values()),
           'derivation': 'Public reports remain unchanged. Separate analysis-input reports restore one public-receipt-proven runtime path and serialization order. No analyzer gate or physical/profile bytes changed.',
           'recipes': recipes}
receipt_pin = put('public-input-recipe.json', receipt)
print(json.dumps({'status': 'prepared', 'selectedRegularMembers': len(seen), 'receipt': receipt_pin,
                  'manifests': [row['manifest'] for row in recipes]}, indent=2))
