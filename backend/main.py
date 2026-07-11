from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
from pathlib import Path

import yaml
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import hosts_inventory as hv
import molecule_runner as mol
import offline as off
import parser as gv

BASE_DIR = Path(__file__).resolve().parent
KUBESPRAY_ROOT = Path(os.environ["KUBESPRAY_ROOT"]).resolve() if os.environ.get("KUBESPRAY_ROOT") else (BASE_DIR / ".." / ".." / "kubespray").resolve()
# Real host-side path to KUBESPRAY_ROOT - only differs from it when running
# containerized (see HOST_KUBESPRAY_ROOT in docker-compose.yml). Needed for any
# `docker run -v` command built by offline.py, since those are resolved by the
# host's daemon against host paths, not this container's.
HOST_KUBESPRAY_ROOT = Path(os.environ["HOST_KUBESPRAY_ROOT"]).resolve() if os.environ.get("HOST_KUBESPRAY_ROOT") else KUBESPRAY_ROOT
INVENTORY_ROOT = KUBESPRAY_ROOT / "inventory"
SAMPLE_DIR = INVENTORY_ROOT / "sample"
STATIC_DIR = (BASE_DIR / ".." / "static").resolve()
MOLECULE_ROOT = (BASE_DIR / ".." / "molecule").resolve()

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
BRANCH_NAME_RE = re.compile(r"^(?!-)[A-Za-z0-9._/-]{1,200}$")
REGISTRY_ADDR_RE = re.compile(r"^[A-Za-z0-9.-]+(:[0-9]{1,5})?$")
UBUNTU_RELEASE_RE = re.compile(r"^[0-9]{2}\.[0-9]{2}$")
HOST_ADDR_RE = re.compile(r"^[A-Za-z0-9.-]+$")

# Friendly labels/groups for the known kubespray group_vars files.
FILE_META = {
    "all/all.yml": ("General", "Core Cluster Settings", "Networking basics, proxy, DNS, cloud provider hooks and other cluster-wide defaults."),
    "all/etcd.yml": ("General", "etcd", "etcd deployment type, versions and TLS settings."),
    "all/containerd.yml": ("Container Engine", "containerd", "containerd runtime configuration."),
    "all/docker.yml": ("Container Engine", "Docker", "Docker engine configuration."),
    "all/cri-o.yml": ("Container Engine", "CRI-O", "CRI-O runtime configuration."),
    "all/coreos.yml": ("General", "Container Linux (CoreOS)", "Settings specific to Container Linux hosts."),
    "all/offline.yml": ("General", "Offline / Air-gapped", "Mirrors and registries for offline installs."),
    "all/oci.yml": ("Cloud Providers", "Oracle Cloud (OCI)", "OCI cloud controller settings."),
    "all/aws.yml": ("Cloud Providers", "AWS", "AWS cloud controller settings."),
    "all/azure.yml": ("Cloud Providers", "Azure", "Azure cloud controller settings."),
    "all/gcp.yml": ("Cloud Providers", "GCP", "Google Cloud controller settings."),
    "all/openstack.yml": ("Cloud Providers", "OpenStack", "OpenStack cloud controller settings."),
    "all/vsphere.yml": ("Cloud Providers", "vSphere", "vSphere cloud controller settings."),
    "all/hcloud.yml": ("Cloud Providers", "Hetzner Cloud", "Hetzner Cloud controller settings."),
    "all/huaweicloud.yml": ("Cloud Providers", "Huawei Cloud", "Huawei Cloud controller settings."),
    "all/upcloud.yml": ("Cloud Providers", "UpCloud", "UpCloud controller settings."),
    "k8s_cluster/k8s-cluster.yml": ("Kubernetes", "Cluster Core", "Kubernetes version, networking plugin choice, DNS, API server and controller-manager settings."),
    "k8s_cluster/addons.yml": ("Kubernetes", "Addons", "Helm, ingress controllers, metrics-server, registry, storage provisioners and other optional addons."),
    "k8s_cluster/kube_control_plane.yml": ("Kubernetes", "Control Plane", "kube-apiserver / controller-manager / scheduler tuning."),
    "k8s_cluster/k8s-net-calico.yml": ("Networking Plugins", "Calico", "Calico CNI configuration."),
    "k8s_cluster/k8s-net-cilium.yml": ("Networking Plugins", "Cilium", "Cilium CNI configuration."),
    "k8s_cluster/k8s-net-flannel.yml": ("Networking Plugins", "Flannel", "Flannel CNI configuration."),
    "k8s_cluster/k8s-net-kube-router.yml": ("Networking Plugins", "Kube-router", "Kube-router CNI configuration."),
    "k8s_cluster/k8s-net-kube-ovn.yml": ("Networking Plugins", "Kube-OVN", "Kube-OVN CNI configuration."),
    "k8s_cluster/k8s-net-macvlan.yml": ("Networking Plugins", "Macvlan", "Macvlan CNI configuration."),
    "k8s_cluster/k8s-net-custom-cni.yml": ("Networking Plugins", "Custom CNI", "Bring-your-own CNI configuration."),
}

