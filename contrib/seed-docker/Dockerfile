# Seed node image. Binaries come from a release tarball verified against its
# SHA256SUMS *before* they are copied in -- the image never builds from source,
# so the hash of /usr/local/bin/bitcoind is the release's hash (README).
#
# Runs as an unprivileged user. Until 2026-09-07 the seeds ran bitcoind as root
# inside the container with a root-owned datadir, so a bug reachable from the
# P2P port (open to the world by necessity) was root in the container. The uid
# is fixed at 1100 so the host datadir can be chowned once and the image
# rebuilt freely; `docker exec pcoin-seed bitcoin-cli` keeps working because
# the cookie lives under this user's HOME.
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
        libevent-core-2.1-7t64 \
        libevent-extra-2.1-7t64 \
        libevent-pthreads-2.1-7t64 \
        libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1100 pcoin && useradd -u 1100 -g 1100 -m -s /usr/sbin/nologin pcoin
COPY bitcoind bitcoin-cli /usr/local/bin/
USER pcoin
WORKDIR /home/pcoin
ENTRYPOINT ["bitcoind"]
