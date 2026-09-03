// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// A minimal QR encoder, written out rather than pulled in.
//
// A 1:1 port of the Android app's Qr.kt. This app is compiled with the in-box
// C# compiler and takes no library dependency (build.bat), and that is
// deliberate: it signs transactions on a PC holding real money, and a barcode
// library is a large amount of code from a third party for one rendered
// square. The whole encoder is ~250 lines and the output is checked in
// SeedSelfTest against golden vectors from an independent implementation
// (contrib/android/app/src/test/resources/qr_vectors.txt, produced by the
// Python `qrcode` library).
//
// Scope, chosen to be exactly enough for an address or a `pcoin:` URI:
//
//   * BYTE mode only. Alphanumeric mode would pack an uppercased bech32
//     address into a smaller symbol, but byte mode round-trips any string
//     unchanged and is what every scanner handles without argument. A
//     42-character address lands in version 3 at ECC M, which is small enough.
//   * ECC level M (~15% recovery), the usual choice for addresses.
//   * Versions 1..10. Version 10 at ECC M holds 213 bytes, far past anything
//     this app will ever show.
//
// Not supported, and not needed: kanji/numeric/alphanumeric modes, structured
// append, ECI. Encode() returns null rather than guessing if the text does not
// fit, and callers must handle that - a QR that silently encodes the wrong
// thing is worse than no QR beside an address someone is about to be paid at.
//
// Drawing is NOT here. This file produces a matrix of booleans so the
// self-test can check it with no window; WalletWindow turns it into pixels.

using System;
using System.Collections.Generic;
using System.Text;

namespace PCoinTray
{
    static class QrCode
    {
        /** A square matrix of modules. `true` is dark. */
        public class Matrix
        {
            public readonly int Size;
            readonly bool[] _cells;
            readonly bool[] _locked;

            public Matrix(int size)
            {
                Size = size;
                _cells = new bool[size * size];
                _locked = new bool[size * size];
            }

            public bool this[int x, int y] { get { return _cells[y * Size + x]; } }

            public void Set(int x, int y, bool dark) { _cells[y * Size + x] = dark; }

            public void Set(int x, int y, bool dark, bool lockIt)
            {
                _cells[y * Size + x] = dark;
                if (lockIt) _locked[y * Size + x] = true;
            }

            /** A function-pattern or format module: the mask never touches it. */
            public bool IsLocked(int x, int y) { return _locked[y * Size + x]; }
        }

        /**
         * Encode text as a QR symbol.
         *
         * @return the module matrix, or null when the text does not fit in
         *   version 10 at ECC M. Null is a real answer: callers must not
         *   render a partial symbol.
         */
        public static Matrix Encode(string text) { return Encode(text, null); }

        /**
         * @param forceMask pins the mask instead of scoring all eight. For
         *   tests only - production callers use Encode(text), because the
         *   spec's penalty rules exist to avoid symbols a scanner struggles
         *   with, and one of those was observed being produced before the
         *   rules were applied properly.
         */
        public static Matrix Encode(string text, int? forceMask)
        {
            byte[] data = Encoding.UTF8.GetBytes(text ?? "");
            int version = 0;
            for (int v = 1; v <= 10; v++) if (data.Length <= CapacityBytes(v)) { version = v; break; }
            if (version == 0) return null;

            var bits = new BitBuffer();
            bits.Append(0x4, 4);                                  // byte mode
            bits.Append(data.Length, CharCountBits(version));
            foreach (byte b in data) bits.Append(b, 8);

            int totalDataBits = DataCodewords(version) * 8;
            bits.Append(0, Math.Min(4, totalDataBits - bits.Size));   // terminator
            while (bits.Size % 8 != 0) bits.Append(0, 1);
            // Pad alternately with the two bytes the spec names.
            int pad = 0xEC;
            while (bits.Size < totalDataBits)
            {
                bits.Append(pad, 8);
                pad = pad == 0xEC ? 0x11 : 0xEC;
            }

            int[] codewords = Interleave(bits.ToBytes(), version);
            int size = 17 + version * 4;
            var m = new Matrix(size);
            DrawFunctionPatterns(m, version);
            DrawCodewords(m, codewords);

            // Every mask is drawn and scored; the lowest penalty wins. Doing
            // fewer is legal but produces symbols some scanners struggle with
            // - observed on the Android side: an early build picked a mask
            // that OpenCV could not read at all for one address, while the
            // same data under a properly-scored mask decoded fine.
            int best = forceMask.HasValue ? forceMask.Value : -1;
            if (!forceMask.HasValue)
            {
                int bestPenalty = int.MaxValue;
                for (int mask = 0; mask <= 7; mask++)
                {
                    ApplyMask(m, mask);
                    DrawFormat(m, mask);
                    int p = Penalty(m);
                    if (p < bestPenalty) { bestPenalty = p; best = mask; }
                    ApplyMask(m, mask);   // XOR again to undo
                }
            }
            ApplyMask(m, best);
            DrawFormat(m, best);
            return m;
        }

