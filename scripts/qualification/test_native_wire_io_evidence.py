"""Counterexamples for complete, source-bound I/O accounting; no services or private archive needed."""
import copy
import importlib.util
import json
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('io_evidence', Path(__file__).with_name('native-wire-io-evidence.py'))
evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evidence)


def histogram(count=0):
    return {'count': count, 'totalNs': str(count), 'minimumNs': '1' if count else None, 'maximumNs': '1' if count else '0',
        'buckets': [0, count] + [0] * 62}


def scope(ident=1):
    return {'openId': ident, 'source': {'chainId': 'a' * 64, 'blockId': 'b' * 64, 'blockNum': 1},
        'selectionId': None, 'firstAuthority': None, 'lastAuthority': None, 'outcome': 'proof_cancelled',
        'openElapsedNs': '10', 'operationsInFlight': 0, **{k: 0 for k in evidence.COUNTERS}, 'timings': {}, 'stageFailures': {}}


def log(events, count=None):
    rows = [{'event': 'start'}, *copy.deepcopy(events)]
    for i, row in enumerate(rows, 1):
        row.update({'kind': 'native_boundary', 'sequence': i, 'pid': 10, 'role': 'fixture', 'monotonicNs': str(i)})
    prefix = b''.join(evidence.profiles.encoded(row) for row in rows)
    calls = len(rows)
    count = sum(r['event'] == 'proof_open_finished' for r in rows) if count is None else count
    rows += [{'kind': 'native_boundary', 'event': 'observer_metrics', 'sequence': calls + 1, 'pid': 10, 'role': 'fixture',
        'monotonicNs': str(calls + 1), 'coverage': 'before-this-row', 'io': {'writeElapsed': histogram(calls),
            'syncElapsed': histogram(calls), 'attemptedBytes': len(prefix), 'writtenBytes': len(prefix), 'writeFailures': 0, 'syncFailures': 0},
        'proofs': {'started': count, 'settled': count, 'reportFailures': 0}},
        {'kind': 'native_boundary', 'event': 'exit', 'sequence': calls + 2, 'pid': 10, 'role': 'fixture', 'monotonicNs': str(calls + 2)}]
    return b''.join(evidence.profiles.encoded(row) for row in rows)


def finished(value=None):
    return {'event': 'proof_open_finished', **(scope() if value is None else value)}


