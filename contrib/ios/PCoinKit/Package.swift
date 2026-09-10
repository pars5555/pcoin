// swift-tools-version: 5.9
import PackageDescription

// PCoinKit is deliberately a package rather than a framework target inside the
// app project, for one reason: `swift test` runs the whole derivation and
// transaction stack on macOS, with no simulator, no signing and no device. The
// published vectors in PCOIN.md 6.4 are therefore checkable on any machine that
// can build Swift, which is what makes "the same twelve words restore the same
// money" a property somebody can verify rather than a claim.
//
// The app target compiles these same sources directly (see tools/genproj.py),
// so there is exactly one copy of the code and no package-resolution step in
// the iOS build.
let package = Package(
    name: "PCoinKit",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "PCoinKit", targets: ["PCoinKit"]),
    ],
    targets: [
        // Vendored libsecp256k1 -- see Sources/CSecp256k1/VENDORED.md.
        //
        // The Android wallet has its own small Kotlin curve implementation and
        // says, correctly, that it "must never be reused for signing": it is a
        // plain double-and-add ladder, not constant time, and Android never
        // signs because the node inside the app does that. iOS has no node, so
        // iOS signs, and the signing scalar is a live private key. That is
        // exactly the case the Kotlin file rules itself out of, so this target
        // is the same library the chain itself uses instead.
        .target(
            name: "CSecp256k1",
            path: "Sources/CSecp256k1",
            sources: ["src"],
            publicHeadersPath: "include",
            cSettings: [
                .headerSearchPath("src"),
                // The values the checked-in precomputed tables were generated
                // for; they are what upstream's CMake defaults to. The tables
                // carry every supported (COMB_BLOCKS, COMB_TEETH) pair behind
                // #elif guards, so a mismatch here is a link error rather than
                // a wrong answer.
                .define("ECMULT_WINDOW_SIZE", to: "15"),
                .define("COMB_BLOCKS", to: "43"),
                .define("COMB_TEETH", to: "6"),
            ]
        ),
        .target(name: "PCoinKit", dependencies: ["CSecp256k1"]),
        .testTarget(name: "PCoinKitTests", dependencies: ["PCoinKit"]),
    ]
)
