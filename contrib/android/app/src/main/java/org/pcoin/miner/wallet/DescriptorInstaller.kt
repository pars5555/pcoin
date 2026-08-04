package org.pcoin.miner.wallet

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import org.pcoin.miner.RpcClient
import java.io.IOException

/**
 * Creates the seeded wallet on the node and imports the descriptors into it.
 *
 * This is the one and only place an extended private key crosses the RPC
 * boundary, and it happens exactly once per wallet, at creation. Not on every
 * start, not on unlock. The key that crosses is the ACCOUNT xprv, never the
 * root and never the mnemonic: a stolen wallet.dat therefore exposes account 0
 * and nothing else, and cannot be turned back into the twelve words.
 *
 * It goes over the HTTP socket to 127.0.0.1 like every other call this app
 * makes. It must never be sent by shelling out to bitcoin-cli -- argv is
 * world-readable in the process table and lands in shell history.
 *
 * Every RPC error string is passed through [Redact] before it is logged,
 * because the node echoes the offending descriptor back in its error text.
 */
class DescriptorInstaller(private val rpc: RpcClient) {

    class InstallException(message: String) : IOException(message)

    data class Result(
        val walletName: String,
        /** m/84'/9444'/0'/0/0, confirmed identical on the node and locally. */
        val payoutAddress: String,
        /** True when this call created the wallet rather than finding it. */
        val created: Boolean,
        /**
         * What the scan actually found. Reported so a restore that produced an
         * empty wallet is visible immediately instead of looking like a success:
         * a single mistyped word that happens to be another BIP39 word passes
         * the 4-bit checksum roughly one time in sixteen, and the only thing
         * that distinguishes that from a good restore is the outcome.
         *
         * -1 means the node could not be asked -- never conflated with 0.
         */
        val txCount: Int = -1,
        val balance: Double = -1.0,
    )

    /**
     * @param rescanFromTimeSec null for a brand-new phrase (the keys provably
     *   never existed, so the node is told "now" and skips scanning entirely);
     *   the network's genesis time for a restore.
     */
    fun install(
        keys: PcoinDerivation.AccountKeys,
        walletName: String,
        rescanFromTimeSec: Long?,
        onProgress: (String) -> Unit,
    ): Result {
        val expectedAddress = keys.payoutAddress()

        onProgress("creating wallet")
        val created = createBlankWallet(walletName)

        if (!created) {
            // The wallet already existed. That happens when a previous setup was
            // interrupted after createwallet, or when the app is reinstalled
            // over a datadir that survived. Do NOT re-import over it blind and
            // do NOT delete it: establish what is in it first.
            //
            // Three outcomes, and all three must be distinguishable:
            //   owns == true   this wallet is already this phrase's; done
            //   owns == false  a definite no from the node
            //   owns == null   the node could not be asked
            //
            // An earlier version returned false for both "no" and "could not
            // ask", and then only logged a warning before importing anyway. A
            // timed-out getaddressinfo therefore authorised an import -- and
            // because importdescriptors with active=true DEACTIVATES the
            // previously active wpkh descriptor, the wallet would stop handing
            // out the addresses the older phrase recovers.
            when (walletOwns(walletName, expectedAddress)) {
                true -> {
                    Log.i(TAG, "wallet \"$walletName\" already matches this phrase")
                    val (tx, bal) = summarise(walletName)
                    return Result(walletName, expectedAddress, created = false, txCount = tx, balance = bal)
                }
                null -> throw InstallException(
                    "Could not read whether the existing wallet \"$walletName\" already belongs to " +
                        "this recovery phrase, so nothing was imported into it. Nothing has been " +
                        "changed. Make sure the node is running and try again."
                )
                false -> guardForeignDescriptors(walletName, keys)
            }
        }

        onProgress("preparing descriptors")
        val external = checksummed(keys.descriptor(PcoinDerivation.CHAIN_EXTERNAL))
        val internal = checksummed(keys.descriptor(PcoinDerivation.CHAIN_INTERNAL))

        onProgress(if (rescanFromTimeSec == null) "importing keys" else "importing keys and rescanning")
        importDescriptors(walletName, external, internal, rescanFromTimeSec)

        onProgress("verifying")
        verify(walletName, expectedAddress)

        val (tx, bal) = summarise(walletName)
        return Result(walletName, expectedAddress, created = created, txCount = tx, balance = bal)
    }

