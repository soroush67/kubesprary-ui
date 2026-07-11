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

## Architecture — vertical left-hand nav, 6 destinations

The left side of the page is a two-level layout: `#primaryNav` (5 nav
buttons, `static/index.html`/`styles.css`'s `.primary-nav`/`.nav-btn`) is
the outermost column, with the Files-only `#sidebar` (hosts/inventory list)
as a second column that only shows when the Files tab is active — this
replaced an earlier horizontal top-tab bar (`.view-tabs`/`.tab-btn`), moved
to vertical per the user's request. `app.js`'s `TOP_TABS` maps each nav
button id to its tab key; `switchTab()` still drives which tab is active,
unchanged in shape from the old horizontal version.

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
4. **Offline Install** — prepares an air-gapped install of the currently
   checked-out kubespray version, and closes the loop by writing the
   resulting repo addresses into the inventory's `offline.yml`. Started as a
   pure command-builder (like Cluster Operations), then became real
   execution (click a button, it actually downloads/pushes), then the user
   asked for the repos themselves to be **permanent services in
   `docker-compose.yml`** (start empty, get filled in by the Run buttons)
   instead of ad-hoc `docker run` containers, plus the same real treatment
   for Python packages, plus writing `registry_host`/`files_repo`/
   `ubuntu_repo`/`debian_repo` straight into `offline.yml`. Getting the real
   execution working at all required giving the `webui` container
   `ansible-core`, `docker-cli` + `sudo`, and — the one architecturally
   significant change here — **mounting the host's `/var/run/docker.sock`
   into the container**, so its `docker` CLI drives the real host daemon.
   This gives the webui root-equivalent control of the Docker host, and
   **the webui itself has no login** — flagged with a standing danger
   banner on the tab itself, not just here. See the "Offline / air-gapped
   install" section below for the full design, every gotcha found (there
   were several, each fixed by actually running the thing, not by
   inspection), and current verification state — all 5 stages are now
   verified working end-to-end.
5. **Ansible Molecule** — real Molecule role tests, not a command builder.
   Currently one card: **run Molecule against a kubespray role**
   (`adduser`, `bastion-ssh-config`). See "Ansible Molecule tab — Molecule
   role tests" below for full design/gotchas.
