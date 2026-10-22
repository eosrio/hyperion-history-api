"""Verify the complete public #252 package, then replay its independent audits."""
from pathlib import Path
import subprocess
import sys
sys.dont_write_bytecode = True
from common import archive_files, bounded_file, encoded, parsed, require, safe_name, sha, verifier_arguments, write_tar

root, output = verifier_arguments(__doc__)
records = []
for line in bounded_file(root/"SHA256SUMS").decode("ascii").splitlines():
    digest, name = line.split("  ",1)
    safe_name(name)
    require(len(digest)==64 and all(c in "0123456789abcdef" for c in digest), "Invalid checksum")
    require(sha(bounded_file(root/name)) == digest, "Public file checksum mismatch: "+name)
    records.append(name)
require(len(records)==len(set(records)), "Duplicate checksum name")
actual = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
require(actual == sorted(records+["SHA256SUMS"]), "Public file inventory disagrees")
manifest = parsed(bounded_file(root/"manifest.json"))
for row in manifest["originalFiles"]:
    data=bounded_file(root/safe_name(row["path"]))
    require(row["transformation"]=="exact" and len(data)==row["bytes"] and sha(data)==row["sha256"],
        "Original file provenance mismatch")
for row in manifest["adaptations"]:
    data=bounded_file(root/safe_name(row["publicPath"]))
    require(len(data)==row["publicBytes"] and sha(data)==row["publicSha256"], "Audit adaptation receipt mismatch")
emission=archive_files(root/"retained-emission.tar.gz")
require(len(emission)==len(manifest["retainedEmissionMembers"]), "Retained emission member inventory differs")
for row in manifest["retainedEmissionMembers"]:
    data=emission[row["path"]]
    require(row["type"]=="file" and len(data)==row["bytes"] and sha(data)==row["sha256"], "Retained emission member provenance mismatch")
payload = archive_files(root/"raw-evidence.tar.gz")
inventory = manifest["publicMembers"]
require(set(payload)=={r["path"] for r in inventory}, "Raw member inventory differs")
require(len(inventory)==len(payload), "Duplicate public member inventory")
for row in inventory:
    data = payload[row["path"]]
    require(len(data)==row["bytes"] and sha(data)==row["sha256"], "Raw member hash mismatch")
    origin = row["origin"]
    if row["transformation"]=="exact":
        require(row["bytes"]==origin["bytes"] and row["sha256"]==origin["sha256"], "Copied source-member mismatch")
    else:
        require(row["transformation"]=="omit-private-json-fields", "Unknown transformation")
        value = parsed(data)
        require(encoded(value)==data, "Derived report is not in the declared canonical format")
        require(value["publication"]["original"]==origin, "Derived report origin differs")
        require({row["pointer"] for row in value["publication"]["omissions"]}==
            {"/inspections","/network","/volumes","/config","/connections","/mongo/uri","/mongo/container"},
            "Derived report omission allowlist differs")
        for omitted in value["publication"]["omissions"]:
            parts = omitted["pointer"].strip("/").split("/")
            node = value
            for part in parts[:-1]:
                node = node.get(part,{})
            require(parts[-1] not in node, "Declared private omission is present")
            require(omitted["present"] in (True,False), "Invalid omission receipt")
for source in manifest["sourceArchives"]:
    members = source["members"]
    require(len(members)==source["memberCount"], "Original member inventory count differs")
    require(sum(r["type"]=="file" for r in members)==source["regularFiles"], "Original regular-file inventory differs")
    require(sum(r["bytes"] for r in members if r["type"]=="file")==source["regularBytes"], "Original byte inventory differs")
    for row in members:
        if row["action"] in ("copied","derived"):
            public = next(r for r in inventory if r["path"]==row["publicPath"])
            origin=public["origin"]
            require(origin["member"]==row["path"] and origin["sha256"]==row["sha256"] and origin["bytes"]==row["bytes"]
                and origin["archive"]==source["archive"] and origin["archiveSha256"]==source["sha256"], "Member origin link differs")
        else:
            require(row["action"]=="omitted" and row["reason"], "Undeclared omission")
repacked = output/"raw-evidence.repacked.tar.gz"
write_tar(repacked,payload)
require(bounded_file(repacked)==bounded_file(root/"raw-evidence.tar.gz"), "Deterministic archive replay differs")
subprocess.run([sys.executable,str(root/"reproduce/test-metadata-reader.py"),str(root)],check=True,timeout=30)
for script, destination in [("verify-kernel.py","kernel"),("verify-workers.py","worker"),("verify-emission-control.py","emission-control")]:
    subprocess.run([sys.executable,str(root/"reproduce"/script),str(root),str(output/destination)],check=True,timeout=120)
result = {"schemaVersion":1,"status":"verified-public-package","publicFiles":len(records)+1,
          "rawMembers":len(payload),"deterministicRawArchive":True,"independentAudits":3,
          "authenticatedBoundedMetadataControls":True,
          "limitations":["Original private archives and omitted values are not present; their identities/omissions are captured provenance receipts, not rehashed original archive bytes.",
             "No services, validators, native runtime binaries or performance experiments are executed.",
             "One pilot pair and four kernel plumbing reports; 20 fresh comparison cases and full #246 remain outside this package."]}
(output/"verification.json").write_bytes(encoded(result))
print(encoded(result).decode("ascii"))
