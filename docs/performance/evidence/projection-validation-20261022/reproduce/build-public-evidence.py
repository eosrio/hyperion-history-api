"""Stage public #252 evidence from explicit private frozen inputs; no services/Git.

Custodian use: python build-public-evidence.py --inputs ROOT --native-audit AUDIT
--output NEW_DIRECTORY. Public readers use reproduce/verify-public.py instead.
Uses the regular-only inventory, explicit-omission and deterministic USTAR/gzip
format established by portable-state-prefix-20261022. No archive is extracted.
"""
from pathlib import Path
import argparse
import copy
import json
import re
import sys
sys.dont_write_bytecode = True

TEMPLATES = Path(__file__).resolve().parent/"templates"
sys.path.insert(0,str(TEMPLATES if TEMPLATES.is_dir() else Path(__file__).resolve().parent))
from common import CASES, HEAD, archive_files, bounded_file, encoded, inspect_tar, parsed, require, safe_name, sha, write_tar

ARCHIVES = {
    CASES[0]:"f71f1ca0040cd9b4e874b06146a92c73c9396855c8bfde6b84fa4288c942ee8b",
    CASES[1]:"a5cf1466dacc3b96cb94784d63151d1da853936e38fb84aefd4c21435335cb05",
}
EMISSION_SHA = "1b5c31062319386fc981d184f7904a0a9f9b7276bb76d166e737d9c15e3275e6"
PRIVATE_REPORT_FIELDS = (("inspections",),("network",),("volumes",),("config",),("connections",),("mongo","uri"),("mongo","container"))

def put(root, name, data):
    safe_name(name)
    path = root/name
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open("xb") as file:
        file.write(data)

def report_projection(data, origin):
    value = parsed(data)
    require(isinstance(value,dict) and "publication" not in value, "Unexpected source report")
    result, omitted = copy.deepcopy(value), []
    for parts in PRIVATE_REPORT_FIELDS:
        node = result
        for part in parts[:-1]:
            node = node.get(part,{})
        row = {"pointer":"/"+"/".join(parts),"present":parts[-1] in node,
               "reason":"Private connection/configuration, container environment or topology"}
        if row["present"]:
            original = encoded(node.pop(parts[-1]))
            row.update(canonicalValueBytes=len(original),canonicalValueSha256=sha(original))
        omitted.append(row)
    result["publication"] = {"derived":True,"original":origin,"omissions":omitted}
    return encoded(result)

def source_origin(case, member, data):
    return {"archive":case+"-full.tar.gz","archiveSha256":ARCHIVES[case],
            "member":member,"bytes":len(data),"sha256":sha(data)}

def selected_case(case, inputs, payload, public_inventory):
    archive = inputs/(case+"-full.tar.gz")
    raw = bounded_file(archive)
    require(sha(raw)==ARCHIVES[case], "Original pilot archive hash mismatch")
    members, expanded = inspect_tar(archive,regular_only=False)
    inventory = []
    for member in members:
        row = {k:v for k,v in member.items() if k!="data"}
        row.update(action="omitted",reason="Outside the explicit diagnostic allowlist")
        destination, data, transformation = None, member.get("data"), "exact"
        name = member["path"]
        local = name[len(case)+1:] if name.startswith(case+"/") else None
        if member["type"]=="directory":
            row["reason"] = "Directory header omitted; public archive has regular members only"
        elif member["type"]=="symlink":
            require(local and local.startswith("logs/") and local.endswith("/deserialization_errors.log"), "Unexpected original link")
            row["reason"] = "Known relative error-log symlink inspected and skipped; never followed or materialized"
        elif local=="report.json":
            destination = "cases/"+case+"/report.json"
            data = report_projection(data,source_origin(case,name,data))
            transformation = "omit-private-json-fields"
        elif local and local.startswith(("bulk/","observer/","projection-observer/","stages/")):
            destination = "cases/"+case+"/"+local
        elif name==case+"-invocation.json":
            destination = "cases/"+case+"/invocation.json"
        elif name==case+"-resources.jsonl":
            destination = "cases/"+case+"/driver/resources.jsonl"
        elif name=="source-emission-pins-"+HEAD+".json":
            destination = "cases/"+case+"/source-emission-pins.json"
        elif name=="runtimes/receipt.json":
            destination = "cases/"+case+"/runtimes.json"
        elif name.endswith(".cleanup.json"):
            destination = "cases/"+case+"/cleanup/"+name
        elif local=="chain.json" or (local and local.startswith("config/")) or name.endswith(("core-state.json","worker-state.json")):
            row["reason"] = "Credential-bearing disposable service/configuration state omitted"
        elif "-precleanup/" in name or (local and (local.startswith("logs/") or local.endswith(".log"))) or name.endswith(".log"):
            row["reason"] = "Human/service logs and container inspections omitted; resource/process JSONL and cleanup receipts retained separately"
        if destination is not None:
            require(member["type"]=="file" and destination not in payload, "Invalid/duplicate public selection")
            payload[destination] = data
            origin = source_origin(case,name,member["data"])
            public_inventory.append({"path":destination,"bytes":len(data),"sha256":sha(data),"origin":origin,"transformation":transformation})
            row.update(action="copied" if transformation=="exact" else "derived",publicPath=destination)
            row.pop("reason",None)
        inventory.append(row)
    require(sum(m["type"]=="symlink" for m in inventory)==1,"Expected exactly one skipped relative log symlink per original case")
    return {"case":case,"archive":archive.name,"bytes":len(raw),"sha256":sha(raw),"gzipExpandedBytes":expanded,
            "memberCount":len(inventory),"regularFiles":sum(r["type"]=="file" for r in inventory),
            "regularBytes":sum(r["bytes"] for r in inventory if r["type"]=="file"),"members":inventory}

