# kubespray-webui — project state

Custom FastAPI + vanilla JS admin UI over a kubespray checkout, so the user
manages clusters through a browser instead of hand-editing YAML/INI and
memorizing ansible-playbook flags.

- This app: `/home/soroush/infra/kubespray-webui` (this repo).
- Managed kubespray checkout: `/home/soroush/infra/kubespray` (upstream
  `kubernetes-sigs/kubespray`, currently on local branch
  `kubespray-version/v2.31.0` — see "Kubespray Version tab" below for what
  that branch name means).
- Pushed to `https://github.com/soroush67/kubesprary-ui.git`, branch `main`.
- Host OS: Ubuntu 24.04.

## Architecture — top nav has 4 tabs

1. **Files** — sidebar with "Hosts & Inventory" + per-inventory `group_vars`
   files, parsed/edited via `backend/parser.py` (comment-preserving line
   parser that rewrites only changed lines, keeps every comment/blank
   line/section heading intact). Scope: the ~22 "main" group_vars files
   kubespray ships in `inventory/sample/group_vars` — role-level
   `defaults/main.yml` internals are not exposed.
   - **Known deferred bug**: this tab reads/writes `inventory.yml` (YAML),
     but the real kubespray inventories on this box use INI
     (`inventory/local/hosts.ini`, `inventory/afshin/hosts.ini`,
     `inventory/sample/inventory.ini`) — so it currently shows empty. User
     explicitly deferred this fix and wants to stay on YAML long-term
     ("inventory.yml می‌مونه... هر وقت خواستی برگردیم سراغش بگو") — don't
     switch to INI without asking again.
2. **Cluster Operations** — command *builder* only, never executes anything.
   User's explicit model: "UI فقط دستور دقیق را می‌سازد، اجرا با خود کاربر
   در ترمینال" (the UI only builds the exact command; the user runs it
   themselves in the terminal). Sub-tabs in this exact order: Add node,
   Remove node, Reset, Scale, Backup etcd.
3. **Kubespray Version** — lists the 10 newest git *tags* (e.g. `v2.31.0`,
   sorted `--sort=-version:refname`, not branches), lets user checkout one
   via `backend/main.py` `/api/kubespray/versions` + `/api/kubespray/checkout`.
   Checkout is blocked if the kubespray checkout has uncommitted changes to
   *tracked* files (untracked additions like `extra_playbooks/` don't
   block it). Local branch for a checked-out tag is named
   `kubespray-version/<tag>` internally (avoids git ref-name ambiguity with
   the tag of the same name) but displayed to the user as the bare tag name.
4. **Offline Install** — command builder + read-only status dashboard for
   preparing an air-gapped install of the currently checked-out kubespray
   version. Same "build the command, never execute" model as Cluster
   Operations — deliberately, not just by preference: the `webui` container
   has no `ansible-playbook`/`docker`/`helm` and its `apt-get download` is
   broken, and `manage-offline-container-images.sh register` mutates
   `/etc/docker/daemon.json` on whatever host runs it, which is exactly the
   kind of system-level change the UI should never do itself. Backend:
   `backend/offline.py` (`detect_config`, `artifact_status`, `build_plan`,
   flat module like `parser.py`/`hosts_inventory.py`, no back-import of
   `main`), wired as `GET /api/inventories/{inv}/offline/plan` in
   `backend/main.py`. Six stages, each with a copy-paste shell command +
   relevance/status derived from the inventory's `container_manager` /
   `kube_network_plugin` / `helm_enabled` / `cilium_version`: generate
   files/images lists (`contrib/offline/generate_list.sh`), download static
   files + local nginx mirror (`manage-offline-files.sh`), container images
   create+register (`manage-offline-container-images.sh`), Python packages
   for the control node (`pip download -r requirements.txt`), OS packages
   (curated best-effort apt list — **not** derived from this kubespray
   version's actual Jinja-templated role defaults, flagged as such in the
   UI), and Helm charts (only relevant for Cilium/helm_enabled inventories;
   auto-fills the Cilium chart per kubespray's own offline docs, plus a
   small "add another chart" form for anything else). None of the current
   inventories (`local`/`sample`/`afshin`) use Cilium or `helm_enabled`, so
   that stage shows as not-needed for all three today.

## etcd backup feature

`extra_playbooks/etcd-backup-schedule.yml` (custom playbook, not upstream)
installs a systemd timer + script on etcd nodes for periodic
`etcdctl snapshot save` + retention pruning. Configured from the
"Backup etcd" sub-tab (schedule preset, retention count, backup dir).

## Docker / RustFS

`docker-compose.yml` runs 3 services:

