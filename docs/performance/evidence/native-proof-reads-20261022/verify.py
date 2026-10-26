"""Authenticate the frozen proof-read measurements; does not extract or execute payloads."""
import hashlib
import json
from pathlib import Path
import tarfile

root=Path(__file__).resolve().parent
def sha(data):return hashlib.sha256(data).hexdigest()
for line in (root/'SHA256SUMS').read_text(encoding='utf8').splitlines():
    digest,name=line.split('  ',1)
    path=(root/name).resolve()
    assert path.is_relative_to(root) and path.is_file()
    assert sha(path.read_bytes())==digest,name
summary=json.loads((root/'summary.json').read_bytes())
archive=root/'raw-evidence.tar.gz'
assert sha(archive.read_bytes())==summary['rawArchive']['sha256']
with tarfile.open(archive,'r:gz') as tar:
    entries=tar.getmembers();names=[entry.name for entry in entries]
    assert len(names)==len(set(names))==37 and all(entry.isfile() for entry in entries)
    manifest_bytes=tar.extractfile('manifest.json').read()
    assert manifest_bytes==(root/'manifest.json').read_bytes()
    members=json.loads(manifest_bytes)['members'];assert len(members)==36
    assert set(members)==set(names)-{'manifest.json'}
    for name,expected in members.items():
        assert not Path(name).is_absolute() and '..' not in Path(name).parts
        data=tar.extractfile(name).read()
        assert len(data)==expected['bytes'] and sha(data)==expected['sha256'],name
    for version in ['24','22']:
        prefix='proof-node'+version+'-b/'
        report=next(json.loads(line) for line in tar.extractfile(prefix+'probe.log').read().decode('utf8').splitlines() if line.startswith('{"scenario"'))
        assert report['realElasticsearchStore'] and report['controlledBrokerTransport'] and not report['fullWorkerQualification']
        assert report['sourceHead']==290 and report['queuedBlock']==33 and report['sourceDistance']==257 and report['defaultAncestryBlocks']==256
        assert report['publishedActions']==0 and report['consumerAcknowledgments']==1 and report['sealed'] is False
        assert report['codecStillDecodesExactOriginal'] and not report['syntheticSourceFrames']
        assert len(report['controls'])==4 and len(report['measurements'])==87
        selected=[row for row in report['measurements'] if row.get('distance')==232 and row['stage'] in ['abi.waitForOpen','native.waitForOpen']]
        assert len(selected)==10
        for repetition in range(5):
            rows=[row for row in selected if row['repetition']==repetition]
            assert len(rows)==2 and sum(row['allClientGetCount'] for row in rows)==2858
            assert sum(row['responseJsonBytes'] for row in rows)==11631525
        profiles=[entry for entry in entries if entry.name.startswith(prefix+'cpu/') and entry.name.endswith('.cpuprofile')]
        assert len(profiles)==4
        for entry in profiles:
            profile=json.loads(tar.extractfile(entry).read())
            assert profile['samples'] and profile['nodes'] and profile['endTime']>profile['startTime']
print('Verified 37 raw members, two actual-ES diagnoses and eight CPU profiles; known expiry remains unfixed.')
