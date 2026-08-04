package org.pcoin.miner.wallet

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Redaction is only worth having if it actually fires on the strings the node
 * really produces, so these are shaped like genuine bitcoind error messages
 * rather than convenient examples.
 */
class RedactTest {

    private val acctXprv =
        "xprv9y14Hos54MVJgZi4fDbHMeHQznnF9PCiwjtq5yCv6YKF1nCBFDSzHRtXHxqCWKy4EE5VXRJDdKcyfpSgrrTKKXJLvkPqWfpcLAXQtZcMRwL"

    @Test
    fun stripsExtendedPrivateKeysFromDescriptorErrors() {
        val message =
            "importdescriptors: Descriptor \"wpkh([73c5da0a/84h/9444h/0h]$acctXprv/0/*)#w8mxel75\" " +
                "is not valid for this wallet"
        val safe = Redact.text(message)
        assertFalse("xprv survived redaction", safe.contains("xprv"))
        assertFalse("descriptor body survived", safe.contains("73c5da0a"))
        assertTrue("lost all context", safe.contains("importdescriptors"))
    }

    @Test
    fun stripsBareExtendedKeys() {
        assertFalse(Redact.text("key $acctXprv rejected").contains("xprv9"))
        val tprv =
            "tprv8ZgxMBicQKsPeDgjzdC36fs6bMjGApWDNLR9erAXMs5skhMv36j9MV5ecvfavji5khqjWaWSFhN3YcCUUdiKH6isR4Pwy3U5y5egddBr16m"
        assertFalse(Redact.text("loaded $tprv ok").contains("tprv8"))
    }

    @Test
    fun leavesOrdinaryNodeErrorsReadable() {
        val message = "Fee estimation failed. Fallbackfee is disabled."
        assertTrue(Redact.text(message) == message)
    }

    @Test
    fun handlesNullAndEmpty() {
        assertTrue(Redact.text(null as String?).isEmpty())
        assertTrue(Redact.text("").isEmpty())
    }
}
