# Exact engineering metadata

`metadata.json.gz.base64` is a compact transport of the metadata at
`/physical/0/metadata` in the block-288 stage named by `origin.json`. It retains
the exact original receipts, binding, definition, undo descriptors and revision;
the measurement script derives its six states in memory. It contains no machine
paths. The original stage/source/emission hashes are provenance, not a claim
that a new service-free harness execution rereads those external archives.

The original preparation verified the full public archive, stage, exact
uncompressed metadata, emission archive and its 602 pre-run code pins. The
public archive and verified emission archive are retained by the
[published prefix evidence](../../../docs/performance/evidence/portable-state-prefix-20261022/README.md).
Their names, byte sizes and SHA-256 values are in `origin.json`.

To verify the selected metadata independently, point this bounded recipe at the
downloaded public archive. It selects only one regular member, checks both the
archive and stage SHA, and compares minified selected metadata with the committed
decompressed bytes. It does not extract archive members or write files:

```sh
python - raw-evidence.tar.gz <<'PY'
import base64, gzip, hashlib, json, pathlib, sys, tarfile
fixture = pathlib.Path('tests/fixtures/projection-validation')
origin = json.loads((fixture / 'origin.json').read_text(encoding='utf-8'))
archive = pathlib.Path(sys.argv[1])
assert archive.is_file() and not archive.is_symlink()
assert archive.stat().st_size == origin['publicArchive']['bytes']
digest = hashlib.sha256()
with archive.open('rb') as stream:
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(block)
assert digest.hexdigest() == origin['publicArchive']['sha256']
with tarfile.open(archive, 'r:gz') as stream:
    member = stream.getmember(origin['stage']['path'])
    assert member.isfile() and not member.issym() and not member.islnk()
    assert member.size == origin['stage']['bytes'] <= 1024 * 1024
    raw = stream.extractfile(member).read(member.size + 1)
assert len(raw) == origin['stage']['bytes']
assert hashlib.sha256(raw).hexdigest() == origin['stage']['sha256']
metadata = json.loads(raw)['physical'][0]['metadata']
selected = json.dumps(metadata, ensure_ascii=False, separators=(',', ':')).encode()
assert len(selected) == origin['metadata']['bytes'] <= 256 * 1024
assert hashlib.sha256(selected).hexdigest() == origin['metadata']['sha256']
packed = base64.b64decode((fixture / origin['metadata']['file']).read_text().strip(), validate=True)
assert len(packed) == origin['metadata']['gzipBytes']
assert hashlib.sha256(packed).hexdigest() == origin['metadata']['gzipSha256']
with gzip.GzipFile(fileobj=__import__('io').BytesIO(packed)) as stream:
    committed = stream.read(256 * 1024 + 1)
assert committed == selected
print('exact original metadata verified')
PY
```

This fixture has empty target rows and zero before images. It is neither a
node-authenticated fork nor populated-table or full recovery qualification.
Replay receipts remain fixed at 256 in every derived state; their count is not
an independent variable. Original image/hash and floor-receipt assumptions stay
explicit in the harness and its negative controls.
