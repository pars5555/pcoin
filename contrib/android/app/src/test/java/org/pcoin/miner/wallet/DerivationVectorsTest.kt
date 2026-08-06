package org.pcoin.miner.wallet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The published test vectors, run on a plain JVM.
 *
 * This is the safety net for the whole feature. Every layer below the UI --
 * RIPEMD-160, PBKDF2-HMAC-SHA512, secp256k1, BIP32 serialisation, bech32 -- was
 * written from the specification for this app, and a single wrong constant in
 * any of them produces a recovery phrase that silently restores the wrong
 * wallet. The BIP84 case at the bottom exercises all of them at once and
 * compares against addresses published by the BIP itself.
 */
class DerivationVectorsTest {

    private val wordlistFile = File("src/main/assets/bip39/english.txt")

    // trim() each line, exactly as WordList.load does in production. Without it
    // these tests are line-ending fragile: a checkout that hands over CRLF puts
    // a trailing \r on all 2048 words and every vector below fails with a
    // baffling diff. The real defence is the -text rule in .gitattributes;
    // matching production's parsing here means the tests cannot disagree with
    // the app about what a wordlist is.
    private fun bip39(): Bip39 =
        Bip39(wordlistFile.readText().split("\n").map { it.trim() }.filter { it.isNotEmpty() })

    // ---------------------------------------------------------------- wordlist

    @Test
    fun wordlistMatchesPublishedDigest() {
        val bytes = wordlistFile.readBytes()
        assertEquals(2048, bytes.toString(Charsets.UTF_8).split("\n").filter { it.isNotBlank() }.size)
        assertEquals(Bip39.WORDLIST_SHA256, Hashes.sha256(bytes).toHex())
    }

    // -------------------------------------------------------------- ripemd160

    @Test
    fun ripemd160SpecVectors() {
        fun rip(s: String) = Hashes.ripemd160(s.toByteArray(Charsets.US_ASCII)).toHex()
        assertEquals("9c1185a5c5e9fc54612808977ee8f548b2258d31", rip(""))
        assertEquals("0bdc9d2d256b3ee9daae347be6f4dc835a467ffe", rip("a"))
        assertEquals("8eb208f7e05d987a9b044a8e98c6b087f15a0bfc", rip("abc"))
        assertEquals("5d0689ef49d2fae572b881b123a85ffa21595f36", rip("message digest"))
        assertEquals(
            "f71c27109c692c1b56bbdceb5b9d2865b3708dbc",
            rip("abcdefghijklmnopqrstuvwxyz"),
        )
        assertEquals(
            "b0e20b6e3116640286ed3a87a5713079b21f5189",
            rip("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"),
        )
        // Multi-block, exercises the padding boundary.
        assertEquals(
            "9b752e45573d4b39f4dbd3323cab82bf63326bfb",
            rip("1234567890".repeat(8)),
        )
    }

    // ------------------------------------------------------------------ bip39

    /** (entropy hex, mnemonic, seed hex with the reference "TREZOR" passphrase). */
    private val bip39Vectors = listOf(
        Triple(
            "00000000000000000000000000000000",
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04",
        ),
        Triple(
            "80808080808080808080808080808080",
            "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
            "d71de856f81a8acc65e6fc851a38d4d7ec216fd0796d0a6827a3ad6ed5511a30fa280f12eb2e47ed2ac03b5c462a0358d18d69fe4f985ec81778c1b370b652a8",
        ),
        Triple(
            "0000000000000000000000000000000000000000000000000000000000000000",
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
            "bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd3097170af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8",
        ),
    )

    @Test
    fun bip39ReferenceVectors() {
        val b = bip39()
        // The app itself always uses an empty passphrase (see Bip39's notes);
        // "TREZOR" is used here only because that is what the vectors publish.
        for ((hex, mnemonic, seedHex) in bip39Vectors) {
            assertEquals("entropy -> mnemonic", mnemonic, String(b.fromEntropy(hexToBytes(hex))))
            assertEquals(Bip39.Validation.Ok, b.validate(Bip39.splitWords(mnemonic)))
            assertEquals(
                "mnemonic -> seed",
                seedHex,
                b.toSeed(mnemonic.toCharArray(), "TREZOR").toHex(),
            )
        }
    }

    @Test
    fun bip39ChecksumRejectsWrongOrder() {
        val b = bip39()
        // All twelve words are real; two are swapped. This must fail on the
        // checksum, and must NOT be reported as an unknown word.
        val bad = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about abandon"
        assertEquals(Bip39.Validation.ChecksumFailed, b.validate(Bip39.splitWords(bad)))
    }

