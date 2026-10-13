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

import gzip
import json
import re
import shlex
import subprocess
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import parser as gv

DEFAULT_CONFIG = {
    "container_manager": "containerd",
    "kube_network_plugin": "calico",
    "helm_enabled": False,
    "cilium_version": None,
}

# Everything kubespray's roles/system_packages installs on Ubuntu nodes
# (vars/main.yml, Debian-family entries) plus a few tools the webui's own
# playbooks use. Most are already on Ubuntu Server, but "already installed"
# isn't guaranteed on every node image, and in an isolated site apt has no
# other source than this repo.
BASE_OS_PACKAGES = [
    "apparmor", "apt-transport-https", "bash-completion", "ca-certificates", "chrony",
    "conntrack", "curl", "e2fsprogs", "ebtables", "ethtool", "iproute2", "iptables",
    "iputils-ping", "ipset", "ipvsadm", "libseccomp2", "nftables", "openssl",
    "python3-apt", "rsync", "socat", "software-properties-common", "tar", "unzip",
    "xfsprogs",
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
        "cilium_charts": {"exists": bool(offline_cilium_charts(kubespray_root)),
                          "file_count": len(offline_cilium_charts(kubespray_root))},
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

    # images.list (generate-lists stage) already has every image prefixed with
    # whatever registry_host the inventory's offline.yml points at (e.g.
    # "172.22.120.105:5000/coreos/etcd:v3.6.10") - that's correct, it's what
    # real cluster nodes need. But create()'s own prefix-stripping only fires
    # when PRIVATE_REGISTRY exactly matches that prefix; left unset (as
    # before), container-images.txt keeps the full prefix in its "raw_image"
    # column, and register() then does `${DESTINATION_REGISTRY}/${raw_image}`
    # - doubling it into an invalid reference like
    # "localhost:5000/172.22.120.105:5000/coreos/etcd:v3.6.10" (hit for real:
    # aborted on the very first image, nothing got registered). Reading the
    # prefix directly off images.list's own first line - rather than trying
    # to separately recompute/pass in whatever host_address was configured -
    # guarantees an exact match by construction, no risk of the two drifting.
    private_registry = ""
    images_list = offline_dir / "temp" / "images.list"
    if images_list.is_file():
        first_line = next((line for line in images_list.read_text().splitlines() if line.strip()), "")
        if "/" in first_line:
            private_registry = first_line.split("/", 1)[0]
    private_registry_env = f"PRIVATE_REGISTRY={private_registry} " if private_registry else ""

    # create() PULLS every image in images.list. A list generated before the
    # upstream_source_vars() fix points at the local mirror itself
    # ("172.22.120.105:5000/coreos/etcd:...") - pulling from the registry we are
    # about to fill can only work if it already has the images. Upstream
    # registries never carry a :port, so a host:port prefix means "stale list".
    stale_list_guard = (
        f"if head -1 {offline_dir}/temp/images.list | cut -d/ -f1 | grep -q ':'; then "
        "echo 'images.list points at a private registry, not the original sources: "
        "run \"Generate file & image lists\" again first.'; exit 1; fi && "
    )

    base = (
        f"cd {offline_dir} && {stale_list_guard}{private_registry_env}IMAGES_FROM_FILE={offline_dir}/temp/images.list "
        f"./manage-offline-container-images.sh create && "
        f"DESTINATION_REGISTRY={dest} ./manage-offline-container-images.sh register"
    )
    if registry_mode == "remote":
        return base
    # Local registry: register() aborts the whole remaining batch on the first
    # image `docker push` can't handle (gotcha #7 - e.g. metrics-server:v0.8.1,
    # "was found but does not provide any platform"). So whatever is still
    # missing afterwards is copied straight from its original source with
    # skopeo (multi-arch, digests kept), and the stage only succeeds once
    # every image in images.list is really in the registry.
    fill = rf"""set -uo pipefail
REG=offline-registry:{LOCAL_REGISTRY_PORT}
ACCEPT='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
missing=0; filled=0
while read -r img; do
  [ -n "$img" ] || continue
  name=${{img%@*}}; last=${{name##*/}}
  if [ "${{last#*:}}" != "$last" ]; then repo=${{name%:*}}; tag=${{name##*:}}; else repo=$name; tag=latest; fi
  path=$(echo "$repo" | sed -E 's#^(registry\.k8s\.io|gcr\.io|ghcr\.io|docker\.io|quay\.io)/##')
  curl -fsI -H "Accept: $ACCEPT" "http://$REG/v2/$path/manifests/$tag" >/dev/null 2>&1 && continue
  if skopeo copy --all --preserve-digests --retry-times 3 --dest-tls-verify=false "docker://$repo:$tag" "docker://$REG/$path:$tag" >/dev/null; then
    echo "filled with skopeo: $img"; filled=$((filled+1))
  else
    echo "STILL MISSING: $img"; missing=$((missing+1))
  fi
done < {offline_dir}/temp/images.list
total=$(grep -c . {offline_dir}/temp/images.list)
echo "registry check: $((total - missing))/$total images present ($filled filled with skopeo)"
[ "$missing" = 0 ]
"""
    return (
        f"{{ {base} || echo '--- register stopped partway - filling the missing images with skopeo ---'; }} ; "
        f"bash -c {shlex.quote(fill)}"
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
    # The FULL dependency closure, not `apt-get install --download-only`: that
    # skips every dependency already installed in the throwaway ubuntu image
    # (libc6, libssl3, ...), and a node with an older version of one of those
    # then can't install anything offline. apt-cache depends --recurse lists
    # them all; virtual packages (no candidate) are skipped. Then every
    # requested package must really have a .deb, or the stage fails.
    script = (
        "set -e; apt-get update -q >/dev/null; "
        "deps=$(apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts "
        "--no-breaks --no-replaces --no-enhances $PKGS | grep '^[a-z0-9]' | sort -u); "
        "cd /out; n=0; for p in $deps; do "
        "if apt-get download -q \"$p\" >/dev/null 2>&1; then n=$((n+1)); else echo \"skipped $p (virtual, no candidate)\"; fi; "
        "done; echo \"downloaded $n packages (requested + all dependencies)\"; "
        "missing=0; for p in $PKGS; do ls ${p}_*.deb >/dev/null 2>&1 || { echo \"MISSING: $p\"; missing=1; }; done; "
        "exit $missing"
    )
    return (
        f"mkdir -p {outdir} && docker run --rm -e PKGS='{' '.join(packages)}' -v {host_outdir}:/out "
        f"ubuntu:{ubuntu_release} bash -c {shlex.quote(script)} && "
        f"cd {outdir} && dpkg-scanpackages . /dev/null 2>/dev/null | gzip -9c > Packages.gz && "
        f"echo \"Packages.gz: $(zcat Packages.gz | grep -c '^Package:') entries\""
    )


# Fallback versions for helm / the cilium CLI if download-files hasn't put
# kubespray's own copies (files.list has both) into offline-files yet.
CILIUM_HELM_FALLBACK = "3.18.4"
CILIUM_CLI_FALLBACK = "0.18.9"
HELM_TARBALL = "get.helm.sh/helm-v{v}-linux-amd64.tar.gz"
CILIUM_CLI_TARBALL = "github.com/cilium/cilium-cli/releases/download/v{v}/cilium-linux-amd64.tar.gz"
CILIUM_CHART = "helm.cilium.io/cilium-{v}.tgz"


def _newest_version(files_dir: Path, pattern: str, regex: str) -> str | None:
    found = []
    for f in files_dir.glob(pattern):
        m = re.search(regex, str(f.relative_to(files_dir)))
        if m:
            found.append(m.group(1))
    found.sort(key=lambda v: [int(x) if x.isdigit() else x for x in re.split(r"[.-]", v)])
    return found[-1] if found else None


def cilium_tool_versions(kubespray_root: Path) -> tuple[str, str]:
    """helm / cilium-cli versions for the offline Cilium path: the ones
    kubespray's files.list put into offline-files, else the fallbacks."""
    files_dir = kubespray_root / "contrib" / "offline" / "offline-files"
    helm = _newest_version(files_dir, "get.helm.sh/helm-v*-linux-amd64.tar.gz", r"helm-v([0-9][^/]*)-linux-amd64")
    cli = _newest_version(files_dir, "github.com/cilium/cilium-cli/releases/download/v*/cilium-linux-amd64.tar.gz",
                          r"download/v([0-9][^/]*)/cilium-linux")
    return helm or CILIUM_HELM_FALLBACK, cli or CILIUM_CLI_FALLBACK


def offline_cilium_charts(kubespray_root: Path) -> list[str]:
    """Cilium chart versions present in offline-files, newest first."""
    d = kubespray_root / "contrib" / "offline" / "offline-files" / "helm.cilium.io"
    versions = [m.group(1) for f in d.glob("cilium-*.tgz") if (m := re.match(r"cilium-(.+)\.tgz$", f.name))]
    versions.sort(key=lambda v: [int(x) if x.isdigit() else x for x in re.split(r"[.-]", v)], reverse=True)
    return versions


def cilium_assets_command(kubespray_root: Path, cilium_version: str) -> str:
    """Everything the Cilium tab needs with no internet, into the local mirrors:
    helm + cilium CLI + the chart -> offline-files (:8080, same `wget -x` layout
    as download-files), every image the chart (and `cilium connectivity test`)
    uses -> offline-registry (:5000).

    Images are copied with `skopeo copy --all --preserve-digests`: the chart
    references them as quay.io/cilium/cilium:v1.19.3@sha256:<manifest LIST
    digest>. A docker pull/push (what container-images does) re-pushes only
    the one platform manifest, so that digest would not exist in the local
    registry and every pull through the containerd mirror would fail.
    The registry is reached as offline-registry:5000 (compose service name):
    this runs inside the webui container, where localhost is not the registry.
    """
    helm_v, cli_v = cilium_tool_versions(kubespray_root)
    files_dir = kubespray_root / "contrib" / "offline" / "offline-files"
    script = rf"""set -euo pipefail
CILIUM_VERSION={shlex.quote(cilium_version)}
HELM_TGZ={HELM_TARBALL.format(v=helm_v)}
CLI_TGZ={CILIUM_CLI_TARBALL.format(v=cli_v)}
CHART=helm.cilium.io/cilium-$CILIUM_VERSION.tgz
REGISTRY=offline-registry:{LOCAL_REGISTRY_PORT}
cd {files_dir}
echo 'inet4only = on' > ~/.wgetrc
for f in "$HELM_TGZ" "$CLI_TGZ" "$CHART"; do wget -nv -c -x "https://$f"; done
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
tar -xzf "$HELM_TGZ" -C "$T"
tar -xzf "$CLI_TGZ" -C "$T"
# images of the chart with every optional component the Cilium tab can turn
# on (hubble relay/ui, certgen, clustermesh, nodeinit), plus the ones
# `cilium connectivity test` deploys
{{
  "$T/linux-amd64/helm" template cilium "$CHART" --namespace kube-system \
    --set hubble.relay.enabled=true --set hubble.ui.enabled=true \
    --set hubble.tls.auto.method=cronJob --set clustermesh.useAPIServer=true \
    --set nodeinit.enabled=true | sed -n 's/^ *image: *//p'
  "$T/cilium" connectivity test --help \
    | grep -oE '(quay\.io|docker\.io|registry\.k8s\.io|ghcr\.io|gcr\.io)/[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{{64}})?'
}} | tr -d "\"'" | sort -u > "helm.cilium.io/cilium-$CILIUM_VERSION.images"
echo "== $(wc -l < helm.cilium.io/cilium-$CILIUM_VERSION.images) images for Cilium $CILIUM_VERSION -> $REGISTRY"
copied=0; failed=0
while read -r img; do
  name=${{img%@*}}; digest=""; [ "$name" != "$img" ] && digest=${{img#*@}}
  last=${{name##*/}}
  if [ "${{last#*:}}" != "$last" ]; then repo=${{name%:*}}; tag=${{name##*:}}; else repo=$name; tag=latest; fi
  path=${{repo#*/}}
  if [ -n "$digest" ]; then src="docker://$repo@$digest"; else src="docker://$repo:$tag"; fi
  if skopeo copy --all --preserve-digests --retry-times 3 --dest-tls-verify=false "$src" "docker://$REGISTRY/$path:$tag" >/dev/null; then
    echo "ok      $img"; copied=$((copied+1))
  else
    echo "FAILED  $img"; failed=$((failed+1))
  fi
done < "helm.cilium.io/cilium-$CILIUM_VERSION.images"
echo "copied $copied, failed $failed"
[ "$failed" = 0 ]
"""
    return f"bash -c {shlex.quote(script)}"


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


# Upstream registries whose image references containerd should resolve from
# the local registry too: images that reach the nodes with their ORIGINAL
# name - Cilium's Helm chart (quay.io/cilium/...@sha256:..., installed by the
# Cilium tab, not by kubespray's image_repo rewrite) - still come from :5000.
UPSTREAM_REGISTRIES = ("docker.io", "quay.io", "registry.k8s.io", "ghcr.io", "gcr.io")


def containerd_mirrors_block(host_address: str) -> str:
    # Plain http:// mirror host and NO skip_verify: with skip_verify next to an
    # http:// host containerd tries HTTPS first (hit for real, see CLAUDE.md).
    registry = f"{host_address}:{LOCAL_REGISTRY_PORT}"
    lines = ["containerd_registries_mirrors:"]
    for prefix in (registry,) + UPSTREAM_REGISTRIES:
        lines += [
            f'  - prefix: "{prefix}"',
            "    mirrors:",
            f'      - host: "http://{registry}"',
            '        capabilities: ["pull", "resolve"]',
        ]
    return "\n".join(lines)


def offline_yml_updates(host_address: str, parsed=None) -> dict:
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
    updates = {
        "registry_host": {"enabled": True, "value": f'"{host_address}:{LOCAL_REGISTRY_PORT}"'},
        "files_repo": {"enabled": True, "value": f'"http://{host_address}:{LOCAL_NGINX_PORT}"'},
        "ubuntu_repo": {"enabled": True, "value": f'"http://{host_address}:{LOCAL_APT_PORT}"'},
        "debian_repo": {"enabled": True, "value": f'"http://{host_address}:{LOCAL_APT_PORT}"'},
        "kube_image_repo": {"enabled": True, "value": image_repo_template},
        "gcr_image_repo": {"enabled": True, "value": image_repo_template},
        "github_image_repo": {"enabled": True, "value": image_repo_template},
        "docker_image_repo": {"enabled": True, "value": image_repo_template},
        "quay_image_repo": {"enabled": True, "value": image_repo_template},
        "containerd_registries_mirrors": {"enabled": True, "value": containerd_mirrors_block(host_address)},
    }
    # Every *_download_url placeholder offline.yml ships (kubeadm, kubelet,
    # containerd, etcd, cni, crictl, ... - 20 in kubespray v2.31): enabled at
    # its own templated value "{{ files_repo }}/<original host>/<path>", which
    # is exactly where download-files' `wget -x` stored each file. Left
    # commented (as before), the nodes downloaded every binary from the
    # internet during cluster.yml - impossible in an isolated site.
    if parsed is not None:
        for e in parsed.entries:
            if e.key.endswith("_download_url") and "files_repo" in e.value:
                updates[e.key] = {"enabled": True}
    return updates


IMAGE_REPO_VARS = ("kube_image_repo", "gcr_image_repo", "github_image_repo", "docker_image_repo", "quay_image_repo")


def upstream_source_vars(kubespray_root: Path, inv_dir: Path) -> dict:
    """Upstream (internet) values for every variable offline.yml points at the
    local mirrors, read from this kubespray version's own role defaults.

    generate-lists must render images.list/files.list with the ORIGINAL
    sources: container-images then pulls from them and pushes into the local
    registry (manage-offline-container-images.sh strips registry.k8s.io/quay.io/
    ... itself), and download-files fetches from them. Rendered with the
    inventory's offline.yml instead, every entry pointed at the still-empty
    local registry ("172.22.120.105:5000/coreos/etcd:v3.6.10") - the pull
    failed on the very first image and the registry on :5000 stayed empty.
    The inventory is still used for everything else (versions, CNI, runtime).
    """
    defaults_dir = kubespray_root / "roles" / "kubespray_defaults" / "defaults" / "main"
    defaults: dict[str, str] = {}
    for f in sorted(defaults_dir.glob("*.yml")):
        for line in f.read_text().splitlines():
            m = re.match(r'^([a-z0-9_]+(?:_image_repo|_download_url)):\s*"?(.*?)"?\s*$', line)
            if m and m.group(1) not in defaults:
                defaults[m.group(1)] = m.group(2)

    overrides = {k: defaults[k] for k in IMAGE_REPO_VARS if k in defaults}
    # *_download_url lines offline.yml (or any group_vars file) has enabled
    for f in sorted((inv_dir / "group_vars").rglob("*.yml")):
        for e in gv.parse(f.read_text()).entries:
            if e.enabled and e.key.endswith("_download_url") and e.key in defaults:
                overrides[e.key] = defaults[e.key]
    return overrides


def _kubespray_default(kubespray_root: Path, key: str) -> str | None:
    defaults_dir = kubespray_root / "roles" / "kubespray_defaults" / "defaults" / "main"
    for f in sorted(defaults_dir.glob("*.yml")):
        for line in f.read_text().splitlines():
            m = re.match(rf'^{re.escape(key)}:\s*"?([^"{{]+?)"?\s*$', line)
            if m:
                return m.group(1)
    return None


def build_plan(kubespray_root: Path, host_kubespray_root: Path, inv: str, inv_dir: Path, current_version: str, config: dict, status: dict) -> list[dict]:
    offline_dir = kubespray_root / "contrib" / "offline"
    inventory_arg = f"inventory/{inv}/{inventory_file(inv_dir)}"
    # via a file: generate_list.sh hands its arguments to ansible-playbook
    # unquoted ($*), so inline JSON with spaces would be split into words
    upstream_file = offline_dir / "temp" / "upstream-sources.json"
    upstream_json = shlex.quote(json.dumps(upstream_source_vars(kubespray_root, inv_dir)))

    stages = []

    stages.append({
        "id": "generate-lists",
        "title": "Generate file & image lists",
        "relevant": True,
        "note": (
            "Renders files.list and images.list for the currently checked-out "
            f"kubespray version ({current_version}) and this inventory's settings, "
            "with the original internet sources (registry.k8s.io, quay.io, ...) "
            "instead of the local mirrors from offline.yml - that is where the "
            "next stages download from."
        ),
        "command": (
            f"mkdir -p {upstream_file.parent} && printf '%s\\n' {upstream_json} > {upstream_file} && "
            f"cd {kubespray_root} && ./contrib/offline/generate_list.sh -i {inventory_arg} -e @{upstream_file}"
        ),
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
            "Downloads real .deb files - the full dependency closure - for every "
            "package kubespray installs on Ubuntu nodes, inside a throwaway ubuntu:<release> container so they "
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

    default_cilium = config["cilium_version"] or _kubespray_default(kubespray_root, "cilium_version") or "1.19.3"
    stages.append({
        "id": "cilium-assets",
        "title": "Cilium for the Cilium tab (helm, cilium CLI, chart, images)",
        "relevant": True,
        "version": default_cilium,
        "note": (
            "Puts everything the Cilium tab needs into the local mirrors, so Cilium "
            "installs with no internet: helm and the cilium CLI (kubespray's own "
            "versions) and the Cilium Helm chart go to the files mirror (:8080), "
            "and every image the chart and `cilium connectivity test` use is copied "
            "into the registry (:5000) with its multi-arch digest intact. Run it "
            "once per Cilium version you want to be able to install."
        ),
        "command": cilium_assets_command(kubespray_root, default_cilium),
    })

    return stages


# --- "Ready for an isolated site?" -------------------------------------------
UPSTREAM_HOST_RE = re.compile(r"^(registry\.k8s\.io|gcr\.io|ghcr\.io|docker\.io|quay\.io)/")
MANIFEST_ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


def _registry_has(registry: str, image: str) -> bool:
    """image as written in images.list / *.images (upstream host, :tag and/or
    @digest) -> is that tag in the local registry, under the same path
    register()/skopeo pushed it to (upstream host stripped)?"""
    name = image.split("@", 1)[0]
    last = name.rsplit("/", 1)[-1]
    repo, tag = (name.rsplit(":", 1) if ":" in last else (name, "latest"))
    path = UPSTREAM_HOST_RE.sub("", repo)
    req = urllib.request.Request(f"http://{registry}/v2/{path}/manifests/{tag}", method="HEAD",
                                 headers={"Accept": MANIFEST_ACCEPT})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status == 200
    except (urllib.error.URLError, OSError):
        return False


def _check(name: str, ok: bool, detail: str) -> dict:
    return {"name": name, "ok": ok, "detail": detail}


def readiness(kubespray_root: Path, inv_dir: Path, registry: str = f"offline-registry:{LOCAL_REGISTRY_PORT}") -> list[dict]:
    """Everything an isolated site needs, checked against what is REALLY in the
    local mirrors (not just "a stage ran once"). Read-only."""
    offline_dir = kubespray_root / "contrib" / "offline"
    files_dir = offline_dir / "offline-files"
    checks = []

    # container images (kubespray) + Cilium images
    images_list = offline_dir / "temp" / "images.list"
    for label, lists in (("kubespray images in the registry", [images_list] if images_list.is_file() else []),
                         ("Cilium images in the registry", sorted((files_dir / "helm.cilium.io").glob("cilium-*.images")))):
        images = sorted({l.strip() for f in lists for l in f.read_text().splitlines() if l.strip()})
        if not images:
            checks.append(_check(label, False, "no image list yet - run the stage that creates it"))
            continue
        with ThreadPoolExecutor(max_workers=8) as pool:
            present = list(pool.map(lambda i: _registry_has(registry, i), images))
        missing = [i for i, p in zip(images, present) if not p]
        checks.append(_check(label, not missing,
                             f"{len(images) - len(missing)}/{len(images)} present"
                             + (f"; missing: {', '.join(missing[:6])}{' ...' if len(missing) > 6 else ''}" if missing else "")))

    # static files (files.list, wget -x layout) + Cilium tools/chart
    files_list = offline_dir / "temp" / "files.list"
    urls = [u.strip() for u in files_list.read_text().splitlines() if u.strip()] if files_list.is_file() else []
    missing = [u for u in urls if not (files_dir / re.sub(r"^https?://", "", u)).is_file()]
    checks.append(_check("kubespray files in the files mirror (:8080)", bool(urls) and not missing,
                         f"{len(urls) - len(missing)}/{len(urls)} present" + (f"; missing: {', '.join(missing[:4])}" if missing else "")
                         if urls else "no files.list yet - run Generate lists"))
    helm_v, cli_v = cilium_tool_versions(kubespray_root)
    charts = offline_cilium_charts(kubespray_root)
    tools = [HELM_TARBALL.format(v=helm_v), CILIUM_CLI_TARBALL.format(v=cli_v)]
    tools_missing = [t for t in tools if not (files_dir / t).is_file()]
    checks.append(_check("Cilium tab: helm, cilium CLI, chart (:8080)", not tools_missing and bool(charts),
                         f"chart versions: {', '.join(charts) or 'none'}"
                         + (f"; missing: {', '.join(tools_missing)}" if tools_missing else "")))

    # OS packages
    pkgs_gz = offline_dir / "os-packages" / "Packages.gz"
    if pkgs_gz.is_file():
        index = gzip.decompress(pkgs_gz.read_bytes()).decode(errors="replace")
        names = set(re.findall(r"^Package: (\S+)", index, re.M))
        missing = [p for p in BASE_OS_PACKAGES if p not in names]
        checks.append(_check("OS packages repo (:8081)", not missing,
                             f"{len(names)} packages in the index" + (f"; missing: {', '.join(missing)}" if missing else "")))
    else:
        checks.append(_check("OS packages repo (:8081)", False, "no Packages.gz - run the OS packages stage"))

    pip_dir = offline_dir / "pip-packages"
    pip_count = len(list(pip_dir.glob("*"))) if pip_dir.is_dir() else 0
    checks.append(_check("pip packages (:8082)", pip_count > 0, f"{pip_count} files"))

    # offline.yml
    offline_yml = inv_dir / "group_vars" / "all" / "offline.yml"
    if offline_yml.is_file():
        parsed = gv.parse(offline_yml.read_text())
        enabled = {e.key: e.value for e in parsed.entries if e.enabled}
        urls_on = sum(1 for k in enabled if k.endswith("_download_url"))
        urls_all = sum(1 for e in parsed.entries if e.key.endswith("_download_url"))
        # every address must be the SAME host: hand-editing only registry_host
        # after a move left the mirrors on the old address - nodes then had no
        # mirror for the new registry, fell back to https:// and failed with
        # "server gave HTTP response to HTTPS client" (hit for real).
        hosts = {}
        for key in ("registry_host", "files_repo", "ubuntu_repo", "debian_repo"):
            if key in enabled:
                hosts[key] = re.sub(r"^https?://", "", enabled[key].strip().strip("\"'")).split(":")[0]
        mirrors = []
        mirror_entry = next((e for e in parsed.entries if e.key == "containerd_registries_mirrors" and e.enabled), None)
        if mirror_entry:
            try:
                import yaml
                for m in (yaml.safe_load(mirror_entry.raw_block) or {}).get("containerd_registries_mirrors") or []:
                    mirrors.append(str(m.get("prefix", "")))
                    for h in m.get("mirrors") or []:
                        hosts[f"mirror for {m.get('prefix')}"] = re.sub(r"^https?://", "", str(h.get("host", ""))).split(":")[0]
            except Exception as exc:  # noqa: BLE001 - report, don't crash the check
                hosts["containerd_registries_mirrors"] = f"unparsable ({exc})"
        registry = enabled.get("registry_host", "").strip().strip("\"'")
        expected = hosts.get("registry_host")
        mismatched = {k: v for k, v in hosts.items() if v != expected}
        no_mirror = bool(registry) and registry not in mirrors
        ok = ("files_repo" in enabled and mirror_entry is not None and urls_on == urls_all
              and not mismatched and not no_mirror)
        detail = (f"registry_host {registry or '-'}, files_repo {enabled.get('files_repo', '-')}, "
                  f"download URLs {urls_on}/{urls_all}, containerd mirrors {len(mirrors)}")
        if mismatched:
            detail += f"; DIFFERENT ADDRESSES: {', '.join(f'{k}={v}' for k, v in mismatched.items())}"
        if no_mirror:
            detail += f"; no containerd mirror for {registry} (nodes would try https and fail)"
        if not ok:
            detail += " - write it again with \"Point kubespray at these repos\""
        checks.append(_check("offline.yml points at this host", ok, detail))
    else:
        checks.append(_check("offline.yml points at this host", False, "offline.yml missing in this inventory"))

    # compose images of this stack, so `docker-compose up` needs no pull/build
    try:
        me = subprocess.run(["docker", "inspect", "--format", '{{index .Config.Labels "com.docker.compose.project"}}',
                             subprocess.run(["hostname"], capture_output=True, text=True).stdout.strip()],
                            capture_output=True, text=True, timeout=10).stdout.strip()
        imgs = subprocess.run(["docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={me}",
                               "--format", "{{.Image}}"], capture_output=True, text=True, timeout=10).stdout.split()
        absent = [i for i in sorted(set(imgs))
                  if subprocess.run(["docker", "image", "inspect", i], capture_output=True).returncode != 0]
        checks.append(_check("docker-compose images on this machine", bool(imgs) and not absent,
                             f"{len(set(imgs))} images of project '{me}'" + (f"; missing: {', '.join(absent)}" if absent else "")))
    except (OSError, subprocess.SubprocessError) as e:
        checks.append(_check("docker-compose images on this machine", False, f"could not check: {e}"))
    return checks
