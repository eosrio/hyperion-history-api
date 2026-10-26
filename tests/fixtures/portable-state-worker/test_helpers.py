"""Resource-free helper guards. No subprocess, Docker, native worker or network execution."""
import copy
import json
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import prepare
import services


class FixtureHelpers(unittest.TestCase):
    def setUp(self):
        self.parent = (Path(__file__).resolve().parents[3] / "out").resolve()
        self.parent.mkdir(exist_ok=True)
        self.directory = Path(tempfile.mkdtemp(prefix="portable-helper-guard-", dir=self.parent))
        self.assertEqual(self.directory.resolve().parent, self.parent)

    def tearDown(self):
        # This is only the newly created scratch directory within this checkout's out/.
        self.assertEqual(self.directory.resolve().parent, self.parent)
        self.assertTrue(self.directory.name.startswith("portable-helper-guard-"))
        shutil.rmtree(self.directory)

    def test_plan_semantics_preserve_paths_on_both_platforms_but_refuse_definition_changes(self):
        value = json.loads((prepare.BUNDLE / "plan.template.json").read_text())
        windows = copy.deepcopy(value)
        windows["source"]["directory"] = r"P:\owned-fixture\source"
        for item in windows["oracleFiles"]:
            item["path"] = "P:\\owned-fixture\\source\\" + Path(item["path"]).name
        self.assertEqual(prepare.plan_semantics(windows), prepare.PLAN_SHA256)
        changed = copy.deepcopy(value)
        changed["definitions"][0]["mappingRevision"] = "f" * 64
        self.assertNotEqual(prepare.plan_semantics(changed), prepare.PLAN_SHA256)

    def test_preflight_rejects_unknown_members_without_creating_output(self):
        member = SimpleNamespace(name="../outside", isfile=lambda: True)
        class Archive:
            def __enter__(self):
                return [member]
            def __exit__(self, *unused):
                pass
        with patch.object(prepare.tarfile, "open", return_value=Archive()):
            with self.assertRaisesRegex(ValueError, "Unknown, duplicate or non-ordinary"):
                prepare.prepare(self.directory / "not-created")
        self.assertFalse((self.directory / "not-created").exists())

    def test_prepare_refuses_an_existing_destination_before_writes(self):
        original = self.directory / "keep.txt"
        original.write_text("preserve")
        with self.assertRaises(FileExistsError):
            prepare.prepare(self.directory)
        self.assertEqual(original.read_text(), "preserve")

    def mocked_cleanup(self, foreign=False):
        run = "123456abcdef"
        core = {"run": run, "network": "hyp-es955-replicas-" + run}
        cid = "c" * 64
        name = core["network"] + "-redis"
        volume = name + "-data"
        labels = {"io.eosrio.qualifier": "es198-workers", "io.eosrio.run": run}
        state = {"run": run, "network": core["network"], "core": core,
                 "redis": {"name": name, "volume": volume, "containerId": cid}}
        (self.directory / "core-state.json").write_text(json.dumps(core))
        (self.directory / "worker-state.json").write_text(json.dumps(state))
        live = {"container": True, "volume": True}
        operations = []
        def docker(*arguments, **unused):
            operations.append(arguments)
            if arguments[:2] == ("ps", "-a"):
                return (cid + "|" + name if "{{.ID}}|{{.Names}}" in arguments else cid) if live["container"] else ""
            if arguments == ("inspect", cid):
                return json.dumps([{"Id": cid, "Name": "/" + name,
                                    "Config": {"Image": services.REDIS_IMAGE, "Labels": {**labels, **({"io.eosrio.run": "foreign"} if foreign else {})}},
                                    "Mounts": [{"Destination": "/data", "Type": "volume", "Name": volume}]}])
            if arguments[:2] == ("volume", "ls"):
                return volume if live["volume"] else ""
            if arguments == ("volume", "inspect", volume):
                return json.dumps([{"Labels": labels}])
            if arguments == ("rm", "--force", cid):
                live["container"] = False
                return cid
            if arguments == ("volume", "rm", volume):
                live["volume"] = False
                return volume
            raise AssertionError("Unexpected fixture operation " + repr(arguments))
        def core_cleanup(action, directory, executable):
            self.assertFalse(live["container"])
            self.assertFalse(live["volume"])
            operations.append(("core", action))
            (directory / "core-state.json.cleanup.json").write_text(json.dumps({
                "remainingContainers": 0, "remainingVolumes": 0, "remainingNetworks": 0}))
        return docker, core_cleanup, operations

    def test_foreign_redis_is_refused_before_any_removal_or_core_cleanup(self):
        docker, core, operations = self.mocked_cleanup(foreign=True)
        with patch.object(services, "docker", side_effect=docker), patch.object(services, "core_command", side_effect=core):
            with self.assertRaisesRegex(ValueError, "ownership differs"):
                services.cleanup(self.directory, "unused-pwsh")
        self.assertFalse(any(args[0] in ["rm", "core"] or args[:2] == ("volume", "rm") for args in operations))

    def test_owned_redis_is_removed_before_core_cleanup_and_absence_is_recorded(self):
        docker, core, operations = self.mocked_cleanup()
        with patch.object(services, "docker", side_effect=docker), patch.object(services, "core_command", side_effect=core):
            result = services.cleanup(self.directory, "unused-pwsh")
        self.assertEqual(result["status"], "cleaned")
        self.assertTrue(result["redis"]["redisVerifiedAbsent"])
        self.assertEqual(operations[-1], ("core", "cleanup"))

    def test_disposable_disk_profile_is_an_explicit_create_only_allowlist(self):
        for profile in ["20-10-5gb", "8-4-2gb"]:
            with patch.object(services.subprocess, "run") as run:
                services.core_command("create", self.directory, "fixture-pwsh", profile)
                arguments = run.call_args.args[0]
                self.assertEqual(arguments[arguments.index("-DiskWatermarkProfile") + 1], profile)
                self.assertEqual(arguments[arguments.index("-IndexingPressureLimitMb") + 1], "64")
        with patch.object(services.subprocess, "run") as run:
            services.core_command("cleanup", self.directory, "fixture-pwsh")
            self.assertNotIn("-DiskWatermarkProfile", run.call_args.args[0])
        with patch.object(services.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "Unsupported disposable"):
                services.core_command("create", self.directory, "fixture-pwsh", "1-1-1gb")
            run.assert_not_called()
        new_directory = self.directory / "must-not-create"
        with self.assertRaisesRegex(ValueError, "Unsupported disposable"):
            services.create(new_directory, "fixture-pwsh", "unsafe")
        self.assertFalse(new_directory.exists())


if __name__ == "__main__":
    unittest.main()
