-- PCoin explorer index schema.
--
-- INVARIANT I (the whole design rests on this; see README.md "Proof"):
--   `blocks` always holds exactly the heights 0..T with no gaps, one row per
--   height, and for every height h in 1..T, blocks[h].prev_hash == blocks[h-1].hash.
--   Therefore the contents of `blocks` are always a genesis-rooted chain, i.e. a
--   prefix of *some* valid chain -- never a mixture of two branches.
--
-- The schema enforces the "one row per height / per hash" half structurally
-- (height is the primary key, hash is UNIQUE). The apply/unwind procedures in
-- indexer.py enforce contiguity and linkage, each inside a single SQLite
-- transaction, which is what makes a crash mid-reorg harmless.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS blocks (
    height        INTEGER PRIMARY KEY,          -- one row per height, enforced
    hash          TEXT    NOT NULL UNIQUE,      -- one row per hash, enforced
    prev_hash     TEXT,                         -- NULL only at height 0
    merkleroot    TEXT    NOT NULL,
    version       INTEGER NOT NULL,
    time          INTEGER NOT NULL,             -- header nTime (NOT monotonic in height)
    mediantime    INTEGER NOT NULL,             -- MTP; this one IS monotonic
    nonce         INTEGER NOT NULL,
    bits          TEXT    NOT NULL,
    difficulty    REAL    NOT NULL,
    chainwork     TEXT    NOT NULL,
    size          INTEGER NOT NULL,
    strippedsize  INTEGER NOT NULL,
    weight        INTEGER NOT NULL,
    n_tx          INTEGER NOT NULL,
    value_out     INTEGER NOT NULL,             -- satoshis: sum of every output in the block
    total_fees    INTEGER NOT NULL,             -- satoshis: sum of non-coinbase fees
    subsidy       INTEGER NOT NULL,             -- satoshis: consensus subsidy at this height
    coinbase_out  INTEGER NOT NULL              -- satoshis: what the coinbase actually claimed
);
CREATE INDEX IF NOT EXISTS blocks_time ON blocks(time);

CREATE TABLE IF NOT EXISTS txs (
    txid         TEXT    PRIMARY KEY,           -- safe as a PK: BIP34 is active from height 1
    wtxid        TEXT,
    height       INTEGER NOT NULL REFERENCES blocks(height),
    block_index  INTEGER NOT NULL,              -- position in the block; 0 == coinbase
    version      INTEGER NOT NULL,
    locktime     INTEGER NOT NULL,
    size         INTEGER,
    vsize        INTEGER,
    weight       INTEGER,
    is_coinbase  INTEGER NOT NULL,
    n_in         INTEGER NOT NULL,
    n_out        INTEGER NOT NULL,
    value_in     INTEGER NOT NULL,              -- 0 for a coinbase
    value_out    INTEGER NOT NULL,
    fee          INTEGER NOT NULL               -- 0 for a coinbase
);
CREATE INDEX IF NOT EXISTS txs_height ON txs(height, block_index);

CREATE TABLE IF NOT EXISTS outputs (
    txid            TEXT    NOT NULL REFERENCES txs(txid),
    n               INTEGER NOT NULL,
    height          INTEGER NOT NULL,
    value           INTEGER NOT NULL,
    address         TEXT,                       -- NULLable: bare pubkey, nulldata, nonstandard
    script_type     TEXT,
    script_hex      TEXT    NOT NULL,
    is_coinbase     INTEGER NOT NULL,
    maturity_height INTEGER,                    -- coinbase only: height + COINBASE_MATURITY,
                                                -- the first height it may be spent at
    unspendable     INTEGER NOT NULL,           -- nulldata, or the genesis coinbase (never in the UTXO set)
    spent_by_txid   TEXT    REFERENCES txs(txid),
    spent_by_n      INTEGER,
    spent_height    INTEGER,                    -- NULL <=> unspent. Spent-ness is stored,
                                                -- so a balance is a lookup and never a scan.
    PRIMARY KEY (txid, n)
);
CREATE INDEX IF NOT EXISTS outputs_address   ON outputs(address, height);
CREATE INDEX IF NOT EXISTS outputs_height    ON outputs(height);
CREATE INDEX IF NOT EXISTS outputs_spent_by  ON outputs(spent_by_txid);
CREATE INDEX IF NOT EXISTS outputs_unspent
    ON outputs(address, value) WHERE spent_height IS NULL AND unspendable = 0;
CREATE INDEX IF NOT EXISTS outputs_immature
    ON outputs(address, maturity_height)
    WHERE spent_height IS NULL AND is_coinbase = 1 AND unspendable = 0;

CREATE TABLE IF NOT EXISTS inputs (
    txid         TEXT    NOT NULL REFERENCES txs(txid),
    n            INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    prev_txid    TEXT,                          -- NULL for a coinbase input
    prev_n       INTEGER,
    value        INTEGER,                       -- the source output's value (from prevout)
    address      TEXT,                          -- the source output's address
    script_type  TEXT,
    sequence     INTEGER NOT NULL,
    coinbase_hex TEXT,                          -- coinbase input scriptSig
    PRIMARY KEY (txid, n)
);
CREATE INDEX IF NOT EXISTS inputs_address ON inputs(address, height);
CREATE INDEX IF NOT EXISTS inputs_prevout ON inputs(prev_txid, prev_n);

