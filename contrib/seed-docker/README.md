# Seed node in Docker

How all three seeds actually run. `pcoin.conf` lives on the host in the bind
mount, not in the image, so the same image serves every seed.

```bash
# once per host: the image runs bitcoind as uid 1100, so the datadir must be its
chown -R 1100:1100 /var/lib/pcoin/data

docker run -d --name pcoin-seed \
  --restart unless-stopped \
  -p 9444:9444 \
  --memory 2g --cap-drop ALL --security-opt no-new-privileges \
  -v /var/lib/pcoin/data:/home/pcoin/.pcoin \
  pcoin:<ver>
```

The mount point is `/home/pcoin/.pcoin`, not `/root/.pcoin`: the container user
is `pcoin` (uid 1100, set in the Dockerfile), and `docker exec pcoin-seed
bitcoin-cli …` runs as that user, so the RPC cookie has to sit under its HOME.
A seed that still mounts at `/root/.pcoin` will start, find an empty datadir,
and begin syncing from genesis as if it were new.

**Building the image** never compiles anything. Fetch the Linux release tarball,
check it against the release's `SHA256SUMS`, extract `bitcoind` and
`bitcoin-cli` next to the Dockerfile, then `docker build -t pcoin:<ver> .`.

**Replacing a running seed.** Use `docker stop`, not `bitcoin-cli stop`: with
`--restart unless-stopped` a process that exits on its own is treated as a crash
and the OLD container comes straight back, holding port 9444 so the new one
cannot start. `docker stop` (which sends SIGTERM, and bitcoind shuts down
cleanly on it) marks the container stopped and it stays that way. Keep the old
container renamed for a rollback until the new one has followed the tip for a
while.

**Only 9444 (P2P) is published.** RPC stays loopback-bound *inside* the
container and is unreachable from outside it — which is why every operation is
`docker exec pcoin-seed bitcoin-cli …` rather than an RPC call over the network.

## Verify the image matches a release before you trust it

```bash
docker run --rm --entrypoint sha256sum pcoin:<ver> /usr/local/bin/bitcoind
```

Compare against `pc.am/dl/SHA256SUMS.txt`. Do **not** infer the version from the
image tag: a seed has run tagged `pcoin:1.2.0` while the binary inside reported
v1.2.3. The tag is a label someone typed; the hash is the software.

## What is deliberately absent

No healthcheck. `restart=unless-stopped` covers a crash and a reboot, but
nothing here notices "container up, chain stalled" — that is
`pcoin-seed-watch`'s job (`contrib/seed-monitoring`), off-host and out-of-band,
because a healthcheck that runs inside the sick container is not a monitor.

No CPU or memory limit. On a dedicated box that is fine; on the shared
production seed it means nothing stops the node starving the ~215 other vhosts
on that machine. Add `--memory` and `--cpus` there.
