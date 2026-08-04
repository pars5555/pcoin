// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// Cryptographic primitives needed to turn a recovery phrase into PCoin keys.
//
// Everything here is written against the .NET Framework base class library on
// purpose: the tray app is compiled with the in-box csc.exe and must stay a
// single dependency-free .exe, so a package such as NBitcoin is not available.
// That means secp256k1, Base58 and Bech32 are implemented here rather than
// borrowed. The correctness of every one of these is checked at startup and by
// "PCoinTray.exe --selftest" against the published BIP32/BIP39/BIP84 test
// vectors; see SeedSelfTest.cs. Do not change anything in this file without
// running that.

using System;
using System.Collections.Generic;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

namespace PCoinTray
{
    static class Hashes
    {
        public static byte[] Sha256(byte[] data)
        {
            using (var h = new SHA256Managed()) return h.ComputeHash(data);
        }

        public static byte[] Hash160(byte[] data)
        {
            using (var sha = new SHA256Managed())
            using (var rmd = new RIPEMD160Managed())
                return rmd.ComputeHash(sha.ComputeHash(data));
        }

        public static byte[] HmacSha512(byte[] key, byte[] data)
        {
            using (var h = new HMACSHA512(key)) return h.ComputeHash(data);
        }

        /**
         * PBKDF2-HMAC-SHA512.
         *
         * The framework's Rfc2898DeriveBytes is SHA-1 only on .NET Framework, so
         * this is done by hand. BIP39 asks for exactly 64 output bytes, which is
         * one SHA-512 block, so there is a single T block and no loop over
         * output blocks to get wrong.
         */
        public static byte[] Pbkdf2Sha512(byte[] password, byte[] salt, int iterations, int dkLen)
        {
            if (dkLen != 64) throw new ArgumentException("only the 64-byte BIP39 case is implemented");
            var block = new byte[salt.Length + 4];
            Buffer.BlockCopy(salt, 0, block, 0, salt.Length);
            block[salt.Length + 0] = 0; block[salt.Length + 1] = 0;
            block[salt.Length + 2] = 0; block[salt.Length + 3] = 1;   // INT(1), big endian

            using (var mac = new HMACSHA512(password))
            {
                byte[] u = mac.ComputeHash(block);
                var t = (byte[])u.Clone();
                for (int i = 1; i < iterations; i++)
                {
                    u = mac.ComputeHash(u);
                    for (int j = 0; j < t.Length; j++) t[j] ^= u[j];
                }
                return t;
            }
        }

        public static string ToHex(byte[] b)
        {
            var sb = new StringBuilder(b.Length * 2);
            foreach (byte x in b) sb.Append(x.ToString("x2"));
            return sb.ToString();
        }

        public static byte[] FromHex(string s)
        {
            var b = new byte[s.Length / 2];
            for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(s.Substring(i * 2, 2), 16);
            return b;
        }

        //! Constant-time-ish comparison. Used for checksum and cross-check
        //! comparisons where an early exit leaks nothing useful, but there is no
        //! reason to write the sloppy version.
        public static bool Equal(byte[] a, byte[] b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }

        public static void Wipe(byte[] b) { if (b != null) Array.Clear(b, 0, b.Length); }
        public static void Wipe(char[] c) { if (c != null) Array.Clear(c, 0, c.Length); }
    }

    static class Base58
    {
        const string ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

        public static string EncodeCheck(byte[] payload)
        {
            var sum = Hashes.Sha256(Hashes.Sha256(payload));
            var full = new byte[payload.Length + 4];
            Buffer.BlockCopy(payload, 0, full, 0, payload.Length);
            Buffer.BlockCopy(sum, 0, full, payload.Length, 4);
            return Encode(full);
        }

        public static string Encode(byte[] data)
        {
            int zeros = 0;
            while (zeros < data.Length && data[zeros] == 0) zeros++;

            // BigInteger wants little-endian and treats a high bit as a sign, so
            // append a zero byte to keep the value positive.
            var le = new byte[data.Length + 1];
            for (int i = 0; i < data.Length; i++) le[i] = data[data.Length - 1 - i];
            var value = new BigInteger(le);

            var sb = new StringBuilder();
            var fiftyEight = new BigInteger(58);
            while (value > BigInteger.Zero)
            {
                BigInteger rem;
                value = BigInteger.DivRem(value, fiftyEight, out rem);
                sb.Insert(0, ALPHABET[(int)rem]);
            }
            for (int i = 0; i < zeros; i++) sb.Insert(0, '1');
            return sb.ToString();
        }
    }

    static class Bech32
    {
        const string CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

        static uint Polymod(List<byte> values)
        {
            uint[] gen = { 0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3 };
            uint chk = 1;
            foreach (byte v in values)
            {
                uint top = chk >> 25;
                chk = ((chk & 0x1ffffff) << 5) ^ v;
                for (int i = 0; i < 5; i++) if (((top >> i) & 1) != 0) chk ^= gen[i];
            }
            return chk;
        }

        static List<byte> HrpExpand(string hrp)
        {
            var r = new List<byte>();
            foreach (char c in hrp) r.Add((byte)(c >> 5));
            r.Add(0);
            foreach (char c in hrp) r.Add((byte)(c & 31));
            return r;
        }

