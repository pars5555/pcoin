package org.pcoin.miner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * What the pool picker will store when someone types a custom pool.
 *
 * The stored string is where this phone's work goes, and MinerService restarts
 * the miner whenever it differs from what the node reports it is mining for. So
 * two things matter: junk must never be stored, and a good pool must be stored
 * in exactly the form the node prints back (PoolClient::Describe:
 * `host + ":" + std::to_string(port)`), or the miner restarts every tick.
 */
class PoolAddressTest {

    private fun problem(raw: String): PoolAddress.Problem? =
        (PoolAddress.parse(raw) as? PoolAddress.Result.Invalid)?.problem

    // ------------------------------------------------------------- accepted

    @Test
    fun `a host name and port is accepted as typed`() {
        assertEquals("pool.pc.am:3333", PoolAddress.normalize("pool.pc.am:3333"))
    }

    @Test
    fun `an IPv4 address and port is accepted as typed`() {
        assertEquals("198.244.169.49:3333", PoolAddress.normalize("198.244.169.49:3333"))
    }

    @Test
    fun `both presets are valid and already in stored form`() {
        assertEquals(PoolAddress.PCOIN_POOL, PoolAddress.normalize(PoolAddress.PCOIN_POOL))
        assertEquals(PoolAddress.PCOIN_POOL_2, PoolAddress.normalize(PoolAddress.PCOIN_POOL_2))
    }

    @Test
    fun `the port range is 1 to 65535 inclusive`() {
        assertEquals("pool.pc.am:1", PoolAddress.normalize("pool.pc.am:1"))
        assertEquals("pool.pc.am:65535", PoolAddress.normalize("pool.pc.am:65535"))
        assertNull(PoolAddress.normalize("pool.pc.am:65536"))
    }

    @Test
    fun `surrounding whitespace from a paste is dropped`() {
        assertEquals("pool.pc.am:3333", PoolAddress.normalize("  pool.pc.am:3333\n"))
    }

    @Test
    fun `a single-label host name is a host name`() {
        assertEquals("localhost:3333", PoolAddress.normalize("localhost:3333"))
        assertEquals("host:1", PoolAddress.normalize("host:1"))
    }

    @Test
    fun `labels may hold digits and inner hyphens`() {
        assertEquals("pool-2.example.org:3333", PoolAddress.normalize("pool-2.example.org:3333"))
        assertEquals("123.example.org:3333", PoolAddress.normalize("123.example.org:3333"))
    }

    // ----------------------------------------------- stored in the node's form

    @Test
    fun `capitals are folded so a preset typed in capitals is the preset`() {
        assertEquals(PoolAddress.PCOIN_POOL, PoolAddress.normalize("POOL.PC.AM:3333"))
        assertEquals(PoolAddress.Choice.PCOIN, PoolAddress.choiceFor(PoolAddress.normalize("Pool.Pc.Am:3333")!!))
    }

    @Test
    fun `a leading zero in the port is dropped, as the node prints it`() {
        // Core's parser reads 03333 as 3333 and Describe() prints 3333. Stored
        // as typed, the two would never compare equal and MinerService would
        // restart the miner on every tick.
        assertEquals("pool.pc.am:3333", PoolAddress.normalize("pool.pc.am:03333"))
    }

    @Test
    fun `a signed port is refused, though Core would accept it`() {
        assertEquals(PoolAddress.Problem.BAD_PORT, problem("pool.pc.am:+3333"))
    }

    // ------------------------------------------------------------- refused

    @Test
    fun `no port is refused, there is no default port`() {
        assertEquals(PoolAddress.Problem.NO_PORT, problem("pool.pc.am"))
    }

    @Test
    fun `no host is refused`() {
        assertEquals(PoolAddress.Problem.BAD_HOST, problem(":3333"))
    }

    @Test
    fun `port 0 is refused`() {
        assertEquals(PoolAddress.Problem.BAD_PORT, problem("host:0"))
        assertEquals(PoolAddress.Problem.BAD_PORT, problem("host:0000"))
    }

    @Test
    fun `a port above 65535 is refused`() {
        assertEquals(PoolAddress.Problem.BAD_PORT, problem("host:70000"))
        assertEquals(PoolAddress.Problem.BAD_PORT, problem("host:99999999999999999999"))
    }

