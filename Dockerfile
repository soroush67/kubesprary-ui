FROM python:3.12-slim

# contrib/offline/manage-offline-container-images.sh exit(1)s unless /etc/docker or
# /etc/containers exists; the daemon.json it writes there is inert (the real daemon is
# on the host, reached via the mounted socket) - this just satisfies the check.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates docker-cli sudo curl wget dpkg-dev sshpass openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global --add safe.directory /kubespray \
    && mkdir -p /etc/docker

WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
# Real cluster.yml runs (Installation tab) need the community.general module
# (and others) that kubespray's own roles use - kubespray's own Dockerfile
# gets these by installing the full "ansible" pip metapackage (not bare
# ansible-core), which bundles community.general/community.docker/
# ansible.posix/etc. as a pinned set - matching that instead of installing
# ansible-core + hand-picked collections avoids finding out one-by-one which
# collections cluster.yml needs (first hit: community.general, via
# roles/kubernetes/preinstall's NetworkManager DNS task). Version pinned to
# match the kubespray checkout's own requirements.txt - cluster.yml's own
# ansible_version.yml preflight check hard-fails outside kubespray's exact
# supported ansible-core range (hit this directly: unpinned "ansible" pulled
# ansible-core 2.21.1, kubespray v2.31.0 requires 2.18.x-2.19.x). Known
# limitation: if the Kubespray Version tab switches to a tag with a
# different requirements.txt pin, this may need to be updated to match.
# cryptography/jmespath/netaddr mirror kubespray's own requirements.txt too
# (community.crypto, jinja2 json_query filter, and ansible.utils.ipaddr all
# need them respectively - the last one found by directly hitting "Check
# that python netaddr is installed" failing on a real cluster.yml run).
# kubespray's requirements.txt itself can't be COPYed at build time - it
# only exists via the /kubespray bind mount at container runtime.
RUN pip install --no-cache-dir -r backend/requirements.txt \
    "ansible==11.13.0" "cryptography==46.0.7" "jmespath==1.1.0" "netaddr==1.3.0" \
    molecule "molecule-plugins[docker]"

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
