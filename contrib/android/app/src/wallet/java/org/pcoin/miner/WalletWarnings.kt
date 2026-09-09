package org.pcoin.miner

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.PackageManagerCompat
import androidx.core.content.UnusedAppRestrictionsConstants

/**
 * The things Android is doing to this app that stop it working properly, and
 * how to send the user to the screen that fixes each one.
 *
 * WHY THIS EXISTS AS A LIST RATHER THAN A CARD PER PROBLEM. A wallet whose node
 * is not running has no balance to show: there is no server to fall back on, so
 * every one of these settings is the difference between "your balance is there
 * when you open the app" and "wait several minutes". They also arrive one at a
 * time, months apart, as OEMs add new power features -- the owner hit battery
 * optimisation first and "Pause app activity if unused" second. Enumerating
 * them in one place means the next one is a row here rather than another
 * bespoke card nobody finds.
 *
 * EVERY CHECK FAILS OPEN. If the system will not answer -- a missing service, an
 * OEM that throws, an API that does not exist on this release -- the warning is
 * NOT shown. An unanswerable question is not a problem found (§7.1); showing a
 * warning we cannot substantiate would train the owner to dismiss the badge,
 * which is worse than showing nothing.
 */
object WalletWarnings {

    /** One actionable problem. [fix] opens the system screen that resolves it. */
    data class Warning(
        val id: Id,
        val titleRes: Int,
        val bodyRes: Int,
        val actionRes: Int,
    ) {
        enum class Id { BATTERY, UNUSED_APP, NOTIFICATIONS }
    }

    fun all(context: Context): List<Warning> {
        val out = ArrayList<Warning>(3)
        if (!batteryExempt(context)) {
            out.add(
                Warning(
                    Warning.Id.BATTERY,
                    R.string.set_warn_battery_title,
                    R.string.set_warn_battery_body,
                    R.string.set_warn_battery_action,
                ),
            )
        }
        if (unusedAppRestricted(context)) {
            out.add(
                Warning(
                    Warning.Id.UNUSED_APP,
                    R.string.set_warn_unused_title,
                    R.string.set_warn_unused_body,
                    R.string.set_warn_unused_action,
                ),
            )
        }
        if (!notificationsAllowed(context)) {
            out.add(
                Warning(
                    Warning.Id.NOTIFICATIONS,
                    R.string.set_warn_notif_title,
                    R.string.set_warn_notif_body,
                    R.string.set_warn_notif_action,
                ),
            )
        }
        return out
    }

    fun count(context: Context): Int = all(context).size

    // ------------------------------------------------------------- the checks

    private fun batteryExempt(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return try {
            pm.isIgnoringBatteryOptimizations(context.packageName)
        } catch (t: Throwable) {
            true
        }
    }

    /**
     * "Pause app activity if unused" (Android's app hibernation). When it is on,
     * Android may stop the app and revoke its permissions after a few months of
     * not being opened -- which for a wallet means the node stops and the next
     * open is a long catch-up. The owner found this one himself.
     *
     * getUnusedAppRestrictionsStatus is asynchronous; this reads the resolved
     * value only if it is already available, because a warning list must render
     * synchronously. [refreshUnusedAppStatus] is what fills the cache.
     */
    private fun unusedAppRestricted(context: Context): Boolean = unusedCache == true

    @Volatile
    private var unusedCache: Boolean? = null

    /**
     * Resolve the hibernation status in the background, then run [then] on the
     * caller's thread so the screen can redraw. Safe to call repeatedly.
     */
    fun refreshUnusedAppStatus(context: Context, then: () -> Unit) {
        val future = try {
            PackageManagerCompat.getUnusedAppRestrictionsStatus(context.applicationContext)
        } catch (t: Throwable) {
            unusedCache = false
            then()
            return
        }
        future.addListener(
            {
                unusedCache = try {
                    when (future.get()) {
                        UnusedAppRestrictionsConstants.API_30_BACKPORT,
                        UnusedAppRestrictionsConstants.API_30,
                        UnusedAppRestrictionsConstants.API_31,
                        -> true
                        // DISABLED means the owner has already turned it off;
                        // ERROR and FEATURE_NOT_AVAILABLE mean we do not know,
                        // and not knowing is not a problem found.
                        else -> false
                    }
                } catch (t: Throwable) {
                    false
                }
                then()
            },
            { r -> r.run() },
        )
    }

    private fun notificationsAllowed(context: Context): Boolean = try {
        NotificationManagerCompat.from(context).areNotificationsEnabled()
    } catch (t: Throwable) {
        true
    }

    // -------------------------------------------------------------- the fixes

    /** Open the system screen that resolves [warning]. Never throws. */
    fun fix(activity: Activity, warning: Warning) {
        when (warning.id) {
            Warning.Id.BATTERY -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
                if (!start(activity, Intent(
                        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:${activity.packageName}"),
                    ))
                ) {
                    start(activity, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                }
            }

            Warning.Id.UNUSED_APP -> {
                // The documented route. It lands on this app's own page, where
                // the toggle lives; there is no direct deep link to the toggle.
                val i = try {
                    androidx.core.content.IntentCompat
                        .createManageUnusedAppRestrictionsIntent(activity, activity.packageName)
                } catch (t: Throwable) {
                    null
                }
                if (i == null || !start(activity, i)) appDetails(activity)
            }

            Warning.Id.NOTIFICATIONS -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    val i = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
                    if (start(activity, i)) return
                }
                appDetails(activity)
            }
        }
    }

    private fun appDetails(activity: Activity) {
        start(
            activity,
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:${activity.packageName}"),
            ),
        )
    }

    private fun start(activity: Activity, intent: Intent): Boolean = try {
        activity.startActivity(intent)
        true
    } catch (t: Throwable) {
        false
    }

    @Suppress("unused")
    private fun unusedPm(context: Context): PackageManager = context.packageManager
}
