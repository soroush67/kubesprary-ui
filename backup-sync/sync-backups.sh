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

until mc alias set rustfs "$RUSTFS_ENDPOINT" "$RUSTFS_ACCESS_KEY" "$RUSTFS_SECRET_KEY" >/dev/null 2>&1; do
  log "waiting for rustfs at $RUSTFS_ENDPOINT ..."
  sleep 5
done
mc mb --ignore-existing "rustfs/${RUSTFS_BUCKET}" >/dev/null

while true; do
  if INVENTORY_FILE="$(find_inventory_file)"; then
    log "pulling etcd backups from inventory '$INVENTORY_NAME' ($INVENTORY_FILE)"
    if ansible etcd -i "$INVENTORY_FILE" \
        -e "ansible_ssh_common_args='-o StrictHostKeyChecking=accept-new'" \
        -m ansible.posix.synchronize \
        -a "mode=pull src=${ETCD_BACKUP_PREFIX}/ dest=${STAGING_DIR}/{{ inventory_hostname }}/ rsync_opts=--ignore-existing,--relative"; then
      mc mirror --overwrite "$STAGING_DIR/" "rustfs/${RUSTFS_BUCKET}/"
      log "sync complete"
    else
      log "ansible pull failed, will retry next cycle"
    fi
  else
    log "no inventory file found for '$INVENTORY_NAME' under $KUBESPRAY_ROOT/inventory, skipping this cycle"
  fi
  sleep "$SYNC_INTERVAL_SECONDS"
done
