"""PCoin block explorer: a server-rendered web UI and a read-only JSON API,
served from one stdlib-only process on top of the index built by
``pcoin_indexer``.

Two properties this package deliberately has, and must keep:

* **It never talks to the node.** Its only input is the SQLite index file,
  opened read-only. It therefore holds no RPC credentials, cannot be tricked
  into calling ``scantxoutset`` (globally serialised, O(UTXO set)), and cannot
  affect the chain no matter what a request contains.
* **It is non-custodial and has no write surface at all.** It never derives an
  address, never holds a key, never signs and never broadcasts. Clients derive
  their own addresses from their own twelve words (BIP84,
  ``m/84'/9444'/0'/0/i``); this serves answers about the chain.

Entry point: ``python3 -m pcoin_explorer --db pcoin-index.sqlite serve``.
"""

__version__ = "0.1.0"
