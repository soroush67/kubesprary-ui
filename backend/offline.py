"""
Read-only helpers for the "Offline Install" tab: detects the relevant
container-runtime/CNI/helm settings for an inventory and builds the ordered
list of copy-paste shell commands needed to prepare an air-gapped install of
the currently checked-out kubespray version. Never executes anything itself -
see CLAUDE.md ("Offline / air-gapped install") for why.
"""
from __future__ import annotations

from pathlib import Path

import parser as gv

DEFAULT_CONFIG = {
    "container_manager": "containerd",
    "kube_network_plugin": "calico",
    "helm_enabled": False,
    "cilium_version": None,
}

BASE_OS_PACKAGES = [
    "conntrack", "ipset", "ipvsadm", "socat", "ebtables", "ethtool",
    "curl", "rsync", "tar", "unzip",
    "apt-transport-https", "ca-certificates", "software-properties-common",
]


def _active_value(inv_dir: Path, rel_path: str, key: str):
    target = inv_dir / "group_vars" / rel_path
    if not target.is_file():
        return None
    parsed = gv.parse(target.read_text())
    for e in parsed.entries:
        if e.key == key:
            return e.value.strip() if e.enabled else None
    return None


def detect_config(inv_dir: Path) -> dict:
    config = dict(DEFAULT_CONFIG)

    container_manager = _active_value(inv_dir, "k8s_cluster/k8s-cluster.yml", "container_manager")
    if container_manager:
        config["container_manager"] = container_manager

    kube_network_plugin = _active_value(inv_dir, "k8s_cluster/k8s-cluster.yml", "kube_network_plugin")
    if kube_network_plugin:
        config["kube_network_plugin"] = kube_network_plugin

    helm_enabled = _active_value(inv_dir, "k8s_cluster/addons.yml", "helm_enabled")
    if helm_enabled is not None:
        config["helm_enabled"] = helm_enabled.lower() == "true"

    cilium_version = _active_value(inv_dir, "k8s_cluster/k8s-net-cilium.yml", "cilium_version")
    if cilium_version:
        config["cilium_version"] = cilium_version.strip("\"'")

    return config


def _file_info(path: Path) -> dict:
    if not path.exists():
        return {"exists": False}
    stat = path.stat()
    info = {"exists": True, "mtime": stat.st_mtime}
    if path.is_dir():
        files = [f for f in path.rglob("*") if f.is_file()]
        info["file_count"] = len(files)
    else:
        info["size_bytes"] = stat.st_size
        if path.suffix == ".list":
            info["line_count"] = sum(1 for _ in path.read_text().splitlines() if _.strip())
    return info


def artifact_status(kubespray_root: Path) -> dict:
    offline_dir = kubespray_root / "contrib" / "offline"
    return {
        "files_list": _file_info(offline_dir / "temp" / "files.list"),
        "images_list": _file_info(offline_dir / "temp" / "images.list"),
        "offline_files_dir": _file_info(offline_dir / "offline-files"),
        "offline_files_archive": _file_info(offline_dir / "offline-files.tar.gz"),
        "container_images_archive": _file_info(offline_dir / "container-images.tar.gz"),
        "pip_packages_dir": _file_info(offline_dir / "offline-files" / "pip-packages"),
        "helm_charts_dir": _file_info(offline_dir / "offline-files" / "helm-charts"),
    }


def _inventory_file(inv_dir: Path) -> str:
    candidates = ["inventory.yml", "inventory.yaml", "hosts.yaml", "hosts.ini", "inventory.ini"]
    found = next((f for f in candidates if (inv_dir / f).is_file()), None)
    return found or candidates[-1]


