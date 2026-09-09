package org.pcoin.miner

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Settings: what is wrong, then what is adjustable.
 *
 * WHY THE WARNINGS COME FIRST AND WHY THEY ARE HERE AT ALL. A wallet with no
 * running node has no balance to show -- there is no server behind it -- so
 * Android's power features are not a footnote, they are the difference between
 * an instant balance and a four-minute wait. The owner ran for a day with the
 * node being killed nightly because the one warning that said so was a card
 * near the BOTTOM of the home screen. Now the home screen carries only a banner
 * that cannot be scrolled past, and every detail and every fix lives here.
 *
 * Each row hands off to a SYSTEM screen. This app cannot grant itself any of
 * these, so the honest shape is: name the problem, say what it costs, open the
 * right page. Nothing is auto-fixed and nothing is nagged twice.
 */
class SettingsActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var warnRows: LinearLayout
    private lateinit var warnSummary: TextView
    private lateinit var feeNormal: Button
    private lateinit var feeFast: Button
    private lateinit var feeVeryFast: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        setContentView(R.layout.activity_settings)
        padForSystemBars()

        warnRows = findViewById(R.id.set_warn_rows)
        warnSummary = findViewById(R.id.set_warn_summary)
        feeNormal = findViewById(R.id.set_fee_normal)
        feeFast = findViewById(R.id.set_fee_fast)
        feeVeryFast = findViewById(R.id.set_fee_very_fast)

        feeNormal.setOnClickListener { setTier(ForwardPolicy.FeeTier.NORMAL) }
        feeFast.setOnClickListener { setTier(ForwardPolicy.FeeTier.FAST) }
        feeVeryFast.setOnClickListener { setTier(ForwardPolicy.FeeTier.VERY_FAST) }
        markTierButtons()

        findViewById<TextView>(R.id.set_version).text =
            getString(R.string.set_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE)
    }

    override fun onResume() {
        super.onResume()
        // Re-read every time. The owner leaves this screen to change a system
        // setting and comes straight back; the list must reflect what they just
        // did, not what was true when the activity was created.
        renderWarnings()
        // The hibernation status resolves asynchronously, so redraw when it
        // lands. Posting to the view keeps the callback on the main thread.
        WalletWarnings.refreshUnusedAppStatus(this) {
            warnRows.post { renderWarnings() }
        }
    }

    private fun renderWarnings() {
        val list = WalletWarnings.all(this)
        warnRows.removeAllViews()
        if (list.isEmpty()) {
            warnSummary.text = getString(R.string.set_warn_none)
            return
        }
        warnSummary.text = resources.getQuantityString(R.plurals.set_warn_some, list.size, list.size)
        val inflater = LayoutInflater.from(this)
        for (w in list) {
            val v = inflater.inflate(R.layout.row_warning, warnRows, false)
            v.findViewById<TextView>(R.id.warn_title).text = getString(w.titleRes)
            v.findViewById<TextView>(R.id.warn_body).text = getString(w.bodyRes)
            val action = v.findViewById<Button>(R.id.warn_action)
            action.text = getString(w.actionRes)
            action.setOnClickListener { WalletWarnings.fix(this, w) }
            warnRows.addView(v)
        }
    }

    // ------------------------------------------------------- sending speed

    private fun currentTier(): ForwardPolicy.FeeTier = try {
        ForwardPolicy.FeeTier.valueOf(prefs.defaultFeeTier)
    } catch (t: IllegalArgumentException) {
        // An unreadable preference falls to the cheapest tier, never the
        // dearest: the safe direction for a fee we cannot read is down.
        ForwardPolicy.FeeTier.NORMAL
    }

    private fun setTier(tier: ForwardPolicy.FeeTier) {
        prefs.defaultFeeTier = tier.name
        markTierButtons()
    }

    private fun markTierButtons() {
        val cur = currentTier()
        val pairs = listOf(
            ForwardPolicy.FeeTier.NORMAL to feeNormal,
            ForwardPolicy.FeeTier.FAST to feeFast,
            ForwardPolicy.FeeTier.VERY_FAST to feeVeryFast,
        )
        for ((tier, button) in pairs) {
            val on = tier == cur
            // Filled, not a difference in alpha. An alpha-only selected state
            // shipped once on the send screen and was invisible on a real phone.
            button.setBackgroundResource(if (on) R.drawable.btn_primary else R.drawable.btn_ghost)
            button.setTextColor(
                resources.getColor(if (on) R.color.on_brand else R.color.brand, theme),
            )
        }
    }

    @Suppress("unused")
    private fun unusedView(): View = warnRows
}
