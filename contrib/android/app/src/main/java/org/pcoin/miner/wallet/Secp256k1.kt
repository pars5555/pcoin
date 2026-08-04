package org.pcoin.miner.wallet

import java.math.BigInteger

/**
 * Just enough secp256k1 to turn a private key into a compressed public key.
 *
 * That is genuinely all BIP32 needs from the curve: no signing happens in this
 * app (the node signs), so there is no nonce generation and no ECDSA here. What
 * is needed is scalar multiplication of the generator, for three things:
 *   - the master fingerprint (HASH160 of the master public key),
 *   - each extended key's own identifier / parent fingerprint,
 *   - the public keys of the non-hardened children, which is what actually
 *     produces the receive addresses the app cross-checks against the node.
 *
 * Implemented in Jacobian coordinates with a plain double-and-add ladder. This
 * is NOT constant-time. That is a deliberate and safe choice here: every scalar
 * multiplied is a public-key derivation whose result is published anyway, the
 * code runs in the app's own process on the user's own device, and there is no
 * remote timing surface. It must never be reused for signing.
 */
object Secp256k1 {

    val P: BigInteger = BigInteger(
        "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F", 16
    )

    /** Curve order. A BIP32 child key is invalid if it lands outside [1, N). */
    val N: BigInteger = BigInteger(
        "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", 16
    )

    private val GX = BigInteger(
        "79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798", 16
    )
    private val GY = BigInteger(
        "483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8", 16
    )

    /** Affine point; null coordinates mean the point at infinity. */
    private data class Point(val x: BigInteger?, val y: BigInteger?) {
        val isInfinity: Boolean get() = x == null
    }

    private val INFINITY = Point(null, null)
    private val G = Point(GX, GY)

    /**
     * Compressed SEC1 public key (33 bytes: 0x02/0x03 || X) for [privKey].
     *
     * @throws IllegalArgumentException if the scalar is not a valid private key.
     *   BIP32 relies on that being detected rather than silently producing the
     *   point at infinity.
     */
    fun publicKeyCompressed(privKey: ByteArray): ByteArray {
        val d = BigInteger(1, privKey)
        require(d.signum() > 0 && d < N) { "private key out of range" }
        val q = multiply(G, d)
        check(!q.isInfinity) { "point at infinity" }
        val x = q.x!!
        val y = q.y!!
        val out = ByteArray(33)
        out[0] = if (y.testBit(0)) 0x03 else 0x02
        val xb = unsigned32(x)
        System.arraycopy(xb, 0, out, 1, 32)
        return out
    }

    /** Big-endian, exactly 32 bytes, no sign byte. */
    fun unsigned32(v: BigInteger): ByteArray {
        val raw = v.toByteArray()
        val out = ByteArray(32)
        if (raw.size <= 32) {
            System.arraycopy(raw, 0, out, 32 - raw.size, raw.size)
        } else {
            // BigInteger.toByteArray() prefixes a 0x00 sign byte when the top
            // bit is set; drop it.
            System.arraycopy(raw, raw.size - 32, out, 0, 32)
        }
        return out
    }

    // --------------------------------------------------------- curve arithmetic

    /** Jacobian (X, Y, Z) with x = X/Z^2, y = Y/Z^3. */
    private class Jacobian(val x: BigInteger, val y: BigInteger, val z: BigInteger)

    private val ZERO: BigInteger = BigInteger.ZERO
    private val ONE: BigInteger = BigInteger.ONE
    private val TWO: BigInteger = BigInteger.valueOf(2)
    private val THREE: BigInteger = BigInteger.valueOf(3)
    private val EIGHT: BigInteger = BigInteger.valueOf(8)

    private fun multiply(point: Point, scalar: BigInteger): Point {
        if (scalar.signum() == 0 || point.isInfinity) return INFINITY
        var acc = Jacobian(ONE, ONE, ZERO) // infinity
        var add = Jacobian(point.x!!, point.y!!, ONE)
        var k = scalar
        while (k.signum() > 0) {
            if (k.testBit(0)) acc = addJ(acc, add)
            add = doubleJ(add)
            k = k.shiftRight(1)
        }
        return toAffine(acc)
    }

    private fun doubleJ(p: Jacobian): Jacobian {
        if (p.y.signum() == 0 || p.z.signum() == 0) return Jacobian(ONE, ONE, ZERO)
        // dbl-2009-l, valid for a = 0 curves such as secp256k1.
        val a = p.x.multiply(p.x).mod(P)
        val b = p.y.multiply(p.y).mod(P)
        val c = b.multiply(b).mod(P)
        var d = p.x.add(b)
        d = d.multiply(d).subtract(a).subtract(c).multiply(TWO).mod(P)
        val e = a.multiply(THREE).mod(P)
        val f = e.multiply(e).mod(P)
        val x3 = f.subtract(d.multiply(TWO)).mod(P)
        val y3 = e.multiply(d.subtract(x3)).subtract(c.multiply(EIGHT)).mod(P)
        val z3 = p.y.multiply(p.z).multiply(TWO).mod(P)
        return Jacobian(x3, y3, z3)
    }

    private fun addJ(p: Jacobian, q: Jacobian): Jacobian {
        if (p.z.signum() == 0) return q
        if (q.z.signum() == 0) return p
        val z1z1 = p.z.multiply(p.z).mod(P)
        val z2z2 = q.z.multiply(q.z).mod(P)
        val u1 = p.x.multiply(z2z2).mod(P)
        val u2 = q.x.multiply(z1z1).mod(P)
        val s1 = p.y.multiply(q.z).multiply(z2z2).mod(P)
        val s2 = q.y.multiply(p.z).multiply(z1z1).mod(P)
        if (u1 == u2) {
            // Same x: either a doubling, or P + (-P) = infinity.
            return if (s1 == s2) doubleJ(p) else Jacobian(ONE, ONE, ZERO)
        }
        val h = u2.subtract(u1).mod(P)
        val i = h.multiply(TWO).let { it.multiply(it) }.mod(P)
        val j = h.multiply(i).mod(P)
        val r = s2.subtract(s1).multiply(TWO).mod(P)
        val v = u1.multiply(i).mod(P)
        val x3 = r.multiply(r).subtract(j).subtract(v.multiply(TWO)).mod(P)
        val y3 = r.multiply(v.subtract(x3)).subtract(s1.multiply(j).multiply(TWO)).mod(P)
        val z3 = p.z.add(q.z).let { it.multiply(it) }
            .subtract(z1z1).subtract(z2z2).multiply(h).mod(P)
        return Jacobian(x3, y3, z3)
    }

    private fun toAffine(p: Jacobian): Point {
        if (p.z.signum() == 0) return INFINITY
        val zInv = p.z.modInverse(P)
        val zInv2 = zInv.multiply(zInv).mod(P)
        val x = p.x.multiply(zInv2).mod(P)
        val y = p.y.multiply(zInv2).multiply(zInv).mod(P)
        return Point(x, y)
    }
}