    /**
     * Refuses to import over a wallet that plainly holds a different phrase.
     *
     * Reached only when the node has given a definite "this wallet does not own
     * the address your words derive". A blank wallet left behind by an
     * interrupted setup has no descriptors and is fine to import into; a wallet
     * carrying somebody else's origin is not, because importdescriptors with
     * active=true would deactivate their descriptor and the wallet would stop
     * handing out the addresses their phrase recovers.
     *
     * Mirrors the Windows implementation, which gets this right.
     */
    private fun guardForeignDescriptors(walletName: String, keys: PcoinDerivation.AccountKeys) {
        val existing = existingOrigins(walletName)
            ?: throw InstallException(
                "Could not read what the wallet \"$walletName\" already contains, so nothing was " +
                    "imported into it. Nothing has been changed. Make sure the node is running " +
                    "and try again."
            )
        if (existing.isEmpty()) {
            // A blank wallet: createwallet ran, importdescriptors did not.
            Log.i(TAG, "wallet \"$walletName\" exists but is empty; importing into it")
            return
        }
        val expected = normalizeOrigin(
            PcoinDerivation.originString(keys.masterFingerprintHex, keys.network)
        )
        val foreign = existing.filter { it != expected }
        if (foreign.isNotEmpty()) {
            throw InstallException(
                "The wallet \"$walletName\" already exists on this device and was made from a " +
                    "DIFFERENT recovery phrase. Nothing has been changed and no keys were " +
                    "imported. Its coins are untouched and still spendable."
            )
        }
        // Same origin, but getaddressinfo said the address is not its -- e.g. a
        // half-finished import that never got the ranges in. Re-importing the
        // same origin's descriptors cannot cost anybody anything.
        Log.i(TAG, "wallet \"$walletName\" carries this phrase's origin; re-importing")
    }

    /**
     * Descriptor origins already in a wallet, or null when the node could not be
     * asked.
     *
     * Null rather than an empty list, deliberately: "I do not know what is in
     * this wallet" and "this wallet is empty" lead to opposite decisions, and
     * conflating them lets a failed RPC authorise an import over somebody's
     * existing keys.
     *
     * listdescriptors is called WITHOUT private=true: the origins are all this
     * needs and there is no reason to pull xprvs across the socket to read them.
     */
    private fun existingOrigins(walletName: String): List<String>? = try {
        val r = rpc.call("listdescriptors", wallet = walletName, readTimeoutMs = LONG_TIMEOUT_MS)
            as? JSONObject
        val arr = r?.optJSONArray("descriptors")
        if (arr == null) null else (0 until arr.length())
            .mapNotNull { arr.optJSONObject(it)?.optString("desc") }
            .mapNotNull { originIn(it) }
            .distinct()
    } catch (e: IOException) {
        Log.w(TAG, "listdescriptors: ${Redact.text(e.message)}")
        null
    }

    /**
     * The bracketed origin out of a descriptor: given
     * `wpkh([73c5da0a/84'/9444'/0']xpub…/0/…)` this returns
     * `[73c5da0a/84h/9444h/0h]`.
     */
    private fun originIn(descriptor: String): String? {
        val open = descriptor.indexOf('[')
        if (open < 0) return null
        val close = descriptor.indexOf(']', open)
        if (close < 0) return null
        return normalizeOrigin(descriptor.substring(open, close + 1))
    }

    /** ' and h are the same hardened marker, and the fingerprint is hex. */
    private fun normalizeOrigin(origin: String): String =
        origin.replace('\'', 'h').lowercase()

