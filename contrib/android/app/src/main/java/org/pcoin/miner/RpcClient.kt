package org.pcoin.miner

import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * Minimal JSON-RPC client for a locally running PCoin node.
 *
 * Talking HTTP to 127.0.0.1 rather than shelling out to bitcoin-cli:
 *  - no process spawn every 3 seconds,
 *  - batch requests fetch every statistic in one round trip,
 *  - structured JSON instead of scraped text,
 *  - "node not up yet" is a clean, typed condition ([NotReady]) instead of a
 *    non-zero exit code that has to be pattern-matched.
 *
 * Authentication uses the .cookie file bitcoind writes into the datadir, so no
 * password ever has to be generated, stored or displayed.
 *
 * Every method here does blocking I/O. Never call it from the main thread.
 */
class RpcClient(private val dataDir: File, val port: Int = DEFAULT_RPC_PORT) {

    /**
     * The node is not answering yet: connection refused, or HTTP 503 while the
     * RPC layer is still warming up (loading block index / verifying blocks).
     * [warmup] distinguishes the two: warmup means a node IS there and our
     * credentials were accepted, it is just not ready to serve calls.
     */
    class NotReady(message: String, val warmup: Boolean = false) : IOException(message)

    /**
     * Something is listening on the RPC port but rejected our cookie. In
     * practice this means a different PCoin node owns the port -- typically one
     * started by hand from /data/local/tmp. We must NOT start a second node.
     */
    class AuthFailed(message: String) : IOException(message)

    /** The node answered and returned a JSON-RPC error object. */
    class RpcError(val code: Int, message: String) : IOException(message)

    private fun cookieAuth(): String {
        val f = File(dataDir, COOKIE_FILE)
        val text = try {
            if (!f.isFile) throw NotReady("RPC cookie not written yet")
            f.readText().trim()
        } catch (e: NotReady) {
            throw e
        } catch (e: IOException) {
            throw NotReady("RPC cookie unreadable: ${e.message}")
        }
        if (text.isEmpty()) throw NotReady("RPC cookie is empty")
        return "Basic " + Base64.encodeToString(text.toByteArray(StandardCharsets.UTF_8), Base64.NO_WRAP)
    }

    /** True if anything at all is accepting TCP connections on the RPC port. */
    fun isPortOpen(timeoutMs: Int = 800): Boolean = try {
        Socket().use { s ->
            s.connect(InetSocketAddress("127.0.0.1", port), timeoutMs)
            true
        }
    } catch (e: IOException) {
        false
    }

    /**
     * Single JSON-RPC call.
     *
     * @param wallet wallet name to scope the call to, or null for the node-level
     *   endpoint. Wallet RPCs (getbalances, getnewaddress) need this.
     * @return the "result" value: JSONObject, JSONArray, String, Number,
     *   Boolean, or null.
     */
    fun call(
        method: String,
        params: JSONArray = JSONArray(),
        wallet: String? = null,
        readTimeoutMs: Int = DEFAULT_READ_TIMEOUT_MS,
    ): Any? {
        val body = JSONObject()
            .put("jsonrpc", "1.0")
            .put("id", method)
            .put("method", method)
            .put("params", params)
            .toString()

        val text = post(body, wallet, readTimeoutMs)
        val obj = try {
            JSONObject(text)
        } catch (e: Exception) {
            throw NotReady("RPC returned non-JSON (${text.take(120)})")
        }
        return unwrap(obj, method)
    }

    /**
     * Batch several parameter-less calls in one HTTP round trip.
     *
     * @return method name -> result. A method whose individual call errored maps
     *   to null rather than failing the whole batch, because a wallet RPC can
     *   legitimately fail (no wallet loaded yet) while the chain RPCs succeed.
     *   Transport-level problems still throw.
     */
    fun batch(
        methods: List<String>,
        wallet: String? = null,
        readTimeoutMs: Int = DEFAULT_READ_TIMEOUT_MS,
    ): Map<String, Any?> {
        if (methods.isEmpty()) return emptyMap()
        val arr = JSONArray()
        methods.forEachIndexed { i, m ->
            arr.put(
                JSONObject()
                    .put("jsonrpc", "1.0")
                    .put("id", i)
                    .put("method", m)
                    .put("params", JSONArray())
            )
        }

        val text = post(arr.toString(), wallet, readTimeoutMs)
        val responses = try {
            JSONArray(text)
        } catch (e: Exception) {
            throw NotReady("RPC batch returned non-JSON (${text.take(120)})")
        }

        val out = LinkedHashMap<String, Any?>()
        methods.forEach { out[it] = null }
        for (i in 0 until responses.length()) {
            val item = responses.optJSONObject(i) ?: continue
            val idx = item.opt("id")
            val name = when (idx) {
                is Int -> methods.getOrNull(idx)
                is Number -> methods.getOrNull(idx.toInt())
                is String -> idx.toIntOrNull()?.let { methods.getOrNull(it) }
                else -> null
            } ?: continue
            out[name] = try {
                unwrap(item, name)
            } catch (e: RpcError) {
                Log.d(TAG, "batch item $name failed: ${e.message}")
                null
            }
        }
        return out
    }

