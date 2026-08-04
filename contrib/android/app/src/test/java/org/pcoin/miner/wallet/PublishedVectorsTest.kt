package org.pcoin.miner.wallet

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * The test vectors published in PCOIN.md, pinned against the implementation.
 *
 * Publishing vectors is what turns "any future wallet can restore these words"
 * from a claim into something checkable. That only holds if the numbers in the
 * document are the numbers this code actually produces, so they are asserted
 * here: change anything in the derivation and this test fails, which is exactly
 * the moment someone must go and look at the published document.
 *
 * Every value below was independently reproduced by a separate implementation
 * before being written down, so this is a two-implementation agreement rather
 * than a snapshot of whatever the code happened to do.
 *
 * The mnemonic is BIP39's all-zero-entropy phrase: public, famous, and swept
 * within seconds of anything being sent to it. It is a BURN PHRASE. Never put
 * value on it.
 */
class PublishedVectorsTest {

    private val burnPhrase =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

    private fun bip39(): Bip39 = Bip39(
        File("src/main/assets/bip39/english.txt").readText()
            .split("\n").filter { it.isNotBlank() }
    )

    @Test
    fun publishedMainnetVectors() {
        val b = bip39()
        val seed = b.toSeed(burnPhrase.toCharArray())
        val master = Bip32.fromSeed(seed)
        val keys = PcoinDerivation.accountKeys(
            b, burnPhrase.toCharArray(), PcoinDerivation.Network.MAINNET,
        )

        assertEquals(
            "seed",
            "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1" +
                "9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4",
            seed.toHex(),
        )
        assertEquals(
            "master xprv",
            "xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu",
            master.serialize(MAINNET_XPRV),
        )
        assertEquals("master fingerprint", "73c5da0a", keys.masterFingerprintHex)
        assertEquals(
            "account xprv at m/84'/9444'/0'",
            "xprv9y14Hos54MVJgZi4fDbHMeHQznnF9PCiwjtq5yCv6YKF1nCBFDSzHRtXHxqCWKy4EE5VXRJDdKcyfpSgrrTKKXJLvkPqWfpcLAXQtZcMRwL",
            keys.accountXprv(),
        )

        assertEquals(
            "external descriptor",
            "wpkh([73c5da0a/84h/9444h/0h]" + keys.accountXprv() + "/0/" + STAR + ")",
            keys.descriptor(PcoinDerivation.CHAIN_EXTERNAL),
        )
        assertEquals(
            "internal descriptor",
            "wpkh([73c5da0a/84h/9444h/0h]" + keys.accountXprv() + "/1/" + STAR + ")",
            keys.descriptor(PcoinDerivation.CHAIN_INTERNAL),
        )

        assertEquals("pc1qj7lccmpqhdgg6enh503hqqyx244e49yespm8pf", keys.address(0, 0))
        assertEquals("pc1q0ncnjjyklxwts46h7e7jmls0l8d99lhv3wk0sm", keys.address(0, 1))
        assertEquals("pc1qzze3twr9c0cg0s3v2yh7797gae4ufk7zu4wux0", keys.address(0, 2))
        assertEquals("pc1qel0k9nyfvgqsgkc4fv9jp9ff37gw48gnsqt2rs", keys.address(1, 0))
        assertEquals("pc1qszm5tcmmewdgjny34klqv3dupm6jd5939k6e20", keys.address(1, 1))
        assertEquals("pc1qxyzkhz58fs86rxjmm96hz58zt3j0qnx8s76tyg", keys.address(1, 2))

        // The payout address is receive index 0, generated once and reused.
        assertEquals(keys.address(0, 0), keys.payoutAddress())
    }

    companion object {
        private val MAINNET_XPRV =
            byteArrayOf(0x04, 0x88.toByte(), 0xAD.toByte(), 0xE4.toByte())

        /** The descriptor wildcard, spelled out to keep it out of comments. */
        private const val STAR = "*"
    }
}
