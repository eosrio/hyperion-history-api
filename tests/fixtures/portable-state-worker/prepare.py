"""Verify/extract the immutable actual-source fixture and resolve a path-only replay plan."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tarfile


ARCHIVE = "source-1-1480-20261020.tar.gz"
ARCHIVE_SHA256 = "42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7"
MANIFEST_SHA256 = "fa48079240a25d6fddfe80b83539bf0735be0f03b034dd816205c7e815d2d305"
PLAN_SHA256 = "b5416f1e9c874caa83a80de9e6daec51aac0765af557806b728c0bb6a1704e4b"
BUNDLE = Path(__file__).absolute().parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def ordinary(path, directory=False):
    path = Path(path).absolute()
    for part in (path, *path.parents):
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Symbolic links and reparse points are not fixture paths")
        if part != path or directory:
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError("Expected an ordinary directory")
        elif not stat.S_ISREG(info.st_mode):
            raise ValueError("Expected an ordinary file")
    return path.resolve(strict=True)


def bounded_file(path, maximum):
    selected = ordinary(path)
    size = selected.stat().st_size
    if size > maximum:
        raise ValueError("Fixture file exceeds its byte bound")
    data = selected.read_bytes()
    if len(data) != size:
        raise ValueError("Fixture file changed during read")
    return data


def plan_semantics(plan):
    value = copy.deepcopy(plan)
    value["source"]["directory"] = "<source-directory>"
    for item in value["oracleFiles"]:
        item["path"] = PurePosixPath(item["path"].replace("\\", "/")).name
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def verified_inputs():
    manifest_bytes = bounded_file(BUNDLE / "manifest.json", 1024 * 1024)
    if digest(manifest_bytes) != MANIFEST_SHA256:
        raise ValueError("Immutable source inventory differs")
    manifest = json.loads(manifest_bytes)
    archive_bytes = bounded_file(BUNDLE / ARCHIVE, 4 * 1024 * 1024)
    if digest(archive_bytes) != ARCHIVE_SHA256 or len(archive_bytes) != manifest["archive"]["bytes"]:
        raise ValueError("Original source archive differs")
    plan = json.loads(bounded_file(BUNDLE / "plan.template.json", 65536))
    if plan_semantics(plan) != PLAN_SHA256:
        raise ValueError("Only source/oracle paths may differ from the original plan")
    expected = {item["path"]: item for item in manifest["members"]}
    if len(expected) != 1488:
        raise ValueError("Unexpected source file coverage")
    # Preflight every entry and byte before creating the output directory. Never tar.extract().
    files = {}
    with tarfile.open(ordinary(BUNDLE / ARCHIVE), "r:gz") as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if not member.isfile() or member.name not in expected or member.name in files:
                raise ValueError("Unknown, duplicate or non-ordinary archive member")
            if len(name.parts) != 2 or name.parts[0] != "source" or name.is_absolute() or ".." in name.parts:
                raise ValueError("Archive member escapes its source directory")
            entry = expected[member.name]
            if member.size != entry["bytes"] or member.size > 8 * 1024 * 1024:
                raise ValueError("Archive entry size differs")
            data = archive.extractfile(member).read(member.size + 1)
            if len(data) != member.size or digest(data) != entry["sha256"]:
                raise ValueError("Original source member differs")
            files[member.name] = data
    if set(files) != set(expected) or sum(map(len, files.values())) != manifest["source"]["bytes"]:
        raise ValueError("Source inventory is incomplete")
    receipt = json.loads(files["source/receipt.json"])
    if receipt["start"] != 1 or receipt["endExclusive"] != 2401 or receipt["complete"] is not True:
        raise ValueError("Original capture receipt was changed")
    if digest(files["source/receipt.json"]) != plan["source"]["receiptSha256"] or plan["source"]["endBlock"] != 1480:
        raise ValueError("Selected range or source receipt differs")
    for item in plan["oracleFiles"]:
        if item["path"] != "source/" + PurePosixPath(item["path"]).name or item["path"] not in files:
            raise ValueError("Oracle path is outside the verified source directory")
        if len(files[item["path"]]) != item["bytes"] or digest(files[item["path"]]) != item["sha256"]:
            raise ValueError("Independent oracle differs")
    return manifest, plan, files


def prepare(output):
    output = Path(output).absolute()
    parent = ordinary(output.parent, directory=True)
    if os.path.lexists(output):
        raise FileExistsError("Fixture output must be a new directory")
    manifest, plan, files = verified_inputs()
    output = parent / output.name
    output.mkdir()
    (output / "source").mkdir()
    for name, data in files.items():
        with (output / name).open("xb") as stream:
            stream.write(data)
    # The source audit resolves directory relative to cwd; oracle files resolve relative to plan.
    # Absolute ordinary paths make the same generated plan valid from either caller directory.
    plan["source"]["directory"] = str(ordinary(output / "source", directory=True))
    for item in plan["oracleFiles"]:
        item["path"] = str(ordinary(output / item["path"]))
    if plan_semantics(plan) != PLAN_SHA256:
        raise ValueError("Path resolution changed plan semantics")
    data = (json.dumps(plan, indent=2) + "\n").encode()
    with (output / "plan.json").open("xb") as stream:
        stream.write(data)
    return {"plan": str(output / "plan.json"), "planSha256": digest(data), "archiveSha256": ARCHIVE_SHA256,
            "files": len(files), "bytes": manifest["source"]["bytes"], "selectedBlocks": 1480,
            "note": "Byte/hash preflight only; the native worker driver independently verifies source/ABI/oracle semantics."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", help="new directory below an existing ordinary parent")
    arguments = parser.parse_args()
    print(json.dumps(prepare(arguments.output), indent=2))