        // ------------------------------------------------------------ tables

        // Total codewords per version, and ECC codewords per block at level M.
        static readonly int[] TOTAL = { 0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346 };
        static readonly int[] ECC_PER_BLOCK = { 0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26 };
        static readonly int[] BLOCKS = { 0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5 };

        static int DataCodewords(int v) { return TOTAL[v] - ECC_PER_BLOCK[v] * BLOCKS[v]; }
        static int CapacityBytes(int v) { return DataCodewords(v) - 2 - (v >= 10 ? 1 : 0); }
        static int CharCountBits(int v) { return v < 10 ? 8 : 16; }

        static readonly int[][] ALIGN =
        {
            new int[0], new int[0], new[] { 6, 18 }, new[] { 6, 22 }, new[] { 6, 26 },
            new[] { 6, 30 }, new[] { 6, 34 }, new[] { 6, 22, 38 }, new[] { 6, 24, 42 },
            new[] { 6, 26, 46 }, new[] { 6, 28, 50 },
        };

        // ------------------------------------------------------- bit plumbing

        class BitBuffer
        {
            readonly List<byte> _bytes = new List<byte>();
            public int Size;

            public void Append(int value, int bits)
            {
                for (int i = bits - 1; i >= 0; i--)
                {
                    if (Size % 8 == 0) _bytes.Add(0);
                    if (((value >> i) & 1) == 1)
                    {
                        int idx = Size / 8;
                        _bytes[idx] = (byte)(_bytes[idx] | (0x80 >> (Size % 8)));
                    }
                    Size++;
                }
            }

            public int[] ToBytes()
            {
                var r = new int[_bytes.Count];
                for (int i = 0; i < r.Length; i++) r[i] = _bytes[i];
                return r;
            }
        }

        /** Split into blocks, compute Reed-Solomon, then interleave as the spec requires. */
        static int[] Interleave(int[] data, int version)
        {
            int blocks = BLOCKS[version];
            int eccLen = ECC_PER_BLOCK[version];
            int shortLen = data.Length / blocks;
            int longCount = data.Length % blocks;

            var dataBlocks = new List<int[]>(blocks);
            var eccBlocks = new List<int[]>(blocks);
            int p = 0;
            for (int i = 0; i < blocks; i++)
            {
                int len = shortLen + (i >= blocks - longCount ? 1 : 0);
                var b = new int[len];
                Array.Copy(data, p, b, 0, len);
                p += len;
                dataBlocks.Add(b);
                eccBlocks.Add(ReedSolomon(b, eccLen));
            }

            var outList = new List<int>(TOTAL[version]);
            int maxData = 0;
            foreach (var b in dataBlocks) if (b.Length > maxData) maxData = b.Length;
            for (int i = 0; i < maxData; i++)
                foreach (var b in dataBlocks) if (i < b.Length) outList.Add(b[i]);
            for (int i = 0; i < eccLen; i++)
                foreach (var b in eccBlocks) outList.Add(b[i]);
            return outList.ToArray();
        }

        // GF(256) with the QR primitive polynomial 0x11D.
        static readonly int[] EXP = new int[512];
        static readonly int[] LOG = new int[256];

