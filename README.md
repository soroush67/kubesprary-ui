# Kubespray Variables Editor

A small web UI for editing kubespray's inventory `group_vars` files
(`inventory/<cluster>/group_vars/all/*.yml` and `.../k8s_cluster/*.yml`)
without hand-editing YAML.

It talks directly to the kubespray checkout at `../kubespray` (i.e.
`/home/soroush/infra/kubespray`), so anything you save here is exactly what
`ansible-playbook -i inventory/<cluster>/hosts.yaml cluster.yml` will read.

## How it works

kubespray's sample files ship almost every optional variable already present
but commented out, with the description living in the comment lines above it.
The editor parses each file line-by-line, turns every top-level variable
(active or commented-out) into a form row with a checkbox (enabled/disabled)
and a value field, and on save only rewrites the exact lines that changed —
every comment, blank line and section heading in the file is left untouched.

There's also a "Raw YAML" toggle per file for direct text editing, and search
across every variable in the current inventory.

Scope: only the ~22 "main" group_vars files that kubespray ships in
`inventory/sample/group_vars` (all.yml, etcd.yml, containerd/docker/cri-o,
cloud-provider files, k8s-cluster.yml, addons.yml, CNI plugin files, ...).
Role-level `defaults/main.yml` internals are not exposed — those are meant to
stay at their defaults for the vast majority of clusters.

## Running

### Docker (recommended)

```bash
cp .env.example .env   # adjust RustFS credentials, backup inventory name, SSH_DIR, ...
docker-compose up -d
```

This starts three services:

- `webui` — this app, on http://localhost:8420. Mounts `../kubespray` read-write
  (it needs to write group_vars/hosts files).
- `rustfs` — an [S3-compatible object store](https://github.com/rustfs/rustfs)
  (console on http://localhost:9001, API on :9000) used as the destination for
  synced etcd backups.
- `backup-sync` — pulls whatever etcd snapshot files exist under
  `etcd_backup_prefix` on the etcd nodes of `BACKUP_INVENTORY_NAME` (see
  `.env.example`) via `ansible.posix.synchronize`, then mirrors them into the
  RustFS bucket `etcd-backups`. It needs the SSH key(s) to reach those nodes
  mounted from `SSH_DIR`. This is independent from — and downstream of — the
  systemd timer that the "Backup etcd" tab installs on the etcd nodes
  themselves (`extra_playbooks/etcd-backup-schedule.yml`); that timer produces
  the local snapshot files, `backup-sync` just centralizes them.

### Bare metal

Dependencies (fastapi, uvicorn, pyyaml, pydantic) are already installed to
your user site-packages. To start the server:

```bash
./start.sh
# or: PORT=9000 ./start.sh
```

Then open http://localhost:8420 in a browser. (This mode only runs the web UI
itself — no RustFS, no backup-sync.)

## Managing clusters

Use the "+ New" button in the top bar to create a new inventory (it copies
`inventory/sample`, or the currently-selected inventory, into a new
`inventory/<name>` directory). You still need to edit that inventory's
`hosts.yaml`/`inventory.ini` yourself to list your actual nodes — this tool
only manages `group_vars`.

## Files

- `backend/parser.py` — the comment-preserving line parser/serializer.
- `backend/main.py` — FastAPI app exposing `/api/inventories/...` endpoints.
- `static/` — vanilla HTML/CSS/JS front end (no build step).
- `Dockerfile`, `docker-compose.yml` — containerized webui + RustFS + backup-sync.
- `backup-sync/` — the etcd-backup-to-RustFS sync container.
