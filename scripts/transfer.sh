#!/usr/bin/env bash
# Moves kubespray-webui - the app, the kubespray checkout with every offline
# download, the docker images of the stack and the offline registry's data -
# to another server, and starts it there with docker compose. Afterwards that
# server serves everything an isolated install needs (registry :5000, files
# :8080, apt :8081, pip :8082, webui :8420) with no internet.
#
#   scripts/transfer.sh --host 192.168.12.22 --user devops --dest /home/devops/kube-offline
#                       [--password PASS | --key ~/.ssh/id_ed25519] [--port 22]
#                       [--with-backups] [--no-start] [--check-only]
#
#   The password can also come from the environment: TRANSFER_PASSWORD=...
#   (keeps it out of `ps`). --with-backups also copies the RustFS (etcd backup)
#   volumes. --check-only runs every check and copies nothing.
#
# The target needs Docker + compose already installed and usable by the user
# (docker group); this script does NOT install Docker - it checks and stops
# with a clear message. Safe to re-run: files go with rsync, and images /
# volumes that already arrived intact are skipped.
#
# Also run by the webui's "Move to another server" card (inside the webui
# container: WEBUI_DIR=/webui-src, KUBESPRAY_DIR=/kubespray, docker via the
# host socket).
set -euo pipefail

HOST="" USER_NAME="" DEST="" PORT=22 KEY="" WITH_BACKUPS=0 START=1 CHECK_ONLY=0
PASSWORD=${TRANSFER_PASSWORD:-}
usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
    case "$1" in
        --host) HOST=$2; shift 2 ;;
        --user) USER_NAME=$2; shift 2 ;;
        --password) PASSWORD=$2; shift 2 ;;
        --key) KEY=$2; shift 2 ;;
        --port) PORT=$2; shift 2 ;;
        --dest) DEST=${2%/}; shift 2 ;;
        --with-backups) WITH_BACKUPS=1; shift ;;
        --no-start) START=0; shift ;;
        --check-only) CHECK_ONLY=1; shift ;;
        -h|--help) usage 0 ;;
        *) echo "unknown option: $1"; usage 1 ;;
    esac
