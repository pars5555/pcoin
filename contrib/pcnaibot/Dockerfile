# pcnaibot -- one image, used by BOTH processes.
#
# bookworm-slim, not alpine: better-sqlite3 ships glibc prebuilds, and on musl
# it would compile from source at install time -- which turns a deploy into a
# toolchain problem on a box running the only public node surface PCoin has.
# The host is Debian 12 with node 20, so this matches it.
FROM node:20-bookworm-slim

# tini so signals reach node: without an init, `docker stop` on the bot sends
# SIGTERM to PID 1 and node as PID 1 does not get the default handlers, so the
# container sits until the 10s kill. The watcher is a oneshot and would be cut
# mid-tick.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a source edit does not re-run npm.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY lib/ ./lib/
COPY migrations/ ./migrations/
COPY bot.mjs watch.mjs api.mjs migrate.mjs ./

# The image runs as a non-root user whose uid/gid must match the host owner of
# the bind-mounted state and log directories, or the watcher cannot write the
# log file that check_holding reads -- and a holding check that reads a file
# nobody can write is a check that can never fire.
#
# Override at build time to match the host account:
#   docker build --build-arg PCNAI_UID=$(id -u pcnaibot) --build-arg PCNAI_GID=$(id -g pcnaibot) ...
ARG PCNAI_UID=10001
ARG PCNAI_GID=10001
RUN groupadd -g "${PCNAI_GID}" pcnaibot \
 && useradd -u "${PCNAI_UID}" -g "${PCNAI_GID}" -M -s /usr/sbin/nologin pcnaibot \
 && mkdir -p /var/lib/pcnaibot /var/log/pcnaibot \
 && chown -R pcnaibot:pcnaibot /var/lib/pcnaibot /var/log/pcnaibot

USER pcnaibot

# NO SECRETS IN ENV, AND NONE IN THE IMAGE. `docker inspect` prints Env in full
# to anyone in the docker group, which is the same leak the config-file design
# exists to avoid. The config is BIND-MOUNTED READ-ONLY at runtime and read by
# the process itself.
ENV PCNAIBOT_CONF=/etc/pcoin/pcnaibot.conf \
    NODE_ENV=production

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/bot.mjs"]
