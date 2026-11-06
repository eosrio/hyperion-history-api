"""Offline evidence boundaries, independent of services, raw private data and runtime qualification."""
import copy
import importlib.util
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('profile_evidence', Path(__file__).with_name('native-wire-profile-evidence.py'))
evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evidence)


def frame(ident, name, children=None, url='node:example', line=0):
    value = {'id': ident, 'callFrame': {'functionName': name, 'url': url, 'lineNumber': line, 'columnNumber': 0, 'scriptId': '1'}}
    if children:
        value['children'] = children
    return value


def resources():
    return [{'kind': 'sample', 'monotonicMs': i * 1000, 'elapsedMs': 1000,
        'cpuDeltaMicros': {'user': 100, 'system': 20}, 'cpuTotalMicros': {'user': i * 100, 'system': i * 20},
        'memory': {'rss': i * 4096, 'heapUsed': i * 1024}} for i in (1, 2)]


class EvidenceTests(unittest.TestCase):
    def test_archive_names_refuse_windows_and_posix_escape(self):
        for name in ('/absolute', '../escape', 'observer/../escape', 'C:/escape', 'observer\\escape', 'a//b', './observer', ''):
            with self.subTest(name=name), self.assertRaises(ValueError):
                evidence.ordinary_name(name)
        self.assertEqual(evidence.ordinary_name('observer/master/worker-1.cpuprofile'), 'observer/master/worker-1.cpuprofile')

    def test_archive_rejects_duplicate_members_and_links_outside_tree(self):
        import io
        import tarfile
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bad.tar.gz'
            for names in (['same', 'same'], ['../escape']):
                with tarfile.open(path, 'w:gz') as archive:
                    for name in names:
                        info = tarfile.TarInfo(name)
                        info.size = 1
                        archive.addfile(info, io.BytesIO(b'x'))
                with self.assertRaises(ValueError):
                    evidence.read_archive(path)
            with tarfile.open(path, 'w:gz') as archive:
                info = tarfile.TarInfo('observer/link')
                info.type, info.linkname = tarfile.SYMTYPE, '../escape'
                archive.addfile(info)
            with self.assertRaises(ValueError):
                evidence.read_archive(path)

    def test_path_redaction_covers_metadata_keys_without_mutating_source(self):
        original = {evidence.PRIVATE_ROOT + '/source/oracle.json': [evidence.PRIVATE_ROOT + '/toolchain/node', 'a' * 64]}
        before = copy.deepcopy(original)
        result = evidence.redact(original)
        self.assertEqual(original, before)
        self.assertEqual(result, {'/qualification/source/oracle.json': ['/qualification/run/toolchain/node', 'a' * 64]})
        evidence.scan(evidence.encoded(result))

    def test_publication_rejects_private_paths_and_credentials(self):
        for value in (b'/var/tmp/unknown-root', b'http://user:secret@example.invalid', b'Basic Zm9vOmJhcg==',
                      b'Bearer test.secret.token', b'{"password":"secret"}', b'192.168.1.2'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                evidence.scan(value)
        evidence.scan(b'{"global_sequence":"18446744073709551615","payloadSha256":"' + b'a' * 64 + b'"}')

    def test_recursive_frames_have_one_inclusive_count_per_sample(self):
        profile = {'nodes': [frame(1, '(root)', [2]), frame(2, 'visit', [3]), frame(3, 'visit')],
            'samples': [2, 3, 3], 'timeDeltas': [10, 10, 10]}
        result = evidence.summarize_profile(profile, resources())
        self.assertEqual(next(v['samples'] for v in result['topSelfLocations'] if v['function'] == 'visit'), 3)
        self.assertEqual(next(v['samples'] for v in result['topInclusiveLocations'] if v['function'] == 'visit'), 3)

    def test_equal_function_names_at_different_locations_stay_distinct(self):
        profile = {'nodes': [frame(1, '(root)', [2, 3]), frame(2, 'read', url='node:first'), frame(3, 'read', url='node:second')],
            'samples': [2, 3, 3], 'timeDeltas': [10, 10, 10]}
        result = evidence.summarize_profile(profile, resources())
        self.assertEqual({v['url']: v['samples'] for v in result['topSelfLocations']}, {'node:first': 1, 'node:second': 2})
        self.assertEqual(result['cpuUserMicros'], 200)
        self.assertEqual(result['cpuSystemMicros'], 40)
        self.assertEqual(result['resourceElapsedMs'], 2000)

    def test_fsync_attribution_requires_the_observer_caller(self):
        url = '/qualification/source/scripts/qualification/portable-state-worker-native-observer.mjs'
        profile = {'nodes': [frame(1, '(root)', [2, 4]), frame(2, 'record', [3], url=url), frame(3, 'fsync'), frame(4, 'fsync')],
            'samples': [3, 4, 4], 'timeDeltas': [10, 10, 10]}
        result = evidence.summarize_profile(profile, resources())
        self.assertEqual(result['fsyncLeafSamples'], 3)
        self.assertEqual(result['nativeObserverFsyncLeafSamples'], 1)

    def test_cpu_counters_and_unknown_profile_samples_fail_closed(self):
        profile = {'nodes': [frame(1, '(root)')], 'samples': [1], 'timeDeltas': [10]}
        for field, value in [('monotonicMs', 0), ('cpuTotalMicros', {'user': 100, 'system': 40}),
                             ('cpuDeltaMicros', {'user': -1, 'system': 20})]:
            rows = resources()
            rows[1][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                evidence.summarize_profile(profile, rows)
        profile['samples'] = [2]
        with self.assertRaises(ValueError):
            evidence.summarize_profile(profile, resources())


if __name__ == '__main__':
    unittest.main()
