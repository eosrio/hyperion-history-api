"""Derive auditable public evidence from explicit, SHA-pinned private case archives.

Private engineering helper only. No extraction, services, Git operations or publication.
Usage: python package-recovery-evidence.py --cases cases.json --output NEW_DIRECTORY
The recipe is {"cases": [{"case": "name", "archive": "...tar.gz",
"receipt": "...archive.json", "sha256": "<explicit archive SHA-256>"}]}.
Relative inputs resolve against the recipe's directory; output must not already exist.
"""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import tempfile


MAX_CASES = 16
MAX_ARCHIVE_BYTES = 128 * 1024**2
MAX_TAR_BYTES = 512 * 1024**2
MAX_MEMBER_BYTES = 128 * 1024**2
MAX_CPU_PROFILE_BYTES = 32 * 1024**2
MAX_MEMBERS = 30_000
MAX_PUBLIC_BYTES = 512 * 1024**2
MAX_RECIPE_BYTES = 1024**2
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
COMMIT = re.compile(r"[0-9a-f]{40}\Z")
CASE_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,79}\Z")
COMPONENT = re.compile(r"[A-Za-z0-9._@+=,-]+\Z")
DEVICES = {"con", "prn", "aux", "nul"} | {
    stem + str(number) for stem in ("com", "lpt") for number in range(1, 10)
}
REPORT_OMISSIONS = (
    ("inspections",), ("network",), ("volumes",), ("config",), ("connections",),
    ("mongo", "uri"), ("mongo", "container"), ("runtime", "executable"),
)
CLAIMS = {"authenticWire": False, "rust": False, "legacy": False, "release": False}


class PackagingError(ValueError):
    """The input cannot safely support the requested evidence derivation."""


def require(condition, message):
    if not condition:
        raise PackagingError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True,
                       allow_nan=False) + "\n").encode("ascii")