def scan_public(name, data):
    require(not re.search(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY",data),"Private-key marker in public selection")
    require(not re.search(rb"gh[pousr]_[A-Za-z0-9]{30,}",data),"Token marker in public selection")
    for match in re.finditer(rb"(?i)(?:mongodb|amqp|https?)://([^\s/\"']+:[^\s/\"']+)@",data):
        require(b"${" in match[1], "Literal credential URL in public selection: "+name)

def adapt(source, changes, label):
    text = source.decode("utf-8")
    receipts = []
    for before, after, reason in changes:
        require(text.count(before)==1, "Ambiguous/missing adaptation in "+label+": "+reason)
        receipts.append({"reason":reason,"originalBlockSha256":sha(before.encode()),"publicBlockSha256":sha(after.encode())})
        text = text.replace(before,after)
    return text.encode(), {"originalFile":label,"originalBytes":len(source),"originalSha256":sha(source),"edits":receipts}

def kernel_verifier(native):
    source = bounded_file(native/"audit.py")
    original = source.decode()
    start = original.index("public_path=BASE/")
    end = original.index("harness_bytes=",start)
    replacement = """code_bytes={}
for code in origin['code']:
    data=EMISSION[code['path']]
    assert len(data)==code['bytes'] and sha(data)==code['sha256']
    code_bytes[code['path']]=data
emission_path=PACKAGE_ROOT/'retained-emission.tar.gz'
"""
    header_start = original.index("HERE = Path(__file__).resolve().parent")
    header_end = original.index("HEAD = ",header_start)
    header = """import sys
sys.dont_write_bytecode = True
from common import archive_files, bounded_file, parsed, require, safe_name, sha, verifier_arguments
PACKAGE_ROOT, HERE = verifier_arguments('Independently verify four frozen native kernel reports; no services or validators')
INPUT = PACKAGE_ROOT/'kernel'
ROOT = PACKAGE_ROOT/'receipts'
EMISSION = archive_files(PACKAGE_ROOT/'retained-emission.tar.gz')
WITNESSES = parsed(bounded_file(PACKAGE_ROOT/'source-witnesses/receipt.json'))
require({row['path'] for row in WITNESSES['files']}=={'packages/backend-mongodb/src/contract.ts','packages/backend-mongodb/src/rollback-contract.ts'},'Unexpected source witness paths')
SOURCE = {row['path']:bounded_file(PACKAGE_ROOT/'source-witnesses'/safe_name(row['path'])) for row in WITNESSES['files']}
for row in WITNESSES['files']:
    require(len(SOURCE[row['path']])==row['bytes'] and sha(SOURCE[row['path']])==row['sha256'],'Source witness differs')
"""
    changes = [(original[header_start:header_end],header,"Replace private paths with explicit public package/fresh output arguments"),
        ("import subprocess","","Remove unused process dependency after replacing Git reads"),
        ("assert HERE.name == 'hyperion-hapi252-native-audit-d95d-20261022'","assert PACKAGE_ROOT.is_dir()","Portable verifier location"),
        ("return json.loads(path.read_bytes())","return parsed(bounded_file(path))","Bound standalone JSON reads"),
        ("data=(INPUT/filename).read_bytes();assert sha(data)==digest","data=bounded_file(INPUT/filename);assert sha(data)==digest","Bound standalone raw report read"),
        ("log_bytes=(INPUT/(filename[:-5]+'.log')).read_bytes();log=json.loads(log_bytes)","log_bytes=bounded_file(INPUT/(filename[:-5]+'.log'));log=json.loads(log_bytes)","Bound standalone log read"),
        ("sha((INPUT/'invocations.json').read_bytes())","sha(bounded_file(INPUT/'invocations.json'))","Bound invocation checksum read"),
        ("sha((ROOT/'h1-preparation-receipt.json').read_bytes())","sha(bounded_file(ROOT/'h1-preparation-receipt.json'))","Bound preparation checksum read"),
        ("return subprocess.check_output(['git','-C',str(REPO),'show',HEAD+':'+name])","return EMISSION[name] if name in EMISSION else SOURCE[name]","Read retained exact bytes; no Git invocation"),
        ("origin_bytes=(HERE/'origin.json').read_bytes();origin=json.loads(origin_bytes)","origin_bytes=EMISSION['tests/fixtures/projection-validation/origin.json'];origin=json.loads(origin_bytes)","Read committed origin witness from retained emission"),
        ("packed_bytes=(HERE/'metadata.json.gz.base64').read_bytes()","packed_bytes=EMISSION['tests/fixtures/projection-validation/metadata.json.gz.base64']","Read exact compact metadata witness"),
        (original[start:end],replacement,"Use retained metadata/code bytes; old private/public origin archive identities remain receipts, not freshly rehashed archives"),
        ("harness_bytes=(HERE/'projection-validation-kernel.mjs').read_bytes()","harness_bytes=EMISSION['scripts/qualification/projection-validation-kernel.mjs']","Read measured harness bytes"),
        ("'originArchivesIndependentlyRehashed':True","'originArchivesIndependentlyRehashed':False, 'originArchiveVerification':'Captured origin pins only; original historical archives are outside this publication'","Expose external origin archive omission"),
        ("'MongoDB/BSON nested-resolution identities are retained module/package receipts and harness identity assertions; dependency library bytes are not included in the original auxiliary archive. Independent JSON-subset BSON reconstruction matches all twelve reported byte hashes.'","'Actual MongoDB/BSON entry and package bytes are retained as five pre-pilot kernel witnesses; full dependency trees and runtime binaries are not archived. Independent JSON-subset BSON reconstruction matches all twelve reported byte hashes.'","Describe later exact code retention without implying complete dependencies"),
    ]
    result, receipt = adapt(source,changes,"native-kernel-audit.py")
    return result,receipt

def worker_verifier(inputs):
    source = bounded_file(inputs/"actual-worker-pilot-audit-verified/spec-audit-measured-pilot.py")
    text = source.decode()
    begin = text.index("r = read(RUN / 'report.json')")
    header = """\"\"\"Replay the independent worker span/state audit over public retained bytes; no services.\"\"\"
import collections, hashlib, json, sys
sys.dont_write_bytecode = True
from common import CASES, HEAD, VirtualPath, bounded_file, encoded, parsed, verifier_arguments, worker_context
PACKAGE_ROOT, OUT = verifier_arguments(__doc__)
payload, publication, files = worker_context(PACKAGE_ROOT)
CASE = CASES[0]
ROOT = VirtualPath(files)
DEST = ROOT/'measured-pilot-regular-files'
RUN = DEST/CASE
sha = lambda data: hashlib.sha256(data).hexdigest()
read = lambda file: parsed(file.read_bytes())
source = next(row for row in publication['sourceArchives'] if row['case']==CASE)
EXPECTED_ARCHIVE = source['sha256']
members = source['members']
member_manifest = [{key:row[key] for key in ['path','bytes','sha256']} for row in members if row['type']=='file']
links = [{'path':row['path'],'target':row['linkTarget']} for row in members if row['type']=='symlink']
total_bytes = source['regularBytes']
"""
    result, receipt = adapt(source,[(text[:begin],header,"Replace private extraction/original archive access with bounded public tar reader and captured source-member inventory"),
        ("607-file emitted payload not present in pilot archive; payload byte verification is pending separately.","Original pilot archive did not include payload; companion public emission/control audit verifies the separately retained 612 files.","Keep original audit chronology distinct from current retained-payload verification"),
        ("(ROOT/'spec-measured-pilot-audit.json').write_text", "(OUT/'audit.json').write_text","Write only into fresh audit output"),
    ],"spec-audit-measured-pilot.py")
    return result,receipt

def emission_verifier(inputs):
    source = bounded_file(inputs/"actual-worker-pilot-audit-verified/spec-audit-emission-control.py")
    text = source.decode()
    begin = text.index("audit = read(ROOT / 'spec-measured-pilot-audit.json')")
    header = """\"\"\"Verify retained emission, control pilot and protected-process receipts without services.\"\"\"
import collections, hashlib, io, json, pathlib, tarfile, sys
sys.dont_write_bytecode = True
from common import CASES, HEAD, VirtualPath, bounded_file, parsed, verifier_arguments, worker_context
PACKAGE_ROOT, OUT = verifier_arguments(__doc__)
case_payload, publication, files = worker_context(PACKAGE_ROOT)
CASE, CONTROL = CASES
for name in ['h1-before-d95d797.stdout','postflight-pilot-pair-d95d797.json']:
    files[name]=bounded_file(PACKAGE_ROOT/'receipts'/name)
for name in ['node22-count.json','node22-timing.json','node24-count.json','node24-timing.json']:
    files['kernel252-d95d797-native/'+name]=bounded_file(PACKAGE_ROOT/'kernel'/name)
files['spec-measured-pilot-audit.json']=bounded_file(PACKAGE_ROOT/'audits/worker-audit-original.json')
files['retained-emission-'+HEAD+'-receipt.json']=bounded_file(PACKAGE_ROOT/'retained-emission-receipt.json')
files['retained-emission-'+HEAD+'.tar.gz']=bounded_file(PACKAGE_ROOT/'retained-emission.tar.gz')
ROOT = VirtualPath(files)
DEST = ROOT/'measured-pilot-regular-files'
RUN = DEST/CASE
sha = lambda data: hashlib.sha256(data).hexdigest()
read = lambda file: parsed(file.read_bytes())
r = read(RUN/'report.json')
"""
    cstart = text.index("control_archive = ROOT / (CONTROL + '-full.tar.gz')")
    cend = text.index("assert len(control_links) == 1",cstart)
    control = """control_source = next(row for row in publication['sourceArchives'] if row['case']==CONTROL)
control_archive_sha = control_source['sha256']
assert control_archive_sha == 'a5cf1466dacc3b96cb94784d63151d1da853936e38fb84aefd4c21435335cb05'
assert control_source['bytes'] == 5905863
needed = {CONTROL+'/report.json',CONTROL+'-invocation.json',CONTROL+'/stages/profile-prefix-288.json',
    CONTROL+'/stages/profile-held-head-288.json','source-emission-pins-'+HEAD+'.json'}
captured = {CONTROL+'/report.json':case_payload['cases/'+CONTROL+'/report.json'],
    CONTROL+'-invocation.json':case_payload['cases/'+CONTROL+'/invocation.json'],
    CONTROL+'/stages/profile-prefix-288.json':case_payload['cases/'+CONTROL+'/stages/profile-prefix-288.json'],
    CONTROL+'/stages/profile-held-head-288.json':case_payload['cases/'+CONTROL+'/stages/profile-held-head-288.json'],
    'source-emission-pins-'+HEAD+'.json':case_payload['cases/'+CONTROL+'/source-emission-pins.json']}
control_names = {row['path'] for row in control_source['members']}
control_links = [{'path':row['path'],'target':row['linkTarget']} for row in control_source['members'] if row['type']=='symlink']
control_regular, control_total = control_source['regularFiles'], control_source['regularBytes']
assert not any(row['path'].startswith(CONTROL+'/projection-observer/') and row['type']=='file' for row in control_source['members'])
assert not any(row['path'].endswith('.cpuprofile') for row in control_source['members'])
"""
    result, receipt = adapt(source,[(text[:begin],header,"Replace private paths with bounded public inputs and explicit fresh output"),
        ("with tarfile.open(ROOT / (name + '.tar.gz'), 'r:gz') as archive:","with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode='r:gz') as archive:","Read the retained original emission archive without filesystem extraction"),
        (text[cstart:cend],control,"Verify published control subset against captured source-member inventory; original private control archive is not rehashed here"),
        ("'archiveSha256':sha(control_bytes)","'archiveSha256':control_archive_sha","Use explicitly captured original control archive identity"),
        ("(ROOT/'spec-emission-control-supplement.json').write_text","(OUT/'audit.json').write_text","Write only into fresh audit output"),
    ],"spec-audit-emission-control.py")
    return result,receipt

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs",required=True,type=Path)
    parser.add_argument("--native-audit",required=True,type=Path)
    parser.add_argument("--output",required=True,type=Path)
    options = parser.parse_args()
    inputs, native, output = options.inputs.absolute(),options.native_audit.absolute(),options.output.absolute()
    require(inputs.is_dir() and native.is_dir(),"Explicit input directories required")
    require(output.parent.is_dir() and not output.exists() and not output.is_symlink(),"Output must be fresh with existing parent")
    output.mkdir()
    payload, public_inventory = {}, []
    sources = [selected_case(case,inputs,payload,public_inventory) for case in CASES]
    for name,data in payload.items():
        scan_public(name,data)
    write_tar(output/"raw-evidence.tar.gz",payload)
    originals = []
    def copy_file(source, destination):
        data = bounded_file(source)
        scan_public(destination,data)
        put(output,destination,data)
        originals.append({"path":destination,"originalFile":source.name,"bytes":len(data),"sha256":sha(data),"transformation":"exact"})
    for case in CASES:
        copy_file(inputs/(case+"-local-receipt.json"),"receipts/"+case+"-local-receipt.json")
    for file in sorted((inputs/"kernel252-d95d797-native").iterdir()):
        require(file.name in {"invocations.json",*[r+"-"+m+e for r in ("node22","node24") for m in ("count","timing") for e in (".json",".log")]},"Unexpected kernel input")
        copy_file(file,"kernel/"+file.name)
    retained = inputs/("retained-emission-"+HEAD+".tar.gz")
    require(sha(bounded_file(retained))==EMISSION_SHA,"Retained emission archive hash differs")
    emission = archive_files(retained)
    require(len(emission)==613,"Retained payload inventory differs")
    for name,data in emission.items():
        scan_public(name,data)
    copy_file(retained,"retained-emission.tar.gz")
    copy_file(inputs/("retained-emission-"+HEAD+"-receipt.json"),"retained-emission-receipt.json")
    witnesses = parsed(bounded_file(inputs/"kernel-source-witnesses/receipt.json"))
    require(witnesses["head"]==HEAD and len(witnesses["files"])==2,"Unexpected source witnesses")
    copy_file(inputs/"kernel-source-witnesses/receipt.json","source-witnesses/receipt.json")
    for witness in witnesses["files"]:
        source = inputs/"kernel-source-witnesses"/safe_name(witness["path"])
        data = bounded_file(source)
        require(len(data)==witness["bytes"] and sha(data)==witness["sha256"],"Immutable source witness differs")
        copy_file(source,"source-witnesses/"+witness["path"])
    for name in ["h1-preparation-receipt.json","h1-before-d95d797.stdout","postflight-pilot-pair-d95d797.json"]:
        copy_file(inputs/name,"receipts/"+name)
    for source,destination in [
        (native/"REPORT.md","kernel-audit-original.md"),(native/"COUNTS.json","kernel-counts-original.json"),(native/"audit-results.json","kernel-audit-original.json"),
        (inputs/"actual-worker-pilot-audit-verified/spec-measured-pilot-report.md","worker-audit-original.md"),
        (inputs/"actual-worker-pilot-audit-verified/spec-measured-pilot-audit.json","worker-audit-original.json"),
        (inputs/"actual-worker-pilot-audit-verified/spec-emission-control-supplement.json","emission-control-original.json"),
        (inputs/"pilot-pair-root-audit.json","pilot-pair-root-original.json")]:
        copy_file(source,"audits/"+destination)
    template_source = TEMPLATES if TEMPLATES.is_dir() else Path(__file__).resolve().parent
    for name in ("common.py","verify-public.py"):
        copy_file(template_source/name,"reproduce/"+name)
    adaptations = []
    for name,generated in [("verify-kernel.py",kernel_verifier(native)),("verify-workers.py",worker_verifier(inputs)),("verify-emission-control.py",emission_verifier(inputs))]:
        data, receipt = generated
        put(output,"reproduce/"+name,data)
        receipt.update(publicPath="reproduce/"+name,publicBytes=len(data),publicSha256=sha(data))
        adaptations.append(receipt)
    copy_file(Path(__file__),"reproduce/build-public-evidence.py")
    measured = parsed(payload["cases/"+CASES[0]+"/report.json"])
    control = parsed(payload["cases/"+CASES[1]+"/report.json"])
    audit = parsed(bounded_file(inputs/"actual-worker-pilot-audit-verified/spec-measured-pilot-audit.json"))
    summary = {"schemaVersion":1,"issue":252,"head":HEAD,"status":"pilot-and-kernel-plumbing-only",
        "kernelReports":4,"workerPilots":2,"comparisonCampaign":{"conditions":4,"freshRunsPerCondition":5,"total":20,"status":"pending; pilot pair excluded"},
        "state":{"checkpoint":288,"selectedProjections":3,"rowsPerProjection":0,"undoDescriptors":256,"coverageFloor":32,"replayReceipts":256},
        "workerPhaseStartTables":audit["phaseStartTables"],"workerOperationStartTables":audit["operationStartTables"],
        "pilots":[{"case":case,"measurements":value["profiling"]["projectionMeasurements"]["enabled"],
            "cpuSampling":False,"firstReleaseToStableMs":value["profiling"]["stableAt"]-value["profiling"]["firstReleaseAt"],
            "heldHead":value["profiling"]["projectionMeasurements"]["heldHead"]} for case,value in [(CASES[0],measured),(CASES[1],control)]],
        "units":"Operation/load counts, descriptor visits, overlapping elapsed spans, sampled CPU and process CPU are distinct. Nested scopes are not additive.",
        "limits":["One sequential pilot pair on a shared host is not an overhead estimate, improvement or capacity result.",
            "Native Node22/24 count/timing reports validate plumbing, not a runtime ranking.","No populated-row, original full #246 recovery/finality, live Wire consensus or release qualification.",
            "Exact 612 measured emission/kernel witness files are retained after pilots against pre-run607 pins and five pre-pilot witnesses; two TS source witnesses were retrieved later from immutable Git blobs.",
            "Source re-audit1484 equality receipts are retained; the original1484 source files, historical kernel-origin archives, full dependency trees and native runtime binaries are not included."]}
    put(output,"summary.json",encoded(summary))
    manifest = {"schemaVersion":1,"head":HEAD,"sourceArchives":sources,"publicMembers":public_inventory,"originalFiles":originals,
        "adaptations":adaptations,"retainedEmissionMembers":[{k:v for k,v in row.items() if k!="data"} for row in inspect_tar(retained)[0]],
        "publicSelection":"Raw projection/resource/process observers, bulk requests/responses, physical/API stages, source/broker/cleanup/progress receipts retained; report configuration/environment fields and human/service logs omitted.",
        "provenanceLimit":"Whole original private archive hashes and omitted value/member hashes are captured receipts. A public reader can rehash all retained original bytes and audit declared derivations, but cannot independently reconstruct an original archive containing undisclosed credentials."}
    put(output,"manifest.json",encoded(manifest))
    readme_path = template_source/"README.md"
    readme = bounded_file(readme_path if readme_path.is_file() else template_source.parent/"README.md")
    put(output,"README.md",readme)
    listing = sorted(p.relative_to(output).as_posix() for p in output.rglob("*") if p.is_file())
    put(output,"SHA256SUMS",("".join(sha(bounded_file(output/name))+"  "+name+"\n" for name in listing)).encode("ascii"))
    total = sum(p.stat().st_size for p in output.rglob("*") if p.is_file())
    require(total <= 30*1024**2,"Final package exceeds30MiB")
    print(json.dumps({"status":"staged","files":len(listing)+1,"bytes":total,"rawMembers":len(payload),"output":str(output)},sort_keys=True))

if __name__=="__main__":
    main()