app = FastAPI(title="Kubespray Variables Editor")


def _validate_name(name: str) -> str:
    if not NAME_RE.match(name):
        raise HTTPException(400, "Invalid inventory name. Use letters, numbers, - or _.")
    return name


def _inventory_dir(name: str) -> Path:
    _validate_name(name)
    d = (INVENTORY_ROOT / name).resolve()
    if not str(d).startswith(str(INVENTORY_ROOT)):
        raise HTTPException(400, "Invalid inventory path.")
    if not d.is_dir():
        raise HTTPException(404, f"Inventory '{name}' not found.")
    return d


def _canonical_files() -> list[str]:
    files = []
    for sub in ("all", "k8s_cluster"):
        d = SAMPLE_DIR / "group_vars" / sub
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.yml")):
            files.append(f"{sub}/{f.name}")
    return files


def _resolve_file(inv: str, rel_path: str) -> Path:
    if rel_path not in _canonical_files():
        raise HTTPException(404, "Unknown group_vars file.")
    inv_dir = _inventory_dir(inv)
    target = (inv_dir / "group_vars" / rel_path).resolve()
    # Some kubespray inventories (e.g. "local") symlink group_vars straight at
    # "sample", so only require the resolved file to stay within the overall
    # inventory tree rather than the specific inventory's own directory.
    if not str(target).startswith(str(INVENTORY_ROOT)):
        raise HTTPException(400, "Invalid file path.")
    return target


class CreateInventory(BaseModel):
    name: str
    clone_from: str | None = None


class UpdatesPayload(BaseModel):
    updates: dict[str, dict]


class RawPayload(BaseModel):
    text: str


@app.get("/api/inventories")
def list_inventories():
    if not INVENTORY_ROOT.is_dir():
        raise HTTPException(500, f"Kubespray inventory dir not found at {INVENTORY_ROOT}")
    names = sorted(p.name for p in INVENTORY_ROOT.iterdir() if p.is_dir())
    return {"inventories": names, "sample": "sample" in names}


@app.post("/api/inventories")
def create_inventory(payload: CreateInventory):
    _validate_name(payload.name)
    dest = INVENTORY_ROOT / payload.name
    if dest.exists():
        raise HTTPException(409, "An inventory with this name already exists.")
    src_name = payload.clone_from or "sample"
    src = _inventory_dir(src_name)
    shutil.copytree(src, dest)
    return {"ok": True, "name": payload.name}


@app.delete("/api/inventories/{inv}")
def delete_inventory(inv: str):
    if inv == "sample":
        raise HTTPException(400, "The 'sample' inventory is the built-in template and cannot be deleted.")
    inv_dir = _inventory_dir(inv)
    shutil.rmtree(inv_dir)
    return {"ok": True}


@app.get("/api/inventories/{inv}/files")
def list_files(inv: str):
    _inventory_dir(inv)
    out = []
    for rel in _canonical_files():
        group, title, desc = FILE_META.get(rel, ("Other", rel, ""))
        exists = (_inventory_dir(inv) / "group_vars" / rel).is_file()
        out.append({"path": rel, "group": group, "title": title, "description": desc, "exists": exists})
    return {"files": out}


def _entry_dict(e: gv.Entry) -> dict:
    return {
        "key": e.key,
        "enabled": e.enabled,
        "description": e.description,
        "value": e.raw_block if e.multiline else e.value,
        "multiline": e.multiline,
        "type": gv.infer_type(e.value) if not e.multiline else "block",
    }