        static QrCode()
        {
            int x = 1;
            for (int i = 0; i < 255; i++)
            {
                EXP[i] = x;
                LOG[x] = i;
                x <<= 1;
                if ((x & 0x100) != 0) x ^= 0x11D;
            }
            for (int i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
        }

        static int Mul(int a, int b) { return a == 0 || b == 0 ? 0 : EXP[LOG[a] + LOG[b]]; }

        static int[] ReedSolomon(int[] data, int eccLen)
        {
            // Generator polynomial for eccLen check symbols.
            int[] gen = { 1 };
            for (int i = 0; i < eccLen; i++)
            {
                var next = new int[gen.Length + 1];
                for (int j = 0; j < gen.Length; j++)
                {
                    next[j] ^= gen[j];
                    next[j + 1] ^= Mul(gen[j], EXP[i]);
                }
                gen = next;
            }
            var res = new int[eccLen];
            foreach (int b in data)
            {
                int factor = b ^ res[0];
                Array.Copy(res, 1, res, 0, eccLen - 1);
                res[eccLen - 1] = 0;
                for (int j = 0; j < eccLen; j++) res[j] ^= Mul(gen[j + 1], factor);
            }
            return res;
        }

        // ----------------------------------------------------------- drawing

        static void DrawFunctionPatterns(Matrix m, int version)
        {
            int size = m.Size;
            // Timing patterns first: finders overwrite their ends.
            for (int i = 0; i < size; i++)
            {
                m.Set(6, i, i % 2 == 0, true);
                m.Set(i, 6, i % 2 == 0, true);
            }
            Finder(m, 0, 0); Finder(m, size - 7, 0); Finder(m, 0, size - 7);

            int[] centres = ALIGN[version];
            foreach (int a in centres) foreach (int b in centres)
            {
                // Skip the three that would land on a finder.
                if ((a == 6 && b == 6) || (a == 6 && b == size - 7) || (a == size - 7 && b == 6)) continue;
                Alignment(m, a, b);
            }

            // Format areas are reserved here and written by DrawFormat.
            for (int i = 0; i <= 8; i++)
            {
                if (i != 6) { m.Set(i, 8, false, true); m.Set(8, i, false, true); }
            }
            for (int i = 0; i <= 7; i++) m.Set(size - 1 - i, 8, false, true);
            for (int i = 0; i <= 6; i++) m.Set(8, size - 1 - i, false, true);
            m.Set(8, size - 8, true, true);   // always-dark module
        }

        static void Finder(Matrix m, int x, int y)
        {
            for (int dy = -1; dy <= 7; dy++) for (int dx = -1; dx <= 7; dx++)
            {
                int px = x + dx;
                int py = y + dy;
                if (px < 0 || px >= m.Size || py < 0 || py >= m.Size) continue;
                int d = Math.Max(Math.Abs(dx - 3), Math.Abs(dy - 3));
                m.Set(px, py, d != 2 && d <= 3, true);
            }
        }

        static void Alignment(Matrix m, int cx, int cy)
        {
            for (int dy = -2; dy <= 2; dy++) for (int dx = -2; dx <= 2; dx++)
            {
                int d = Math.Max(Math.Abs(dx), Math.Abs(dy));
                m.Set(cx + dx, cy + dy, d != 1, true);
            }
        }

        static void DrawCodewords(Matrix m, int[] words)
        {
            int size = m.Size;
            int bit = 0;
            int col = size - 1;
            while (col > 0)
            {
                if (col == 6) col--;          // the vertical timing column is skipped
                for (int row = 0; row < size; row++)
                {
                    for (int c = 0; c <= 1; c++)
                    {
                        int x = col - c;
                        // Odd columns run upwards.
                        bool upward = ((col + 1) & 2) == 0;
                        int y = upward ? size - 1 - row : row;
                        if (m.IsLocked(x, y)) continue;
                        bool dark = bit < words.Length * 8 &&
                            ((words[bit / 8] >> (7 - bit % 8)) & 1) == 1;
                        m.Set(x, y, dark);
                        bit++;
                    }
                }
                col -= 2;
            }
        }

        /** The eight mask conditions, exactly as the spec tabulates them. */
        public static bool MaskBit(int mask, int x, int y)
        {
            switch (mask)
            {
                case 0: return (x + y) % 2 == 0;
                case 1: return y % 2 == 0;
                case 2: return x % 3 == 0;
                case 3: return (x + y) % 3 == 0;
                case 4: return (y / 2 + x / 3) % 2 == 0;
                case 5: return (x * y) % 2 + (x * y) % 3 == 0;
                case 6: return ((x * y) % 2 + (x * y) % 3) % 2 == 0;
                default: return ((x + y) % 2 + (x * y) % 3) % 2 == 0;
            }
        }

        static void ApplyMask(Matrix m, int mask)
        {
            for (int y = 0; y < m.Size; y++) for (int x = 0; x < m.Size; x++)
            {
                if (m.IsLocked(x, y)) continue;
                if (MaskBit(mask, x, y)) m.Set(x, y, !m[x, y]);
            }
        }

        static void DrawFormat(Matrix m, int mask)
        {
            // ECC level M is 0b00; 15 bits of BCH(15,5) then XOR 0x5412.
            int data = (0x0 << 3) | mask;
            int rem = data;
            for (int i = 0; i < 10; i++)
            {
                rem = (rem << 1) ^ ((rem >> 9) * 0x537);
            }
            int bits = ((data << 10) | rem) ^ 0x5412;

            int size = m.Size;
            for (int i = 0; i <= 5; i++) m.Set(8, i, Bit(bits, i), true);
            m.Set(8, 7, Bit(bits, 6), true);
            m.Set(8, 8, Bit(bits, 7), true);
            m.Set(7, 8, Bit(bits, 8), true);
            for (int i = 9; i <= 14; i++) m.Set(14 - i, 8, Bit(bits, i), true);

            for (int i = 0; i <= 7; i++) m.Set(size - 1 - i, 8, Bit(bits, i), true);
            for (int i = 8; i <= 14; i++) m.Set(8, size - 15 + i, Bit(bits, i), true);
            m.Set(8, size - 8, true, true);
        }

        static bool Bit(int v, int i) { return ((v >> i) & 1) == 1; }

        /** The mask a symbol declares, read back out of its format information. */
        public static int DeclaredMask(Matrix m)
        {
            int bits = 0;
            for (int i = 0; i <= 5; i++) if (m[8, i]) bits |= 1 << i;
            if (m[8, 7]) bits |= 1 << 6;
            if (m[8, 8]) bits |= 1 << 7;
            if (m[7, 8]) bits |= 1 << 8;
            for (int i = 9; i <= 14; i++) if (m[14 - i, 8]) bits |= 1 << i;
            // 15-bit word is (data << 10) | bch, and data is (ecc << 3) | mask.
            return ((bits ^ 0x5412) >> 10) & 7;
        }

        /** The four penalty rules, used only to choose between masks. */
        static int Penalty(Matrix m)
        {
            int size = m.Size;
            int score = 0;

            // Rule 1: runs of five or more.
            for (int i = 0; i < size; i++)
            {
                bool runColour = m[0, i]; int run = 1;
                for (int j = 1; j < size; j++)
                {
                    if (m[j, i] == runColour) run++;
                    else { if (run >= 5) score += run - 2; runColour = m[j, i]; run = 1; }
                }
                if (run >= 5) score += run - 2;
                runColour = m[i, 0]; run = 1;
                for (int j = 1; j < size; j++)
                {
                    if (m[i, j] == runColour) run++;
                    else { if (run >= 5) score += run - 2; runColour = m[i, j]; run = 1; }
                }
                if (run >= 5) score += run - 2;
            }

            // Rule 2: 2x2 blocks of one colour.
            for (int y = 0; y < size - 1; y++) for (int x = 0; x < size - 1; x++)
            {
                bool c = m[x, y];
                if (c == m[x + 1, y] && c == m[x, y + 1] && c == m[x + 1, y + 1]) score += 3;
            }

            // Rule 3: the finder-like 1:1:3:1:1 pattern.
            bool[] a = { true, false, true, true, true, false, true, false, false, false, false };
            bool[] b = { false, false, false, false, true, false, true, true, true, false, true };
            for (int y = 0; y < size; y++) for (int x = 0; x < size - 10; x++)
            {
                bool ha = true, hb = true, va = true, vb = true;
                for (int k = 0; k < 11; k++)
                {
                    if (m[x + k, y] != a[k]) ha = false;
                    if (m[x + k, y] != b[k]) hb = false;
                    if (m[y, x + k] != a[k]) va = false;
                    if (m[y, x + k] != b[k]) vb = false;
                }
                if (ha) score += 40;
                if (hb) score += 40;
                if (va) score += 40;
                if (vb) score += 40;
            }

            // Rule 4: deviation from an even split of dark and light.
            int dark = 0;
            for (int y = 0; y < size; y++) for (int x = 0; x < size; x++) if (m[x, y]) dark++;
            int percent = dark * 100 / (size * size);
            score += (Math.Abs(percent - 50) / 5) * 10;
            return score;
        }
    }
}