def parsed(data, label):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, f"Duplicate JSON key in {label}: {key}")
            result[key] = value
        return result

    def no_constant(value):
        raise PackagingError(f"Non-finite JSON value in {label}: {value}")

    try:
        return json.loads(data, object_pairs_hook=unique, parse_constant=no_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise PackagingError(f"Invalid bounded JSON in {label}") from error


def bounded_file(path, maximum):
    with path.open("rb") as stream:
        data = stream.read(maximum + 1)
    require(len(data) <= maximum, f"File exceeds byte limit: {path.name}")
    return data


def safe_path(name, directory=False):
    require(isinstance(name, str) and 0 < len(name) <= 255, "Invalid path length")
    if directory and name.endswith("/"):
        name = name[:-1]
    parts = name.split("/")
    require(all(part not in ("", ".", "..") and COMPONENT.fullmatch(part)
                and not part.endswith((".", " "))
                and part.split(".")[0].lower() not in DEVICES for part in parts),
            f"Unsafe archive path: {name!r}")
    require(not PurePosixPath(name).is_absolute(), f"Absolute archive path: {name!r}")
    return name


def provenance(case, member=None, data=None):
    result = {"case": case["case"], "archive": case["archiveName"],
              "archiveSha256": case["sha256"]}
    if member is not None:
        result["member"] = member
    if data is not None:
        result.update(bytes=len(data), sha256=sha(data))
    return result


def omit(value, parts, omissions, reason):
    node = value
    for part in parts[:-1]:
        if not isinstance(node, dict) or part not in node:
            omissions.append({"pointer": "/" + "/".join(parts), "present": False,
                              "reason": reason})
            return
        node = node[part]
    require(isinstance(node, dict), "Unexpected object shape for public omission")
    row = {"pointer": "/" + "/".join(parts), "present": parts[-1] in node,
           "reason": reason}
    if parts[-1] in node:
        original = encoded(node.pop(parts[-1]))
        row.update(canonicalValueBytes=len(original), canonicalValueSha256=sha(original))
    omissions.append(row)


def derived(value, origin, paths, reason):
    require(isinstance(value, dict) and "publication" not in value,
            "Expected an object without a pre-existing publication field")
    public, omissions = copy.deepcopy(value), []
    for parts in paths:
        omit(public, parts, omissions, reason)
    public["publication"] = {"derived": True, "original": origin, "omissions": omissions}
    return public


def public_invocation(value, origin):
    public = derived(value, origin, [("node", "path")], "Private executable location")
    require(isinstance(public.get("argv"), list)
            and all(isinstance(item, str) for item in public["argv"]),
            "Invocation argv must be an array of strings")
    for index, item in enumerate(public["argv"]):
        if item.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", item):
            public["publication"]["omissions"].append({
                "pointer": f"/argv/{index}", "present": True,
                "reason": "Absolute private location replaced by its basename",
                "canonicalValueSha256": sha(encoded(item)),
                "canonicalValueBytes": len(encoded(item)),
            })
            public["argv"][index] = item.replace("\\", "/").rsplit("/", 1)[-1]
    return public


class Evidence:
    def __init__(self):
        self.files = {}
        self.folded = set()
        self.inventory = []
        self.total_bytes = 0

    def add(self, name, data, origin, transformation):
        name = safe_path(name)
        require(name.casefold() not in self.folded,
                f"Duplicate public destination: {name}")
        require(len(data) <= MAX_MEMBER_BYTES, "Public member exceeds byte limit")
        self.total_bytes += len(data)
        require(self.total_bytes <= MAX_PUBLIC_BYTES, "Public evidence exceeds total byte limit")
        self.files[name] = data
        self.folded.add(name.casefold())
        self.inventory.append({"path": name, "bytes": len(data), "sha256": sha(data),
                               "origin": origin, "transformation": transformation})


def inspect_archive(raw, label):
    """Bound full gzip expansion first; inspect headers and read only regular bytes."""
    members, total = {}, 0
    with tempfile.SpooledTemporaryFile(max_size=8 * 1024**2) as spool:
        with gzip.GzipFile(fileobj=io.BytesIO(raw), mode="rb") as compressed:
            while block := compressed.read(1024**2):
                total += len(block)
                require(total <= MAX_TAR_BYTES, f"Expanded tar exceeds byte limit: {label}")
                spool.write(block)
        spool.seek(0)
        with tarfile.open(fileobj=spool, mode="r:") as archive:
            folded = set()
            for member in archive:
                require(len(members) < MAX_MEMBERS, f"Archive exceeds member limit: {label}")
                name = safe_path(member.name, member.isdir())
                require(name.casefold() not in folded, f"Duplicate/aliased archive path: {name}")
                folded.add(name.casefold())
                require(member.sparse is None and not any("sparse" in k.lower() for k in member.pax_headers),
                        f"Sparse archive member is unsupported: {name}")
                require(member.isfile() or member.isdir() or member.issym(),
                        f"Special archive member is unsupported: {name}")
                require(0 <= member.size <= MAX_MEMBER_BYTES, f"Member exceeds byte limit: {name}")
                if name.endswith(".cpuprofile"):
                    require("/observer/" in name and member.size <= MAX_CPU_PROFILE_BYTES,
                            f"CPU profile must be within observer/ and its 32 MiB bound: {name}")
                if member.issym():
                    require("/logs/" in name and member.size == 0,
                            f"Only original zero-byte log symlinks are supported: {name}")
                    safe_path(member.linkname)
                if member.isdir():
                    require(member.size == 0, f"Nonempty directory header: {name}")
                data = archive.extractfile(member).read() if member.isfile() else None
                if data is not None:
                    require(len(data) == member.size, f"Truncated member: {name}")
                header = {"name": name, "type": member.type.decode("ascii"),
                          "bytes": member.size, "mode": member.mode, "linkTarget": member.linkname}
                members[name] = {"info": member, "data": data, "header": header,
                                 "headerSha256": sha(encoded(header))}
            spool.seek(archive.offset)
            while tail := spool.read(1024**2):
                require(not any(tail), f"Nonzero trailing tar data: {label}")
    folded_members = {name.casefold(): row for name, row in members.items()}
    for name in members:
        for parent in PurePosixPath(name).parents:
            if str(parent).casefold() in folded_members:
                require(folded_members[str(parent).casefold()]["info"].isdir(),
                        f"Archive child beneath a non-directory: {name}")
    return members, total


def member_json(members, name):
    require(name in members and members[name]["info"].isfile(), f"Missing regular JSON member: {name}")
    return parsed(members[name]["data"], name)


def case_summary(case, receipt, report, invocation, pins, service_receipts):
    require(report.get("status") in ("passed", "failed", "profiled-prefix"), "Driver report must be completed")
    if report["status"] == "profiled-prefix":
        require(bool(report.get("profileOnly")), "Profile prefix outcome needs explicit profileOnly metadata")
    require(invocation.get("case") == case["case"], "Invocation case mismatch")
    require(isinstance(invocation.get("fixtureRun"), str) and bool(invocation["fixtureRun"]),
            "Invocation must identify its owned fixture run")
    head = invocation.get("head")
    require(isinstance(head, str) and COMMIT.fullmatch(head), "Invocation must identify an exact source HEAD")
    require("gitHead" not in report or report["gitHead"] == head, "Driver/invocation HEAD mismatch")
    require(report.get("finality") in ("reversible", "irreversible")
            and invocation.get("finality") == report["finality"], "Finality mismatch")
    require(isinstance(report.get("errors"), list) and isinstance(report.get("cleanup"), list),
            "Errors and cleanup must be explicit arrays")
    require(all(isinstance(row, dict) and type(row.get("ok")) is bool for row in report["cleanup"]),
            "Cleanup entries must have explicit boolean outcomes")
    source, limits = report.get("source"), report.get("limits")
    require(isinstance(source, dict) and source.get("kind") == "synthetic-engineering-fork"
            and source.get("nodeAuthenticated") is False, "Only explicitly synthetic engineering forks are supported")
    require(isinstance(limits, dict) and all(limits.get(key) is False for key in (
        "nodeAuthenticatedFork", "wireTestnetReleaseQualified", "legacyRoutesQualified")),
        "Required engineering qualification limits are absent or widened")
    require(all(value is False for key, value in limits.items()
                if any(term in key.lower() for term in ("rustqualified", "authenticwire", "releasequalified"))),
            "Engineering report cannot claim authentic Wire, Rust or release qualification")
    runtime, node = report.get("runtime"), invocation.get("node")
    require(isinstance(runtime, dict) and isinstance(node, dict)
            and isinstance(node.get("version"), str) and bool(node["version"])
            and runtime.get("node") == node.get("version")
            and isinstance(node.get("sha256"), str) and SHA256.fullmatch(node["sha256"])
            and runtime.get("sha256") == node["sha256"], "Runtime identity mismatch")
    require(isinstance(invocation.get("limits"), dict), "Invocation resource bounds are required")
    if pins is not None:
        require(isinstance(pins, dict) and pins.get("head") == head and isinstance(pins.get("members"), list),
                "Source/emission pin receipt HEAD mismatch")
        seen = set()
        for item in pins["members"]:
            require(isinstance(item, dict), "Invalid emission member receipt")
            name = safe_path(item.get("path"))
            require(name.casefold() not in seen, "Duplicate emission pin path")
            seen.add(name.casefold())
            require(type(item.get("bytes")) is int and item["bytes"] >= 0
                    and isinstance(item.get("sha256"), str) and SHA256.fullmatch(item["sha256"]),
                    "Invalid emission size/hash receipt")
    cleanup_ok = bool(report["cleanup"]) and all(row["ok"] is True for row in report["cleanup"])
    mongo = report.get("mongoCleanup", {})
    mongo_ok = (isinstance(mongo, dict) and mongo.get("verified") is True
                and mongo.get("network") is True and mongo.get("volume") is True
                and isinstance(mongo.get("containers"), dict) and bool(mongo["containers"])
                and all(value is True for value in mongo["containers"].values()))
    service_ok = (any("remainingContainers" in row for row in service_receipts)
                  and any("redisVerifiedAbsent" in row for row in service_receipts)) and all(
        (all(row.get(key) == 0 and type(row.get(key)) is int for key in
             ("remainingContainers", "remainingVolumes", "remainingNetworks"))
         if "remainingContainers" in row else row.get("redisVerifiedAbsent") is True)
        and row.get("run") == invocation.get("fixtureRun") for row in service_receipts)
    diagnostic_checks = {
        "driverExitZero": type(invocation.get("exitCode")) is int and invocation["exitCode"] == 0,
        "errorsEmpty": report["errors"] == [], "allDriverCleanupOk": cleanup_ok,
        "noPrimaryError": report.get("error") is None,
        "mongoCleanupVerified": mongo_ok, "serviceCleanupVerified": service_ok,
        "archiveHasNoOwnedContainers": type(receipt.get("remainingOwnedRunContainers")) is int and receipt["remainingOwnedRunContainers"] == 0,
        "archiveMongoCleanupVerified": receipt.get("mongoCleanupVerified") is True,
        "sourceEmissionPinsPresent": pins is not None,
    }
    passed_checks = {"driverPassed": report["status"] == "passed", **diagnostic_checks}
    if report["status"] == "passed":
        require(all(passed_checks.values()), "Passed report fails acceptance consistency gates: "
                + ", ".join(key for key, value in passed_checks.items() if not value))
        require(receipt.get("status") == "passed", "Passed report/archive receipt status conflict")
    elif report["status"] == "profiled-prefix":
        require(all(diagnostic_checks.values()), "Profiled prefix fails diagnostic consistency gates: "
                + ", ".join(key for key, value in diagnostic_checks.items() if not value))
        require(receipt.get("status") == "profiled-prefix", "Profiled prefix/archive receipt status conflict")
    else:
        require(receipt.get("status") != "passed", "Failed report cannot have a passed archive receipt")
    return {
        "case": case["case"], "status": report["status"], "archiveStatus": receipt.get("status"),
        "fullRecoveryPassed": report["status"] == "passed", "profileOnly": report.get("profileOnly"),
        "head": head, "headSource": "invocation.head", "runtime": {"version": node["version"], "sha256": node["sha256"]},
        "finality": report["finality"], "startedAt": report.get("startedAt"), "completedAt": report.get("completedAt"),
        "cleanup": [{"name": row.get("name"), "ok": row["ok"]} for row in report["cleanup"]],
        "mongoCleanupVerified": mongo_ok, "serviceCleanupVerified": service_ok,
        "bounds": {"invocation": invocation["limits"], "engineering": limits},
        "source": {key: source.get(key) for key in ("kind", "nodeAuthenticated", "common", "branchRanges", "recordsSha256")},
        "sourceEmission": {"present": pins is not None, "capturedHashCount": len(pins["members"]) if pins else 0,
                           "actualCodeBytesBundled": False},
        "passedConsistencyChecks": passed_checks, "claims": CLAIMS.copy(),
        "diagnosticSuccess": report["status"] in ("passed", "profiled-prefix") and all(diagnostic_checks.values()),
        "failure": {"error": report.get("error"), "errors": report["errors"]},
    }


def package_case(case, evidence):
    raw = bounded_file(case["archive"], MAX_ARCHIVE_BYTES)
    require(sha(raw) == case["sha256"], f"Archive SHA mismatch: {case['case']}")
    receipt_raw = bounded_file(case["receipt"], MAX_RECIPE_BYTES)
    receipt = parsed(receipt_raw, case["receipt"].name)
    require(isinstance(receipt, dict) and receipt.get("case") == case["case"]
            and receipt.get("archive") == case["archiveName"]
            and receipt.get("sha256") == case["sha256"]
            and type(receipt.get("bytes")) is int and receipt["bytes"] == len(raw),
            f"Archive SHA/size/case receipt mismatch: {case['case']}")
    members, expanded_bytes = inspect_archive(raw, case["case"])
    report_name, invocation_name = case["case"] + "/report.json", case["case"] + "-invocation.json"
    report = member_json(members, report_name)
    invocation = member_json(members, invocation_name)
    require(isinstance(report, dict) and isinstance(invocation, dict), "Driver report and invocation must be objects")
    pin_names = [name for name in members if re.fullmatch(r"source-emission-pins(?:-[0-9a-f]{40})?\.json", name)]
    require(len(pin_names) <= 1, "Multiple ambiguous source/emission pin receipts")
    pins = member_json(members, pin_names[0]) if pin_names else None
    if pin_names:
        require(pin_names[0] in ("source-emission-pins.json", "source-emission-pins-" + str(invocation.get("head")) + ".json"),
                "Source/emission pin filename disagrees with invocation HEAD")
    cleanup_names = [name for name in members if name.endswith(".cleanup.json")]
    service_receipts = [member_json(members, name) for name in cleanup_names]
    require(all(isinstance(row, dict) for row in service_receipts), "Cleanup receipts must be objects")
    summary = case_summary(case, receipt, report, invocation, pins, service_receipts)
    report_origin = provenance(case, report_name, members[report_name]["data"])
    summary["originalReport"] = report_origin
    summary["originalInvocation"] = provenance(case, invocation_name, members[invocation_name]["data"])
    inventory, prefix = [], "cases/" + case["case"] + "/"
    for name, member in sorted(members.items()):
        info, data = member["info"], member["data"]
        origin = provenance(case, name, data)
        origin["headerSha256"] = member["headerSha256"]
        row = {**origin, "type": member["header"]["type"], "action": "omitted",
               "reason": "Outside the explicit public evidence allowlist"}
        destination, public, transformation = None, data, "Byte-for-byte regular source member"
        local = name[len(case["case"]) + 1:] if name.startswith(case["case"] + "/") else None
        if info.isdir():
            row["reason"] = "Directory headers omitted; output has regular files only"
        elif name == report_name:
            destination = prefix + "report.public.json"
            public = encoded(derived(report, report_origin, REPORT_OMISSIONS, "Private connection/configuration or runtime location"))
            transformation = "Public report derivation; every requested JSON omission recorded in publication.omissions"
        elif name == invocation_name:
            destination = prefix + "invocation.public.json"
            public = encoded(public_invocation(invocation, origin))
            transformation = "Public invocation derivation; private executable/absolute argv locations recorded as omissions"
        elif name in pin_names:
            destination = prefix + "source-emission-pins.json"
        elif name in cleanup_names:
            destination = prefix + "cleanup/" + name
        elif name == "runtimes/receipt.json":
            runtime_receipt = member_json(members, name)
            require(isinstance(runtime_receipt, dict) and isinstance(runtime_receipt.get("runtimes"), dict), "Runtime receipt must identify runtimes")
            paths = [("runtimes", key, "path") for key in sorted(runtime_receipt["runtimes"])]
            destination = prefix + "runtimes.public.json"
            public = encoded(derived(runtime_receipt, origin, paths, "Private executable location"))
            transformation = "Runtime receipt derivation; each executable path omission recorded"
        elif local and (local.startswith(("bulk/", "observer/", "stages/", "logs/"))
                        or re.fullmatch(r"[^/]+\.(?:stdout|stderr)\.log", local)):
            destination = prefix + local
        elif name in {case["case"] + suffix for suffix in (
                "-resources.jsonl", "-progress.jsonl", "-stdout.log", "-stderr.log", "-driver.log", "-build.log", "-services-cleanup.log")}:
            destination = prefix + "driver/" + name
        elif name.startswith(case["case"] + "-precleanup/") and name.endswith(".log"):
            destination = prefix + "service-logs/" + PurePosixPath(name).name
        if destination is not None:
            if info.issym():
                destination += ".link-metadata.json"
                public = encoded({"schemaVersion": 1, "type": "original-log-symlink",
                                  "original": origin, "linkTarget": info.linkname,
                                  "followed": False, "originalHeader": member["header"]})
                transformation = "Original log symlink represented as regular JSON metadata; never followed or extracted"
            evidence.add(destination, public, origin, transformation)
            row.update(action="derived" if transformation != "Byte-for-byte regular source member" else "copied",
                       publicPath=destination, transformation=transformation)
            row.pop("reason", None)
        elif "-precleanup/" in name or local == "chain.json" or (local and local.startswith("config/")):
            row["reason"] = "Private precleanup inspection/configuration/environment state omitted"
        inventory.append(row)
    receipt_origin = {"file": case["receipt"].name, "bytes": len(receipt_raw), "sha256": sha(receipt_raw)}
    receipt_fields = {key: value for key, value in receipt.items() if key in {
        "case", "status", "remainingOwnedRunContainers", "mongoCleanupVerified", "archive", "bytes", "sha256", "completedAt"}}
    receipt_fields["publication"] = {"derived": True, "original": receipt_origin,
        "omittedFields": sorted(set(receipt) - set(receipt_fields))}
    evidence.add(prefix + "archive-receipt.public.json", encoded(receipt_fields), receipt_origin,
                 "Explicit archive SHA/cleanup receipt projection; omitted field names recorded")
    return summary, {"case": case["case"], "archive": case["archiveName"], "sha256": case["sha256"],
                     "bytes": len(raw), "expandedBytes": expanded_bytes, "memberCount": len(members),
                     "receipt": receipt_origin, "members": inventory}


def write_tar(path, files):
    with path.open("xb") as output:
        with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0, compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
                for name, data in sorted(files.items()):
                    member = tarfile.TarInfo(name)
                    member.size, member.mtime, member.mode = len(data), 0, 0o444
                    member.uid = member.gid = 0
                    member.uname = member.gname = ""
                    archive.addfile(member, io.BytesIO(data))


def package(recipe_path, output):
    require(not output.exists(), "Output already exists; refusing to overwrite evidence")
    require(output.parent.is_dir(), "Output parent must already exist")
    recipe_raw = bounded_file(recipe_path, MAX_RECIPE_BYTES)
    recipe = parsed(recipe_raw, recipe_path.name)
    require(isinstance(recipe, dict) and isinstance(recipe.get("cases"), list)
            and 0 < len(recipe["cases"]) <= MAX_CASES, "Recipe must explicitly list bounded cases")
    cases, seen = [], set()
    for item in recipe["cases"]:
        require(isinstance(item, dict) and set(item) == {"case", "archive", "receipt", "sha256"},
                "Each case must contain only case/archive/receipt/sha256")
        require(isinstance(item["case"], str) and CASE_NAME.fullmatch(item["case"])
                and item["case"] not in seen, "Invalid or duplicate case name")
        require(isinstance(item["sha256"], str) and SHA256.fullmatch(item["sha256"]), "Explicit SHA-256 is required")
        require(all(isinstance(item[key], str) and item[key] for key in ("archive", "receipt")), "Explicit input paths are required")
        seen.add(item["case"])
        entry = dict(item)
        for key in ("archive", "receipt"):
            entry[key] = (recipe_path.parent / item[key]).resolve()
        entry["archiveName"] = safe_path(entry["archive"].name)
        cases.append(entry)
    evidence, summaries, sources = Evidence(), [], []
    for case in sorted(cases, key=lambda entry: entry["case"]):
        summary, source = package_case(case, evidence)
        summaries.append(summary)
        sources.append(source)
    summary = {"schemaVersion": 1, "scope": "Synthetic engineering fork/recovery evidence; packaging is not publication or release acceptance.",
               "claims": CLAIMS.copy(), "cases": summaries,
               "failedAttemptsPreserved": [row["case"] for row in summaries if row["status"] == "failed"]}
    summary_raw = encoded(summary)
    evidence.add("summary.json", summary_raw, {"derivedFrom": [row["originalReport"] for row in summaries]},
                 "Deterministic case/cleanup/bounds summary; does not upgrade failed attempts or engineering claims")
    with tempfile.TemporaryDirectory(prefix="recovery-package-", dir=output.parent) as temporary:
        stage = Path(temporary)
        archive = stage / "raw-evidence.tar.gz"
        write_tar(archive, evidence.files)
        archive_raw = bounded_file(archive, MAX_PUBLIC_BYTES)
        manifest = {"schemaVersion": 1, "packagerSha256": sha(Path(__file__).read_bytes()),
                    "recipeSha256": sha(recipe_raw), "sourceArchives": sources,
                    "claims": CLAIMS.copy(), "files": sorted(evidence.inventory, key=lambda row: row["path"]),
                    "archive": {"file": archive.name, "bytes": len(archive_raw), "sha256": sha(archive_raw)},
                    "integrityScope": "files inventories every regular tar member. External manifest and summary plus archive are hashed by external SHA256SUMS; checksum file does not hash itself.",
                    "determinism": "Sorted USTAR regular members, uid/gid/mtime zero, blank owners, mode0444; gzip filename empty/mtime zero, compression9."}
        manifest_raw = encoded(manifest)
        outputs = {"raw-evidence.tar.gz": archive_raw, "manifest.json": manifest_raw, "summary.json": summary_raw}
        outputs["SHA256SUMS"] = "".join(sha(data) + "  " + name + "\n" for name, data in sorted(outputs.items())).encode("ascii")
        output.mkdir()
        for name, data in sorted(outputs.items()):
            with (output / name).open("xb") as stream:
                stream.write(data)
    return {"directory": str(output), "archiveSha256": manifest["archive"]["sha256"],
            "files": len(evidence.files), "publicBytes": evidence.total_bytes,
            "cases": [{"case": row["case"], "status": row["status"], "head": row["head"]} for row in summaries]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    try:
        result = package(arguments.cases.resolve(), arguments.output.resolve())
    except (PackagingError, OSError, EOFError, tarfile.TarError) as error:
        parser.exit(1, f"Evidence packaging refused: {error}\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
