# Vendored libsecp256k1

Copied from this repository's own `src/secp256k1`, which is the library the
PCoin node links against. Keeping the two in step is the point: a wallet that
signs with a different implementation than the chain verifies with is a wallet
that can produce a transaction nobody will relay.

| | |
|---|---|
| source | `src/secp256k1` in this repo (upstream bitcoin-core/secp256k1) |
| last commit touching that tree | `aa61474cca371af5d4300fbdcd8b1b488eace4b9` |
| copied on | 2026-09-10 |

## What was copied, and what was not

```
include/secp256k1.h              public API
include/secp256k1_preallocated.h  included by secp256k1.c
src/*.h                          every internal header (57 files)
src/secp256k1.c                  the single translation unit
src/precomputed_ecmult.c         verification table  (ECMULT_WINDOW_SIZE=15)
src/precomputed_ecmult_gen.c     signing table       (COMB_BLOCKS=43, COMB_TEETH=6)
```

Deliberately NOT copied: `src/bench*.c`, `src/tests*.c`, `src/ctime_tests.c`,
`src/precompute_ecmult*.c` (the generators) and every optional module
(`ecdh`, `ellswift`, `extrakeys`, `musig`, `recovery`, `schnorrsig`).
SwiftPM compiles every `.c` it finds under the target, so a stray benchmark
would become part of the app. None of the modules is needed: a BIP84 `wpkh`
wallet needs key generation, a scalar tweak-add and ECDSA, all of which are in
the core API.

`src/` and `include/` must stay siblings -- `secp256k1.c` opens with
`#include "../include/secp256k1.h"`.

## Checking it has not drifted

```sh
cd contrib/ios/PCoinKit/Sources/CSecp256k1
for f in src/*.h src/secp256k1.c src/precomputed_ecmult.c src/precomputed_ecmult_gen.c; do
  diff -q "$f" "../../../../../src/secp256k1/$f" || echo "DRIFT: $f"
done
diff -q include/secp256k1.h ../../../../../src/secp256k1/include/secp256k1.h
```