done
[ -n "$HOST" ] && [ -n "$USER_NAME" ] && [ -n "$DEST" ] || { echo "ERROR: --host, --user and --dest are required"; usage 1; }
case "$DEST" in /*) ;; *) echo "ERROR: --dest must be an absolute path"; exit 1 ;; esac

WEBUI_DIR=${WEBUI_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
KUBESPRAY_DIR=${KUBESPRAY_DIR:-$(cd "$WEBUI_DIR/../kubespray" && pwd)}

# On the host: re-run inside the webui image, as root. Some files are
# root-owned (written by the webui container - e.g. kubespray's generated
# inventory/<inv>/credentials, which must move too) and the image brings
# sshpass/rsync/ssh, so the host only needs docker. Read-only mounts; the
# password travels as an environment variable, not on a command line.
if [ ! -f /.dockerenv ] && [ -z "${TRANSFER_NO_CONTAINER:-}" ]; then
    image=${TRANSFER_IMAGE:-kubespray-webui-webui}
    docker image inspect "$image" >/dev/null 2>&1 || { echo "ERROR: image $image not found - build the stack first"; exit 1; }
    args=(--host "$HOST" --user "$USER_NAME" --dest "$DEST" --port "$PORT")
    mounts=(-v /var/run/docker.sock:/var/run/docker.sock -v "$WEBUI_DIR":/webui-src:ro -v "$KUBESPRAY_DIR":/kubespray:ro)
    [ -d "$HOME/.ssh" ] && mounts+=(-v "$HOME/.ssh":/root/.ssh:ro)
    [ -n "$KEY" ] && { mounts+=(-v "$(realpath "$KEY")":/transfer-key:ro); args+=(--key /transfer-key); }
    [ "$WITH_BACKUPS" = 1 ] && args+=(--with-backups)
    [ "$START" = 0 ] && args+=(--no-start)
    [ "$CHECK_ONLY" = 1 ] && args+=(--check-only)
    exec docker run --rm -i --network host "${mounts[@]}" \
        -e TRANSFER_PASSWORD="$PASSWORD" -e WEBUI_DIR=/webui-src -e KUBESPRAY_DIR=/kubespray -e COMPOSE_PROJECT="${COMPOSE_PROJECT:-kubespray-webui}" \
        --entrypoint bash "$image" /webui-src/scripts/transfer.sh "${args[@]}"
fi
PROJECT=${COMPOSE_PROJECT:-kubespray-webui}
REMOTE_WEBUI="$DEST/kubespray-webui"
REMOTE_KUBESPRAY="$DEST/kubespray"
# duplicates of what the registry volume / offline-files/ already hold
KUBESPRAY_EXCLUDES=(--exclude=/contrib/offline/container-images/ --exclude=/contrib/offline/container-images.tar.gz
                    --exclude=/contrib/offline/offline-files.tar.gz)

step() { echo; echo "== $*"; }
die()  { echo; echo "ERROR: $*"; exit 1; }
human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "${1}B"; }

# --- ssh ------------------------------------------------------------------
KNOWN_HOSTS="$HOME/.ssh/known_hosts"
[ -w "$(dirname "$KNOWN_HOSTS")" ] 2>/dev/null || KNOWN_HOSTS=/tmp/transfer_known_hosts
SSH_OPTS=(-p "$PORT" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$KNOWN_HOSTS"
          -o ServerAliveInterval=30 -o ConnectTimeout=15)
[ -n "$KEY" ] && SSH_OPTS+=(-i "$KEY" -o IdentitiesOnly=yes)
if [ -n "$PASSWORD" ]; then
    command -v sshpass >/dev/null || die "--password needs sshpass on this machine (apt install sshpass), or use --key"
    export SSHPASS=$PASSWORD
    SSH_OPTS+=(-o PubkeyAuthentication=no)
    SSH=(sshpass -e ssh "${SSH_OPTS[@]}")
else
    SSH=(ssh "${SSH_OPTS[@]}" -o BatchMode=yes)
fi
remote() { "${SSH[@]}" "$USER_NAME@$HOST" "$@"; }

# --- 1. this machine ------------------------------------------------------
step "1/7 checking this machine"
command -v docker >/dev/null || die "docker CLI not found here"
[ -f "$WEBUI_DIR/docker-compose.yml" ] || die "no docker-compose.yml in $WEBUI_DIR"
[ -d "$KUBESPRAY_DIR/contrib/offline" ] || die "no kubespray checkout at $KUBESPRAY_DIR"

mapfile -t IMAGES < <({ docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Image}}'; echo alpine:latest; } | sort -u)
[ "${#IMAGES[@]}" -gt 1 ] || die "no containers of compose project '$PROJECT' here - start the stack first"
for img in "${IMAGES[@]}"; do docker image inspect "$img" >/dev/null 2>&1 || die "image $img is missing here"; done

VOLUMES=("${PROJECT}_offline_registry_data")
if [ "$WITH_BACKUPS" = 1 ]; then
    mapfile -t -O 1 VOLUMES < <(docker volume ls -q --filter "name=^${PROJECT}_rustfs_")
fi
# "<files>:<bytes>" of the files in a volume - not `du -sb`, which also counts
# directory sizes and those differ between filesystems (ext4 here, xfs on the
# target: identical data, different du - hit for real)
VOL_SUM='find /v -type f -exec stat -c %s {} + | awk "{s+=\$1; n++} END {print n+0\":\"s+0}"'
vol_bytes() { docker run --rm -v "$1":/v:ro alpine sh -c "$VOL_SUM"; }
declare -A VOL_SIZE
for v in "${VOLUMES[@]}"; do
    docker volume inspect "$v" >/dev/null 2>&1 || die "volume $v is missing here"
    VOL_SIZE[$v]=$(vol_bytes "$v")
done
files_bytes=$(( $(du -sb "$WEBUI_DIR" | cut -f1) + $(du -sb --exclude=container-images --exclude=container-images.tar.gz \
                                                         --exclude=offline-files.tar.gz "$KUBESPRAY_DIR" | cut -f1) ))
echo "app + kubespray + offline downloads: $(human "$files_bytes")"
echo "images: ${IMAGES[*]}"
for v in "${VOLUMES[@]}"; do echo "volume $v: $(human "${VOL_SIZE[$v]#*:}") in ${VOL_SIZE[$v]%%:*} files"; done

# --- 2. the target --------------------------------------------------------
step "2/7 checking $USER_NAME@$HOST"
remote true 2>/dev/null || die "cannot log in to $USER_NAME@$HOST:$PORT (check address, user, password/key)"
remote 'docker version --format "{{.Server.Version}}"' >/dev/null 2>&1 || die "Docker is not installed on $HOST, or '$USER_NAME' cannot use it.
       Install Docker Engine + the compose plugin there, then:  sudo usermod -aG docker $USER_NAME
       (log out/in) and run this again. This script does not install Docker."
if remote 'docker compose version' >/dev/null 2>&1; then COMPOSE="docker compose"
elif remote 'docker-compose version' >/dev/null 2>&1; then COMPOSE="docker-compose"
else die "docker compose is not installed on $HOST (install the docker-compose-plugin)"; fi
echo "docker $(remote 'docker version --format "{{.Server.Version}}"'), compose: $COMPOSE"
HAVE_RSYNC=0; remote 'command -v rsync' >/dev/null 2>&1 && command -v rsync >/dev/null && HAVE_RSYNC=1
REMOTE_HOME=$(remote 'echo $HOME')

# what is already there (re-runs skip it)
declare -A SKIP_IMG SKIP_VOL
need_docker=0
# identity = the uncompressed layer digests: the same on every docker version
# and image store (.Id differs between the containerd store and the classic one)
layers() { docker image inspect -f '{{join .RootFS.Layers ","}}' "$1"; }
for img in "${IMAGES[@]}"; do
    if [ "$(remote "docker image inspect -f '{{join .RootFS.Layers \",\"}}' '$img' 2>/dev/null" || true)" = "$(layers "$img")" ]; then
        SKIP_IMG[$img]=1
    else
        # .Size can be the compressed size (containerd image store): x3 for disk
        need_docker=$((need_docker + 3 * $(docker image inspect -f '{{.Size}}' "$img")))
    fi
done
for v in "${VOLUMES[@]}"; do
    rb=$(remote "docker volume inspect '$v' >/dev/null 2>&1 && docker run --rm -v '$v':/v:ro alpine sh -c '$VOL_SUM'" 2>/dev/null || true)
    if [ "$rb" = "${VOL_SIZE[$v]}" ]; then SKIP_VOL[$v]=1; else need_docker=$((need_docker + ${VOL_SIZE[$v]#*:})); fi
done

# disk space: files under --dest, images + volumes under docker's data root
free_at() { remote "p='$1'; while [ ! -e \"\$p\" ]; do p=\$(dirname \"\$p\"); done; df -B1 --output=avail \"\$p\" | tail -1"; }
dest_free=$(free_at "$DEST")
docker_root=$(remote 'docker info -f "{{.DockerRootDir}}"')
docker_free=$(free_at "$docker_root")
echo "free at $DEST: $(human "$dest_free") (need ~$(human "$files_bytes"))"
echo "free at $docker_root: $(human "$docker_free") (need ~$(human "$need_docker") for images/volumes not there yet)"
[ "$dest_free" -gt $((files_bytes * 11 / 10)) ] || die "not enough space at $DEST"
[ "$docker_free" -gt $((need_docker * 11 / 10)) ] || die "not enough space in docker's data root $docker_root"

# ports the stack publishes must be free (or already ours, on a re-run)
busy=$(remote "ss -ltnH 2>/dev/null | awk '{print \$4}' | grep -oE ':(8420|8080|8081|8082|5000|9000|9001)\$' | sort -u | tr '\n' ' '" || true)
ours=$(remote "docker ps --filter label=com.docker.compose.project=$PROJECT -q | head -1" 2>/dev/null || true)
[ -z "$busy" ] || [ -n "$ours" ] || die "ports already in use on $HOST: $busy- the stack needs 8420 8080 8081 8082 5000 9000 9001"

[ "$CHECK_ONLY" = 1 ] && { echo; echo "check-only: everything looks fine, nothing copied."; exit 0; }

# --- 3. files -------------------------------------------------------------
step "3/7 copying the app and kubespray (with every offline download) to $DEST"
remote "mkdir -p '$REMOTE_WEBUI' '$REMOTE_KUBESPRAY'"
if [ "$HAVE_RSYNC" = 1 ]; then
    export RSYNC_RSH="${SSH[*]}"
    rsync -a --partial --info=stats1 --exclude=/.env "$WEBUI_DIR/" "$USER_NAME@$HOST:$REMOTE_WEBUI/"
    rsync -a --partial --info=stats1 "${KUBESPRAY_EXCLUDES[@]}" "$KUBESPRAY_DIR/" "$USER_NAME@$HOST:$REMOTE_KUBESPRAY/"
else
    echo "(no rsync on one side - using tar over ssh)"
    tar -C "$WEBUI_DIR" --exclude=./.env -cf - . | remote "tar -C '$REMOTE_WEBUI' -xf -"
    tar -C "$KUBESPRAY_DIR" --exclude=./contrib/offline/container-images --exclude=./contrib/offline/container-images.tar.gz \
        --exclude=./contrib/offline/offline-files.tar.gz -cf - . | remote "tar -C '$REMOTE_KUBESPRAY' -xf -"
fi

# --- 4. .env with the target's paths --------------------------------------
step "4/7 writing $REMOTE_WEBUI/.env"
{ [ -f "$WEBUI_DIR/.env" ] && grep -vE '^(COMPOSE_PROJECT_NAME|HOST_KUBESPRAY_ROOT|SSH_DIR)=' "$WEBUI_DIR/.env" || true
  echo "COMPOSE_PROJECT_NAME=$PROJECT"
  echo "HOST_KUBESPRAY_ROOT=$REMOTE_KUBESPRAY"
  echo "SSH_DIR=$REMOTE_HOME/.ssh"
} | remote "cat > '$REMOTE_WEBUI/.env' && chmod 600 '$REMOTE_WEBUI/.env'"

# --- 5. images ------------------------------------------------------------
step "5/7 docker images"
for img in "${IMAGES[@]}"; do
    if [ -n "${SKIP_IMG[$img]:-}" ]; then echo "already there: $img"; continue; fi
    echo "sending $img ($(human "$(docker image inspect -f '{{.Size}}' "$img")"))"
    docker save "$img" | gzip -1 | remote 'gunzip | docker load -q'
done

# --- 6. volumes -----------------------------------------------------------
step "6/7 docker volumes: ${VOLUMES[*]}"
for v in "${VOLUMES[@]}"; do
    if [ -n "${SKIP_VOL[$v]:-}" ]; then echo "already there: $v"; continue; fi
    echo "sending $v ($(human "${VOL_SIZE[$v]#*:}"))"
    docker run --rm -v "$v":/v:ro alpine tar -C /v -cf - . | gzip -1 \
        | remote "docker volume create '$v' >/dev/null && gunzip | docker run --rm -i -v '$v':/v alpine tar -C /v -xf -"
    rb=$(remote "docker run --rm -v '$v':/v:ro alpine sh -c '$VOL_SUM'")
    [ "$rb" = "${VOL_SIZE[$v]}" ] || die "$v arrived as $rb (files:bytes), expected ${VOL_SIZE[$v]}"
done

# --- 7. start -------------------------------------------------------------
if [ "$START" = 0 ]; then
    step "7/7 skipped (--no-start). Start it with:  cd $REMOTE_WEBUI && $COMPOSE up -d"
    exit 0
fi
step "7/7 starting the stack on $HOST"
remote "cd '$REMOTE_WEBUI' && $COMPOSE up -d --no-build 2>&1 | tail -n 12"
ok=0
for _ in $(seq 1 30); do
    remote 'curl -fsS -o /dev/null http://127.0.0.1:8420/api/inventories' 2>/dev/null && { ok=1; break; }
    sleep 3
done
[ "$ok" = 1 ] || die "the webui did not come up on $HOST - check: cd $REMOTE_WEBUI && $COMPOSE logs webui"
repos=$(remote "curl -fsS http://127.0.0.1:5000/v2/_catalog" | grep -o '"[^"]*"' | grep -vc repositories || true)
files=$(remote "curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/" || true)
apt=$(remote "curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/Packages.gz" || true)
echo "registry :5000 -> $repos repositories | files :8080 -> HTTP $files | apt :8081 Packages.gz -> HTTP $apt"

cat <<EOF

Done. On $HOST:
  webui     http://$HOST:8420
  registry  http://$HOST:5000   files http://$HOST:8080   apt http://$HOST:8081   pip http://$HOST:8082
Next: webui > Offline Install > "Point kubespray at these repos" with the address
the cluster nodes reach $HOST at, then "Check readiness".
EOF
