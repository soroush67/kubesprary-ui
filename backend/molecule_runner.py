"""
Runs kubespray role tests via Ansible Molecule, using scenarios that live in
this repo's own molecule/ directory - not inside the managed kubespray
checkout. That checkout gets re-cloned/switched via the Kubespray Version
tab (and could be wiped/reset independently of this repo), so anything
added inside it wouldn't reliably survive; everything this feature needs
lives here instead. The actual role code under test is reached via
ANSIBLE_ROLES_PATH pointed at the checkout's roles/ directory at invocation
time (main.py), not baked into any scenario's molecule.yml.

Not kubespray's own roles/<role>/molecule/default/ scenarios: those
provision real VMs via KubeVirt + Equinix Metal cloud credentials, which
this environment doesn't have. molecule/<role>/ here re-uses each role's
converge.yml (copied, not referenced) against a plain Docker container.
"""
from __future__ import annotations

from pathlib import Path

MOLECULE_ROLES = {
    "adduser": {
        "title": "adduser",
        "description": "Creates the etcd/kube system users and groups kubespray needs on every node.",
    },
    "bastion-ssh-config": {
        "title": "bastion-ssh-config",
        "description": "Templates the local ~/.ssh ProxyJump config entry for reaching nodes through a bastion host.",
    },
}


def molecule_command(kubespray_root: Path, molecule_root: Path, role: str) -> str:
    scenario_dir = molecule_root / role
    roles_path = kubespray_root / "roles"
    return f"cd {scenario_dir} && ANSIBLE_ROLES_PATH={roles_path} molecule test"