-- One row per (address, tx) it takes part in. This is the address history index
-- and it is also what makes tx_count maintainable incrementally: a txid lives in
-- exactly one block on the active chain, so (address, txid) is unique.
CREATE TABLE IF NOT EXISTS address_txs (
    address     TEXT    NOT NULL,
    txid        TEXT    NOT NULL REFERENCES txs(txid),
    height      INTEGER NOT NULL,
    block_index INTEGER NOT NULL,
    received    INTEGER NOT NULL,               -- satoshis into this address in this tx
    sent        INTEGER NOT NULL,               -- satoshis out of this address in this tx
    n_out       INTEGER NOT NULL,               -- outputs to this address in this tx
    n_in        INTEGER NOT NULL,               -- inputs from this address in this tx
    PRIMARY KEY (address, txid)
);
CREATE INDEX IF NOT EXISTS address_txs_hist   ON address_txs(address, height DESC, block_index DESC);
CREATE INDEX IF NOT EXISTS address_txs_txid   ON address_txs(txid);
CREATE INDEX IF NOT EXISTS address_txs_height ON address_txs(height);

-- Rollup cache. `address_txs` holds the exact per-(address, tx) deltas that
-- apply() added, so unwind subtracts those same recorded numbers back out --
-- an exact inverse by construction, with no second derivation to drift from.
-- Every column here is derivable from `outputs`/`address_txs`;
-- it is maintained incrementally so that a balance is one primary-key lookup.
-- `pcoin-index verify` recomputes the whole table and diffs it, and the unit
-- tests assert that unwind is the exact inverse of apply.
-- NOTE: `immature` is deliberately NOT stored -- it depends on the current tip
-- height, so a cached value goes stale without anything writing to it.
CREATE TABLE IF NOT EXISTS addresses (
    address      TEXT    PRIMARY KEY,
    balance      INTEGER NOT NULL DEFAULT 0,    -- total unspent, INCLUDING immature coinbase
    received     INTEGER NOT NULL DEFAULT 0,
    sent         INTEGER NOT NULL DEFAULT 0,
    utxo_count   INTEGER NOT NULL DEFAULT 0,
    tx_count     INTEGER NOT NULL DEFAULT 0,
    first_height INTEGER,
    last_height  INTEGER
);
CREATE INDEX IF NOT EXISTS addresses_balance ON addresses(balance DESC);

-- The consistency marker. Single row. Every field is written inside the same
-- transaction as the block it describes.
--
-- Doctrine (CLAUDE.md section 7.1/7.2): an RPC that failed, timed out or answered
-- "I do not know" resolves nothing. node_* and last_poll_ts are therefore written
-- ONLY after a successful RPC. A failure sets status/status_detail and leaves the
-- node_* observation exactly as it was, so "behind" is never silently reset to 0.
CREATE TABLE IF NOT EXISTS sync_state (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version    INTEGER NOT NULL,
    chain             TEXT,
    genesis_hash      TEXT,
    indexed_height    INTEGER NOT NULL DEFAULT -1,   -- mirror of max(blocks.height)
    indexed_hash      TEXT,
    node_height       INTEGER,                       -- last *successfully observed* node tip
    node_hash         TEXT,
    node_headers      INTEGER,
    node_ibd          INTEGER,                       -- 1 while the node is in IBD
    node_connections  INTEGER,                       -- peers at the last successful poll;
                                                     -- NULL = not observed, 0 = partitioned
    status            TEXT NOT NULL DEFAULT 'init',  -- init|syncing|ok|reorg|reindex|error
    status_detail     TEXT,
    last_poll_ts      INTEGER,                       -- last SUCCESSFUL node contact
    last_apply_ts     INTEGER,                       -- last time the index advanced
    reorg_count       INTEGER NOT NULL DEFAULT 0,
    blocks_unwound    INTEGER NOT NULL DEFAULT 0,
    indexer_pid       INTEGER,
    indexer_started_ts INTEGER
);

CREATE TABLE IF NOT EXISTS reorg_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,
    fork_height     INTEGER NOT NULL,
    old_tip_height  INTEGER NOT NULL,
    old_tip_hash    TEXT,
    new_tip_height  INTEGER,
    new_tip_hash    TEXT,
    blocks_unwound  INTEGER NOT NULL,
    detail          TEXT
);

-- Blocks this index once held and later unwound. Kept so the explorer can show
-- "orphaned at height H" instead of 404, and so a reorg leaves an audit trail.
CREATE TABLE IF NOT EXISTS orphaned_blocks (
    hash        TEXT PRIMARY KEY,
    height      INTEGER NOT NULL,
    prev_hash   TEXT,
    time        INTEGER,
    n_tx        INTEGER,
    unwound_ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orphaned_blocks_height ON orphaned_blocks(height);