@app.get("/api/inventories/{inv}/files/{rel_path:path}")
def get_file(inv: str, rel_path: str):
    target = _resolve_file(inv, rel_path)
    if not target.is_file():
        raise HTTPException(404, "File does not exist in this inventory.")
    text = target.read_text()
    parsed = gv.parse(text)
    return {
        "path": rel_path,
        "raw": text,
        "entries": [_entry_dict(e) for e in parsed.entries],
    }


@app.put("/api/inventories/{inv}/files/{rel_path:path}")
def update_file(inv: str, rel_path: str, payload: UpdatesPayload):
    target = _resolve_file(inv, rel_path)
    if not target.is_file():
        raise HTTPException(404, "File does not exist in this inventory.")
    text = target.read_text()
    parsed = gv.parse(text)
    new_parsed = gv.apply_updates(parsed, payload.updates)
    new_text = new_parsed.to_text()

    # Validate: everything that is currently "enabled" must be valid YAML.
    active_text = "\n".join(
        line for line in new_text.splitlines() if not line.lstrip().startswith("#")
    )
    try:
        yaml.safe_load(active_text)
    except yaml.YAMLError as exc:
        raise HTTPException(400, f"Resulting YAML is invalid: {exc}")

    target.write_text(new_text)
    return {
        "path": rel_path,
        "raw": new_text,
        "entries": [_entry_dict(e) for e in new_parsed.entries],
    }


@app.put("/api/inventories/{inv}/files/{rel_path:path}/raw")
def update_file_raw(inv: str, rel_path: str, payload: RawPayload):
    target = _resolve_file(inv, rel_path)
    text = payload.text
    active_text = "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("#")
    )
    try:
        yaml.safe_load(active_text)
    except yaml.YAMLError as exc:
        raise HTTPException(400, f"Invalid YAML: {exc}")
    target.write_text(text if text.endswith("\n") else text + "\n")
    parsed = gv.parse(target.read_text())
    return {
        "path": rel_path,
        "raw": target.read_text(),
        "entries": [_entry_dict(e) for e in parsed.entries],
    }


INVENTORY_FILE_CANDIDATES = ["inventory.yml", "inventory.yaml", "hosts.yaml", "hosts.ini", "inventory.ini"]


@app.get("/api/inventories/{inv}/ops-context")
def ops_context(inv: str):
    inv_dir = _inventory_dir(inv)
    found = next((f for f in INVENTORY_FILE_CANDIDATES if (inv_dir / f).is_file()), None)
    rel_file = found or INVENTORY_FILE_CANDIDATES[-1]
    return {"inventory_arg": f"inventory/{inv}/{rel_file}"}


@app.get("/api/inventories/{inv}/search")
def search(inv: str, q: str):
    _inventory_dir(inv)
    q_low = q.lower().strip()
    if not q_low:
        return {"results": []}
    results = []
    for rel in _canonical_files():
        target = _inventory_dir(inv) / "group_vars" / rel
        if not target.is_file():
            continue
        parsed = gv.parse(target.read_text())
        for e in parsed.entries:
            haystack = f"{e.key} {e.description}".lower()
            if q_low in haystack:
                d = _entry_dict(e)
                d["file"] = rel
                results.append(d)
    return {"results": results}


class HostsPayload(BaseModel):
    hosts: list[dict]


def _hosts_file(inv: str) -> Path:
    return _inventory_dir(inv) / "inventory.yml"


@app.get("/api/inventories/{inv}/hosts")
def get_hosts(inv: str):
    target = _hosts_file(inv)
    if not target.is_file():
        return {"hosts": [], "raw": ""}
    text = target.read_text()
    try:
        hosts = hv.parse_hosts_file(text)
    except yaml.YAMLError as exc:
        raise HTTPException(400, f"inventory.yml is not valid YAML: {exc}")
    return {"hosts": hosts, "raw": text}


@app.put("/api/inventories/{inv}/hosts")
def put_hosts(inv: str, payload: HostsPayload):
    inv_dir = _inventory_dir(inv)
    try:
        text = hv.render_hosts_file(payload.hosts)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    _hosts_file(inv).write_text(text)
    return {"hosts": hv.parse_hosts_file(text), "raw": text}


