package org.pcoin.miner

import android.content.Context
import java.io.File

/**
 * Locates the PCoin executables that ship inside the APK.
 *
 * Since API 29 the app's data directory is mounted noexec, so a binary copied
 * to filesDir can never be exec'd. The supported workaround, verified on device
 * (SM-F731U, Android 16 / API 36), is to ship the executables as APK
 * native-library entries (jniLibs/<abi>/lib*.so) with
 * android:extractNativeLibs="true". The installer unpacks them into
 * applicationInfo.nativeLibraryDir, which is exec-permitted and already 0755.
 *
 * Nothing here copies or chmods anything: the binaries are exec'd in place by a
 * plain ProcessBuilder.
 */
object NativeBinaries {

    /** APK entry name for bitcoind. */
    private const val BITCOIND_SO = "libbitcoind.so"

    /** APK entry name for bitcoin-cli. */
    private const val BITCOIN_CLI_SO = "libbitcoincli.so"

    fun nativeLibDir(context: Context): File =
        File(context.applicationInfo.nativeLibraryDir)

    fun bitcoind(context: Context): File = File(nativeLibDir(context), BITCOIND_SO)

    /**
     * The app itself talks JSON-RPC over loopback and never runs bitcoin-cli.
     * It is still shipped (1 MB) so the node can be poked by hand on device
     * during development:
     *
     *   <nativeLibraryDir>/libbitcoincli.so -datadir=<filesDir>/pcoin getcpuminerinfo
     */
    fun bitcoinCli(context: Context): File = File(nativeLibDir(context), BITCOIN_CLI_SO)

    /**
     * Blockchain data directory, inside the app's private storage.
     *
     * The app process has no HOME, so bitcoind would otherwise resolve its
     * default datadir to "/.pcoin" at the filesystem root and abort with
     * "create_directories: Read-only file system" before printing anything --
     * even for `-version`. EVERY invocation must pass -datadir.
     */
    fun dataDir(context: Context): File =
        File(context.filesDir, "pcoin").apply { mkdirs() }

    /** The `-datadir=` argument every invocation needs. */
    fun dataDirArg(context: Context): String = "-datadir=${dataDir(context).absolutePath}"
}
