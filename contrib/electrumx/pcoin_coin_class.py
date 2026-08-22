# PCoin coin class for spesmilo/electrumx.
#
# HOW THIS IS APPLIED: install-electrumx.sh appends this text verbatim to
# src/electrumx/lib/coins.py in a clone of spesmilo/electrumx pinned at the tag
# named in that script. It is kept here, in PCoin's own repository, because it is
# PCoin's fact -- the address version bytes and the genesis hash come from
# src/kernel/chainparams.cpp and must be changed in lockstep with it -- and
# because a patch that lives only on two servers is a patch nobody can review.
#
# It is deliberately a whole class rather than a diff: ElectrumX finds coin
# classes with util.subclasses(Coin), so appending is sufficient and there is no
# context line to go stale when upstream edits the file above it.


class PCoin(Coin):
    '''PCoin (PCN) -- an independent Layer-1, forked from Bitcoin Core v29.4.

    PCoin replaced the proof-of-work CHECK with RandomX and the retarget
    algorithm with LWMA. Neither is visible from here. Block IDs are still
    double-SHA256, headers are still a fixed 80 bytes, and ElectrumX never
    validates proof of work -- it trusts the daemon for that. So this is a plain
    Bitcoin-derived coin class and nothing in ElectrumX needs patching.

    NOT a subclass of Bitcoin, on purpose. That class declares
    MIN_REQUIRED_DAEMON_VERSION "31.0" and REQUIRED_DAEMON_INDEXES containing
    "txospenderindex", both of which postdate the v29.4 codebase PCoin forked
    from. Inheriting them makes the daemon handshake fail at startup with a
    version error that has nothing to do with PCoin.
    '''

    NAME = "PCoin"
    SHORTNAME = "PCN"
    NET = "mainnet"

    # src/kernel/chainparams.cpp: base58Prefixes PUBKEY_ADDRESS 55, SCRIPT_ADDRESS 56.
    # (SECRET_KEY 183 has no equivalent here -- upstream removed WIF handling.)
    P2PKH_VERBYTE = bytes.fromhex("37")     # 55
    P2SH_VERBYTES = (bytes.fromhex("38"),)  # 56

    # Checked against the daemon's own block 0 at startup, so a coin class
    # pointed at the wrong chain refuses to run rather than indexing nonsense.
    GENESIS_HASH = ('a95d51f0cbf25cad10c35961c6189356'
                    '525d079835f02e83e2395f382fbe264a')

    # SegWit is buried and active from height 1, so every block may carry
    # witness data. bech32 "pc1q..." needs no entry here: hashX is taken from
    # the raw scriptPubKey, and the client does the address decoding.
    DESERIALIZER = lib_tx.DeserializerSegWit

    # PCoin's RPC port is P2P MINUS one, not Bitcoin's arrangement --
    # bitcoind's default Tor onion listener already sits at P2P plus one.
    RPC_PORT = 9443

    # Only used to draw an ETA during the initial sync.
    TX_COUNT = 5248
    TX_COUNT_HEIGHT = 4658
    TX_PER_BLOCK = 2

    # Above the default 200. PCoin retargets every block under LWMA, has
    # nMinimumChainWork = 0, and one miner has recently held ~70% of hashrate,
    # so a deep reorg is a live possibility rather than a formality. This is how
    # far back ElectrumX keeps undo information; past it, it needs a resync,
    # which on a chain this small costs minutes.
    REORG_LIMIT = 800

    # Fail loudly at startup if the daemon was started without txindex, instead
    # of failing obscurely later on a mempool lookup.
    REQUIRED_DAEMON_INDEXES = ("txindex",)

    PEERS = [
        'electrum1.pc.am s t',
        'electrum2.pc.am s t',
    ]
