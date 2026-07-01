FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client rsync curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "ansible-core>=2.16" \
    && ansible-galaxy collection install ansible.posix

RUN curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc \
    && chmod +x /usr/local/bin/mc

COPY sync-backups.sh /usr/local/bin/sync-backups.sh
RUN chmod +x /usr/local/bin/sync-backups.sh

CMD ["/usr/local/bin/sync-backups.sh"]
