"""
Installs/upgrades Cilium via Helm and runs its connectivity test, directly
against the cluster's first kube_control_plane host over SSH.

Deliberately bypasses ansible-playbook for the two genuinely long-running
actions (helm upgrade --install, cilium connectivity test) - ansible's
command/shell modules buffer a task's entire output until the task
finishes, so running these through a playbook would make the UI appear to
hang with no output for however many minutes the command takes (unlike
cluster.yml, whose many small tasks each produce visible progress).
A raw SSH command's stdout streams naturally through the same
_stream_shell() every other real-execution tab already uses, so that's
what these two use instead. ansible-inventory itself (a quick, one-shot
call) is still what resolves which host/user/port to SSH into - it
handles both INI and YAML inventory formats correctly, unlike
hosts_inventory.py's parser (YAML-only, and only used by the Files tab).
"""
from __future__ import annotations

import json
import shlex
import subprocess
from pathlib import Path

HELM_VERSION_DEFAULT = "3.16.4"
CILIUM_CLI_VERSION_DEFAULT = "0.16.24"
KUBECONFIG_PATH = "/etc/kubernetes/admin.conf"


class CiliumError(Exception):
    pass


def resolve_control_plane_host(kubespray_root: Path, inv: str, inventory_file: str) -> dict:
    """Returns {ansible_host, ansible_user, ansible_port} for the first
    kube_control_plane host, via `ansible-inventory --list` - correct for
    both INI and YAML inventories, unlike a hand-rolled parser."""
    result = subprocess.run(
        ["ansible-inventory", "-i", f"inventory/{inv}/{inventory_file}", "--list"],
        cwd=str(kubespray_root), capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        raise CiliumError(f"ansible-inventory failed: {result.stderr.strip()}")
    data = json.loads(result.stdout)
    control_plane = data.get("kube_control_plane", {}).get("hosts", [])
    if not control_plane:
        raise CiliumError("This inventory has no kube_control_plane hosts.")
    first = control_plane[0]
    hostvars = data.get("_meta", {}).get("hostvars", {}).get(first, {})
    return {
        "name": first,
        "ansible_host": hostvars.get("ansible_host", first),
        "ansible_user": hostvars.get("ansible_user"),
        "ansible_port": hostvars.get("ansible_port", 22),
    }


def _ssh_prefix(host: dict, ssh_user: str | None, auth_method: str, ssh_password: str | None) -> str:
    user = ssh_user or host["ansible_user"] or "root"
    port = host["ansible_port"]
    addr = host["ansible_host"]
    base = f"ssh -o StrictHostKeyChecking=no -p {port} {shlex.quote(user)}@{shlex.quote(addr)}"
    if auth_method == "password":
        return f"sshpass -p {shlex.quote(ssh_password)} {base}"
    return base


# Bash preamble shared by every remote script: installs helm/the cilium CLI
# if missing (idempotent - skips the download entirely once present), then
# points KUBECONFIG at the admin kubeconfig cluster.yml already put there.
#
# {base} is "https://" online, or "<files_repo>/" offline: the files mirror
# keeps every download under its original host/path (`wget -x`), see
# offline.py's cilium_assets_command().
_REMOTE_PREAMBLE_TEMPLATE = f"""
export KUBECONFIG={KUBECONFIG_PATH}
if ! command -v helm >/dev/null 2>&1; then
  curl -fsSL {{base}}get.helm.sh/helm-v{{helm_version}}-linux-amd64.tar.gz | tar -xz -C /tmp
  install -m 0755 /tmp/linux-amd64/helm /usr/local/bin/helm
fi
if ! command -v cilium >/dev/null 2>&1; then
  curl -fsSL {{base}}github.com/cilium/cilium-cli/releases/download/v{{cilium_cli_version}}/cilium-linux-amd64.tar.gz -o /tmp/cilium-cli.tar.gz
  tar -xzf /tmp/cilium-cli.tar.gz -C /usr/local/bin
fi
""".strip()


def _preamble(offline: dict | None, helm_version: str = HELM_VERSION_DEFAULT,
              cilium_cli_version: str = CILIUM_CLI_VERSION_DEFAULT) -> str:
    """offline = {"files_repo", "helm_version", "cli_version"} when the
    inventory's offline.yml points at the local mirrors (isolated site)."""
    if offline:
        return _REMOTE_PREAMBLE_TEMPLATE.format(
            base=offline["files_repo"].rstrip("/") + "/",
            helm_version=offline["helm_version"], cilium_cli_version=offline["cli_version"])
    return _REMOTE_PREAMBLE_TEMPLATE.format(
        base="https://", helm_version=helm_version, cilium_cli_version=cilium_cli_version)


def _wrap_remote_script(ssh_prefix: str, script: str, sudo_password: str | None) -> str:
    # The remote command runs as root via `sudo bash -s`, reading its script
    # from stdin. `sudo -S` (needed only in password-auth mode, where we
    # can't assume NOPASSWD sudo) reads exactly one line from stdin for the
    # password *before* handing the rest of stdin to bash - so the password
    # goes on its own first line, the script follows, and both travel
    # together in the one heredoc this whole SSH command reads from
    # locally (bash's own `<<'EOF'` here, not a remote one - the quoted
    # delimiter keeps the LOCAL shell from touching anything inside, safe
    # even though install_command's script contains its OWN nested heredoc
    # for values.yaml).
    if sudo_password:
        stdin_content = f"{sudo_password}\n{script}"
        remote_cmd = "sudo -S bash -s"
    else:
        stdin_content = script
        remote_cmd = "sudo bash -s"
    return f"{ssh_prefix} {remote_cmd} <<'CILIUM_REMOTE_SCRIPT_EOF'\n{stdin_content}\nCILIUM_REMOTE_SCRIPT_EOF"


def _sudo_password_for(auth_method: str, ssh_password: str | None) -> str | None:
    # Password auth: the same password is used for both SSH login and sudo,
    # matching the ansible_ssh_pass == ansible_become_pass convention the
    # Installation tab already established. Publickey auth: assume NOPASSWD
    # sudo is configured (same assumption ansible's own `become` makes when
    # no become password is supplied).
    return ssh_password if auth_method == "password" else None


def versions_command(host: dict, ssh_user, auth_method, ssh_password) -> str:
    prefix = _ssh_prefix(host, ssh_user, auth_method, ssh_password)
    script = _preamble(None) + """
helm repo add cilium https://helm.cilium.io/ >/dev/null 2>&1 || true
helm repo update cilium >/dev/null 2>&1
helm search repo cilium/cilium --versions -o json
"""
    return _wrap_remote_script(prefix, script, _sudo_password_for(auth_method, ssh_password))


def node_status_command(host: dict, ssh_user, auth_method, ssh_password) -> str:
    prefix = _ssh_prefix(host, ssh_user, auth_method, ssh_password)
    script = f"export KUBECONFIG={KUBECONFIG_PATH}\nkubectl get pods -n kube-system -l k8s-app=cilium -o json"
    return _wrap_remote_script(prefix, script, _sudo_password_for(auth_method, ssh_password))


def install_command(
    host: dict, ssh_user, auth_method, ssh_password,
    cilium_version: str, values_yaml: str,
    helm_version: str = HELM_VERSION_DEFAULT, cilium_cli_version: str = CILIUM_CLI_VERSION_DEFAULT,
    offline: dict | None = None,
) -> str:
    prefix = _ssh_prefix(host, ssh_user, auth_method, ssh_password)
    if offline:
        # the chart straight from the files mirror; its images come from the
        # local registry through containerd's registry mirrors (offline.yml)
        chart_url = f"{offline['files_repo'].rstrip('/')}/helm.cilium.io/cilium-{cilium_version}.tgz"
        source = "true  # offline: chart from the local files mirror"
        chart = shlex.quote(chart_url)
        version_flag = ""
    else:
        source = "helm repo add cilium https://helm.cilium.io/ >/dev/null 2>&1 || true\nhelm repo update cilium"
        chart = "cilium/cilium"
        version_flag = f" --version {shlex.quote(cilium_version)}"
    script = _preamble(offline, helm_version, cilium_cli_version) + f"""
{source}
cat > /tmp/cilium-values.yaml <<'CILIUM_VALUES_YAML_EOF'
{values_yaml}
CILIUM_VALUES_YAML_EOF
helm upgrade --install cilium {chart}{version_flag} \\
  --namespace kube-system \\
  -f /tmp/cilium-values.yaml \\
  --wait --timeout 10m
"""
    return _wrap_remote_script(prefix, script, _sudo_password_for(auth_method, ssh_password))


def connectivity_test_command(host: dict, ssh_user, auth_method, ssh_password) -> str:
    prefix = _ssh_prefix(host, ssh_user, auth_method, ssh_password)
    script = f"export KUBECONFIG={KUBECONFIG_PATH}\ncilium connectivity test"
    return _wrap_remote_script(prefix, script, _sudo_password_for(auth_method, ssh_password))


def uninstall_command(host: dict, ssh_user, auth_method, ssh_password) -> str:
    # A plain `helm uninstall` alone often leaves Cilium's own CRD instances
    # (CiliumEndpoint, CiliumIdentity, etc.) stuck in Terminating forever:
    # they carry finalizers that only cilium-agent itself clears as part of
    # a graceful teardown, and by the time helm has removed the DaemonSet
    # there's no agent left running to do that. Discovers every Cilium CRD
    # actually registered in *this* cluster (rather than assuming a fixed
    # list of kinds, which would go stale as Cilium adds/renames CRDs across
    # versions), clears finalizers on every instance of each, deletes the
    # instances, then deletes the CRDs themselves - so nothing is left
    # behind, matching what "completely remove it" actually requires.
    script = f"""
export KUBECONFIG={KUBECONFIG_PATH}
helm uninstall cilium --namespace kube-system --wait --timeout 5m || true

CILIUM_CRDS=$(kubectl get crd -o name | grep -i '\\.cilium\\.io' | sed 's|customresourcedefinition.apiextensions.k8s.io/||')

for crd in $CILIUM_CRDS; do
  echo "Clearing finalizers and deleting instances of $crd ..."
  kubectl get "$crd" -A -o name 2>/dev/null | while read -r res; do
    kubectl patch "$res" --type=merge -p '{{"metadata":{{"finalizers":null}}}}' 2>/dev/null || true
  done
  kubectl delete "$crd" --all -A --timeout=30s 2>/dev/null || true
done

if [ -n "$CILIUM_CRDS" ]; then
  echo "Deleting Cilium CRDs ..."
  echo "$CILIUM_CRDS" | xargs -r kubectl delete crd --timeout=60s
fi

echo "Cleaning up any remaining Cilium cluster-scoped RBAC/config objects ..."
kubectl delete clusterrole,clusterrolebinding -l app.kubernetes.io/part-of=cilium --ignore-not-found
kubectl delete clusterrole,clusterrolebinding -l app.kubernetes.io/name=cilium --ignore-not-found
kubectl delete configmap cilium-config -n kube-system --ignore-not-found
kubectl delete secret cilium-ca hubble-server-certs hubble-relay-client-certs hubble-relay-server-certs -n kube-system --ignore-not-found

echo "Cilium uninstall complete."
"""
    return _wrap_remote_script(
        _ssh_prefix(host, ssh_user, auth_method, ssh_password), script,
        _sudo_password_for(auth_method, ssh_password),
    )