6. **Installation** — placeholder, not built yet. Originally this feature
   was requested as part of the "Installation" tab (with Molecule as its
   first sub-option), but the user later explicitly split them into two
   separate nav items — Ansible Molecule and Installation — with
   Installation kept as the **last** nav item and its own distinct, not-yet-
   specified purpose (presumably the real cluster install, i.e. running
   kubespray's own `cluster.yml`, as distinct from role-level testing) —
   don't invent what goes here, ask when it comes up.

## etcd backup feature

`extra_playbooks/etcd-backup-schedule.yml` (custom playbook, not upstream)
installs a systemd timer + script on etcd nodes for periodic
`etcdctl snapshot save` + retention pruning. Configured from the
"Backup etcd" sub-tab (schedule preset, retention count, backup dir).

## Docker / RustFS / offline repos

`docker-compose.yml` runs:

- `webui` — this app. Image has `git`, `docker-cli`, `sudo`, `curl`, `wget`,
  `dpkg-dev` (for `dpkg-scanpackages`), `ansible-core` + `molecule` +
  `molecule-plugins[docker]` (pip) + the `community.docker`/`ansible.posix`
  Galaxy collections (see "Ansible Molecule tab" below for why those two exist),
  and `ENV USER=root` (see offline gotcha #5 below — a real bug, not
  boilerplate). Bind-mounts `/var/run/docker.sock` (see "Offline Install"
  above/below for why and the risk). `KUBESPRAY_ROOT` env var overrides the
  default `../../kubespray` relative path so it works bare-metal and
  containerized; `HOST_KUBESPRAY_ROOT` (hardcoded to
  `/home/soroush/infra/kubespray`) holds the *real host-side* path to that
  same checkout, needed because `docker run -v` commands issued from inside
  this container are resolved by the **host's** daemon against **host**
  paths, not this container's — see offline.py. This only matters for
  genuinely ad-hoc containers (currently just `os-packages`' throwaway
  `ubuntu:<release>`) — the 4 services below resolve their own volumes
  themselves, no DooD translation needed there.
- `offline-files` / `offline-apt` / `offline-pip` (nginx:alpine) /
  `offline-registry` (registry:2) — the Offline Install tab's permanent
  repos, always running, empty until the tab's Run buttons fill them in.
  Ports 8080/8081/8082/5000. All three nginx services mount their data
  straight onto `/usr/share/nginx/html` and override
  `/etc/nginx/conf.d/default.conf` with `nginx-autoindex.conf` (repo root) —
  **do not** mount a full custom `/etc/nginx/nginx.conf` instead, that's
  what caused gotcha #4 below.
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

- `3761878` Initial commit, `6a22128` "Add Kubespray Version and Offline
  Install tabs" (command-builder-only version), `5ee8ea6` "Offline Install:
  real execution, permanent repos, offline.yml write" — all three pushed to
  `origin/main`.
- **Uncommitted, not pushed**: the vertical sidebar nav + new Ansible
  Molecule tab (real Molecule role tests) + an empty placeholder
  Installation tab (split out from Molecule per the user's request, kept
  last, content TBD) — touches `Dockerfile`, `backend/main.py`, new
  `backend/molecule_runner.py`, `static/index.html`, `static/app.js`,
  `static/styles.css`, new `molecule/` directory, `CLAUDE.md`. Both roles
  (`adduser`, `bastion-ssh-config`) verified working end-to-end — see
  "Ansible Molecule tab — Molecule role tests" below — ask before
  committing/pushing.
- Reminder for next session: the `webui` container bakes `backend`/`static`
  into the image via `COPY` at build time — it does **not** live-reload.
  After any backend/static edit, `docker-compose build webui &&
  docker-compose up -d webui` before testing through the browser or curl
  against :8420, or changes will silently appear stale. (The 4 offline-repo
  services pick up changes the same way — `docker-compose up -d
  offline-files offline-apt offline-pip` etc. — but only needed if you edit
  `nginx-autoindex.conf` or the compose file itself, not for anything in
  `backend/`/`static/`.)
- **Real-execution safety pattern, learned the hard way**: any endpoint that
  shells out to a script with `rm -rf`/similar destructive setup (or
  competes for an OS-level lock like apt's) is genuinely unsafe to let two
  browser clicks (or a click racing a background test) hit concurrently -
  this bit us three times this session before `OFFLINE_STAGE_LOCKS` went in.
  If a new run-style endpoint gets added here later, give it a lock from the
  start, don't wait to get bitten.

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
  `files.list`. We only use its download loop (see gotcha #1 below), not
  its own serving step.
- `contrib/offline/manage-offline-container-images.sh` — `create` pulls
  images (from a live env or `IMAGES_FROM_FILE`), `register` pushes them
  into a local/target registry (default port 5000, or `DESTINATION_REGISTRY`).
- `contrib/offline/upload2artifactory.py` — optional push of downloaded
  files to an Artifactory generic repo. Not wired into the webui tab
  (not asked for) — mention it if the user needs Artifactory specifically.
- `inventory/<name>/group_vars/all/offline.yml` — the override variables
  (`registry_host`, `files_repo`, `ubuntu_repo`/`debian_repo`,
  per-component `*_download_url`, etc.) that redirect kubespray's
  downloads at the repos below. The Offline Install tab's "Point kubespray
  at these repos" card writes the first four directly (see below) — reuses
  the exact same `parser.py` (`gv.parse`/`gv.apply_updates`) mechanism the
  Files tab uses, via a new `POST /api/inventories/{inv}/offline/configure`.

### Architecture: permanent repos + real execution

Five stages, all in `backend/offline.py`/`backend/main.py`/`static/app.js`:
**generate-lists**, **download-files**, **container-images**, **os-packages**,
**pip-packages** (helm-charts stays copy-paste-only, not asked for — only
relevant for Cilium/`helm_enabled` inventories anyway, none of which exist
here yet). Each has a real "▶ Run" button (`runOfflineStage` in
`static/app.js`) backed by `POST /api/inventories/{inv}/offline/run/<stage>`,
which streams the subprocess live via `_stream_shell()`
(`asyncio.create_subprocess_shell` + `StreamingResponse` — the first
streaming/long-running-job infra in this codebase). The read-only textarea
above each Run button shows the *literal* command that will execute
(`build_plan()` calls the same `offline.py` builder functions the run
endpoints call) so display and execution can't drift apart; the frontend
mirrors the same builder logic in JS
(`buildContainerImagesCommand`/`buildOsPackagesCommand`) so the textarea
updates live as the user edits fields before running.

The four repos these stages fill (files mirror :8080, apt repo :8081, pip
index :8082, image registry :5000) are **permanent services in
`docker-compose.yml`**, not started ad-hoc — they're already running
(empty) the moment `docker-compose up` runs; the Run buttons just fill
them in. This was a deliberate pivot mid-session (the user wanted an
always-there internal repo, not something spun up per-click) and it
incidentally *simplified* `offline.py` a lot: `download_files_command()`
and `container_images_command()` no longer need their own
`docker inspect ... || docker run ...` idempotency guards to start
anything - only `os_packages_command()` still spins up a genuinely ad-hoc
throwaway `ubuntu:<release>` container (to make the downloaded `.deb`s
match a real Ubuntu release, not the webui's own Debian base).

**Server-side run state, not just browser state**: `OFFLINE_STAGE_LOCKS`
(per-stage `asyncio.Lock`) and `OFFLINE_STAGE_LOGS` (per-stage capped
output buffer) live in `backend/main.py`, not in the frontend. Reasons,
both found by hitting them in practice:
- A run's subprocess **keeps going server-side even if the initiating
  browser tab/request disconnects** (confirmed directly) - so a page
  refresh mid-run must not lose track of it. `GET /offline/plan` now
  returns `running: {stage: bool}` and `logs: {stage: str}`; the frontend
  shows "Running… (started elsewhere)" instead of a misleading fresh "▶
  Run" button, and `pollOfflineRunning()` quietly re-checks every 4s -
  redrawing the tab **only when something actually changed** (a stage
  started/finished, or its log grew), not on a fixed timer, so it doesn't
  keep blowing away whatever the user is doing on the tab (a real bug hit
  and fixed this session).
- Two runs of the **same** stage racing each other caused real damage
  twice before locks went in: `download-files`' old `rm -rf` wiped a
  concurrent run's progress (see gotcha #1), and two `os-packages`
  `apt-get` processes fought over the same lock file (`held by process 0` -
  PID 0 because the lock holder is in a different container's PID
  namespace, unresolvable from this one). `_check_not_running(stage_id)`
  now returns a clean `409` ("already in progress") instead.

### Gotchas found (all fixed) — found by actually running each stage, not by inspection

1. **`manage-offline-files.sh`'s own `rm -rf` + nginx start are both
   unusable here.** It unconditionally `rm -rf`s `offline-files/` before
   every run - actively dangerous once triggered from a browser button (two
   clicks race, second one's `rm -rf` erases the first's progress - observed
   directly, a run at 8/24 files got reset to 0%). And its nginx step
   bind-mounts paths computed from its own script location, meaningless
   once `docker run` runs via the DooD socket (host paths, not this
   container's). Fixed by not calling that script's download logic at all -
   `download_files_command()` does its own `wget -c` loop (resume-if-partial,
   skip-if-already-complete; not a real checksum, `files.list` doesn't carry
   one) directly against `files.list`, and doesn't start anything to serve
   it - `offline-files` is a permanent compose service now.
2. **DooD path translation.** `docker run -v` issued from inside the webui
   container (via the host-socket mount) is resolved by the **host's**
   daemon against **host** paths, not this container's - `HOST_KUBESPRAY_ROOT`
   (`docker-compose.yml`) holds the real host-side path, threaded through
   anywhere a `docker run -v` is still built (just `os_packages_command()`
   now that the permanent services removed the other cases).
3. **`manage-offline-container-images.sh register`'s own local-registry
   setup is unusable.** It resolves the address via `$(hostname)` (this
   container's own random ID, not reachable) and unconditionally
   `exit 1`s unless `/etc/docker/` or `/etc/containers/` exists **inside
   whatever container it's running in** (wants to write an
   insecure-registry `daemon.json` there - neither existed in the `webui`
   image). Fixed by always passing `DESTINATION_REGISTRY` explicitly
   (`localhost:5000` for "local" mode - the permanent `offline-registry`
   service, reachable via the host daemon's own loopback since it publishes
   that port; Docker treats `127.0.0.0/8` as insecure-safe automatically,
   no daemon.json edit needed) and a one-line `mkdir -p /etc/docker` in the
   `Dockerfile` so the directory-existence check passes (the file it then
   writes there is inert - the real daemon is on the host). Known gap: a
   **remote, non-loopback** registry serving plain HTTP would need
   `insecure-registries` configured on the **host's own**
   `/etc/docker/daemon.json` - this tool has no path to do that and doesn't
   attempt to.
4. **A stock nginx `default.conf` silently wins over our intended config
   on `Host: localhost` requests.** First attempt mounted kubespray's own
   `contrib/offline/nginx.conf` at `/etc/nginx/nginx.conf` - but that file's
   own `include /etc/nginx/conf.d/*.conf` still pulls in nginx:alpine's
   **stock** `conf.d/default.conf` (`server_name localhost`, root
   `/usr/share/nginx/html`, no autoindex) as a second server block on the
   same port. Since `server_name localhost` is *more specific* than our
   config's catch-all `server_name _`, any request with a plain
   `Host: localhost` header (any browser/curl hitting `localhost:8080`)
   gets routed to the **stock** block instead - wrong root, no autoindex,
   confusing 403s on browsing (this is exactly what the user hit browsing
   to `:8081` directly). Root-caused by checking `docker exec ... cat
   /etc/nginx/conf.d/default.conf` and comparing against what root path
   each URL variant actually resolved to. Fixed by not fighting the stock
   file - mount data straight onto `/usr/share/nginx/html` and **override
   `/etc/nginx/conf.d/default.conf` directly** (same path, one shared
   `nginx-autoindex.conf` for all three nginx services) instead of trying
   to layer a separate `nginx.conf`. Side effect, and a real correctness
   fix: this also meant the old `/download` URL sub-path (an artifact of
   kubespray's own script's directory convention) was wrong - kubespray's
   own `offline.yml` template expects `files_repo` to be usable directly as
   `{{ files_repo }}/dl.k8s.io/...`, no `/download` in between.
   `offline_yml_updates()`'s `files_repo` value fixed to match.
5. **`sudo chown ${USER} ...` fails because `$USER` is unset.** Found via
   the actual stderr: `chown: invalid user: '<path>'`. `manage-offline-
   container-images.sh`'s `create()` step does `sudo chown ${USER}
   ${IMAGE_DIR}/*` as its very last action, after all 48 images are already
   individually saved - a non-interactive `docker run`/exec shell doesn't
   get `$USER` set (that's normally `pam_env`/login-shell territory), so
   the empty variable vanishes from the command line entirely and `chown`
   misinterprets the *first glob-matched file* as the owner argument,
   erroring right before the final `tar` + handoff to `register()`. This
   silently discarded ~1.5 hours of successful image pulls twice before
   being caught (the individual per-image `.tar` files were all fine on
   disk, `container_images_archive` just never got created and `register()`
   never ran). Fixed with `ENV USER=root` in the `Dockerfile`.
6. **(Design bug, not DooD)** `os-packages`/`pip-packages`/`helm-charts`
   were initially nested under `offline-files/` - but `manage-offline-files.sh`
   (and now our own `download_files_command()`) writes into that same
   directory, so running "Download files" after any of those three would
   have silently mixed in with / been affected by it. Fixed by moving all
   three to be siblings of `offline-files/` directly under
   `contrib/offline/` instead.
7. **`manage-offline-container-images.sh register`'s push loop has no
   per-image error handling** (`set -e` active, no retry, unlike the
   `create()` loop which does retry). One image that fails to tag/push
   (hit once: `registry.k8s.io/metrics-server/metrics-server:v0.8.1` erred
   with `"was found but does not provide any platform"` - an OCI
   multi-arch-manifest edge case, not something this tool caused) aborts
   the **entire remaining batch** - 26 of 48 images made it into the
   registry that run, not 47. Not patched (upstream script, narrow edge
   case, time-boxed) - **known limitation**: if `register` dies partway,
   check `curl localhost:5000/v2/_catalog` against `images.list`'s line
   count and re-run if short: images.list is unaffected by a partial
   register (create() will resume near-instantly from Docker's own layer
   cache) and manual re-registration of just the missing ones is also an
   option if this recurs.

### Verification status — all 5 stages confirmed working end-to-end (2026-07-10)

- **generate-lists**: real `ansible-playbook` run, `files.list` (24 lines)
  / `images.list` (48 lines) land correctly on the host.
- **download-files**: all 24 files landed under `offline-files/`,
  `offline-files` service serves both the directory listing (autoindex,
  post-gotcha-#4-fix) and exact file paths correctly (verified via `curl`).
- **os-packages**: 162 real Ubuntu 24.04 `.deb`s (`file` confirms real
  Debian-format packages, not Debian-base mismatches) plus a real
  `Packages.gz` (via `dpkg-scanpackages`), served correctly by `offline-apt`
  as a genuine flat apt repo.
- **pip-packages**: `requirements.txt` deps downloaded as real wheels;
  `pip install --find-links=http://<host>:8082/ --no-index <pkg>` tested
  from the **host** (not from inside the webui container - `localhost`
  there means the webui container's own loopback, not a sibling
  container's published port) and successfully resolved/downloaded a real
  package through the `offline-pip` service's autoindex listing.
- **container-images**: after gotchas #3/#5/#7, `container_images_archive`
  gets created and `curl localhost:5000/v2/_catalog` lists real pushed
  images. One run hit gotcha #7 (26/48 pushed, one bad image aborted the
  rest) - re-running is cheap (Docker's layer cache makes `create()` nearly
  instant on retry) but this stage is the one most likely to need a manual
  "did everything actually land" check after a real run, per gotcha #7's
  note.
- **`POST /offline/configure`** ("Point kubespray at these repos" card):
  tested against `inventory/local/group_vars/all/offline.yml` with a throwaway
  test address, confirmed all 4 values write correctly with the gotcha-#4-fixed
  `files_repo` format, then reverted (this file isn't tracked by kubespray's
  own git - `local`/`afshin` are user-created inventories outside the
  upstream repo, so `git checkout --` doesn't apply to them; had to manually
  restore the commented-out placeholder lines to match `inventory/sample/`'s
  pristine template exactly).

## Ansible Molecule tab — Molecule role tests — reference notes

Separate nav item from **Installation** (last in the nav, empty placeholder,
content not yet specified — see architecture section above). Originally
built as part of a single "Installation" tab, then split into two per the
user's explicit request, keeping Installation as the final nav item.

Runs real Ansible Molecule tests (create → converge → idempotence →
destroy) against two kubespray roles, via `backend/molecule_runner.py` +
generalized `_stream_shell`/`_check_not_running` in `backend/main.py`
(the same locking/streaming/log-persistence mechanism the Offline Install
tab uses, just parameterized with `locks`/`logs` dicts instead of hardcoded
to `OFFLINE_STAGE_LOCKS`/`OFFLINE_STAGE_LOGS`). `GET /api/molecule/plan`
+ `POST /api/molecule/run/{role}`; not inventory-scoped (a role test is
independent of any specific cluster inventory).

**Architecturally load-bearing decision**: all scenario files live in
**this repo's own `molecule/<role>/molecule/default/`**, not inside the
managed kubespray checkout. The user was explicit about this mid-session:
the kubespray checkout can be re-cloned/switched/wiped independently (via
the Kubespray Version tab), so anything added inside it wouldn't reliably
survive. The actual role code under test is reached via `ANSIBLE_ROLES_PATH`
(set by `molecule_command()` in `molecule_runner.py` at invocation time,
pointed at `<kubespray checkout>/roles`), not baked into any scenario file -
so the scenario directory itself has zero dependency on the checkout's
contents beyond that one env var.

**Why not kubespray's own `roles/<role>/molecule/default/` scenarios**:
every one of them (`container-engine/*`, `bootstrap_os`,
`bastion-ssh-config`, `adduser`, etc.) uses
`provisioner.playbooks.create: tests/cloud_playbooks/create-kubevirt.yml`,
which provisions real VMs via a `packet-ci` role (KubeVirt + Equinix Metal
cloud credentials) - infra this environment doesn't have. Built new,
separate scenarios using Molecule's plain **Docker driver** instead (no
VMs, no cloud), for two simple, non-kernel-level roles: `adduser` (creates
local users/groups) and `bastion-ssh-config` (templates a config file).
Each scenario's `converge.yml` is a verbatim **copy** of the role's own
upstream `default/converge.yml`, not a reference to it -
`bastion-ssh-config`'s converge.yml uses `{{ playbook_dir }}` to know where
to write `ssh-bastion.conf`, and that resolves to wherever the *executing*
file physically lives; referencing the upstream file directly would make
the role write its output into the kubespray checkout's own
`roles/bastion-ssh-config/molecule/default/` as a side effect, cross-
contaminating our scenario with upstream's.

Dockerfile needs `molecule` + `molecule-plugins[docker]` (pip) **and** the
`community.docker`/`ansible.posix` Galaxy collections
(`ansible-galaxy collection install ...`) - `ansible-core` alone
deliberately ships no community collections (same reasoning as the offline
`generate_list.sh` gotcha), but the docker driver's actual create/destroy
logic is implemented as `community.docker.*` Ansible modules, not pure
Python - pip alone isn't enough.

### Gotchas found (all fixed) — found by actually running each role's test, not by inspection

1. **Molecule's scenario-discovery convention needs an extra nesting
   level.** First attempt put scenario files flat at
   `molecule/<role>/molecule.yml` - running `molecule test` from that
   directory produced `CRITICAL 'molecule/default/molecule.yml' glob
   failed. Exiting.` Molecule always looks for
   `<cwd>/molecule/<scenario-name>/molecule.yml` relative to wherever it's
   invoked - fixed by nesting one level deeper:
   `molecule/<role>/molecule/default/{molecule.yml,converge.yml}`.
2. **Missing Galaxy collections weren't caught by a normal rebuild.** After
   adding `ansible-galaxy collection install community.docker ansible.posix`
   to the Dockerfile, a normal `docker-compose build webui` still produced
   an image with *no* collections installed (confirmed via
   `ansible-galaxy collection list` / `find ... ansible_collections`
   inside the running container coming back empty), even though running
   the identical install command manually via `docker exec` on that same
   container worked fine. Root cause not fully pinned down (a Docker
   build-cache layer-reuse quirk, BuildKit not invalidating the layer
   despite the Dockerfile text changing) - reliably fixed with
   `docker-compose build --no-cache webui`. If a future Dockerfile RUN-step
   edit seems to silently not take effect, try `--no-cache` before assuming
   the code/config itself is wrong.
3. **`command: ""` + `privileged: true` + `cgroupns_mode: host` doesn't
   boot reliably on this host's WSL2 kernel.** The initial scenario design
   copied kubespray convention (heavy systemd/Docker-in-Docker base image,
   `geerlingguy/docker-ubuntu2204-ansible`, with `command: ""` meant to let
   its default CMD - `/lib/systemd/systemd` - run under privileged+cgroup
   mount). On this host, that combination produces a container that starts,
   runs briefly, but doesn't stay reliably reachable - the "Wait for
   instance(s) creation to complete" task retried for its full ~300-retry
   budget once (that specific hang traced separately to a slow first-time
   image pull, see gotcha #4), and a subsequent real converge attempt got
   `[ERROR] Task failed: Failed to create temporary directory` (the
   `docker exec`-based connection couldn't reliably create
   `~/.ansible/tmp` under systemd-as-PID1). Neither `adduser` nor
   `bastion-ssh-config` needs systemd or nested Docker at all - fixed by
   dropping `command`/`privileged`/`cgroupns_mode`/the cgroup volume mount
   entirely from both scenarios' `molecule.yml`, letting Molecule's docker
   driver fall back to its own plain keep-alive
   (`bash -c "while true; do sleep 10000; done"`). Confirmed via direct
   `docker run`/`docker exec` reproduction: the same image without
   privileged/systemd overrides starts and stays exec-able instantly;
   with them, `docker run` either errors outright (an empty-string `Cmd`
   override is a distinct, separate foot-gun - see below) or exits
   immediately (255) once systemd fails to initialize under this kernel.
4. **A ~1.37GB first-time image pull looked indistinguishable from a
   stuck/broken run for several minutes.** `docker images`/`docker events`
   showed nothing for a long stretch (the "Wait for instance(s) creation"
   task's retry loop is itself the async-poll for the underlying pull+create
   job, so nothing shows as "changed" until the whole thing - pull included
   - finishes) - confirmed genuinely still-alive (not hung) via
   `docker top <webui container>` showing live CPU on the
   `AnsiballZ_docker_container.py`/`ansible-playbook` process tree across
   multiple checks, then confirmed it really was just a slow pull by
   running `docker pull geerlingguy/docker-ubuntu2204-ansible:latest`
   directly on the host and watching it complete. Not a bug - just don't
   mistake a slow first pull (only pays this cost once; the layer is
   cached afterward) for a stuck run without checking `docker top` and a
   direct host-side pull first.
5. **`command: ""` in `molecule.yml` is not the same as omitting
   `command`.** Manually reproduced via plain `docker run ... ""`: Docker's
   API takes a literal empty-string `Cmd` override at face value and fails
   with `exec: "": executable file not found in $PATH` - `command: ""`
   does not mean "use the image's default CMD," it means "run an empty
   string as the command." (Molecule's own `create.yml` uses
   `item.command | default(...)` which only substitutes on *undefined*,
   not on empty-string - so an explicit `command: ""` in `molecule.yml`
   is a real foot-gun, distinct from just leaving the key out.) Resolved
   as a side effect of gotcha #3's fix (dropping `command` entirely).
6. **`bastion-ssh-config`'s converge.yml needs a `bastion` group and
   specific hostvars our single-container scenario doesn't get for free.**
   The role's `tasks/main.yml` directly reads
   `hostvars[groups['bastion'][0]]['ansible_host'|'ansible_ssh_host']` and
   `ansible_user` - none of which Molecule's docker driver sets
   automatically (its containers connect via `docker exec`, not a real
   address/SSH user). Fixed by adding a `provisioner.inventory` block to
   `bastion-ssh-config`'s `molecule.yml` that puts the single `instance`
   host into a `bastion` group with explicit `ansible_host`/`ansible_port`/
   `ansible_user: root` hostvars (mirroring how kubespray's own upstream
   scenario puts its one VM in a `bastion` group too) - matches upstream's
   pattern of "the bastion tests against itself," and the actual values
   don't matter since the role only templates a local file
   (`delegate_to: localhost`), it never really SSHes anywhere during this
   converge.

### Verification status — both roles confirmed working end-to-end (2026-07-11)

- **adduser**: `SCENARIO RECAP` `successful=6, failed=0`, exit code 0 -
  create → converge → idempotence → destroy all passed.
- **bastion-ssh-config**: same, `successful=6, failed=0`, exit code 0,
  including a genuine idempotence pass (`changed=0` on the second
  converge run). Confirmed via `git status --porcelain` + directory mtime
  comparison that no file was written into the kubespray checkout's own
  `roles/bastion-ssh-config/molecule/default/` during the run (proves the
  copied-not-referenced `converge.yml` decision in gotcha #6 avoided
  cross-contamination as intended).
