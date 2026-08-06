package org.pcoin.miner

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Starts mining again after the phone reboots, if the user left it switched on.
 *
 * "Always mining" has to survive a restart, and phones restart often -- updates,
 * battery runs flat, or the thermal shutdown this app is built to avoid. Without
 * this, a rebooted phone sits idle until somebody notices and opens the app.
 *
 * The gates still apply: the service checks charging and temperature before it
 * hashes anything, exactly as it does on a manual start.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED &&
            action != "android.intent.action.QUICKBOOT_POWERON"
        ) {
            return
        }
        val prefs = Prefs(context)

        if (!BuildConfig.MINING) {
            // A WALLET still needs its node after a reboot or an upgrade.
            //
            // The gate below is `!prefs.miningEnabled`, and in a build with
            // mining compiled out that pref can never be true -- both writers of
            // `true` sit inside `if (BuildConfig.MINING)`. So this receiver used
            // to return early for the wallet on BOTH triggers, leaving bitcoind
            // down after a reboot AND after MY_PACKAGE_REPLACED, which is the
            // fleet's own `adb install -r` upgrade path. A wallet with no node
            // shows no balance, cannot receive, and stops evaluating forwarding.
            //
            // prepare() brings the node up without touching miningEnabled, which
            // is the user's own intent and must not be written by a lifecycle
            // event. A wallet with no address yet is still worth a node: it has
            // a chain to sync and coins may already be on their way to it.
            Log.i(TAG, "boot ($action): wallet build, bringing the node up")
            try {
                MinerService.prepare(context)
            } catch (t: Throwable) {
                Log.w(TAG, "boot prepare refused: ${t.message}")
            }
            return
        }

        if (!prefs.miningEnabled) {
            Log.i(TAG, "boot: mining is switched off, staying idle")
            return
        }
        if (prefs.payoutAddress == null) {
            // No wallet has been set up, so there is nowhere to pay rewards.
            // Starting the node here would only burn battery to sit at
            // NEEDS_SETUP, and the user cannot resolve it without opening the
            // app anyway.
            Log.i(TAG, "boot: no payout address yet, staying idle until setup")
            return
        }
        Log.i(TAG, "boot ($action): resuming mining")
        try {
            MinerService.start(context)
        } catch (t: Throwable) {
            // Android 12+ forbids starting a foreground service from the
            // background in some states; the app will start it when opened.
            Log.w(TAG, "boot start refused: ${t.message}")
        }
    }

    companion object {
        private const val TAG = "PCoinBoot"
    }
}
