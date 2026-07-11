FROM python:3.12-slim

# contrib/offline/manage-offline-container-images.sh exit(1)s unless /etc/docker or
# /etc/containers exists; the daemon.json it writes there is inert (the real daemon is
# on the host, reached via the mounted socket) - this just satisfies the check.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates docker-cli sudo curl wget dpkg-dev \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global --add safe.directory /kubespray \
    && mkdir -p /etc/docker

WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt ansible-core molecule "molecule-plugins[docker]" \
    # molecule-plugins[docker]'s driver is implemented as Ansible modules, not
    # pure Python - ansible-core alone (deliberately lean, no community bundle -
    # see offline.py's generate_list.sh gotcha) doesn't ship these collections.
    && ansible-galaxy collection install community.docker ansible.posix

COPY backend ./backend
COPY static ./static
COPY molecule ./molecule

WORKDIR /app/backend
ENV KUBESPRAY_ROOT=/kubespray
# manage-offline-container-images.sh does `sudo chown ${USER} ...` at the end of its
# create step - $USER isn't set by default for a non-interactive `docker run`/exec
# shell (nothing here runs a login shell), so it silently vanishes and chown
# misinterprets the first glob-matched file as the owner argument, failing with
# "chown: invalid user: <path>" right after all 48 images were already saved.
ENV USER=root

EXPOSE 8420
CMD ["python3", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8420"]
