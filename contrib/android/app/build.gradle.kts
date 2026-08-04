import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.pcoin.miner"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.pcoin.miner"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

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

    signingConfigs {
        if (ksPath != null && ksPass != null && file(ksPath).exists()) {
            create("release") {
                storeFile = file(ksPath)
                storePassword = ksPass
                keyAlias = signingProps.getProperty("keyAlias") ?: "pcoin"
                keyPassword = signingProps.getProperty("keyPassword") ?: ksPass
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