- `webui` — this app. Needs `git` installed in the image (Kubespray Version
  tab). `KUBESPRAY_ROOT` env var overrides the default `../../kubespray`
  relative path so it works bare-metal and containerized.
- `rustfs` — S3-compatible object store (`rustfs/rustfs`), central
  destination for etcd backups. Needs
  `RUSTFS_UNSAFE_BYPASS_DISK_CHECK=true` — this host has a single physical
  disk and RustFS's 4-volume erasure-coding setup otherwise refuses to
  start.
- `backup-sync` — pulls etcd snapshots off etcd nodes via
  `ansible.posix.synchronize` (mode=pull), mirrors into RustFS bucket
  `etcd-backups` via `mc`. Needs SSH key dir mounted (`SSH_DIR` in `.env`,
  default `/home/soroush/.ssh` — currently empty, no real etcd cluster
  exists yet to test against).

`.env` (gitignored) holds RustFS creds + `BACKUP_INVENTORY_NAME` +
`SSH_DIR`; `.env.example` documents it.

## Git state

- Only commit so far: `3761878 Initial commit: Kubespray Variables Editor`,
  pushed to `origin/main`.
- **Uncommitted, not pushed**: the entire "Kubespray Version" tab (tag list
  + checkout endpoints + ambiguous-ref-name fix) — touches `Dockerfile`,
  `backend/main.py`, `static/app.js`, `static/index.html`,
  `static/styles.css` (~205 lines). Built and tested locally. User hadn't
  confirmed pushing yet as of the last session — ask before committing/pushing.
- **Also uncommitted, not pushed**: the "Offline Install" tab (new
  `backend/offline.py` module + `GET /api/inventories/{inv}/offline/plan` in
  `main.py` + the tab itself in `index.html`/`app.js`), built 2026-07-08.
  Backend verified against `local`/`sample`/`afshin` via a temporary
  bare-metal dev server on port 8421 (the docker-compose `webui` container
  bakes `backend`/`static` into the image at build time via `COPY`, so it
  does **not** pick up either uncommitted tab's changes until rebuilt — use
  bare-metal `./start.sh` to test current source, not `docker-compose up`).
  Frontend was reviewed by hand (brace/paren balance, API-shape match) but
  **not exercised in an actual browser** — no browser automation tool was
  available in this environment; ask the user to click through it once
  before treating it as done.

## Testing notes

No real etcd cluster/nodes exist in this environment — only kubespray's
`local` (single all-in-one node, `ansible_connection=local`), `afshin`
(unconfigured clone of `sample`, created via the "+ New" button, group_vars
still all default/commented-out) and `sample` (template, no real hosts)
inventories. Anything involving real remote nodes (backup-sync SSH pull,
actual add/remove/reset/scale execution) has only been smoke-tested against
the sandbox's own dummy `local` inventory, not a real cluster.

## Offline / air-gapped install — reference notes

The "Offline Install" tab (see architecture section above) wraps these
upstream kubespray pieces, in the managed checkout, not this webui repo:

- `docs/operations/offline-environment.md` — the overall recipe: static
  files (zips/binaries), OS packages (rpm/deb), container images, and
  optionally Python packages + Helm charts, each served from an internal
  mirror/registry that the inventory's `offline.yml` group_vars point at.
- `contrib/offline/generate_list.sh` (+ `generate_list.yml` playbook) —
  generates `temp/files.list` and `temp/images.list` for the *currently
  checked out* kubespray version (honors inventory/group_vars overrides
  via `-i`).
- `contrib/offline/manage-offline-files.sh` — downloads everything in
  `files.list`, serves it via a local nginx container.
- `contrib/offline/manage-offline-container-images.sh` — `create` pulls
  images (from a live env or `IMAGES_FROM_FILE`), `register` pushes them
  into a local/target registry (default port 5000, or `DESTINATION_REGISTRY`).
- `contrib/offline/upload2artifactory.py` — optional push of downloaded
  files to an Artifactory generic repo. Not wired into the webui tab
  (not asked for) — mention it if the user needs Artifactory specifically.
- `inventory/sample/group_vars/all/offline.yml` — the override variables
  (`registry_host`, `files_repo`, `yum_repo`/`debian_repo`/`ubuntu_repo`,
  per-component `*_download_url`, etc.) that redirect kubespray's
  downloads at the internal mirrors set up above. `inventory/afshin/.../offline.yml`
  and `inventory/local/.../offline.yml` are still the stock
  fully-commented-out template — nothing customized yet. The webui tab
  only *generates commands*; it doesn't yet help populate this file itself
  (a plausible next step if the user asks for it).