def build_plan(kubespray_root: Path, inv: str, inv_dir: Path, current_version: str, config: dict, status: dict) -> list[dict]:
    offline_dir = kubespray_root / "contrib" / "offline"
    inventory_arg = f"inventory/{inv}/{_inventory_file(inv_dir)}"

    stages = []

    stages.append({
        "id": "generate-lists",
        "title": "Generate file & image lists",
        "relevant": True,
        "note": (
            "Renders files.list and images.list for the currently checked-out "
            f"kubespray version ({current_version}) and this inventory's settings. "
            "Must run wherever ansible-playbook for this checkout normally runs "
            "(this box's shell, not the webui container - it has no ansible-playbook)."
        ),
        "command": f"cd {kubespray_root} && ./contrib/offline/generate_list.sh -i {inventory_arg}",
    })

    stages.append({
        "id": "download-files",
        "title": "Download static files & serve local mirror",
        "relevant": True,
        "note": (
            "Downloads every URL in files.list and starts a local nginx container "
            "serving them on :8080. Needs wget and one of docker/podman/nerdctl "
            "plus sudo. Safe to re-run, but always re-downloads everything (no resume)."
        ),
        "command": f"cd {offline_dir} && ./manage-offline-files.sh",
    })

    stages.append({
        "id": "container-images",
        "title": "Pull & package container images",
        "relevant": True,
        "note": (
            "Step 1 (run where the images list is available, no live cluster needed "
            "thanks to IMAGES_FROM_FILE) saves every image in images.list to a tar. "
            "Step 2 (run in the air-gapped environment, on the box that will host "
            "the local registry) loads and pushes them - it OVERWRITES "
            "/etc/docker/daemon.json or /etc/containers/registries.conf on whatever "
            "host runs it, unconditionally, and needs sudo. Review before running."
        ),
        "command": (
            f"cd {offline_dir} && IMAGES_FROM_FILE={offline_dir}/temp/images.list "
            "./manage-offline-container-images.sh create\n\n"
            "# --- then, in the air-gapped environment ---\n"
            f"cd {offline_dir} && DESTINATION_REGISTRY=<registry-host>:5000 "
            "./manage-offline-container-images.sh register"
        ),
    })

    stages.append({
        "id": "pip-packages",
        "title": "Python packages (control node)",
        "relevant": True,
        "note": (
            "Only needed if the control node running ansible-playbook won't have "
            "internet access either. Downloads kubespray's own requirements.txt."
        ),
        "command": f"pip download -r {kubespray_root}/requirements.txt -d {offline_dir}/offline-files/pip-packages",
    })

    os_packages = list(BASE_OS_PACKAGES)
    if config["container_manager"] == "docker":
        os_packages += ["docker-ce", "docker-ce-cli", "containerd.io"]
    stages.append({
        "id": "os-packages",
        "title": "OS packages (Debian/Ubuntu, best-effort)",
        "relevant": True,
        "note": (
            "Best-effort baseline list, NOT derived from this kubespray version's "
            "actual role defaults (those are Jinja-templated per-version/per-OS in "
            "roles/container-engine/docker/vars/*.yml and would need a live ansible "
            "run to resolve exactly) - cross-check before relying on it for a real "
            "air-gapped install."
        ),
        "command": f"apt-get install --download-only -y {' '.join(os_packages)}",
    })

    helm_relevant = config["helm_enabled"] or config["kube_network_plugin"] == "cilium"
    cilium_version = config["cilium_version"] or "<cilium_version>"
    stages.append({
        "id": "helm-charts",
        "title": "Helm charts",
        "relevant": helm_relevant,
        "note": (
            "This inventory uses Cilium and/or has helm_enabled set, so its addons "
            "need Helm charts mirrored too. Only Cilium is auto-filled below (the "
            "one case kubespray's own offline docs call out) - use the form in the "
            "UI to append pull commands for any other chart-based addon."
            if helm_relevant else
            "Not needed for this inventory - container_manager/kube_network_plugin "
            "don't currently require any Helm chart."
        ),
        "command": (
            f"helm repo add cilium https://helm.cilium.io/ && helm repo update && "
            f"helm pull cilium/cilium --version {cilium_version} "
            f"--destination {offline_dir}/offline-files/helm-charts"
        ),
    })

    return stages