    /**
     * txcount and total balance, for reporting what a restore actually found.
     *
     * Failure is reported as -1, never as 0: "the node could not be asked" and
     * "this wallet is empty" must not look the same to somebody checking
     * whether their coins came back.
     */
    private fun summarise(walletName: String): Pair<Int, Double> {
        val txCount = try {
            (rpc.call("getwalletinfo", wallet = walletName, readTimeoutMs = LONG_TIMEOUT_MS)
                as? JSONObject)?.optInt("txcount", -1) ?: -1
        } catch (e: IOException) {
            -1
        }
        val balance = try {
            val mine = (rpc.call("getbalances", wallet = walletName, readTimeoutMs = LONG_TIMEOUT_MS)
                as? JSONObject)?.optJSONObject("mine")
            if (mine == null) -1.0 else {
                mine.optDouble("trusted", 0.0) +
                    mine.optDouble("untrusted_pending", 0.0) +
                    mine.optDouble("immature", 0.0)
            }
        } catch (e: IOException) {
            -1.0
        }
        return txCount to balance
    }

    // ------------------------------------------------------------------ step 1

    /**
     * createwallet with blank=true, which is the essential part: it suppresses
     * Core's own random HD seed, so the wallet ends up containing no keys except
     * the ones imported from the phrase.
     *
     * Argument order is positional and unforgiving:
     *   wallet_name, disable_private_keys, blank, passphrase, avoid_reuse,
     *   descriptors, load_on_startup, external_signer
     *
     * @return true if the wallet was created here.
     */
    private fun createBlankWallet(walletName: String): Boolean {
        // listwallets -> loadwallet -> createwallet, in that order. Anything
        // else races bitcoind's own wallet autoload.
        try {
            val loaded = rpc.call("listwallets") as? JSONArray
            if (loaded != null) {
                for (i in 0 until loaded.length()) {
                    if (loaded.optString(i) == walletName) return false
                }
            }
        } catch (e: RpcClient.RpcError) {
            throw InstallException("wallet support unavailable: ${Redact.text(e.message)}")
        }

        try {
            rpc.call("loadwallet", JSONArray().put(walletName), readTimeoutMs = LONG_TIMEOUT_MS)
            return false
        } catch (e: RpcClient.RpcError) {
            Log.i(TAG, "loadwallet \"$walletName\" failed (${e.code}); creating")
        }

        val params = JSONArray()
            .put(walletName)
            .put(false)  // disable_private_keys
            .put(true)   // blank -- no Core-generated HD seed
            .put("")     // passphrase
            .put(false)  // avoid_reuse
            .put(true)   // descriptors
            .put(true)   // load_on_startup
            .put(false)  // external_signer
        try {
            rpc.call("createwallet", params, readTimeoutMs = LONG_TIMEOUT_MS)
        } catch (e: RpcClient.RpcError) {
            if (e.code == RPC_WALLET_ALREADY_EXISTS) return false
            throw InstallException("could not create wallet: ${Redact.text(e.message)}")
        }
        return true
    }

    // ------------------------------------------------------------------ step 2

    /**
     * Appends the checksum importdescriptors demands.
     *
     * ONLY the `checksum` field of getdescriptorinfo is used. The `descriptor`
     * field is documented and implemented as the canonical form WITHOUT private
     * keys -- it comes back as an xpub. Importing that produces a watch-only
     * wallet that looks perfect right up until the day the user tries to send,
     * at which point the money is unreachable. `hasprivatekeys` is asserted for
     * exactly that reason.
     */
    private fun checksummed(descriptor: String): String {
        val info = try {
            rpc.call("getdescriptorinfo", JSONArray().put(descriptor)) as? JSONObject
        } catch (e: RpcClient.RpcError) {
            throw InstallException("descriptor rejected by the node: ${Redact.text(e.message)}")
        } ?: throw InstallException("getdescriptorinfo returned nothing")

        if (!info.optBoolean("hasprivatekeys", false)) {
            throw InstallException(
                "refusing to import: the node reports this descriptor has no private keys, " +
                    "which would create a wallet that can receive but never spend"
            )
        }
        if (!info.optBoolean("isrange", false)) {
            throw InstallException("refusing to import: descriptor is not ranged")
        }
        val checksum = info.optString("checksum")
        if (checksum.isBlank()) throw InstallException("node returned no descriptor checksum")
        return "$descriptor#$checksum"
    }

    // ------------------------------------------------------------------ step 3

