package org.pcoin.miner.wallet

/**
 * PCoin's published key derivation. This file IS the specification as far as
 * the app is concerned, and it must stay in step with the "Wallet / key
 * derivation" section of PCOIN.md — any future wallet restoring the same twelve
 * words depends on both saying exactly the same thing.
 *
 *   m / 84' / 9444' / account' / change / index
 *
 * Purpose 84' is BIP84 (native SegWit P2WPKH), which produces the "pc1q..."
 * bech32 addresses PCoin's wallet defaults to.
 *
 * Coin type 9444' is PCoin's own, matching its P2P port, and is unregistered in
 * SLIP-44 (a registration PR is the plan, but shipping does not wait on it).
 * The coin type is load-bearing in a way it is not for most chains: PCoin
 * inherited Bitcoin's EXT_SECRET_KEY version bytes, so PCoin extended keys
 * serialise as literal "xprv..." and a Bitcoin xprv parses in a PCoin
 * descriptor. Coin type 0 would therefore make one phrase derive
 * byte-identical keys on both chains. 9444' is the only thing keeping the two
 * trees apart — never change it, and never use it on a test network, where
 * SLIP-44's universal "coin type 1 = all testnets" applies instead.
 */
object PcoinDerivation {

    enum class Network(
        val coinType: Int,
        /** base58Prefixes[EXT_SECRET_KEY] from kernel/chainparams.cpp. */
        val extSecretKeyVersion: ByteArray,
        val bech32Hrp: String,
        /** Genesis nTime: the true lower bound for a restore rescan. */
        val genesisTime: Long,
    ) {
        MAINNET(
            coinType = 9444,
            extSecretKeyVersion = byteArrayOf(0x04, 0x88.toByte(), 0xAD.toByte(), 0xE4.toByte()),
            bech32Hrp = Bech32.HRP_MAINNET,
            genesisTime = 1785600628L,
        ),

        /**
         * Regtest/testnet share "coin type 1" and the tprv version bytes.
         * Present so the derivation is testable end-to-end against a regtest
         * node without ever putting test coins on the mainnet path.
         */
        REGTEST(
            coinType = 1,
            extSecretKeyVersion = byteArrayOf(0x04, 0x35, 0x83.toByte(), 0x94.toByte()),
            bech32Hrp = Bech32.HRP_REGTEST,
            genesisTime = 1785600628L,
        ),
    }

    const val PURPOSE = 84

    /** Fixed at 0 for v1. Not exposed in the UI; 1', 2', ... are reserved. */
    const val ACCOUNT = 0

    const val CHAIN_EXTERNAL = 0
    const val CHAIN_INTERNAL = 1

    /**
     * How many scriptPubKeys per chain the node pre-derives and rescans for.
     *
     * This is not the BIP44 gap limit (20, a UI concept). PCoin's chain is tiny,
     * so importing 1000 external + 1000 internal costs nothing and means a
     * restore finds funds up to index 999 with no gap-limit logic at all.
     */
    const val IMPORT_RANGE_END = 999

    /** The mining payout address: index 0, generated once, reused forever. */
    val PAYOUT_PATH_SUFFIX = intArrayOf(CHAIN_EXTERNAL, 0)

    fun accountPath(network: Network, account: Int = ACCOUNT): IntArray = intArrayOf(
        Bip32.hardened(PURPOSE),
        Bip32.hardened(network.coinType),
        Bip32.hardened(account),
    )

    /** "m/84h/9444h/0h" — written with h, which is identical to ' but safe in JSON and shells. */
    fun accountPathString(network: Network, account: Int = ACCOUNT): String =
        "m/${PURPOSE}h/${network.coinType}h/${account}h"

    /** The origin field of a descriptor: "[<fingerprint>/84h/9444h/0h]". */
    fun originString(masterFingerprintHex: String, network: Network, account: Int = ACCOUNT): String =
        "[$masterFingerprintHex/${PURPOSE}h/${network.coinType}h/${account}h]"

    /**
     * Everything the node and the UI need, derived once from a mnemonic.
     *
     * Holds an account-level xprv, deliberately not the root. The node is given
     * a key that can spend account 0 and nothing else: a stolen wallet.dat
     * exposes neither the seed nor any future account, and cannot be reversed
     * into the twelve words. The root private key never leaves this process.
     */
    class AccountKeys(
        val network: Network,
        val masterFingerprintHex: String,
        private val accountKey: Bip32.ExtendedKey,
    ) {
        /** Secret. Never log this, never put it in a notification. */
        fun accountXprv(): String = accountKey.serialize(network.extSecretKeyVersion)

        /**
         * The ranged descriptor for one chain, e.g.
         * `wpkh([fp/84h/9444h/0h]xprv.../0/<star>)` with `<star>` the literal
         * wildcard. No checksum yet; importdescriptors requires one and
         * DescriptorInstaller obtains it from the node.
         */
        fun descriptor(chain: Int): String =
            "wpkh(${originString(masterFingerprintHex, network)}${accountXprv()}/$chain/*)"

        /** The address at m/84'/coin'/0'/change/index, computed locally. */
        fun address(chain: Int, index: Int): String {
            val leaf = Bip32.derivePath(accountKey, intArrayOf(chain, index))
            val addr = Bech32.encodeP2wpkh(network.bech32Hrp, Hashes.hash160(leaf.publicKey))
            leaf.wipe()
            return addr
        }

        /** m/84'/coin'/0'/0/0 — the mining payout address. */
        fun payoutAddress(): String = address(CHAIN_EXTERNAL, 0)

        fun wipe() = accountKey.wipe()
    }

    /**
     * mnemonic -> seed -> master -> account key.
     *
     * The seed and the master key are wiped before returning: the only secret
     * that survives this call is the account key, and the only secret that ever
     * crosses the RPC boundary is its xprv, once, at wallet creation.
     */
    fun accountKeys(
        bip39: Bip39,
        mnemonic: CharArray,
        network: Network,
        passphrase: String = "",
        account: Int = ACCOUNT,
    ): AccountKeys {
        val seed = bip39.toSeed(mnemonic, passphrase)
        val master = try {
            Bip32.fromSeed(seed)
        } finally {
            seed.fill(0)
        }
        val fingerprint = master.fingerprint.toHex()
        val acct = Bip32.derivePath(master, accountPath(network, account))
        master.wipe()
        return AccountKeys(network, fingerprint, acct)
    }
}
