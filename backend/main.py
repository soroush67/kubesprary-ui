from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

import yaml
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import hosts_inventory as hv
import parser as gv

BASE_DIR = Path(__file__).resolve().parent
KUBESPRAY_ROOT = Path(os.environ["KUBESPRAY_ROOT"]).resolve() if os.environ.get("KUBESPRAY_ROOT") else (BASE_DIR / ".." / ".." / "kubespray").resolve()
INVENTORY_ROOT = KUBESPRAY_ROOT / "inventory"
SAMPLE_DIR = INVENTORY_ROOT / "sample"
STATIC_DIR = (BASE_DIR / ".." / "static").resolve()

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

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


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
