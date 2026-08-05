"""Raw transaction parsing and txid computation.

The two vectors below are not invented: both hex strings were fed to a live
PCoin node's `decoderawtransaction` (v29.4, `/root/pcoin-verify`) and the txid,
wtxid, size, vsize and weight recorded here are that node's answers. That makes
this a cross-implementation check rather than a restatement of our own code --
which matters, because the txid this API computes is what it uses to ask "did my
broadcast survive?" after a lost response.
"""

import unittest

from . import helpers  # noqa: F401  (sets sys.path)
from pcoin_api.txid import MAX_TX_BYTES, TxParseError, parse_hex, parse_tx

# A v2 segwit spend: 1 input, 2 outputs (P2WPKH + P2WSH), 2 witness items.
SEGWIT_HEX = (
    "02000000" "0001" "01" + "aa" * 32 + "00000000" "00" "fdffffff"
    "02"
    "00e1f50500000000" "16" "0014" + "bb" * 20 +
    "804a5d0500000000" "22" "0020" + "cc" * 32 +
    "02" "47" + "30" * 71 + "21" + "03" * 33 + "00000000")
SEGWIT_TXID = "0299f611edd55fcd0344ef51c5a2735ee2b0f451fc3e6f066e10986dcabf903c"
SEGWIT_WTXID = "68246cad25d4d36310cfceac7ed4481df9c46973f62522ac9e418a797b5c4629"

# A v2 pre-segwit spend: 1 P2PKH input, 1 P2WPKH output, no witness.
LEGACY_HEX = (
    "02000000" "01" + "dd" * 32 + "01000000" "1976a914" + "ee" * 20 + "88ac"
    "ffffffff" "01" "00e1f50500000000" "160014" + "bb" * 20 + "00000000")
LEGACY_TXID = "cd41b5bbf31532e479bbef80fcf0e85893454039454f2c7230354291afcc0591"


class VectorTests(unittest.TestCase):
    def test_segwit_matches_the_node(self):
        tx = parse_hex(SEGWIT_HEX)
        self.assertEqual(tx["txid"], SEGWIT_TXID)
        self.assertEqual(tx["wtxid"], SEGWIT_WTXID)
        self.assertEqual((tx["size"], tx["vsize"], tx["weight"]), (234, 153, 609))
        self.assertTrue(tx["has_witness"])
        self.assertEqual(len(tx["vin"]), 1)
        self.assertEqual(len(tx["vout"]), 2)
        self.assertEqual(tx["vout"][0]["value_sat"], 100_000_000)
        self.assertEqual(tx["vin"][0]["prev_txid"], "aa" * 32)

    def test_legacy_matches_the_node(self):
        tx = parse_hex(LEGACY_HEX)
        self.assertEqual(tx["txid"], LEGACY_TXID)
        self.assertEqual((tx["size"], tx["vsize"], tx["weight"]), (107, 107, 428))
        self.assertFalse(tx["has_witness"])

    def test_wtxid_equals_txid_without_witness(self):
        tx = parse_hex(LEGACY_HEX)
        self.assertEqual(tx["wtxid"], tx["txid"])

    def test_witness_does_not_change_the_txid(self):
        """The whole point of segwit, and the property broadcast relies on: two
        transactions differing only in witness data have the same txid."""
        other = SEGWIT_HEX.replace("30" * 71, "31" * 71)
        self.assertNotEqual(other, SEGWIT_HEX)
        self.assertEqual(parse_hex(other)["txid"], SEGWIT_TXID)
        self.assertNotEqual(parse_hex(other)["wtxid"], SEGWIT_WTXID)


class RejectionTests(unittest.TestCase):
    def test_trailing_bytes_rejected(self):
        # Accepting junk would mean the txid we report is not the txid of what we
        # would have sent.
        with self.assertRaises(TxParseError) as cm:
            parse_hex(LEGACY_HEX + "00")
        self.assertIn("trailing", str(cm.exception))

    def test_truncated_rejected(self):
        with self.assertRaises(TxParseError):
            parse_hex(LEGACY_HEX[:-20])

    def test_odd_length_hex_rejected(self):
        with self.assertRaises(TxParseError) as cm:
            parse_hex(LEGACY_HEX + "0")
        self.assertIn("odd length", str(cm.exception))

    def test_non_hex_rejected(self):
        with self.assertRaises(TxParseError) as cm:
            parse_hex(LEGACY_HEX[:-2] + "zz")
        self.assertIn("non-hex", str(cm.exception))

    def test_empty_rejected(self):
        for value in ("", "   "):
            with self.assertRaises(TxParseError):
                parse_hex(value)

    def test_recovery_phrase_is_not_a_transaction(self):
        """A user pasting the wrong thing into the wrong box must get a clean
        rejection, not a confusing node error -- and this API must never be the
        place a phrase ends up."""
        with self.assertRaises(TxParseError):
            parse_hex("abandon abandon abandon abandon abandon abandon abandon "
                      "abandon abandon abandon abandon about")

    def test_coinbase_rejected(self):
        cb = ("01000000" "01" + "00" * 32 + "ffffffff" "04" "01020304"
              "ffffffff" "01" "00f2052a01000000" "160014" + "bb" * 20 + "00000000")
        with self.assertRaises(TxParseError) as cm:
            parse_hex(cb)
        self.assertIn("coinbase", str(cm.exception))

    def test_no_outputs_rejected(self):
        no_out = ("02000000" "01" + "dd" * 32 + "01000000" "00" "ffffffff"
                  "00" "00000000")
        with self.assertRaises(TxParseError):
            parse_hex(no_out)

    def test_oversized_rejected(self):
        with self.assertRaises(TxParseError) as cm:
            parse_hex("00" * (MAX_TX_BYTES + 1))
        self.assertIn("ceiling", str(cm.exception))

    def test_absurd_length_prefix_does_not_allocate(self):
        """A varint claiming a 2^32-byte script must be bounds-checked before
        anything is allocated."""
        evil = ("02000000" "01" + "dd" * 32 + "01000000" "feffffffff" "ffffffff"
                "01" "00e1f50500000000" "160014" + "bb" * 20 + "00000000")
        with self.assertRaises(TxParseError) as cm:
            parse_hex(evil)
        self.assertIn("truncated", str(cm.exception))

    def test_bad_segwit_flag_rejected(self):
        bad = SEGWIT_HEX[:8] + "0002" + SEGWIT_HEX[12:]
        with self.assertRaises(TxParseError) as cm:
            parse_hex(bad)
        self.assertIn("segwit flag", str(cm.exception))

    def test_bytes_input_rejected_where_a_string_is_expected(self):
        with self.assertRaises(TxParseError):
            parse_hex(b"0200")
        with self.assertRaises(TxParseError):
            parse_tx("not bytes")


if __name__ == "__main__":                                   # pragma: no cover
    unittest.main()
