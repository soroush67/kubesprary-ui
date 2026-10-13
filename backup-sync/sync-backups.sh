#!/usr/bin/env bash
# Periodically pulls the etcd snapshot files that the etcd-snapshot-backup.timer
# (installed by extra_playbooks/etcd-backup-schedule.yml) writes locally on each
# etcd node, and mirrors them into a RustFS (S3-compatible) bucket.
set -euo pipefail

: "${INVENTORY_NAME:=local}"
: "${SYNC_INTERVAL_SECONDS:=900}"
: "${RUSTFS_ENDPOINT:=http://rustfs:9000}"
: "${RUSTFS_ACCESS_KEY:?RUSTFS_ACCESS_KEY is required}"
: "${RUSTFS_SECRET_KEY:?RUSTFS_SECRET_KEY is required}"
: "${RUSTFS_BUCKET:=etcd-backups}"
: "${KUBESPRAY_ROOT:=/kubespray}"
: "${ETCD_BACKUP_PREFIX:=/var/backups}"
STAGING_DIR=/staging

mkdir -p "$STAGING_DIR"
cd "$KUBESPRAY_ROOT"

log() { echo "[$(date -Is)] $*"; }

find_inventory_file() {
  for candidate in inventory.yml inventory.yaml hosts.yaml hosts.ini inventory.ini; do
    if [ -f "$KUBESPRAY_ROOT/inventory/$INVENTORY_NAME/$candidate" ]; then
      echo "$KUBESPRAY_ROOT/inventory/$INVENTORY_NAME/$candidate"
      return 0
    fi
  done
  return 1
}

# rclone remote "rustfs:" defined via environment (no config file needed)
export RCLONE_CONFIG=/dev/null            # remote is fully defined below; no config file
export RCLONE_CONFIG_RUSTFS_TYPE=s3
export RCLONE_CONFIG_RUSTFS_PROVIDER=Other
export RCLONE_CONFIG_RUSTFS_ENDPOINT="$RUSTFS_ENDPOINT"
export RCLONE_CONFIG_RUSTFS_ACCESS_KEY_ID="$RUSTFS_ACCESS_KEY"
export RCLONE_CONFIG_RUSTFS_SECRET_ACCESS_KEY="$RUSTFS_SECRET_KEY"
export RCLONE_CONFIG_RUSTFS_FORCE_PATH_STYLE=true

until rclone lsd rustfs: >/dev/null 2>&1; do
  log "waiting for rustfs at $RUSTFS_ENDPOINT ..."
  sleep 5
done
rclone mkdir "rustfs:${RUSTFS_BUCKET}"

while true; do
  if INVENTORY_FILE="$(find_inventory_file)"; then
    log "pulling etcd backups from inventory '$INVENTORY_NAME' ($INVENTORY_FILE)"
    if ansible etcd -i "$INVENTORY_FILE" \
        -e "ansible_ssh_common_args='-o StrictHostKeyChecking=accept-new'" \
        -m ansible.posix.synchronize \
        -a "mode=pull src=${ETCD_BACKUP_PREFIX}/ dest=${STAGING_DIR}/{{ inventory_hostname }}/ rsync_opts=--ignore-existing,--relative"; then
      # like the old `mc mirror --overwrite`: upload new/changed files, never delete from the bucket
      rclone copy "$STAGING_DIR/" "rustfs:${RUSTFS_BUCKET}/"
      log "sync complete"
    else
      log "ansible pull failed, will retry next cycle"
    fi
  else
    log "no inventory file found for '$INVENTORY_NAME' under $KUBESPRAY_ROOT/inventory, skipping this cycle"
  fi
  sleep "$SYNC_INTERVAL_SECONDS"
done
