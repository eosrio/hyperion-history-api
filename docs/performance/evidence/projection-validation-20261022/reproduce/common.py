"""Bounded, service-free readers for the published #252 evidence.

Python 3.11+ standard library only. Never extracts tar members, starts services,
invokes Git/native validators, or follows archive links.
"""
from __future__ import annotations
import argparse
import base64
import fnmatch
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import tempfile

if not __debug__:
    raise RuntimeError("Verification requires ordinary Python; -O is unsupported")

HEAD = "d95d797fc3de8c695e2817a2952eedebeb4b3241"
CASES = ("h252-n24-mon-coff-pilot1", "h252-n24-moff-coff-pilot1")
MAX_FILE = 30 * 1024**2
MAX_EXPANDED = 192 * 1024**2
MAX_MEMBERS = 16000
MAX_KERNEL_METADATA = 256 * 1024
KERNEL_ORIGIN_SHA256 = "b55332ee9b86aee69c0b3c04bb113a42495f594f649f5da6288df884dab50bfb"
KERNEL_PACKED_SHA256 = "9e222f65e2ec9e6e3724c5147fb91a2cbaaee556fd707279c1bc7609e9a1e269"
COMPONENT = re.compile(r"[A-Za-z0-9._@+=,-]+\Z")
DEVICES = {"con", "prn", "aux", "nul"} | {a+str(b) for a in ("com", "lpt") for b in range(1,10)}

def require(condition, message):
    if not condition:
        raise ValueError(message)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True, allow_nan=False)+"\n").encode("ascii")

def parsed(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON key: "+key)
            result[key] = value
        return result
    def constant(value):
        raise ValueError("Non-finite JSON constant: "+value)
    return json.loads(data, object_pairs_hook=unique, parse_constant=constant)

def bounded_gzip_metadata(compressed, expected_bytes):
    """Read at most the authenticated expected size plus one; reject overruns."""
    require(type(expected_bytes) is int and 0 < expected_bytes <= MAX_KERNEL_METADATA,
            "Kernel metadata size exceeds the hard bound")
    with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode="rb") as reader:
        data = reader.read(expected_bytes + 1)
    require(len(data) == expected_bytes, "Kernel metadata expanded size differs")
    return data

def decode_kernel_metadata(origin_bytes, packed_bytes):
    """Authenticate fixed raw pins before JSON/base64/gzip processing."""
    require(type(origin_bytes) is bytes and 0 < len(origin_bytes) <= 64*1024, "Invalid bounded origin bytes")
    require(type(packed_bytes) is bytes and 0 < len(packed_bytes) <= 256*1024, "Invalid bounded packed bytes")
    require(sha(origin_bytes) == KERNEL_ORIGIN_SHA256, "Kernel origin fixed hash differs")
    require(sha(packed_bytes) == KERNEL_PACKED_SHA256, "Kernel packed fixed hash differs")
    origin = parsed(origin_bytes)
    metadata = origin["metadata"]
    require(metadata["encoding"] == "gzip+base64", "Unexpected kernel metadata encoding")
    expected_bytes = metadata["bytes"]
    require(type(expected_bytes) is int and 0 < expected_bytes <= MAX_KERNEL_METADATA, "Invalid expected metadata size")
    text = packed_bytes.strip()
    compressed = base64.b64decode(text, validate=True)
    require(base64.b64encode(compressed) == text, "Noncanonical packed metadata")
    require(len(compressed) == metadata["gzipBytes"] and sha(compressed) == metadata["gzipSha256"],
            "Kernel compressed bytes differ")
    data = bounded_gzip_metadata(compressed, expected_bytes)
    require(sha(data) == metadata["sha256"], "Kernel expanded metadata hash differs")
    return origin, data

def safe_name(name):
    require(isinstance(name,str) and 0 < len(name) <= 512, "Invalid member name length")
    parts = name.split("/")
    require(not PurePosixPath(name).is_absolute() and all(
        p not in ("", ".", "..") and COMPONENT.fullmatch(p) and not p.endswith(("."," "))
        and p.split(".")[0].lower() not in DEVICES for p in parts), "Unsafe member name: "+repr(name))
    return name

def bounded_file(path, maximum=MAX_FILE):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), "Expected ordinary file: "+str(path))
    require(path.absolute().resolve()==path.absolute(), "Linked input parent is unsupported")
    require(path.stat().st_size <= maximum, "File exceeds bound: "+path.name)
    with path.open("rb") as stream:
        data = stream.read(maximum+1)
    require(len(data) <= maximum, "File grew beyond bound: "+path.name)
    return data

