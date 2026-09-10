#!/usr/bin/env python3
"""Regenerate PCoinKit/Sources/PCoinKit/Wordlist.swift from the Android app copy.

There is exactly one BIP39 English wordlist in this repository and it lives at
contrib/android/app/src/main/assets/bip39/english.txt. The iOS wallet embeds it
rather than shipping it as a resource (see the generated file for why), so this
script is what keeps the two byte-identical. The same twelve words have to mean
the same thing on Android, Windows and iOS; a divergence here is not a bug that
shows up in a test, it is a wallet that restores to the wrong money.

    python contrib/ios/tools/gen_wordlist.py

Refuses to write anything if the source list does not hash to the canonical
published digest.
"""
import hashlib
import os
import sys

CANONICAL_SHA256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SRC = os.path.join(REPO, "contrib", "android", "app", "src", "main", "assets", "bip39", "english.txt")
DST = os.path.join(HERE, "..", "PCoinKit", "Sources", "PCoinKit", "Wordlist.swift")

TEMPLATE = '''import Foundation

/// The BIP39 English wordlist, embedded.
///
/// Embedded rather than shipped as a bundle resource on purpose. A resource is
/// looked up by URL at runtime, and the failure mode of a lookup that misses --
/// the wrong bundle in a test target, a missing Copy Files phase, a package
/// resource rule that was not applied -- is a wallet that cannot read a phrase,
/// discovered by a user rather than by the build. Embedded, the list is a
/// compile-time constant and cannot be absent.
///
/// English only, always. A phrase generated against a localised wordlist cannot
/// be restored by any wallet that does not guess the same language, and picking
/// the list from the device locale is a well-known way to lose coins for good.
/// There is deliberately no language parameter anywhere in this package.
///
/// GENERATED FILE -- do not edit. To regenerate:
///
///     python contrib/ios/tools/gen_wordlist.py
///
/// The digest below is the canonical published SHA-256 of the list, over the
/// words joined with LF and terminated with one. It is checked at load time in
/// `Bip39.english()`, because a corrupted or substituted wordlist silently
/// changes every derived key -- undetectable until the money is already gone.
public enum Wordlist {

    /// Matches `Bip39.WORDLIST_SHA256` in the Android app.
    public static let sha256Hex = "%(digest)s"

    public static let words: [String] =
        text.split(whereSeparator: { $0.isNewline }).map(String.init)

    /// The list exactly as the digest covers it: LF separated, LF terminated.
    public static let text: String = """
%(body)s

"""
}
'''


def main():
    with open(SRC, "rb") as fh:
        raw = fh.read().replace(b"\r\n", b"\n")
    digest = hashlib.sha256(raw).hexdigest()
    if digest != CANONICAL_SHA256:
        sys.exit("REFUSING: %s hashes to %s, not the canonical %s"
                 % (SRC, digest, CANONICAL_SHA256))
    words = [w for w in raw.decode("ascii").split("\n") if w]
    if len(words) != 2048:
        sys.exit("REFUSING: %d words, expected 2048" % len(words))

    out = TEMPLATE % {"digest": digest, "body": "\n".join(words)}
    with open(DST, "w", newline="\n") as fh:
        fh.write(out)
    print("wrote %s (%d words, sha256 %s)" % (os.path.normpath(DST), len(words), digest))


if __name__ == "__main__":
    main()
