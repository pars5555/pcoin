"""PCoin explorer JSON API.

A read-only HTTP interface over the index built by ``pcoin_indexer``, plus one
state-changing endpoint (``POST /api/tx``) that relays an already-signed
transaction to a node.

Non-custodial, and structurally so: nothing in this package derives an address,
generates a key, stores a key or signs anything. Clients derive their own
addresses from their own twelve words (BIP84, ``m/84'/9444'/0'/0/i``) and this
API answers questions about the chain.

Stdlib only, same as the indexer -- ``http.server``, ``sqlite3``, ``json``,
``urllib``. ``git clone && python3 -m pcoin_api serve`` is the whole install.
"""

__version__ = "1.0.0"
