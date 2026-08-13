# The PCoin seed-node image.
#
# Reconstructed 2026-08-13 from `docker history pcoin:1.2.1` on a running seed,
# because the original build context existed nowhere: all three seeds ran an
# image whose only definition was the layer metadata inside Docker itself. A
# `docker system prune` would have left three containers nobody could rebuild.
#
# The binaries are NOT built here on purpose. They come from the release
# tarball, which is what the published SHA256SUMS covers -- building them in
# this Dockerfile would produce a node whose hash matches nothing anybody can
# verify. Put bitcoind and bitcoin-cli next to this file first:
#
#   tar xf pcoin-<ver>-linux-x86_64.tar.gz --strip-components=2 \
#       -C contrib/seed-docker pcoin-<ver>/bin/bitcoind pcoin-<ver>/bin/bitcoin-cli
#   sha256sum -c <(grep -E 'bitcoind|bitcoin-cli' SHA256SUMS)
#   docker build -t pcoin:<ver> contrib/seed-docker
#
FROM ubuntu:24.04

# Exactly the three libevent modules the binaries actually link, plus sqlite for
# the wallet. The `-7t64` suffix is the 64-bit-time_t rename in 24.04; on an
# older base these are `-2.1-7`. Declaring only libc6 is how the .deb shipped a
# node that installed cleanly and then crash-looped 43 times -- see CLAUDE.md
# lesson 12. Same trap, same fix.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libevent-core-2.1-7t64 \
        libevent-extra-2.1-7t64 \
        libevent-pthreads-2.1-7t64 \
        libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

COPY bitcoind bitcoin-cli /usr/local/bin/

# No CMD. The datadir, and everything else, comes from the run command so one
# image serves every seed.
ENTRYPOINT ["bitcoind"]