class IoEvidenceTests(unittest.TestCase):
    def test_histogram_refuses_false_counts_or_totals(self):
        evidence.histogram(histogram()); evidence.histogram(histogram(3))
        for patch in [{'count': True}, {'count': 4}, {'totalNs': '4'}, {'maximumNs': '0'}, {'buckets': [3]},
            {'buckets': [0, 0, 3] + [0] * 61}]:
            value = histogram(3) | patch
            with self.subTest(patch=patch), self.assertRaises(ValueError): evidence.histogram(value)

    def test_io_snapshot_excludes_its_own_summary_and_exit(self):
        data = log([finished()]); result = evidence.summarize_native(data, 10, 'fixture')
        self.assertEqual(result['proofOpens'], 1)
        self.assertEqual(result['observerIo']['writeElapsed']['count'], 2)
        self.assertEqual(result['observerIo']['syncElapsed']['count'], 2)
        self.assertEqual(result['observerIo']['writtenBytes'], sum(len(v) for v in data.splitlines(keepends=True)[:2]))
        rows = [json.loads(v) for v in data.splitlines()]; rows[-2]['io']['writtenBytes'] += 1
        with self.assertRaises(ValueError): evidence.summarize_native(b''.join(map(evidence.profiles.encoded, rows)), 10, 'fixture')

    def test_missing_or_duplicate_opens_cannot_look_complete(self):
        for data in [log([finished()], count=2), log([finished(), finished()])]:
            with self.assertRaises(ValueError): evidence.summarize_native(data, 10, 'fixture')

    def test_late_io_updates_one_open_without_double_counting(self):
        initial = scope() | {'operationsInFlight': 1, 'httpGetAttempts': 1}
        final = copy.deepcopy(initial) | {'operationsInFlight': 0, 'httpCompleted': 1, 'utf8ReencodedBodyBytes': 7,
            'timings': {'connectionRequest': histogram(1)}}
        late = {'event': 'proof_open_late_operation', 'openId': 1, 'accounting': final}
        result = evidence.summarize_native(log([finished(initial), late]), 10, 'fixture')
        self.assertEqual((result['proofOpens'], result['httpGetAttempts'], result['utf8ReencodedBodyBytes']), (1, 1, 7))
        self.assertEqual(result['lateOperationRecords'], 1)
        with self.assertRaises(ValueError): evidence.summarize_native(log([finished(initial)]), 10, 'fixture')
        late['accounting']['source']['blockId'] = 'c' * 64
        with self.assertRaises(ValueError): evidence.summarize_native(log([finished(initial), late]), 10, 'fixture')

    def test_failed_partial_bodies_must_remain_unknown(self):
        value = scope() | {'httpGetAttempts': 1, 'httpErrors': 1, 'unknownBodySizes': 1, 'timings': {'connectionRequest': histogram(1)}}
        result = evidence.summarize_native(log([finished(value)]), 10, 'fixture')
        self.assertEqual(result['unknownBodySizes'], 1)
        for patch in [{'unknownBodySizes': 0}, {'httpGetAttempts': 2}, {'utf8ReencodedBodyBytes': 7}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                evidence.summarize_native(log([finished(value | patch)]), 10, 'fixture')

    def test_identity_clock_and_stage_mismatches_fail(self):
        value = scope() | {'immutableGets': 1}
        with self.assertRaises(ValueError): evidence.summarize_native(log([finished(value)]), 10, 'fixture')
        for patch in [{'pid': 11}, {'monotonicNs': '0'}, {'sequence': 5}]:
            rows = [json.loads(v) for v in log([finished()]).splitlines()]; rows[1].update(patch)
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                evidence.summarize_native(b''.join(map(evidence.profiles.encoded, rows)), 10, 'fixture')

    def test_returned_proofs_require_consistent_authority_and_ancestry(self):
        authority = {'generation': 'g', 'headBlockNum': 1, 'headBlockId': 'b' * 64}
        value = scope() | {'outcome': 'returned', 'firstAuthority': authority, 'lastAuthority': authority,
            'commitValidationCalls': 1, 'timings': {'validateCommit': histogram(1)}}
        evidence.summarize_native(log([finished(value)]), 10, 'fixture')
        for patch in [{'lastAuthority': None}, {'lastAuthority': authority | {'generation': 'replacement'}},
            {'commitValidationCalls': 2}, {'source': value['source'] | {'chainId': 'invalid'}}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                evidence.summarize_native(log([finished(value | patch)]), 10, 'fixture')

    def test_relocated_metadata_cannot_collapse_keys_or_change_counters(self):
        value = {'path': '/private/source/code', 'nanoseconds': '12345678901234567890', 'count': 7}
        self.assertEqual(evidence.profiles.relocate(value, [('/private/source', '/public/source')]),
            value | {'path': '/public/source/code'})
        with self.assertRaises(ValueError):
            evidence.profiles.relocate({'/private/a': 1, '/public/a': 2}, [('/private', '/public')])

    def test_failed_replay_source_and_cleanup_cannot_be_promoted(self):
        steps = ['bundle-verify', 'bundle-fetch', 'source-worktree', 'npm-ci', 'typecheck', 'build', 'qualification-check',
            'native-metrics-tests', 'services', 'replay', 'services-cleanup']
        run = {'sourceRevision': evidence.REVISION, 'status': 'failed', 'profilingStatus': 'captured',
            'successfulHeldPrefixes': [1, 33, 122, 256, 397], 'releasedThrough': 685,
            'sourceLastSentBlock': 661, 'sourceLastAckBlock': 653, 'sourceSendCount': 661, 'sourceAckCount': 653,
            'error': 'projection cursor 685 did not complete', 'wholeSourceReplayPassed': False, 'releaseQualified': False,
            'incumbentsPreserved': True, 'incumbentsBefore': [{'pid': 1, 'start': 'original'}], 'incumbentsAfter': [{'pid': 1, 'start': 'original'}],
            'cleanup': [{'name': n, 'ok': True} for n in ['api', 'master', 'replay', 'rpc', 'bulk', 'redis', 'mongo-client', 'elasticsearch', 'owned-mongodb']],
            'driverSteps': [{'name': n, 'exitCode': 1 if n == 'replay' else 0} for n in steps]}
        evidence.validate_run(run)
        for patch in [{'status': 'passed'}, {'releaseQualified': True}, {'sourceLastSentBlock': 685}, {'cleanup': []},
            {'incumbentsAfter': []}, {'driverSteps': run['driverSteps'] + [run['driverSteps'][0]]}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError): evidence.validate_run(run | patch)

    def test_literal_credentials_are_collected_from_configuration(self):
        raw = {'fixture/state.json': b'{"password":"private-fixture-password"}',
            'capture/config/connections.json': b'{"amqp":{"pass":"private-broker-password"}}',
            'capture/bulk/response.json': b'{"token":"public-contract-data"}'}
        self.assertEqual(evidence.credential_values(raw, {}), {b'private-fixture-password', b'private-broker-password'})


if __name__ == '__main__': unittest.main()
