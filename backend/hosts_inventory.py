"""
Reader/writer for the dynamic ansible inventory file (inventory.yml) that
lists actual hosts and their group membership, using Ansible's standard
nested YAML inventory schema (all.hosts / all.children.<group>.hosts).

kube_control_plane, kube_node and etcd are the three groups kubespray needs
explicitly; calico_rr and bastion are optional/special groups. k8s_cluster is
computed at playbook runtime by kubespray's own dynamic_groups role (a union
of kube_node + kube_control_plane + calico_rr), so it is intentionally never
written here - matching kubespray's own sample inventory.
"""
from __future__ import annotations

import re

import yaml

HOST_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")

GROUP_FIELD_TO_NAME = {
    "control_plane": "kube_control_plane",
    "etcd": "etcd",
    "node": "kube_node",
    "calico_rr": "calico_rr",
    "bastion": "bastion",
}
HOST_VAR_FIELDS = ["ansible_host", "ip", "access_ip", "ansible_port", "ansible_user"]


def parse_hosts_file(text: str) -> list[dict]:
    if not text.strip():
        return []
    data = yaml.safe_load(text) or {}
    all_block = data.get("all") or {}
    hosts_block = all_block.get("hosts") or {}
    children = all_block.get("children") or {}

    membership = {field: set((children.get(name) or {}).get("hosts") or {}) for field, name in GROUP_FIELD_TO_NAME.items()}

    hosts = []
    for name, hvars in hosts_block.items():
        hvars = hvars or {}
        host = {"name": name}
        for f in HOST_VAR_FIELDS:
            host[f] = "" if hvars.get(f) is None else str(hvars.get(f))
        for field in GROUP_FIELD_TO_NAME:
            host[field] = name in membership[field]
        hosts.append(host)
    return hosts


def _validate_hosts(hosts: list[dict]) -> None:
    seen = set()
    for h in hosts:
        name = (h.get("name") or "").strip()
        if not name:
            raise ValueError("Every host needs a name.")
        if not HOST_NAME_RE.match(name):
            raise ValueError(f"Invalid host name '{name}'. Use letters, numbers, '-', '_' or '.'.")
        if name in seen:
            raise ValueError(f"Duplicate host name '{name}'.")
        seen.add(name)


def render_hosts_file(hosts: list[dict]) -> str:
    _validate_hosts(hosts)

    all_hosts = {}
    group_members: dict[str, dict] = {name: {} for name in GROUP_FIELD_TO_NAME.values()}

    for h in hosts:
        name = h["name"].strip()
        hvars = {}
        for f in HOST_VAR_FIELDS:
            v = (h.get(f) or "").strip() if isinstance(h.get(f), str) else h.get(f)
            if v not in (None, ""):
                if f == "ansible_port" and str(v).isdigit():
                    v = int(v)
                hvars[f] = v
        all_hosts[name] = hvars or None

        for field, group_name in GROUP_FIELD_TO_NAME.items():
            if h.get(field):
                group_members[group_name][name] = None

    children = {
        group_name: {"hosts": members}
        for group_name, members in group_members.items()
        if members
    }
    # Always show the three core groups even if empty, so the file documents
    # the expected topology and is easy to hand-edit later.
    for group_name in ("kube_control_plane", "etcd", "kube_node"):
        children.setdefault(group_name, {"hosts": {}})

    doc = {"all": {"hosts": all_hosts, "children": children}}
    return yaml.safe_dump(doc, sort_keys=False, default_flow_style=False)
