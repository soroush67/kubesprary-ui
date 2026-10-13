FROM python:3.12-slim

# rclone (from Debian) is the S3 client for RustFS. It replaced MinIO's `mc`:
# dl.min.io no longer serves the mc binary (HTTP 410 Gone), which broke this build.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client rsync curl ca-certificates rclone \
    && rm -rf /var/lib/apt/lists/* \
    && rclone version | head -1

RUN pip install --no-cache-dir "ansible-core>=2.16" \
    && ansible-galaxy collection install ansible.posix

COPY sync-backups.sh /usr/local/bin/sync-backups.sh
RUN chmod +x /usr/local/bin/sync-backups.sh

CMD ["/usr/local/bin/sync-backups.sh"]