    @Test
    fun bip39ReportsUnknownWordPositions() {
        val b = bip39()
        val bad = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abuot"
        val v = b.validate(Bip39.splitWords(bad))
        assertTrue(v is Bip39.Validation.UnknownWords)
        assertEquals(listOf(11), (v as Bip39.Validation.UnknownWords).positions)
    }

    @Test
    fun generatedPhrasesValidateAndDiffer() {
        val b = bip39()
        val seen = HashSet<String>()
        repeat(25) {
            val m = b.generate(12)
            assertEquals(12, Bip39.splitWords(String(m)).size)
            assertEquals(Bip39.Validation.Ok, b.validate(Bip39.splitWords(String(m))))
            seen.add(String(m))
        }
        assertEquals("SecureRandom produced a repeat", 25, seen.size)
        repeat(3) {
            val m = b.generate(24)
            assertEquals(24, Bip39.splitWords(String(m)).size)
            assertEquals(Bip39.Validation.Ok, b.validate(Bip39.splitWords(String(m))))
        }
    }

    @Test
    fun normalizationCollapsesRealWorldPasteDamage() {
        // Leading blanks, a tab, a non-breaking space, capitals and a trailing
        // newline: exactly what a paste out of a notes app can contain, and
        // every one of them silently produces a different seed if it survives
        // into PBKDF2.
        val tab = 9.toChar()
        val nbsp = 160.toChar()
        val lf = 10.toChar()
        val ugly = "  Abandon" + tab + "abandon" + nbsp + "abandon abandon " +
            "abandon abandon abandon abandon abandon abandon abandon ABOUT " + lf
        assertEquals(12, Bip39.splitWords(ugly).size)
        assertEquals(Bip39.Validation.Ok, bip39().validate(Bip39.splitWords(ugly)))
    }

    // ------------------------------------------------------------------ bip32

    private val xprvVersion = byteArrayOf(0x04, 0x88.toByte(), 0xAD.toByte(), 0xE4.toByte())

    private fun xprv(k: Bip32.ExtendedKey) = k.serialize(xprvVersion)

    @Test
    fun bip32Vector1() {
        val m = Bip32.fromSeed(hexToBytes("000102030405060708090a0b0c0d0e0f"))
        assertEquals(
            "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi",
            xprv(m),
        )
        assertEquals("3442193e", m.fingerprint.toHex())
        assertEquals(
            "xprv9uHRZZhk6KAJC1avXpDAp4MDc3sQKNxDiPvvkX8Br5ngLNv1TxvUxt4cV1rGL5hj6KCesnDYUhd7oWgT11eZG7XnxHrnYeSvkzY7d2bhkJ7",
            xprv(Bip32.derivePath(m, Bip32.parsePath("m/0'"))),
        )
        assertEquals(
            "xprv9wTYmMFdV23N2TdNG573QoEsfRrWKQgWeibmLntzniatZvR9BmLnvSxqu53Kw1UmYPxLgboyZQaXwTCg8MSY3H2EU4pWcQDnRnrVA1xe8fs",
            xprv(Bip32.derivePath(m, Bip32.parsePath("m/0'/1"))),
        )
        assertEquals(
            "xprv9z4pot5VBttmtdRTWfWQmoH1taj2axGVzFqSb8C9xaxKymcFzXBDptWmT7FwuEzG3ryjH4ktypQSAewRiNMjANTtpgP4mLTj34bhnZX7UiM",
            xprv(Bip32.derivePath(m, Bip32.parsePath("m/0'/1/2'"))),
        )
        assertEquals(
            "xprvA41z7zogVVwxVSgdKUHDy1SKmdb533PjDz7J6N6mV6uS3ze1ai8FHa8kmHScGpWmj4WggLyQjgPie1rFSruoUihUZREPSL39UNdE3BBDu76",
            xprv(Bip32.derivePath(m, Bip32.parsePath("m/0'/1/2'/2/1000000000"))),
        )
        // "h" and "'" must mean the same thing; the descriptor strings use "h".
        assertEquals(
            xprv(Bip32.derivePath(m, Bip32.parsePath("m/0'/1/2'"))),
            xprv(Bip32.derivePath(m, Bip32.parsePath("m/0h/1/2h"))),
        )
    }