    private fun importDescriptors(
        walletName: String,
        external: String,
        internal: String,
        rescanFromTimeSec: Long?,
    ) {
        fun request(desc: String, isInternal: Boolean) = JSONObject()
            .put("desc", desc)
            .put("active", true)
            .put("internal", isInternal)
            .put("range", JSONArray().put(0).put(PcoinDerivation.IMPORT_RANGE_END))
            .put("next_index", 0)
            // "now" makes Core skip scanning entirely for a phrase that has just
            // been generated. A restore passes the genesis time; never 0 or 1,
            // and never a label on the internal descriptor -- ProcessImport
            // throws "Internal addresses should not have a label".
            .put("timestamp", rescanFromTimeSec ?: "now")

        val params = JSONArray().put(
            JSONArray()
                .put(request(external, false))
                .put(request(internal, true))
        )

        val raw = try {
            rpc.call("importdescriptors", params, wallet = walletName, readTimeoutMs = IMPORT_TIMEOUT_MS)
        } catch (e: RpcClient.RpcError) {
            throw InstallException("importdescriptors failed: ${Redact.text(e.message)}")
        }
        val result = raw as? JSONArray
            ?: throw InstallException("importdescriptors returned nothing")

        // importdescriptors reports per-request results and does NOT throw on a
        // partial failure. Importing the external descriptor while silently
        // failing the internal one gives a wallet that can receive but cannot
        // build change -- money-losing, and invisible until the first send.
        if (result.length() != 2) {
            throw InstallException("importdescriptors returned ${result.length()} results, expected 2")
        }
        for (i in 0 until result.length()) {
            val item = result.optJSONObject(i)
            if (item?.optBoolean("success", false) != true) {
                val why = item?.optJSONObject("error")?.optString("message").orEmpty()
                throw InstallException(
                    "descriptor ${if (i == 0) "receive" else "change"} was not imported: " +
                        Redact.text(why).ifBlank { "no reason given" }
                )
            }
        }
    }

    // ------------------------------------------------------------------ step 4

    /**
     * The cross-check that is the whole point.
     *
     * The address the node hands out must be byte-identical to the one the app
     * derived locally from the same phrase. That single comparison is what
     * catches an xpub-instead-of-xprv import, the wrong network's version bytes,
     * and an off-by-one anywhere in the path. If it does not match, nothing is
     * shown to the user and nothing starts mining.
     */
    private fun verify(walletName: String, expectedAddress: String) {
        val walletInfo = rpc.call("getwalletinfo", wallet = walletName, readTimeoutMs = LONG_TIMEOUT_MS)
            as? JSONObject ?: throw InstallException("getwalletinfo returned nothing")
        if (!walletInfo.optBoolean("descriptors", false)) {
            throw InstallException("the node did not create a descriptor wallet")
        }
        if (!walletInfo.optBoolean("private_keys_enabled", false)) {
            throw InstallException("the new wallet has no private keys and could never spend")
        }

        val descriptors = rpc.call("listdescriptors", wallet = walletName, readTimeoutMs = LONG_TIMEOUT_MS)
            as? JSONObject
        val list = descriptors?.optJSONArray("descriptors")
            ?: throw InstallException("listdescriptors returned nothing")
        var activeExternal = 0
        var activeInternal = 0
        for (i in 0 until list.length()) {
            val d = list.optJSONObject(i) ?: continue
            if (!d.optBoolean("active", false)) continue
            if (d.optBoolean("internal", false)) activeInternal++ else activeExternal++
        }
        if (activeExternal < 1 || activeInternal < 1) {
            throw InstallException(
                "wallet has $activeExternal active receive and $activeInternal active change " +
                    "descriptors; it needs at least one of each"
            )
        }

        // The cross-check is getaddressinfo on the LOCALLY derived address, not
        // getnewaddress.
        //
        // getnewaddress would be wrong, and wrong in the worst direction: after
        // a restore the rescan advances the descriptor past every index that
        // already has history, so the node correctly returns a later address
        // than index 0. Comparing that against index 0 would fail the check on
        // exactly the restores that worked -- telling a user with a good phrase
        // and real coins "do not use this wallet".
        //
        // getaddressinfo answers the question that actually matters ("can this
        // wallet spend the address my phrase derives?"), is exact, and advances
        // nothing.
        val info = rpc.call(
            "getaddressinfo",
            JSONArray().put(expectedAddress),
            wallet = walletName,
            readTimeoutMs = LONG_TIMEOUT_MS,
        ) as? JSONObject ?: throw InstallException("getaddressinfo returned nothing")

        val mine = info.optBoolean("ismine", false)
        // Watch-only counts as NOT owned. A wallet built from an xpub reports
        // ismine=true and looks perfectly healthy right up until the first
        // send, which is the precise failure this verification exists for.
        val watchOnly = info.optBoolean("iswatchonly", false)
        val solvable = info.optBoolean("solvable", false)
        if (!mine || watchOnly || !solvable) {
            throw InstallException(
                "the wallet does not recognise the address derived from your recovery phrase " +
                    "(ismine=$mine, watchonly=$watchOnly, solvable=$solvable). " +
                    "Nothing has been started. Do not use this wallet."
            )
        }

        // Stronger still when the node reports it: proof the node derived that
        // address at the same path, not merely that it happens to own it.
        val path = info.optString("hdkeypath").takeIf { it.isNotBlank() }
        if (path != null && normalizePath(path) != EXPECTED_PAYOUT_PATH) {
            throw InstallException(
                "the node derived the payout address at ${normalizePath(path)}, " +
                    "not $EXPECTED_PAYOUT_PATH"
            )
        }
    }