def inspect_tar(path, regular_only=True):
    """Bound gzip expansion before parsing; return member bytes without extraction."""
    raw = bounded_file(path)
    result, names, expanded = [], set(), 0
    with tempfile.SpooledTemporaryFile(max_size=8*1024**2) as spool:
        with gzip.GzipFile(fileobj=io.BytesIO(raw), mode="rb") as source:
            while chunk := source.read(1024**2):
                expanded += len(chunk)
                require(expanded <= MAX_EXPANDED, "Gzip expansion exceeds bound")
                spool.write(chunk)
        spool.seek(0)
        with tarfile.open(fileobj=spool, mode="r:") as archive:
            for member in archive:
                require(len(result) < MAX_MEMBERS, "Archive member count exceeds bound")
                name = safe_name(member.name.rstrip("/") if member.isdir() else member.name)
                require(name.casefold() not in names, "Duplicate/case-colliding member: "+name)
                names.add(name.casefold())
                require(member.isfile() or (not regular_only and (member.isdir() or member.issym())), "Unsupported member type")
                row = {"path":name, "type":"file" if member.isfile() else "directory" if member.isdir() else "symlink", "bytes":member.size}
                if member.isfile():
                    require(0 <= member.size <= MAX_FILE, "Member exceeds bound")
                    data = archive.extractfile(member).read(member.size+1)
                    require(len(data) == member.size, "Truncated member")
                    row.update(data=data, sha256=sha(data))
                elif member.issym():
                    require("/" not in member.linkname and "\\" not in member.linkname
                            and member.linkname not in ("", ".", ".."), "Unexpected log link target")
                    row["linkTarget"] = member.linkname
                result.append(row)
    return result, expanded

def archive_files(path):
    members, _ = inspect_tar(path)
    return {row["path"]:row["data"] for row in members}

def write_tar(path, files):
    with Path(path).open("xb") as output:
        with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0, compresslevel=9) as zipped:
            with tarfile.open(fileobj=zipped, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
                for name, data in sorted(files.items()):
                    safe_name(name)
                    member = tarfile.TarInfo(name)
                    member.size, member.mode, member.mtime = len(data), 0o444, 0
                    member.uid = member.gid = 0
                    member.uname = member.gname = ""
                    archive.addfile(member, io.BytesIO(data))

def verifier_arguments(description):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("package", type=Path)
    parser.add_argument("output", type=Path)
    options = parser.parse_args()
    root, output = options.package.absolute(), options.output.absolute()
    require(root.is_dir() and root.resolve() == root, "Package must be an ordinary directory")
    require(output.parent.is_dir() and output.parent.resolve() == output.parent, "Output parent must exist and be ordinary")
    require(not output.is_relative_to(root), "Audit output must be outside the immutable package")
    require(not output.exists() and not output.is_symlink(), "Output must be fresh")
    output.mkdir()
    return root, output

class VirtualPath:
    """Read-only path facade over audited tar bytes; no filesystem extraction."""
    def __init__(self, files, path=""):
        self.files, self.path = files, path
    def __truediv__(self, child):
        return VirtualPath(self.files, self.path+"/"+str(child) if self.path else str(child))
    def read_bytes(self):
        return self.files[self.path]
    @property
    def name(self):
        return self.path.rsplit("/",1)[-1]
    def glob(self, pattern):
        prefix = self.path+"/"
        return [VirtualPath(self.files, name) for name in sorted(self.files)
                if name.startswith(prefix) and fnmatch.fnmatchcase(name[len(prefix):],pattern)]
    def __str__(self):
        return "public:"+self.path

def worker_context(root):
    payload = archive_files(root/"raw-evidence.tar.gz")
    manifest = parsed(bounded_file(root/"manifest.json"))
    files = {}
    for case in CASES:
        prefix = "cases/"+case+"/"
        for name, data in payload.items():
            if name.startswith(prefix):
                suffix = name[len(prefix):]
                files["measured-pilot-regular-files/"+case+"/"+suffix] = data
        files["measured-pilot-regular-files/"+case+"-invocation.json"] = payload[prefix+"invocation.json"]
    files["measured-pilot-regular-files/source-emission-pins-"+HEAD+".json"] = payload["cases/"+CASES[0]+"/source-emission-pins.json"]
    return payload, manifest, files
