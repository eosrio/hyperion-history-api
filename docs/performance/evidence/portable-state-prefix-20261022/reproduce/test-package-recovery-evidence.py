"""Private, service-free integrity/security regressions for the evidence helper."""
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("recovery_packager", Path(__file__).with_name("package-recovery-evidence.py"))
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
HEAD, DIGEST = "a" * 40, "b" * 64


def archive_bytes(members):
    target = io.BytesIO()
    with tarfile.open(fileobj=target, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, value in members:
            item = tarfile.TarInfo(name)
            if isinstance(value, tuple):
                item.type, item.linkname = value
                archive.addfile(item)
            else:
                item.size = len(value)
                archive.addfile(item, io.BytesIO(value))
    return gzip.compress(target.getvalue(), mtime=0)


def fixture(directory, status="failed", change_report=None, change_invocation=None, pins=True, change_members=None):
    diagnostic_success = status in ("passed", "profiled-prefix")
    report = {
        "schemaVersion": 1, "status": status, "finality": "reversible",
        "runtime": {"node": "v24.19.0", "sha256": DIGEST, "executable": "/private/node"},
        "source": {"kind": "synthetic-engineering-fork", "nodeAuthenticated": False,
                   "common": {"blockNum": 1243}, "recordsSha256": DIGEST},
        "limits": {"nodeAuthenticatedFork": False, "wireTestnetReleaseQualified": False,
                   "legacyRoutesQualified": False},
        "errors": [] if diagnostic_success else ["retained failure"],
        "error": None if diagnostic_success else "retained primary failure",
        "cleanup": [{"name": "master-0", "ok": diagnostic_success}],
        "mongoCleanup": {"verified": True, "network": True, "volume": True, "containers": {"replica": True}},
        "inspections": {"Env": ["secret=value"]}, "network": "private", "volumes": ["private"],
        "config": {"password": "secret"}, "connections": {"mongodb": "private"},
        "mongo": {"uri": "mongodb://private", "container": "private", "version": "8.0.14"},
        "oracleHashes": {"/original/path.json": DIGEST}, "inputHashes": {"block.bin": DIGEST},
        "stages": [{"physical": {"rows": [1]}, "api": {"status": 503}}],
        "probes": [{"kind": "unaffected", "status": 200}], "transitions": ["rollback"], "crashes": ["SIGKILL"],
    }
    invocation = {"case": "test", "head": HEAD, "finality": "reversible", "fixtureRun": "run",
                  "node": {"version": "v24.19.0", "sha256": DIGEST, "path": "/private/node"},
                  "argv": ["/private/node", "--flag", "/private/output"],
                  "exitCode": 0 if diagnostic_success else 1, "limits": {"deadlineSeconds": 900}}
    if change_report:
        change_report(report)
    if change_invocation:
        change_invocation(invocation)
    members = [
        ("test/report.json", P.encoded(report)), ("test-invocation.json", P.encoded(invocation)),
        ("test/bulk/1.ndjson", b'{"kept":"exact"}\n'), ("test/observer/profile.cpuprofile", b'{"nodes":[]}'),
        ("test/stages/physical.json", b'{"exact":true}\n'), ("test/master-0.stdout.log", b"exact stdout\n"),
        ("test/logs/actual.log", b"exact log\n"), ("test/logs/current.log", (tarfile.SYMTYPE, "actual.log")),
        ("test/config/connections.json", b'{"password":"secret"}'),
        ("test-precleanup/raw-inspection.json", b'{"Env":["secret=value"]}'),
        ("test-services/core-state.json.cleanup.json", P.encoded({"run": "run", "remainingContainers": 0,
            "remainingVolumes": 0, "remainingNetworks": 0})),
        ("test-services/redis.cleanup.json", P.encoded({"run": "run", "redisVerifiedAbsent": True})),
    ]
    if pins:
        members.append(("source-emission-pins-" + HEAD + ".json", P.encoded({
            "head": HEAD, "members": [{"path": "build/index.js", "bytes": 123, "sha256": DIGEST}]})))
    if change_members:
        change_members(members)
    raw = archive_bytes(members)
    (directory / "test.tar.gz").write_bytes(raw)
    receipt = {"case": "test", "archive": "test.tar.gz", "status": status,
               "bytes": len(raw), "sha256": P.sha(raw), "mongoCleanupVerified": True, "remainingOwnedRunContainers": 0}
    (directory / "receipt.json").write_bytes(P.encoded(receipt))
    recipe = directory / "cases.json"
    recipe.write_bytes(P.encoded({"cases": [{"case": "test", "archive": "test.tar.gz", "receipt": "receipt.json", "sha256": P.sha(raw)}]}))
    return recipe, report


class PackagerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="packager-tests-", dir=Path(__file__).parent)
        self.directory = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_failed_truth_omissions_provenance_links_and_integrity(self):
        recipe, original = fixture(self.directory)
        output = self.directory / "public"
        P.package(recipe, output)
        manifest = json.loads((output / "manifest.json").read_bytes())
        summary = json.loads((output / "summary.json").read_bytes())
        self.assertEqual(summary["failedAttemptsPreserved"], ["test"])
        self.assertFalse(summary["cases"][0]["cleanup"][0]["ok"])
        self.assertTrue(summary["cases"][0]["mongoCleanupVerified"])
        self.assertEqual(summary["cases"][0]["head"], HEAD)
        inventory = {row["path"]: row for row in manifest["files"]}
        with tarfile.open(output / "raw-evidence.tar.gz", "r:gz") as archive:
            self.assertEqual(set(archive.getnames()), set(inventory))
            for member in archive:
                self.assertTrue(member.isfile())
                self.assertEqual((member.uid, member.gid, member.mtime, member.mode), (0, 0, 0, 0o444))
                data = archive.extractfile(member).read()
                self.assertEqual(P.sha(data), inventory[member.name]["sha256"])
                self.assertEqual(len(data), inventory[member.name]["bytes"])
            public = json.loads(archive.extractfile("cases/test/report.public.json").read())
            for key in ("inspections", "network", "volumes", "config", "connections"):
                self.assertNotIn(key, public)
            self.assertNotIn("uri", public["mongo"])
            self.assertNotIn("container", public["mongo"])
            self.assertNotIn("executable", public["runtime"])
            self.assertEqual(public["oracleHashes"], original["oracleHashes"])
            for key in ("errors", "error", "cleanup", "stages", "probes", "transitions", "crashes"):
                self.assertEqual(public[key], original[key])
            self.assertEqual(public["publication"]["original"]["sha256"], P.sha(P.encoded(original)))
            self.assertEqual(len(public["publication"]["omissions"]), 8)
            self.assertEqual(archive.extractfile("cases/test/bulk/1.ndjson").read(), b'{"kept":"exact"}\n')
            link = json.loads(archive.extractfile("cases/test/logs/current.log.link-metadata.json").read())
            self.assertEqual(link["linkTarget"], "actual.log")
            self.assertIs(link["followed"], False)
            invocation = json.loads(archive.extractfile("cases/test/invocation.public.json").read())
            self.assertEqual(invocation["argv"], ["node", "--flag", "output"])
        omitted = [row for row in manifest["sourceArchives"][0]["members"] if row["action"] == "omitted"]
        self.assertTrue(any(row["member"] == "test/config/connections.json" for row in omitted))
        self.assertTrue(any(row["member"] == "test-precleanup/raw-inspection.json" for row in omitted))
        for line in (output / "SHA256SUMS").read_text().splitlines():
            wanted, name = line.split("  ")
            self.assertEqual(hashlib.sha256((output / name).read_bytes()).hexdigest(), wanted)

    def test_deterministic_and_never_overwrites(self):
        recipe, _ = fixture(self.directory)
        for name in ("one", "two"):
            P.package(recipe, self.directory / name)
        for name in ("raw-evidence.tar.gz", "manifest.json", "summary.json", "SHA256SUMS"):
            self.assertEqual((self.directory / "one" / name).read_bytes(), (self.directory / "two" / name).read_bytes())
        with self.assertRaisesRegex(P.PackagingError, "refusing to overwrite"):
            P.package(recipe, self.directory / "one")

    def test_pass_requires_consistent_errors_cleanup_mongo_exit_and_pins(self):
        defects = [
            (lambda r: r["errors"].append("late failure"), None, True),
            (lambda r: r.update(error="primary failure despite empty errors"), None, True),
            (lambda r: r["cleanup"][0].update(ok=False), None, True),
            (lambda r: r.update(cleanup=[]), None, True),
            (lambda r: r["mongoCleanup"].update(verified=False), None, True),
            (lambda r: r["mongoCleanup"]["containers"].update(replica=False), None, True),
            (None, lambda r: r.update(exitCode=1), True),
            (None, None, False),
        ]
        for index, (report, invocation, pins) in enumerate(defects):
            with self.subTest(index=index):
                recipe, _ = fixture(self.directory, "passed", report, invocation, pins)
                output = self.directory / str(index)
                with self.assertRaisesRegex(P.PackagingError, "acceptance consistency"):
                    P.package(recipe, output)
                self.assertFalse(output.exists())
        recipe, _ = fixture(self.directory, "passed")
        P.package(recipe, self.directory / "valid")

    def test_profiled_prefix_is_distinct_and_does_not_become_full_pass(self):
        recipe, _ = fixture(self.directory, "profiled-prefix", lambda r: r.update(profileOnly={"through": 288}))
        output = self.directory / "profiled"
        P.package(recipe, output)
        row = json.loads((output / "summary.json").read_bytes())["cases"][0]
        self.assertEqual(row["status"], "profiled-prefix")
        self.assertEqual(row["profileOnly"], {"through": 288})
        self.assertIs(row["fullRecoveryPassed"], False)
        self.assertIs(row["passedConsistencyChecks"]["driverPassed"], False)
        self.assertIs(row["diagnosticSuccess"], True)
        self.assertTrue(all(value for key, value in row["passedConsistencyChecks"].items() if key != "driverPassed"))

    def test_profiled_prefix_requires_every_diagnostic_success_gate(self):
        def alter_json_member(name, change):
            def alter(members):
                for index, (member, data) in enumerate(members):
                    if member == name:
                        value = json.loads(data)
                        change(value)
                        members[index] = (member, P.encoded(value))
                        return
                raise AssertionError("Expected member is absent")
            return alter

        defects = [
            {"change_report": lambda r: r["errors"].append("late failure")},
            {"change_report": lambda r: r.update(error="primary failure despite empty errors")},
            {"change_report": lambda r: r["cleanup"][0].update(ok=False)},
            {"change_report": lambda r: r.update(cleanup=[])},
            {"change_report": lambda r: r["mongoCleanup"].update(verified=False)},
            {"change_report": lambda r: r["mongoCleanup"]["containers"].update(replica=False)},
            {"change_invocation": lambda r: r.update(exitCode=1)},
            {"pins": False},
            {"change_members": alter_json_member("test-services/core-state.json.cleanup.json", lambda r: r.update(remainingContainers=1))},
            {"change_members": alter_json_member("test-services/redis.cleanup.json", lambda r: r.update(redisVerifiedAbsent=False))},
            {"change_members": alter_json_member("test-services/core-state.json.cleanup.json", lambda r: r.update(run="wrong-run"))},
        ]
        for index, defect in enumerate(defects):
            with self.subTest(index=index):
                change = defect.pop("change_report", None)
                def report_change(report):
                    report["profileOnly"] = {"through": 288}
                    if change:
                        change(report)
                recipe, _ = fixture(self.directory, "profiled-prefix", change_report=report_change, **defect)
                output = self.directory / ("bad-profile-" + str(index))
                with self.assertRaisesRegex(P.PackagingError, "diagnostic consistency"):
                    P.package(recipe, output)
                self.assertFalse(output.exists())
        for index, change in enumerate((lambda r: r.update(remainingOwnedRunContainers=1),
                                        lambda r: r.update(mongoCleanupVerified=False),
                                        lambda r: r.update(status="failed"))):
            with self.subTest(archive_receipt=index):
                recipe, _ = fixture(self.directory, "profiled-prefix", lambda r: r.update(profileOnly={"through": 288}))
                path = self.directory / "receipt.json"
                receipt = json.loads(path.read_bytes())
                change(receipt)
                path.write_bytes(P.encoded(receipt))
                with self.assertRaises(P.PackagingError):
                    P.package(recipe, self.directory / ("bad-archive-" + str(index)))

    def test_source_head_runtime_finality_and_claim_mismatch_refuse(self):
        defects = [
            (lambda r: r.update(gitHead="c" * 40), None),
            (lambda r: r.update(finality="irreversible"), None),
            (lambda r: r["source"].update(nodeAuthenticated=True), None),
            (lambda r: r["limits"].update(wireTestnetReleaseQualified=True), None),
            (lambda r: r["limits"].update(rustQualified=True), None),
            (None, lambda r: r["node"].update(sha256="c" * 64)),
            (None, lambda r: r.update(head="c" * 40)),
        ]
        for index, (report, invocation) in enumerate(defects):
            with self.subTest(index=index):
                recipe, _ = fixture(self.directory, change_report=report, change_invocation=invocation)
                with self.assertRaises(P.PackagingError):
                    P.package(recipe, self.directory / str(index))

    def test_wrong_archive_sha_receipt_and_duplicate_json_refuse(self):
        recipe, _ = fixture(self.directory)
        value = json.loads(recipe.read_bytes())
        value["cases"][0]["sha256"] = "0" * 64
        recipe.write_bytes(P.encoded(value))
        with self.assertRaisesRegex(P.PackagingError, "Archive SHA mismatch"):
            P.package(recipe, self.directory / "wrong-sha")
        with self.assertRaisesRegex(P.PackagingError, "Duplicate JSON"):
            P.parsed(b'{"status":"passed","status":"failed"}', "report")

    def test_path_special_member_symlink_and_alias_attacks_refuse(self):
        paths = ["/absolute", "../parent", "a/../parent", "C:/drive", "a\\b", "a//b", "./a", "a/CON.log", "a/trailing."]
        for name in paths:
            with self.subTest(path=name), self.assertRaises(P.PackagingError):
                P.inspect_archive(archive_bytes([(name, b"x")]), "unsafe")
        for kind in (tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE):
            with self.subTest(kind=kind), self.assertRaises(P.PackagingError):
                P.inspect_archive(archive_bytes([("a/special", (kind, "target"))]), "special")
        for members in ([('a/file', b'x'), ('a/file', b'y')], [('A/file', b'x'), ('a/FILE', b'y')],
                        [('a', b'x'), ('a/child', b'y')], [('A', b'x'), ('a/child', b'y')],
                        [('a/not-log', (tarfile.SYMTYPE, 'target'))],
                        [('a/logs/link.log', (tarfile.SYMTYPE, '../escape'))]):
            with self.subTest(members=members), self.assertRaises(P.PackagingError):
                P.inspect_archive(archive_bytes(members), "unsafe")

    def test_byte_member_expansion_profile_and_trailing_bounds(self):
        cases = [("MAX_MEMBER_BYTES", 1, [("a/file", b"xx")]),
                 ("MAX_MEMBERS", 1, [("a/one", b"x"), ("a/two", b"y")]),
                 ("MAX_TAR_BYTES", 100, [("a/file", b"x")]),
                 ("MAX_CPU_PROFILE_BYTES", 1, [("a/observer/x.cpuprofile", b"xx")])]
        for constant, maximum, members in cases:
            with self.subTest(constant=constant), patch.object(P, constant, maximum), self.assertRaises(P.PackagingError):
                P.inspect_archive(archive_bytes(members), "bounded")
        with self.assertRaises(P.PackagingError):
            P.inspect_archive(archive_bytes([("a/x.cpuprofile", b"x")]), "profile-outside-observer")
        raw = gzip.decompress(archive_bytes([("a/file", b"x")])) + b"hidden trailing data"
        with self.assertRaisesRegex(P.PackagingError, "Nonzero trailing"):
            P.inspect_archive(gzip.compress(raw), "trailing")


if __name__ == "__main__":
    unittest.main(verbosity=2)