    @Test
    fun bip32Vector3LeadingZeros() {
        // Chosen by the BIP specifically to catch implementations that strip a
        // leading zero byte when serialising a key.
        val m = Bip32.fromSeed(
            hexToBytes(
                "4b381541583be4423346c643850da4b320e46a87ae3d2a4e6da11eba819cd4acba45d239319ac14f863b8d5ab5a0d0c64d2e8a1e7d1457df2e5a3c51c73235be"
            )
        )
        assertEquals(
            "xprv9s21ZrQH143K25QhxbucbDDuQ4naNntJRi4KUfWT7xo4EKsHt2QJDu7KXp1A3u7Bi1j8ph3EGsZ9Xvz9dGuVrtHHs7pXeTzjuxBrCmmhgC6",
            xprv(m),
        )
        assertEquals(
            "xprv9uPDJpEQgRQfDcW7BkF7eTya6RPxXeJCqCJGHuCJ4GiRVLzkTXBAJMu2qaMWPrS7AANYqdq6vcBcBUdJCVVFceUvJFjaPdGZ2y9WACViL4L",
            xprv(Bip32.derivePath(m, Bip32.parsePath("m/0'"))),
        )
    }

    // ------------------------------------------------------- bip84, end to end

    /**
     * BIP84's own vector. Runs the entire stack: NFKD, PBKDF2-HMAC-SHA512,
     * HMAC-SHA512 master, hardened and non-hardened CKDpriv, secp256k1 scalar
     * multiplication, SHA-256, RIPEMD-160 and bech32 -- and compares against
     * addresses published in the BIP. If this passes, the derivation is right.
     */
    @Test
    fun bip84AddressVectors() {
        val b = bip39()
        val mnemonic =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        val master = Bip32.fromSeed(b.toSeed(mnemonic.toCharArray()))

        fun addr(path: String): String {
            val k = Bip32.derivePath(master, Bip32.parsePath(path))
            return Bech32.encodeP2wpkh("bc", Hashes.hash160(k.publicKey))
        }

        assertEquals("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", addr("m/84'/0'/0'/0/0"))
        assertEquals("bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g", addr("m/84'/0'/0'/0/1"))
        assertEquals("bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el", addr("m/84'/0'/0'/1/0"))
    }

    // ------------------------------------------------------------ pcoin paths

    @Test
    fun pcoinPathDiffersFromBitcoinForTheSamePhrase() {
        val b = bip39()
        val mnemonic =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        val master = Bip32.fromSeed(b.toSeed(mnemonic.toCharArray()))

        val btc = Bip32.derivePath(master, Bip32.parsePath("m/84'/0'/0'/0/0"))
        val pcn = Bip32.derivePath(master, Bip32.parsePath("m/84'/9444'/0'/0/0"))

        // PCoin kept Bitcoin's xprv version bytes, so coin type 9444 is the ONLY
        // thing that stops one phrase producing byte-identical keys on both
        // chains. If this ever passes as equal, the wallet is a key-leak.
        assertNotEquals(btc.publicKey.toHex(), pcn.publicKey.toHex())
    }

    @Test
    fun pcoinAccountKeysAreSelfConsistent() {
        val b = bip39()
        val mnemonic =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        val keys = PcoinDerivation.accountKeys(
            b, mnemonic.toCharArray(), PcoinDerivation.Network.MAINNET,
        )

        // Master fingerprint is the one BIP32 vector-style value we can check
        // against an independent path: it is derived from the same master key
        // the BIP84 test above used.
        val master = Bip32.fromSeed(b.toSeed(mnemonic.toCharArray()))
        assertEquals(master.fingerprint.toHex(), keys.masterFingerprintHex)

        // The account xprv the node is given must reproduce, on its own, the
        // exact address derived from the root. This is the same cross-check the
        // installer performs against the live node -- if these two disagree, no
        // amount of node-side success means the phrase can recover the money.
        val fromRoot = Bech32.encodeP2wpkh(
            "pc",
            Hashes.hash160(Bip32.derivePath(master, Bip32.parsePath("m/84'/9444'/0'/0/0")).publicKey),
        )
        assertEquals(fromRoot, keys.payoutAddress())
        assertTrue(keys.payoutAddress().startsWith("pc1q"))

        val desc = keys.descriptor(PcoinDerivation.CHAIN_EXTERNAL)
        assertTrue(desc.startsWith("wpkh([${keys.masterFingerprintHex}/84h/9444h/0h]xprv"))
        assertTrue(desc.endsWith("/0/*)"))
        assertTrue(keys.descriptor(PcoinDerivation.CHAIN_INTERNAL).endsWith("/1/*)"))
    }

    @Test
    fun regtestUsesCoinTypeOneAndTprv() {
        val b = bip39()
        val keys = PcoinDerivation.accountKeys(
            b,
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about".toCharArray(),
            PcoinDerivation.Network.REGTEST,
        )
        // Test coins and real coins must never share keys.
        assertTrue(keys.descriptor(0).contains("/84h/1h/0h]"))
        assertTrue(keys.descriptor(0).contains("]tprv"))
        assertTrue(keys.payoutAddress().startsWith("pcrt1q"))
    }
}
