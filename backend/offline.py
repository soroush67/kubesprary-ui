"""
Helpers for the "Offline Install" tab: detects the relevant
container-runtime/CNI/helm settings for an inventory, builds the ordered list
of shell commands needed to prepare an air-gapped install of the currently
checked-out kubespray version, and (for generate-lists/download-files/
container-images/os-packages) those same commands are actually executed by
backend/main.py's streaming run endpoints via the docker-socket-mounted
webui container - see CLAUDE.md ("Offline / air-gapped install") for the
security trade-off that entails.
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
        # NOT nested under offline-files/ - manage-offline-files.sh unconditionally
        # `rm -rf`s that whole directory on every run, which would silently wipe
        # these out if they lived inside it.
        "pip_packages_dir": _file_info(offline_dir / "pip-packages"),
        "helm_charts_dir": _file_info(offline_dir / "helm-charts"),
        "os_packages_dir": _file_info(offline_dir / "os-packages"),
    }


def inventory_file(inv_dir: Path) -> str:
    candidates = ["inventory.yml", "inventory.yaml", "hosts.yaml", "hosts.ini", "inventory.ini"]
    found = next((f for f in candidates if (inv_dir / f).is_file()), None)
    return found or candidates[-1]


LOCAL_REGISTRY_PORT = 5000
LOCAL_NGINX_PORT = 8080
LOCAL_APT_PORT = 8081
LOCAL_PIP_PORT = 8082


def container_images_command(kubespray_root: Path, registry_mode: str, registry_address: str | None) -> str:
    # manage-offline-container-images.sh's own "DESTINATION_REGISTRY unset" auto-setup
    # path is unusable here: it resolves the address via `$(hostname)` (this
    # container's own random ID, not anything reachable). So we always pass
    # DESTINATION_REGISTRY explicitly - "local" means the permanent offline-registry
    # compose service (docker-compose.yml), always running, port 5000 published to
    # the host, so `localhost:5000` from the HOST daemon's perspective (this runs via
    # the mounted socket) reaches it correctly. Plain HTTP push to a loopback address
    # needs no daemon.json changes (Docker treats 127.0.0.0/8 as insecure by default).
    offline_dir = kubespray_root / "contrib" / "offline"
    dest = registry_address if (registry_mode == "remote" and registry_address) else f"localhost:{LOCAL_REGISTRY_PORT}"
    return (
        f"cd {offline_dir} && IMAGES_FROM_FILE={offline_dir}/temp/images.list "
        f"./manage-offline-container-images.sh create && "
        f"DESTINATION_REGISTRY={dest} ./manage-offline-container-images.sh register"
    )


def download_files_command(kubespray_root: Path) -> str:
    # manage-offline-files.sh unconditionally `rm -rf`s offline-files/ before every
    # run, which is actively dangerous now that this can be triggered from a browser
    # button: two clicks (or a click landing while a previous run is still going)
    # race each other, and the second one's rm -rf wipes out everything the first
    # one already downloaded (observed in practice - a run at 8/24 files got reset
    # to 0% by a second click). So we don't call that script at all; instead a plain
    # loop with `wget -c` (resume-if-partial, skip-if-already-complete - verified by
    # content-length, not a real checksum, which kubespray's own generated
    # files.list doesn't carry) so re-running - accidentally or deliberately - is
    # cheap and never destroys prior progress. Nothing needs to be started to serve
    # this - the permanent offline-files compose service already mounts this same
    # directory.
    #
    # `echo inet4only=on > ~/.wgetrc` forces wget onto IPv4: this host's IPv6 route
    # hangs (rather than failing fast) on several of the download hosts, so without
    # it every URL pays a long timeout before falling back to IPv4.
    offline_dir = kubespray_root / "contrib" / "offline"
    files_dir = offline_dir / "offline-files"
    return (
        f"echo 'inet4only = on' > ~/.wgetrc && "
        f"mkdir -p {files_dir} && "
        # -nv (no-verbose) instead of wget's default: default prints a
        # progress-dot block per ~50KB chunk (unreadable spam once streamed
        # to the browser - a single file can produce hundreds of lines);
        # -nv prints exactly one summary line per file instead (URL, size,
        # saved-as path), still showing real progress/errors per file.
        f"while read -r url; do [ -n \"$url\" ] && wget -nv -c -x -P {files_dir} \"$url\"; done "
        f"< {offline_dir}/temp/files.list && "
        f"tar -czf {offline_dir}/offline-files.tar.gz -C {offline_dir} offline-files"
    )


def os_packages_command(kubespray_root: Path, host_kubespray_root: Path, ubuntu_release: str, config: dict) -> str:
    # Downloading the .debs alone isn't enough - apt needs a real repository index
    # (Packages.gz) to point ubuntu_repo/debian_repo at, not a bare folder of files.
    # dpkg-scanpackages (installed in the Dockerfile) builds a flat-repo index
    # locally - no DooD issue, it's a plain read/write through our own bind-mounted
    # filesystem view, not a `docker run -v`. Only the apt-get step itself needs a
    # throwaway container (to genuinely match the target Ubuntu release, not this
    # webui's own Debian base) - that one still needs host_kubespray_root for its
    # `-v`, since it's a real ad-hoc `docker run` via the socket. Nothing needs to be
    # started to serve the result - the permanent offline-apt compose service
    # already mounts this same directory.
    offline_dir = kubespray_root / "contrib" / "offline"
    outdir = offline_dir / "os-packages"
    host_outdir = host_kubespray_root / "contrib" / "offline" / "os-packages"
    packages = list(BASE_OS_PACKAGES)
    if config["container_manager"] == "docker":
        packages += ["docker-ce", "docker-ce-cli", "containerd.io"]
    return (
        f"mkdir -p {outdir} && docker run --rm -v {host_outdir}:/var/cache/apt/archives "
        f'ubuntu:{ubuntu_release} bash -c "apt-get update -q && apt-get install --download-only -y {" ".join(packages)}" && '
        f"cd {outdir} && dpkg-scanpackages . /dev/null 2>/dev/null | gzip -9c > Packages.gz"
    )


def pip_packages_command(kubespray_root: Path) -> str:
    # Runs directly in the webui container - no throwaway-container wrapping needed
    # the way os-packages has, since these are control-node/ansible dependencies
    # (whatever machine runs ansible-playbook), not target-node binaries, so there's
    # no "must match target OS" concern. Nothing needs to be started to serve the
    # result - the permanent offline-pip compose service (with autoindex on, so
    # `pip install --find-links=...` can parse the directory listing) already
    # mounts this same directory.
    offline_dir = kubespray_root / "contrib" / "offline"
    outdir = offline_dir / "pip-packages"
    return f"mkdir -p {outdir} && pip download --no-cache-dir -r {kubespray_root}/requirements.txt -d {outdir}"


def offline_yml_updates(host_address: str) -> dict:
    # The 4 values kubespray's offline.yml needs to point the REAL target k8s nodes
    # (separate machines) at these repos. Deliberately NOT localhost - that's only
    # correct for the push step above, which runs locally via the Docker socket.
    #
    # registry_host alone does NOT redirect container image pulls - confirmed by
    # hitting this directly on a real cluster.yml run: with only registry_host set,
    # cluster.yml still pulled every image straight from quay.io/docker.io/etc.,
    # ignoring the local mirror entirely, and failed once one of those direct pulls
    # got rate-limited. kubespray's own docs (docs/operations/offline-environment.md)
    # spell out why: `kube_image_repo`/`gcr_image_repo`/`docker_image_repo`/
    # `quay_image_repo`/`github_image_repo` are separate variables that actually
    # rewrite each image reference's registry prefix - registry_host is just what
    # they commonly template against, not a substitute for setting them. All 5 are
    # already present as commented-out placeholders in kubespray's own
    # inventory/sample/group_vars/all/offline.yml (`# kube_image_repo: "{{
    # registry_host }}"` etc.) - this just enables them at their existing templated
    # value, so they always follow whatever registry_host is set to.
    image_repo_template = '"{{ registry_host }}"'
    return {
        "registry_host": {"enabled": True, "value": f'"{host_address}:{LOCAL_REGISTRY_PORT}"'},
        "files_repo": {"enabled": True, "value": f'"http://{host_address}:{LOCAL_NGINX_PORT}"'},
        "ubuntu_repo": {"enabled": True, "value": f'"http://{host_address}:{LOCAL_APT_PORT}"'},
        "debian_repo": {"enabled": True, "value": f'"http://{host_address}:{LOCAL_APT_PORT}"'},
        "kube_image_repo": {"enabled": True, "value": image_repo_template},
        "gcr_image_repo": {"enabled": True, "value": image_repo_template},
        "github_image_repo": {"enabled": True, "value": image_repo_template},
        "docker_image_repo": {"enabled": True, "value": image_repo_template},
        "quay_image_repo": {"enabled": True, "value": image_repo_template},
    }


def build_plan(kubespray_root: Path, host_kubespray_root: Path, inv: str, inv_dir: Path, current_version: str, config: dict, status: dict) -> list[dict]:
    offline_dir = kubespray_root / "contrib" / "offline"
    inventory_arg = f"inventory/{inv}/{inventory_file(inv_dir)}"

    stages = []

    stages.append({
        "id": "generate-lists",
        "title": "Generate file & image lists",
        "relevant": True,
        "note": (
            "Renders files.list and images.list for the currently checked-out "
            f"kubespray version ({current_version}) and this inventory's settings."
        ),
        "command": f"cd {kubespray_root} && ./contrib/offline/generate_list.sh -i {inventory_arg}",
    })

    stages.append({
        "id": "download-files",
        "title": "Download static files & serve local mirror",
        "relevant": True,
        "note": (
            "Downloads every URL in files.list. Served on :8080 by the always-on "
            "offline-files service (docker-compose.yml) - nothing to start. Safe "
            "to re-run - already-complete files are skipped and partial ones "
            "resumed (by size, not a real checksum: kubespray's own files.list "
            "doesn't carry expected hashes)."
        ),
        "command": download_files_command(kubespray_root),
    })

    stages.append({
        "id": "container-images",
        "title": "Pull & push container images to a registry",
        "relevant": True,
        "note": (
            "Pulls every image in images.list and pushes it to a registry - by "
            f"default the always-on offline-registry service (port {LOCAL_REGISTRY_PORT}, "
            "docker-compose.yml), or an existing registry you specify. A "
            "non-loopback remote registry serving plain HTTP would need "
            "insecure-registries configured on the HOST's own Docker daemon "
            "separately - this tool won't do that for you. Once it's done, use "
            "the \"Point kubespray at these repos\" card below to write the "
            "address into offline.yml."
        ),
        "command": container_images_command(kubespray_root, "local", None),
    })

    stages.append({
        "id": "pip-packages",
        "title": "Python packages (control node)",
        "relevant": True,
        "note": (
            "Only needed if the control node running ansible-playbook won't have "
            "internet access either. Downloads kubespray's own requirements.txt, "
            f"served on :{LOCAL_PIP_PORT} by the always-on offline-pip service - "
            f"use `pip install --find-links=http://<this-host>:{LOCAL_PIP_PORT}/ "
            "<package>` on the control node. Not written into offline.yml - "
            "kubespray has no group_var for the control node's own pip index, "
            "this is a separate concern from the target-node repos above."
        ),
        "command": pip_packages_command(kubespray_root),
    })

    os_packages = list(BASE_OS_PACKAGES)
    if config["container_manager"] == "docker":
        os_packages += ["docker-ce", "docker-ce-cli", "containerd.io"]
    stages.append({
        "id": "os-packages",
        "title": "OS packages (Ubuntu)",
        "relevant": True,
        "note": (
            "Downloads real .deb files (with dependencies) for a curated baseline "
            "package list, inside a throwaway ubuntu:<release> container so they "
            "genuinely match your target nodes' Ubuntu release - NOT the webui "
            "container's own Debian base. Then builds a real flat apt repository "
            "index (Packages.gz via dpkg-scanpackages) and serves it on "
            f":{LOCAL_APT_PORT} - point ubuntu_repo at this host and use "
            f"'deb [trusted=yes] http://<this-host>:{LOCAL_APT_PORT}/ ./' as the "
            "apt source line on target nodes (unsigned - fine for an internal "
            "mirror, not for public exposure). The package list itself is still a "
            "best-effort baseline, not derived from this kubespray version's "
            "actual Jinja-templated role defaults - cross-check before relying on "
            "it for a real air-gapped install."
        ),
        "command": os_packages_command(kubespray_root, host_kubespray_root, "24.04", config),
        "packages": os_packages,
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
            f"--destination {offline_dir}/helm-charts"
        ),
    })

    return stages
