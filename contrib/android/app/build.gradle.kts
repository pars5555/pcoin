import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    // Needed for BuildConfig.DEBUG, which gates the fleet provisioning path in
    // MainActivity. AGP 8 stopped generating BuildConfig unless asked.
    buildFeatures { buildConfig = true }

    namespace = "org.pcoin.miner"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.pcoin.miner"
        minSdk = 24
        targetSdk = 34
        // BUMP THIS ON EVERY BUILD THAT LEAVES THIS MACHINE.
        //
        // It stayed at 1 across several different APKs, so two phones running
        // genuinely different binaries both reported 0.1.0/1 and nothing could
        // tell them apart. One of them sat on a build that predated the "Skip
        // for now" button and was stuck in setup, mining nothing, for a day --
        // invisible precisely because the version said it was up to date.
        //
        // Comparing APK size or sha256 is the reliable check; the version is
        // only as good as this line.
        versionCode = 2
        versionName = "0.2.0"

        // Deliberately NO ndk.abiFilters here: the prebuilt PCoin binaries only
        // exist for arm64-v8a and filtering must never drop that ABI.
    }

    // No `splits { abi { ... } }` block anywhere: a per-ABI split would produce
    // an APK that omits arm64-v8a native libs.

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
            signingConfig = signingConfigs.findByName("release")
                ?: signingConfigs.getByName("debug")
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
