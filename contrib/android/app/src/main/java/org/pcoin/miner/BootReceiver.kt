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