        static List<byte> ConvertBits(byte[] data, int from, int to, bool pad)
        {
            int acc = 0, bits = 0, maxv = (1 << to) - 1;
            var ret = new List<byte>();
            foreach (byte value in data)
            {
                acc = (acc << from) | value;
                bits += from;
                while (bits >= to) { bits -= to; ret.Add((byte)((acc >> bits) & maxv)); }
            }
            if (pad && bits > 0) ret.Add((byte)((acc << (to - bits)) & maxv));
            return ret;
        }

        /**
         * Encode a segwit output. Witness version 0 uses the Bech32 constant 1
         * (BIP173); versions 1+ use Bech32m's 0x2bc830a3 (BIP350). PCoin only
         * needs v0 here because the wallet is wpkh-only, but the constant is
         * selected properly rather than hardcoded so a future tr() address does
         * not silently come out wrong.
         */
        public static string EncodeSegwit(string hrp, int witver, byte[] program)
        {
            var data = new List<byte> { (byte)witver };
            data.AddRange(ConvertBits(program, 8, 5, true));

            uint constant = witver == 0 ? 1u : 0x2bc830a3u;
            var values = HrpExpand(hrp);
            values.AddRange(data);
            values.AddRange(new byte[] { 0, 0, 0, 0, 0, 0 });
            uint polymod = Polymod(values) ^ constant;

            var sb = new StringBuilder(hrp);
            sb.Append('1');
            foreach (byte b in data) sb.Append(CHARSET[b]);
            for (int i = 0; i < 6; i++) sb.Append(CHARSET[(int)((polymod >> (5 * (5 - i))) & 31)]);
            return sb.ToString();
        }
    }

    /**
     * Just enough secp256k1 to turn a private key into a compressed public key.
     *
     * Only scalar multiplication of the generator is needed: BIP32 private
     * derivation computes the child private key arithmetically and the public
     * key is derived from it afterwards, so there is never a case here that
     * needs public-point addition.
     */
    static class Secp256k1
    {
        public static readonly BigInteger P = Hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F");
        public static readonly BigInteger N = Hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
        static readonly BigInteger Gx = Hex("79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798");
        static readonly BigInteger Gy = Hex("483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8");

        static BigInteger Hex(string h) { return FromBytes(Hashes.FromHex(h)); }

        //! Big-endian unsigned bytes -> BigInteger.
        public static BigInteger FromBytes(byte[] be)
        {
            var le = new byte[be.Length + 1];
            for (int i = 0; i < be.Length; i++) le[i] = be[be.Length - 1 - i];
            return new BigInteger(le);
        }

        //! BigInteger -> fixed-width big-endian bytes.
        public static byte[] ToBytes(BigInteger v, int len)
        {
            var le = v.ToByteArray();               // little endian, possibly with a sign byte
            var be = new byte[len];
            int n = Math.Min(len, le.Length);
            for (int i = 0; i < n; i++) be[len - 1 - i] = le[i];
            for (int i = len; i < le.Length; i++)
                if (le[i] != 0) throw new ArgumentException("value does not fit");
            return be;
        }

        static BigInteger Mod(BigInteger a, BigInteger m)
        {
            var r = a % m;
            return r.Sign < 0 ? r + m : r;
        }

        //! Modular inverse by the extended Euclidean algorithm.
        static BigInteger Inverse(BigInteger a, BigInteger m)
        {
            BigInteger t = BigInteger.Zero, newt = BigInteger.One;
            BigInteger r = m, newr = Mod(a, m);
            while (!newr.IsZero)
            {
                var q = r / newr;
                var tmp = t - q * newt; t = newt; newt = tmp;
                tmp = r - q * newr; r = newr; newr = tmp;
            }
            if (r > BigInteger.One) throw new InvalidOperationException("not invertible");
            return Mod(t, m);
        }

        // A point is null for infinity, otherwise {x, y}.
        static BigInteger[] Double(BigInteger[] p)
        {
            if (p == null) return null;
            if (p[1].IsZero) return null;
            var s = Mod(3 * p[0] * p[0] * Inverse(2 * p[1], P), P);
            var x = Mod(s * s - 2 * p[0], P);
            var y = Mod(s * (p[0] - x) - p[1], P);
            return new[] { x, y };
        }

        static BigInteger[] Add(BigInteger[] a, BigInteger[] b)
        {
            if (a == null) return b;
            if (b == null) return a;
            if (a[0] == b[0])
            {
                if (a[1] == b[1]) return Double(a);
                return null;                            // p + (-p) = infinity
            }
            var s = Mod((b[1] - a[1]) * Inverse(b[0] - a[0], P), P);
            var x = Mod(s * s - a[0] - b[0], P);
            var y = Mod(s * (a[0] - x) - a[1], P);
            return new[] { x, y };
        }

        //! Compressed SEC public key for the private scalar d.
        public static byte[] PubKey(BigInteger d)
        {
            if (d.Sign <= 0 || d >= N) throw new ArgumentException("private key out of range");
            var g = new[] { Gx, Gy };
            BigInteger[] r = null;
            for (int bit = 255; bit >= 0; bit--)
            {
                r = Double(r);
                if (!((d >> bit) & BigInteger.One).IsZero) r = Add(r, g);
            }
            if (r == null) throw new InvalidOperationException("point at infinity");

            var pub = new byte[33];
            pub[0] = (byte)(r[1].IsEven ? 0x02 : 0x03);
            Buffer.BlockCopy(ToBytes(r[0], 32), 0, pub, 1, 32);
            return pub;
        }

        public static byte[] PubKey(byte[] priv32) { return PubKey(FromBytes(priv32)); }
    }
}