    /** One call inside a [batchCalls] request. */
    data class Req(val method: String, val params: JSONArray = JSONArray())

    /**
     * Batch several calls WITH parameters in one HTTP round trip.
     *
     * [batch] above keys its results by method name, which cannot work when the
     * same method is called several times with different arguments -- exactly
     * what maturity vetting needs (`gettransaction` once per candidate txid).
     * This variant returns results positionally instead.
     *
     * A call that errored maps to null in its slot rather than failing the whole
     * batch: one unknown txid must not cost us the answers for the others.
     * Transport-level problems still throw.
     *
     * @return one entry per request, in the order given.
     */
    fun batchCalls(
        calls: List<Req>,
        wallet: String? = null,
        readTimeoutMs: Int = DEFAULT_READ_TIMEOUT_MS,
    ): List<Any?> {
        if (calls.isEmpty()) return emptyList()
        val arr = JSONArray()
        calls.forEachIndexed { i, c ->
            arr.put(
                JSONObject()
                    .put("jsonrpc", "1.0")
                    .put("id", i)
                    .put("method", c.method)
                    .put("params", c.params)
            )
        }

        val text = post(arr.toString(), wallet, readTimeoutMs)
        val responses = try {
            JSONArray(text)
        } catch (e: Exception) {
            throw NotReady("RPC batch returned non-JSON (${text.take(120)})")
        }

        // Responses may come back in any order, so the id is what places them,
        // never the array index.
        val out = arrayOfNulls<Any?>(calls.size)
        for (i in 0 until responses.length()) {
            val item = responses.optJSONObject(i) ?: continue
            val idx = when (val id = item.opt("id")) {
                is Int -> id
                is Number -> id.toInt()
                is String -> id.toIntOrNull()
                else -> null
            } ?: continue
            if (idx !in calls.indices) continue
            out[idx] = try {
                unwrap(item, calls[idx].method)
            } catch (e: RpcError) {
                Log.d(TAG, "batch item ${calls[idx].method} failed: ${e.message}")
                null
            }
        }
        return out.toList()
    }

    private fun unwrap(obj: JSONObject, method: String): Any? {
        val err = obj.opt("error")
        if (err != null && err != JSONObject.NULL) {
            val eo = err as? JSONObject
            val code = eo?.optInt("code", 0) ?: 0
            val msg = eo?.optString("message") ?: err.toString()
            throw RpcError(code, "$method: $msg")
        }
        val result = obj.opt("result")
        return if (result == JSONObject.NULL) null else result
    }

    private fun post(body: String, wallet: String?, readTimeoutMs: Int): String {
        val path = if (wallet == null) "/" else "/wallet/" + URLEncoder.encode(wallet, "UTF-8")
        // Auth is resolved before opening the socket so a missing cookie is
        // reported as NotReady instead of a confusing connection error.
        val auth = cookieAuth()

        var conn: HttpURLConnection? = null
        try {
            conn = (URL("http://127.0.0.1:$port$path").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MS
                setReadTimeout(readTimeoutMs)
                doOutput = true
                useCaches = false
                setRequestProperty("Authorization", auth)
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Connection", "close")
            }
            conn.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }

            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() } ?: ""

            when {
                code == 401 || code == 403 ->
                    throw AuthFailed(
                        "RPC on port $port rejected our cookie (HTTP $code). " +
                            "Another PCoin node is probably already using this port."
                    )
                // Warmup: auth already passed, so this is our node, just not ready.
                code == 503 -> throw NotReady(warmupMessage(text), warmup = true)
                text.isBlank() -> throw NotReady("RPC HTTP $code with empty body")
            }
            return text
        } catch (e: NotReady) {
            throw e
        } catch (e: AuthFailed) {
            throw e
        } catch (e: RpcError) {
            throw e
        } catch (e: IOException) {
            // Connection refused / reset / timeout: node is down or still binding.
            throw NotReady("RPC unreachable on port $port: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            conn?.disconnect()
        }
    }

    /** bitcoind's 503 body is a JSON-RPC error whose message is the warmup phase. */
    private fun warmupMessage(text: String): String {
        val fallback = "RPC warming up"
        if (text.isBlank()) return fallback
        return try {
            val msg = JSONObject(text).optJSONObject("error")?.optString("message")
            if (msg.isNullOrBlank()) fallback else msg
        } catch (e: Exception) {
            text.trim().take(120).ifEmpty { fallback }
        }
    }

    companion object {
        const val TAG = "PCoinRpc"

        /**
         * PCoin mainnet RPC port. Chosen in chainparamsbase.cpp as P2P port - 1
         * (9444 - 1), because P2P + 1 is reserved for the Tor onion listener.
         *
         * Deliberately NOT overridden to some private port: if a second PCoin
         * node is already on 9443, we want bitcoind to fail loudly at bind time
         * rather than quietly run a second node with a second 256 MiB RandomX
         * cache on the user's phone.
         */
        const val DEFAULT_RPC_PORT = 9443

        const val COOKIE_FILE = ".cookie"
        private const val CONNECT_TIMEOUT_MS = 4_000
        private const val DEFAULT_READ_TIMEOUT_MS = 20_000
    }
}
