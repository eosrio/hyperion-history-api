"""Authenticate bounded evidence without extracting or executing archive content."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile

root = Path(__file__).resolve().parent
def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

checks = {}
for line in (root / 'SHA256SUMS').read_text(encoding='utf8').splitlines():
    expected, filename = line.split('  ', 1)
    assert filename in {'summary.json', 'manifest.json', 'raw-evidence.tar.gz'}
    assert filename not in checks and digest(root / filename) == expected
    checks[filename] = expected
assert len(checks) == 3
summary = json.loads((root / 'summary.json').read_bytes())
manifest = json.loads((root / 'manifest.json').read_bytes())
assert manifest['source'] == summary['executionCandidate']
assert summary['case24d']['status'] == 'failed'
assert not summary['boundaries']['fullWorkerQualified']
assert summary['boundaries']['defaultAncestryBlocks'] == 256
archive = root / manifest['archive']
assert archive.name == 'raw-evidence.tar.gz'
assert archive.stat().st_size == manifest['archiveBytes'] <= 64 * 1024 * 1024
assert checks[archive.name] == manifest['archiveSha256']
assert 0 < len(manifest['members']) <= 50000
seen = set()
total = 0
with tarfile.open(archive, 'r:gz') as source:
    for member in source:
        path = PurePosixPath(member.name)
        assert member.isfile() and not path.is_absolute() and '..' not in path.parts
        assert '\\' not in member.name and ':' not in member.name
        assert member.name not in seen and member.name in manifest['members']
        expected = manifest['members'][member.name]
        assert member.size == expected['bytes'] <= 64 * 1024 * 1024
        data = source.extractfile(member).read()
        assert len(data) == member.size and hashlib.sha256(data).hexdigest() == expected['sha256']
        seen.add(member.name)
        total += member.size
        assert total <= 512 * 1024 * 1024
assert seen == set(manifest['members']) and total == manifest['uncompressedBytes']
print(json.dumps({'status': 'authenticated evidence; worker qualification failed',
                  'source': manifest['source'], 'members': len(seen), 'bytes': total,
                  'archiveSha256': manifest['archiveSha256']}))