    /** "m/84'/9444'/0'/0/0" and "m/84h/9444h/0h/0/0" are the same path. */
    private fun normalizePath(path: String): String = path.replace('\'', 'h')

    /**
     * getaddressinfo, scoped to [walletName].
     *
     * Wallet-scoped on purpose and always explicitly: with two wallets loaded,
     * asking the wrong one produces a confident, wrong "no".
     *
     * Watch-only counts as NOT owned. A wallet that can see an address but not
     * spend from it is precisely the failure this whole verification exists to
     * catch, and it would otherwise report ismine=true and look fine.
     *
     * @return true/false when the node answered, null when it could not be
     *   asked. The caller must NOT treat null as "no": RpcError and NotReady
     *   both extend IOException, so a timed-out or errored call used to be
     *   indistinguishable from a definitive no -- and a transient RPC failure
     *   therefore authorised an import over an existing wallet.
     */
    private fun walletOwns(walletName: String, address: String): Boolean? = try {
        val info = rpc.call(
            "getaddressinfo",
            JSONArray().put(address),
            wallet = walletName,
            readTimeoutMs = LONG_TIMEOUT_MS,
        ) as? JSONObject
        if (info == null) null else {
            info.optBoolean("ismine", false) &&
                !info.optBoolean("iswatchonly", false) &&
                info.optBoolean("solvable", true)
        }
    } catch (e: IOException) {
        Log.w(TAG, "getaddressinfo: ${Redact.text(e.message)}")
        null
    }

    /**
     * Rescan progress, for the restore screen. 0..1, or null when not scanning.
     *
     * Polled from a different thread than the blocking importdescriptors call:
     * a rescan with no visible progress reads as a hung app, and a user who
     * force-quits mid-rescan is a user who thinks their money is gone.
     */
    fun scanProgress(walletName: String): Double? = try {
        val info = rpc.call("getwalletinfo", wallet = walletName, readTimeoutMs = 10_000) as? JSONObject
        val scanning = info?.opt("scanning")
        when (scanning) {
            is JSONObject -> scanning.optDouble("progress", 0.0)
            else -> null
        }
    } catch (e: IOException) {
        null
    }

    companion object {
        private const val TAG = "PCoinInstaller"

        /** RPC_WALLET_ALREADY_EXISTS in rpc/protocol.h. */
        private const val RPC_WALLET_ALREADY_EXISTS = -4

        /**
         * The payout path, in the "h" spelling getaddressinfo uses for keys
         * imported from a descriptor written with "h".
         */
        private const val EXPECTED_PAYOUT_PATH = "m/84h/9444h/0h/0/0"

        private const val LONG_TIMEOUT_MS = 60_000

        /**
         * A restore rescans the whole chain inside this one call. PCoin is tiny
         * today, but the timeout is generous because the alternative -- timing
         * out on a rescan that is actually progressing -- would leave the user
         * staring at a failure for a wallet that was in fact being built.
         */
        private const val IMPORT_TIMEOUT_MS = 600_000
    }
}