@app.put("/api/inventories/{inv}/hosts/raw")
def put_hosts_raw(inv: str, payload: RawPayload):
    _inventory_dir(inv)
    text = payload.text
    try:
        hosts = hv.parse_hosts_file(text)
    except yaml.YAMLError as exc:
        raise HTTPException(400, f"Invalid YAML: {exc}")
    _hosts_file(inv).write_text(text if text.endswith("\n") else text + "\n")
    return {"hosts": hosts, "raw": _hosts_file(inv).read_text()}


def _run_git(args: list[str]) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=str(KUBESPRAY_ROOT),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise HTTPException(500, f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


class CheckoutPayload(BaseModel):
    version: str


def _has_tracked_changes() -> bool:
    # Untracked files (e.g. extra_playbooks/ additions) never get clobbered or
    # lost by `git checkout`, so only uncommitted changes to tracked files -
    # like group_vars edits made from the Files tab - should block a checkout.
    lines = _run_git(["status", "--porcelain"]).splitlines()
    return any(not line.startswith("??") for line in lines)


VERSION_BRANCH_PREFIX = "kubespray-version/"


def _current_ref() -> str:
    # Tag checkouts land on a local branch named "kubespray-version/<tag>"
    # (see checkout_kubespray_version) rather than the bare tag name, to avoid
    # rev-parse returning an ambiguous "heads/<tag>" when a branch and a tag
    # share the same short name. Strip the prefix back off for display.
    ref = _run_git(["rev-parse", "--abbrev-ref", "HEAD"]).strip()
    return ref.removeprefix(VERSION_BRANCH_PREFIX)


@app.get("/api/kubespray/versions")
def list_kubespray_versions():
    _run_git(["fetch", "--tags", "--depth=1", "origin"])
    out = _run_git([
        "for-each-ref",
        "--sort=-version:refname",
        "--format=%(refname:short)|%(creatordate:iso-strict)|%(objectname:short)",
        "refs/tags",
    ])
    versions = []
    for line in out.splitlines():
        name, date, sha = line.split("|")
        versions.append({"name": name, "date": date, "sha": sha})
        if len(versions) >= 10:
            break

    current = _current_ref()
    dirty = _has_tracked_changes()
    return {"current": current, "dirty": dirty, "versions": versions}


@app.post("/api/kubespray/checkout")
def checkout_kubespray_version(payload: CheckoutPayload):
    version = payload.version
    if not BRANCH_NAME_RE.match(version):
        raise HTTPException(400, "Invalid version name.")
    if _has_tracked_changes():
        raise HTTPException(409, "kubespray checkout has uncommitted changes. Commit or discard them before switching versions.")

    ref_check = subprocess.run(
        ["git", "show-ref", "--verify", "--quiet", f"refs/tags/{version}"],
        cwd=str(KUBESPRAY_ROOT),
    )
    if ref_check.returncode != 0:
        raise HTTPException(404, f"Version '{version}' not found on origin. Refresh the version list and try again.")

    _run_git(["checkout", "-B", VERSION_BRANCH_PREFIX + version, f"refs/tags/{version}"])
    current = _current_ref()
    sha = _run_git(["rev-parse", "--short", "HEAD"]).strip()
    return {"current": current, "sha": sha}


@app.get("/api/inventories/{inv}/offline/plan")
def offline_plan(inv: str):
    inv_dir = _inventory_dir(inv)
    config = off.detect_config(inv_dir)
    status = off.artifact_status(KUBESPRAY_ROOT)
    current = _current_ref()
    stages = off.build_plan(KUBESPRAY_ROOT, HOST_KUBESPRAY_ROOT, inv, inv_dir, current, config, status)
    offline_dir = str(KUBESPRAY_ROOT / "contrib" / "offline")
    host_offline_dir = str(HOST_KUBESPRAY_ROOT / "contrib" / "offline")
    # Run state lives server-side (OFFLINE_STAGE_LOCKS) precisely so a page refresh
    # doesn't lose track of an in-progress run - the frontend's own idea of "is this
    # running" is just in-memory JS state, gone on reload, even though the actual
    # subprocess keeps going regardless of any browser tab being open.
    running = {stage_id: lock.locked() for stage_id, lock in OFFLINE_STAGE_LOCKS.items()}
    return {
        "current_version": current, "config": config, "status": status, "stages": stages,
        "offline_dir": offline_dir, "host_offline_dir": host_offline_dir, "running": running,
        "logs": OFFLINE_STAGE_LOGS,
    }


class RegistryPayload(BaseModel):
    registry_mode: str  # "local" | "remote"
    registry_address: str | None = None


class OsPackagesPayload(BaseModel):
    ubuntu_release: str = "24.04"


# Two runs of the *same* offline stage racing each other has repeatedly caused real
# damage (download-files' rm -rf wiping a concurrent run's progress; os-packages'
# two `apt-get` processes fighting over the same lock file, one dying with a
# cryptic "held by process 0" - PID 0 because the holder is in a different
# container's PID namespace, unresolvable from this one). These aren't inventory-
# scoped (they all touch shared files under contrib/offline/), so one lock per
# stage id, independent of which inventory triggered it.
OFFLINE_STAGE_LOCKS: dict[str, asyncio.Lock] = {
    "generate-lists": asyncio.Lock(),
    "download-files": asyncio.Lock(),
    "container-images": asyncio.Lock(),
    "os-packages": asyncio.Lock(),
    "pip-packages": asyncio.Lock(),
}
# The live stream in _stream_shell only reaches whichever single browser tab's
# fetch() is actually reading it - if that tab reloads (or a different tab/session
# looks), the connection is gone but the server-side subprocess keeps running
# regardless (observed directly - killing the client doesn't kill the process).
# So also mirror each stage's output here, capped, and hand it back from
# /offline/plan - any page load can see "where things stand" even if it wasn't
# the one that started the run. Shared (via the `locks`/`logs` params below)
# with the Installation tab's Molecule runs - same mechanism, different keys.
OFFLINE_STAGE_LOGS: dict[str, str] = {stage_id: "" for stage_id in OFFLINE_STAGE_LOCKS}
LOG_CAP = 20000

MOLECULE_LOCKS: dict[str, asyncio.Lock] = {role: asyncio.Lock() for role in mol.MOLECULE_ROLES}
MOLECULE_LOGS: dict[str, str] = {role: "" for role in mol.MOLECULE_ROLES}


async def _stream_shell(cmd: str, cwd: Path, lock: asyncio.Lock, key: str, logs: dict[str, str]):
    await lock.acquire()
    logs[key] = ""
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        async for raw_line in proc.stdout:
            text = raw_line.decode(errors="replace")
            logs[key] = (logs[key] + text)[-LOG_CAP:]
            yield text
        await proc.wait()
        tail = f"\n[exit code {proc.returncode}]\n"
        logs[key] += tail
        yield tail
    finally:
        lock.release()


def _check_not_running(key: str, locks: dict[str, asyncio.Lock]) -> asyncio.Lock:
    lock = locks[key]
    if lock.locked():
        raise HTTPException(409, f"A '{key}' run is already in progress - wait for it to finish before starting another.")
    return lock


@app.post("/api/inventories/{inv}/offline/run/generate-lists")
def run_generate_lists(inv: str):
    inv_dir = _inventory_dir(inv)
    lock = _check_not_running("generate-lists", OFFLINE_STAGE_LOCKS)
    stages = off.build_plan(KUBESPRAY_ROOT, HOST_KUBESPRAY_ROOT, inv, inv_dir, _current_ref(), off.detect_config(inv_dir), off.artifact_status(KUBESPRAY_ROOT))
    cmd = next(s["command"] for s in stages if s["id"] == "generate-lists")
    return StreamingResponse(_stream_shell(cmd, KUBESPRAY_ROOT, lock, "generate-lists", OFFLINE_STAGE_LOGS), media_type="text/plain")


@app.post("/api/inventories/{inv}/offline/run/download-files")
def run_download_files(inv: str):
    _inventory_dir(inv)
    lock = _check_not_running("download-files", OFFLINE_STAGE_LOCKS)
    cmd = off.download_files_command(KUBESPRAY_ROOT)
    return StreamingResponse(
        _stream_shell(cmd, KUBESPRAY_ROOT / "contrib" / "offline", lock, "download-files", OFFLINE_STAGE_LOGS),
        media_type="text/plain",
    )


@app.post("/api/inventories/{inv}/offline/run/container-images")
def run_container_images(inv: str, payload: RegistryPayload):
    _inventory_dir(inv)
    if payload.registry_mode not in ("local", "remote"):
        raise HTTPException(400, "Invalid registry mode.")
    if payload.registry_mode == "remote":
        if not payload.registry_address or not REGISTRY_ADDR_RE.match(payload.registry_address):
            raise HTTPException(400, "Invalid registry address.")
    lock = _check_not_running("container-images", OFFLINE_STAGE_LOCKS)
    cmd = off.container_images_command(KUBESPRAY_ROOT, payload.registry_mode, payload.registry_address)
    return StreamingResponse(
        _stream_shell(cmd, KUBESPRAY_ROOT / "contrib" / "offline", lock, "container-images", OFFLINE_STAGE_LOGS),
        media_type="text/plain",
    )


@app.post("/api/inventories/{inv}/offline/run/os-packages")
def run_os_packages(inv: str, payload: OsPackagesPayload):
    inv_dir = _inventory_dir(inv)
    if not UBUNTU_RELEASE_RE.match(payload.ubuntu_release):
        raise HTTPException(400, "Invalid Ubuntu release, expected e.g. 24.04.")
    lock = _check_not_running("os-packages", OFFLINE_STAGE_LOCKS)
    cmd = off.os_packages_command(KUBESPRAY_ROOT, HOST_KUBESPRAY_ROOT, payload.ubuntu_release, off.detect_config(inv_dir))
    return StreamingResponse(
        _stream_shell(cmd, KUBESPRAY_ROOT / "contrib" / "offline", lock, "os-packages", OFFLINE_STAGE_LOGS),
        media_type="text/plain",
    )


@app.post("/api/inventories/{inv}/offline/run/pip-packages")
def run_pip_packages(inv: str):
    _inventory_dir(inv)
    lock = _check_not_running("pip-packages", OFFLINE_STAGE_LOCKS)
    cmd = off.pip_packages_command(KUBESPRAY_ROOT)
    return StreamingResponse(
        _stream_shell(cmd, KUBESPRAY_ROOT / "contrib" / "offline", lock, "pip-packages", OFFLINE_STAGE_LOGS),
        media_type="text/plain",
    )


class OfflineConfigurePayload(BaseModel):
    host_address: str


@app.post("/api/inventories/{inv}/offline/configure")
def configure_offline_yml(inv: str, payload: OfflineConfigurePayload):
    if not HOST_ADDR_RE.match(payload.host_address):
        raise HTTPException(400, "Invalid host address.")
    target = _resolve_file(inv, "all/offline.yml")
    if not target.is_file():
        raise HTTPException(404, "offline.yml does not exist in this inventory.")
    updates = off.offline_yml_updates(payload.host_address)
    new_parsed = gv.apply_updates(gv.parse(target.read_text()), updates)
    new_text = new_parsed.to_text()
    target.write_text(new_text)
    return {"path": "all/offline.yml", "raw": new_text}


# --- Ansible Molecule tab: real Molecule role tests (Docker driver,
# scenarios in ./molecule/, not inside the kubespray checkout - see
# molecule_runner.py). Not inventory-scoped: Molecule tests a role in
# isolation, independent of any specific cluster inventory. Separate from
# the Installation tab (real cluster install) - kept as its own nav item
# per the user's explicit split.

@app.get("/api/molecule/plan")
def molecule_plan():
    running = {role: lock.locked() for role, lock in MOLECULE_LOCKS.items()}
    roles = [{"id": role, **meta} for role, meta in mol.MOLECULE_ROLES.items()]
    return {"roles": roles, "running": running, "logs": MOLECULE_LOGS}


@app.post("/api/molecule/run/{role}")
def run_molecule(role: str):
    if role not in mol.MOLECULE_ROLES:
        raise HTTPException(404, f"Unknown role '{role}'.")
    lock = _check_not_running(role, MOLECULE_LOCKS)
    cmd = mol.molecule_command(KUBESPRAY_ROOT, MOLECULE_ROOT, role)
    return StreamingResponse(
        _stream_shell(cmd, MOLECULE_ROOT / role, lock, role, MOLECULE_LOGS),
        media_type="text/plain",
    )


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
