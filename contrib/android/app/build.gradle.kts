import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Hoisted out of `android { }` so the signing guard below can see them too.
val signingProps = Properties().apply {
    val f = rootProject.file("signing.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val ksPath: String? = signingProps.getProperty("storeFile") ?: System.getenv("PCOIN_KEYSTORE")
val ksPass: String? = signingProps.getProperty("storePassword") ?: System.getenv("PCOIN_KEYSTORE_PASSWORD")
val dbgPath: String? = signingProps.getProperty("debugStoreFile") ?: System.getenv("PCOIN_DEBUG_KEYSTORE")
@Suppress("unused") // read by the release signing guard in buildTypes below
val releaseKeyAvailable: Boolean = ksPath != null && ksPass != null && file(ksPath).exists()

android {
    // Needed for BuildConfig.DEBUG, which gates the fleet provisioning path in
    // MainActivity. AGP 8 stopped generating BuildConfig unless asked.
    buildFeatures { buildConfig = true }

    namespace = "org.pcoin.miner"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
        targetSdk = 34

        // Deliberately NO ndk.abiFilters here: the prebuilt PCoin binaries only
        // exist for arm64-v8a and filtering must never drop that ABI.
    }

    // No `splits { abi { ... } }` block anywhere: a per-ABI split would produce
    // an APK that omits arm64-v8a native libs.

    // TWO APPS, ONE SOURCE TREE.
    //
    // `miner` is the existing app, unchanged. `wallet` is the same wallet and
    // the same bundled node WITHOUT mining -- possible at all because PCoin's
    // entire chain is about 1 MB, so a phone can carry a full node and owe
    // nothing to a trusted server.
    //
    // Flavours rather than a second module, deliberately: the shared code is
    // ~11k lines of money-handling doctrine paid for in real incidents, this
    // tree has NO CI, and a fork would drift silently. Flavours also leave
    // jniLibs where they are, whose failure mode is a silently stripped
    // libbitcoind.so that installs fine and dies on exec.
    //
    // `namespace` stays org.pcoin.miner for BOTH. It is the R/BuildConfig
    // package, not the app identity; changing it would rename 29 source files
    // for nothing. `applicationId` is what makes them different apps.
    flavorDimensions += "role"

    productFlavors {
        create("miner") {
            dimension = "role"
            // Renamed from org.pcoin.miner on 2026-08-06, deliberately and once.
            //
            // Android treats a changed applicationId as a DIFFERENT app, so
            // every phone had to be uninstalled -- which destroys the wallet in
            // app-private data. That was acceptable only because it was done as
            // a planned migration: every wallet, seed blob and prefs file was
            // backed up to D:\pc.am\wallet-backups first, the treasury seed had
            // already been restored onto a separate phone, and the coins left
            // behind were immature coinbase worth a few hundred PCN.
            //
            // It is NOT free to do again. Once these phones have mined for a
            // day they hold real balances, and there is no second free window.
            applicationId = "am.pc.pcoinminer"

            // BUMP THIS ON EVERY BUILD THAT LEAVES THIS MACHINE.
            //
            // It stayed at 1 across several different APKs, so two phones
            // running genuinely different binaries both reported 0.1.0/1 and
            // nothing could tell them apart. One of them sat on a build that
            // predated the "Skip for now" button and was stuck in setup, mining
            // nothing, for a day -- invisible precisely because the version said
            // it was up to date.
            //
            // Comparing APK size or sha256 is the reliable check; the version is
            // only as good as this line.
            // Reset to 1 with the new applicationId: this is a new app as far as
            // Android is concerned, and carrying 2 over would claim an upgrade
            // history it does not have.
            versionCode = 2
            versionName = "0.3.1"

            buildConfigField("boolean", "MINING", "true")
            // The miner keeps 9443. This half of the change is a provable no-op
            // on the fleet.
            buildConfigField("int", "RPC_PORT", "9443")
        }

        create("wallet") {
            dimension = "role"
            // Free to choose: this app has never been installed anywhere, so
            // there is no wallet on any device to strand. Contrast the miner
            // above, whose id cannot move without an uninstall, and an
            // uninstall destroys the wallet in app-private data.
            //
            // NOTE this is the APP ID, not the Kotlin package. `namespace`
            // stays org.pcoin.miner for both flavours because it is only the
            // R/BuildConfig package; renaming it would touch 29 source files
            // and buy nothing a user can see.
            applicationId = "am.pc.pcoinwallet"
            // 0.2.0: the address book. Bumped on the wallet only -- the miner's
            // APK gains the AddressBook classes but nothing in it reaches them,
            // so its behaviour is byte-for-byte the same decision it was.
            versionCode = 3
            versionName = "0.2.0"

            buildConfigField("boolean", "MINING", "false")
            // The ONLY genuine collision between the two apps. bitcoind is
            // started with listen=0 so P2P 9444 is never bound, and datadirs,
            // Keystore aliases, prefs files and notification channels are all
            // per-package already. Loopback RPC is the one shared resource.
            buildConfigField("int", "RPC_PORT", "9543")
        }
    }

    // Release signing. The keystore lives OUTSIDE the repo and its location and
    // password come from signing.properties (also outside version control) or
    // from the environment, so neither is ever committed.
    //
    // This key is irreplaceable: Android refuses to upgrade an app signed with a
    // different key, so losing it would force every user to uninstall — and an
    // uninstall destroys the wallet stored in app data.
    val signingProps = Properties().apply {
        val f = rootProject.file("signing.properties")
        if (f.exists()) f.inputStream().use { load(it) }
    }
    val ksPath = signingProps.getProperty("storeFile") ?: System.getenv("PCOIN_KEYSTORE")
    val ksPass = signingProps.getProperty("storePassword") ?: System.getenv("PCOIN_KEYSTORE_PASSWORD")

    // The DEBUG key matters just as much as the release one here, because the
    // fleet phones run debug-signed builds and their wallets live in app data.
    //
    // Gradle's default is ~/.android/debug.keystore. That file was lost and
    // silently regenerated on 2026-08-04, which produced a build Android refused
    // to install over the existing one ("signatures do not match"). The only way
    // through would have been an uninstall, and an uninstall destroys the wallet
    // -- on a phone with no recovery phrase, that is the coins.
    //
    // So the debug key is pinned to a copy of the ORIGINAL keystore kept outside
    // the repo, exactly like the release key. If it is ever missing, the build
    // still works but silently falls back to the regenerated default, so verify
    // the signer before shipping:
    //   apksigner verify --print-certs app-debug.apk
    // must report SHA-256 de1fd65053b2448d6541c01c045b599d68344e71f82eb854895ee5cea8a510d8
    val dbgPath = signingProps.getProperty("debugStoreFile") ?: System.getenv("PCOIN_DEBUG_KEYSTORE")

    signingConfigs {
        if (ksPath != null && ksPass != null && file(ksPath).exists()) {
            create("release") {
                storeFile = file(ksPath)
                storePassword = ksPass
                keyAlias = signingProps.getProperty("keyAlias") ?: "pcoin"
                keyPassword = signingProps.getProperty("keyPassword") ?: ksPass
            }
        }
        if (dbgPath != null && file(dbgPath).exists()) {
            getByName("debug") {
                storeFile = file(dbgPath)
                storePassword = signingProps.getProperty("debugStorePassword") ?: "android"
                keyAlias = signingProps.getProperty("debugKeyAlias") ?: "androiddebugkey"
                keyPassword = signingProps.getProperty("debugKeyPassword") ?: "android"
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
        getByName("release") {
            isMinifyEnabled = false
            // Fall back to the debug key only when no release keystore is
            // configured, so a fresh clone can still build something runnable.
            //
            // Loudly, though. A debug-signed "release" APK installs and runs
            // perfectly and is indistinguishable at a glance, but Android will
            // refuse to upgrade a properly-signed build over it later -- and the
            // only recovery is an uninstall, which destroys the wallet in
            // app-private storage. This warning is the guard the hoisted
            // `releaseKeyAvailable` at the top of this file was declared for; it
            // sat unused, so the fallback was completely silent.
            signingConfig = signingConfigs.findByName("release")
                ?: signingConfigs.getByName("debug").also {
                    logger.warn(
                        "\n" +
                            "**********************************************************************\n" +
                            "  PCoin: RELEASE build is being signed with the DEBUG key.\n" +
                            "  No usable release keystore was found.\n" +
                            "    signing.properties storeFile : ${ksPath ?: "(not set)"}\n" +
                            "    exists                       : ${ksPath?.let { p -> file(p).exists() } ?: false}\n" +
                            "  Do NOT ship this APK. See contrib/android/README.md - Signing.\n" +
                            "**********************************************************************\n"
                    )
                }
        }
    }

    packaging {
        jniLibs {
            // libbitcoind.so / libbitcoincli.so are complete PCoin executables
            // (ET_DYN PIE), not libraries. Never let AGP run `strip` on them.
            keepDebugSymbols += setOf("**/libbitcoind.so", "**/libbitcoincli.so")
            // extractNativeLibs=true -> installer unpacks them into
            // applicationInfo.nativeLibraryDir, which is on an exec-permitted
            // mount. This is the only way to exec a binary on API 29+.
            useLegacyPackaging = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")

    // The BIP39/BIP32/secp256k1 stack under org.pcoin.miner.wallet has no
    // Android imports precisely so it can be run on a plain JVM against the
    // published BIP39, BIP32 and BIP84 test vectors. Two independent
    // implementations agreeing on published vectors is the only real evidence
    // that a phrase generated here can be restored somewhere else.
    testImplementation("junit:junit:4.13.2")
}
