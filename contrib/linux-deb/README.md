# Debian/Ubuntu package

`build-deb.sh` turns an already-built pair of Linux binaries into
`pcoin_<ver>_amd64.deb`. It does not compile anything — build the node first
(see `PCOIN.md` §3) or unpack a published `pcoin-<ver>-linux-x86_64.tar.gz`.

```bash
tar xf pcoin-1.2.2-linux-x86_64.tar.gz
contrib/linux-deb/build-deb.sh 1.2.2 pcoin-1.2.2/bin /tmp/debbuild
sudo apt install /tmp/debbuild/pcoin_1.2.2_amd64.deb
```

## What the package does

| | |
|---|---|
| binaries | `/opt/pcoin/bin/{bitcoind,bitcoin-cli}` |
| on `PATH` | `pcoind`, `pcoin-cli` (symlinks) |
| datadir | `/var/lib/pcoin`, owned by the `pcoin` system user, mode 710 |
| config | `/var/lib/pcoin/pcoin.conf`, written only if absent |
| service | `pcoind.service`, installed but **not enabled** |

Three decisions in there are load-bearing and should survive any rewrite.

**The binaries are not installed as `/usr/bin/bitcoind`.** That path belongs to
Bitcoin Core's own package and `dpkg` refuses to overwrite a file owned by
another package — anyone with both installed could not install this one at all.
They keep their upstream names inside `/opt/pcoin/bin` and are exposed under
PCoin names via symlinks, so the two packages coexist.

**The config is `pcoin.conf`, not `bitcoin.conf`.** A node handed
`bitcoin.conf` ignores every setting in it without a word of complaint. That is
the single most common newcomer mistake on this fork, so the package writes the
right filename rather than leaving it to the user. It also sets `fallbackfee`
and `changetype=bech32`, without which every mainnet send fails — see
`PCOIN.md` §6.5.

**`postrm` never deletes `/var/lib/pcoin`,** not even on `purge`. That
directory holds the chain *and any wallet*. `apt purge` removing somebody's
coins is not a recoverable mistake, so purge only prints where the data is and
leaves it alone.

The service is deliberately left disabled after install. A node that starts
mining before it has synced builds on a chain it has not verified (`CLAUDE.md`
§7.9), and the same caution applies to starting unattended at all. The
`postinst` prints the one command that starts it.

## Testing a change

Do it in a throwaway container or VM, not on a machine you care about — the
package creates a system user and a systemd unit.

```bash
sudo apt install ./pcoin_1.2.2_amd64.deb
sudo systemctl enable --now pcoind
pcoin-cli -datadir=/var/lib/pcoin getblockchaininfo   # chain must read "main"
sudo apt remove pcoin      # /var/lib/pcoin must still exist afterwards
```

That last check is the one worth actually running every time.