    @Test
    fun `a URL scheme is refused`() {
        assertEquals(PoolAddress.Problem.SCHEME, problem("http://x:1"))
        assertEquals(PoolAddress.Problem.SCHEME, problem("stratum+tcp://pool.pc.am:3333"))
    }

    @Test
    fun `whitespace inside is refused`() {
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("a b:1"))
        assertEquals(PoolAddress.Problem.BAD_PORT, problem("pool.pc.am: 3333"))
    }

    @Test
    fun `an empty field is refused, solo is its own choice`() {
        assertEquals(PoolAddress.Problem.EMPTY, problem(""))
        assertEquals(PoolAddress.Problem.EMPTY, problem("   "))
    }

    @Test
    fun `an empty port is refused`() {
        assertEquals(PoolAddress.Problem.BAD_PORT, problem("pool.pc.am:"))
    }

    @Test
    fun `anything after the port is refused`() {
        assertEquals(PoolAddress.Problem.BAD_PORT, problem("pool.pc.am:3333/"))
        assertEquals(PoolAddress.Problem.BAD_PORT, problem("pool.pc.am:3333x"))
    }

    @Test
    fun `IPv6 and extra colons are refused`() {
        assertEquals(PoolAddress.Problem.TOO_MANY_COLONS, problem("[::1]:3333"))
        assertEquals(PoolAddress.Problem.TOO_MANY_COLONS, problem("a:b:3333"))
    }

    @Test
    fun `a digits-and-dots host must be a real IPv4 address`() {
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("256.1.1.1:3333"))
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("1.2.3:3333"))
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("1.2.3.4.5:3333"))
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("3333:3333"))
        // Octal to some resolvers, decimal to others: refused, not guessed.
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("010.1.1.1:3333"))
        assertEquals("0.0.0.0:3333", PoolAddress.normalize("0.0.0.0:3333"))
    }

    @Test
    fun `a name ending in an all-digit label is refused`() {
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("pool.123:3333"))
    }

    @Test
    fun `malformed labels are refused`() {
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("-pool.pc.am:3333"))
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("pool-.pc.am:3333"))
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("pool..pc.am:3333"))
        assertEquals(PoolAddress.Problem.BAD_HOST, problem(".pool.pc.am:3333"))
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("pool.pc.am.:3333"))
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("pool_1.pc.am:3333"))
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("user@pool.pc.am:3333"))
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("pool.pc.am/x:3333"))
    }

    @Test
    fun `label and name lengths are bounded`() {
        val label63 = "a".repeat(63)
        assertEquals("$label63.example:3333", PoolAddress.normalize("$label63.example:3333"))
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("${"a".repeat(64)}.example:3333"))
        // 4 x 63 + 3 dots = 255 characters: every label legal, the name too long.
        val tooLong = List(4) { label63 }.joinToString(".")
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("$tooLong:3333"))
    }

    @Test
    fun `non-ASCII look-alikes are refused, not folded`() {
        // Cyrillic o in "pool".
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("pооl.pc.am:3333"))
        // The Kelvin sign lower-cases to an ASCII k in Java.
        assertEquals(PoolAddress.Problem.BAD_HOST, problem("Key.pc.am:3333"))
        // Arabic-Indic digits pass Char.isDigit(); they are not a port.
        assertEquals(PoolAddress.Problem.BAD_PORT, problem("pool.pc.am:٣٣٣٣"))
    }

    // ------------------------------------------------------ picker mapping

    @Test
    fun `the stored setting maps to the right choice`() {
        assertEquals(PoolAddress.Choice.SOLO, PoolAddress.choiceFor(""))
        assertEquals(PoolAddress.Choice.PCOIN, PoolAddress.choiceFor("pool.pc.am:3333"))
        assertEquals(PoolAddress.Choice.PCOIN_2, PoolAddress.choiceFor("pool2.pc.am:3333"))
        assertEquals(PoolAddress.Choice.CUSTOM, PoolAddress.choiceFor("198.244.169.49:3333"))
    }

    @Test
    fun `a new install's default is the recommended pool`() {
        assertEquals(PoolAddress.Choice.PCOIN, PoolAddress.choiceFor(Prefs.DEFAULT_POOL))
    }
}
