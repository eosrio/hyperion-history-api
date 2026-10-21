"""Create/clean the exclusively owned ES/Rabbit/Redis fixture; Mongo is owned by the driver."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time

from prepare import ordinary


REPO = Path(__file__).resolve().parents[3]
REDIS_IMAGE = "redis@sha256:978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241"


def command(arguments, timeout=30):
    result = subprocess.run(arguments, cwd=REPO, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=True, timeout=timeout)
    if len(result.stdout) + len(result.stderr) > 1024 * 1024:
        raise ValueError("Fixture command output exceeds its bound")
    return result.stdout.strip()


def docker(*arguments, timeout=30):
    return command(["docker", *arguments], timeout)


def save(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
    os.replace(temporary, path)


def labels(value, qualifier, run):
    if value.get("io.eosrio.qualifier") != qualifier or value.get("io.eosrio.run") != run:
        raise ValueError("Fixture ownership differs")


def core_state(directory):
    value = json.loads(ordinary(directory / "core-state.json").read_text(encoding="utf-8-sig"))
    if not re.fullmatch("[0-9a-f]{12}", value["run"]) or value["network"] != "hyp-es955-replicas-" + value["run"]:
        raise ValueError("Unexpected core fixture identity")
    return value


def core_command(action, directory, pwsh, disk_watermark_profile="20-10-5gb"):
    if disk_watermark_profile not in ("20-10-5gb", "8-4-2gb"):
        raise ValueError("Unsupported disposable fixture disk watermark profile")
    arguments = [pwsh, "-NoProfile", "-File", "scripts/qualification/es955-replica-fixture.ps1",
                 "-Action", action, "-StateFile", str(directory / "core-state.json")]
    if action == "create":
        arguments += ["-ExposeRabbitManagement", "-IndexingPressureLimitMb", "64",
                      "-DiskWatermarkProfile", disk_watermark_profile]
    # Preserve diagnostics if core setup or ownership-checked cleanup fails.
    with (directory / ("core-" + action + ".log")).open("ab") as log:
        subprocess.run(arguments, cwd=REPO, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=360)


def create(directory, pwsh, disk_watermark_profile="20-10-5gb"):
    if disk_watermark_profile not in ("20-10-5gb", "8-4-2gb"):
        raise ValueError("Unsupported disposable fixture disk watermark profile")
    directory = Path(directory).absolute()
    parent = ordinary(directory.parent, directory=True)
    if os.path.lexists(directory):
        raise FileExistsError("Service fixture directory must be new")
    directory = parent / directory.name
    directory.mkdir()
    core_command("create", directory, pwsh, disk_watermark_profile)
    core = core_state(directory)
    if core["status"] != "ready" or core["indexingPressureLimitMb"] != 64:
        raise ValueError("Core fixture is not ready at the actual-source pressure budget")
    if core.get("diskWatermarkProfile") != disk_watermark_profile:
        raise ValueError("Core disposable fixture disk watermark profile differs")
    run = core["run"]
    name = core["network"] + "-redis"
    volume = name + "-data"
    state = {"schemaVersion": 1, "run": run, "network": core["network"], "core": core,
             "redis": {"name": name, "volume": volume, "containerId": None, "url": None}}
    save(directory / "worker-state.json", state)  # Reserve exact Redis intent before any creation.
    tag = ["--label", "io.eosrio.qualifier=es198-workers", "--label", "io.eosrio.run=" + run]
    docker("pull", REDIS_IMAGE, timeout=180)
    docker("volume", "create", *tag, volume)
    cid = docker("run", "-d", "--name", name, "--hostname", name, "--network", core["network"], *tag,
                 "--cpus", "1", "--memory", "512m", "--publish", "127.0.0.1::6379", "--mount",
                 "type=volume,src=" + volume + ",dst=/data", REDIS_IMAGE, "redis-server", "--appendonly", "yes",
                 "--maxmemory", "384mb", "--maxmemory-policy", "noeviction")
    if not re.fullmatch("[0-9a-f]{64}", cid):
        raise ValueError("Unexpected Redis container identity")
    state["redis"]["containerId"] = cid
    save(directory / "worker-state.json", state)
    inspected = json.loads(docker("inspect", cid))[0]
    labels(inspected["Config"]["Labels"], "es198-workers", run)
    if inspected["Config"]["Image"] != REDIS_IMAGE or inspected["Name"] != "/" + name:
        raise ValueError("Redis identity differs")
    ports = inspected["NetworkSettings"]["Ports"]["6379/tcp"]
    if len(ports) != 1 or ports[0]["HostIp"] != "127.0.0.1" or not 1024 < int(ports[0]["HostPort"]) < 65536:
        raise ValueError("Redis must publish one ephemeral loopback port")
    state["redis"]["url"] = "redis://127.0.0.1:" + ports[0]["HostPort"]
    save(directory / "worker-state.json", state)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            if docker("exec", cid, "redis-cli", "ping", timeout=3) == "PONG":
                return {"state": str(directory / "worker-state.json"), "run": run, "status": "ready"}
        except subprocess.SubprocessError:
            pass
        time.sleep(0.25)
    raise RuntimeError("Owned Redis did not become ready; preserve the state for cleanup")


def cleanup(directory, pwsh):
    directory = ordinary(directory, directory=True)
    core = core_state(directory)
    worker_path = directory / "worker-state.json"
    receipt = {"schemaVersion": 1, "run": core["run"], "redisContainersRemoved": [], "redisVolumesRemoved": []}
    if worker_path.exists():
        state = json.loads(ordinary(worker_path).read_text(encoding="utf-8"))
        if state["run"] != core["run"] or state["network"] != core["network"] or state["core"] != core:
            raise ValueError("Worker/core fixture identities differ")
        redis = state["redis"]
        name = core["network"] + "-redis"
        if redis["name"] != name or redis["volume"] != name + "-data":
            raise ValueError("Unexpected Redis resource intent")
        inventory = docker("ps", "-a", "--no-trunc", "--filter", "name=^/" + name + "$", "--format", "{{.ID}}|{{.Names}}")
        candidates = [line.split("|", 1) for line in inventory.splitlines() if line]
        if len(candidates) > 1 or any(row[1] != name for row in candidates):
            raise ValueError("Ambiguous Redis resource")
        cid = candidates[0][0] if candidates else None
        if cid:
            inspected = json.loads(docker("inspect", cid))[0]
            labels(inspected["Config"]["Labels"], "es198-workers", core["run"])
            if redis["containerId"] is not None and redis["containerId"] != cid:
                raise ValueError("Redis container was replaced")
            if inspected["Id"] != cid or inspected["Name"] != "/" + name or inspected["Config"]["Image"] != REDIS_IMAGE:
                raise ValueError("Redis identity differs")
            mounts = [entry for entry in inspected["Mounts"] if entry["Destination"] == "/data"]
            if len(mounts) != 1 or mounts[0]["Type"] != "volume" or mounts[0]["Name"] != redis["volume"]:
                raise ValueError("Redis volume differs")
        volumes = docker("volume", "ls", "--quiet", "--filter", "name=^" + redis["volume"] + "$").splitlines()
        if volumes and volumes != [redis["volume"]]:
            raise ValueError("Ambiguous Redis volume")
        if volumes:
            inspected_volume = json.loads(docker("volume", "inspect", redis["volume"]))[0]
            labels(inspected_volume["Labels"], "es198-workers", core["run"])
            users = docker("ps", "-a", "--no-trunc", "--filter", "volume=" + redis["volume"], "--format", "{{.ID}}").splitlines()
            if users != ([cid] if cid else []):
                raise ValueError("Unexpected Redis volume consumer")
        if cid:
            docker("rm", "--force", cid)
            receipt["redisContainersRemoved"].append(cid)
        if volumes:
            docker("volume", "rm", redis["volume"])
            receipt["redisVolumesRemoved"].append(redis["volume"])
        if docker("ps", "-a", "--filter", "name=^/" + name + "$", "--format", "{{.ID}}"):
            raise ValueError("Redis container cleanup did not verify")
        if docker("volume", "ls", "--quiet", "--filter", "name=^" + redis["volume"] + "$"):
            raise ValueError("Redis volume cleanup did not verify")
    receipt["redisVerifiedAbsent"] = True
    save(directory / "redis.cleanup.json", receipt)
    # The core script deliberately refuses foreign/run-labelled resources: remove owned Redis first.
    core_command("cleanup", directory, pwsh)
    complete = json.loads(ordinary(directory / "core-state.json.cleanup.json").read_text(encoding="utf-8-sig"))
    if any(complete[field] != 0 for field in ["remainingContainers", "remainingVolumes", "remainingNetworks"]):
        raise ValueError("Core resource cleanup did not verify")
    return {"status": "cleaned", "run": core["run"], "redis": receipt, "core": complete}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["create", "cleanup"])
    parser.add_argument("directory", help="new service directory for create; preserved service directory for cleanup")
    parser.add_argument("--pwsh", default="pwsh", help="PowerShell7 executable; defaults to PATH")
    parser.add_argument("--disk-watermark-profile", choices=["20-10-5gb", "8-4-2gb"], default="20-10-5gb",
                        help="create only: explicit disposable fixture disk profile; default20/10/5GiB")
    arguments = parser.parse_args()
    if arguments.action == "cleanup" and arguments.disk_watermark_profile != "20-10-5gb":
        parser.error("cleanup uses preserved ownership state; disk profile applies only to create")
    result = create(arguments.directory, arguments.pwsh, arguments.disk_watermark_profile) if arguments.action == "create" else cleanup(arguments.directory, arguments.pwsh)
    print(json.dumps(result, indent=2))
