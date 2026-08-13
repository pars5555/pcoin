# Seed node in Docker

How all three seeds actually run. `pcoin.conf` lives on the host in the bind
mount, not in the image, so the same image serves every seed.

```bash
docker run -d --name pcoin-seed \
  --restart unless-stopped \
  -p 9444:9444 \
  -v /var/lib/pcoin/data:/root/.pcoin \
  pcoin:<ver>
```

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
