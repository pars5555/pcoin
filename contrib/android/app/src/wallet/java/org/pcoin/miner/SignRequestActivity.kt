package org.pcoin.miner

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * The one screen in this app that ANY other app is allowed to open.
 *
 * WHY IT EXISTS. The Telegram mini app (pc.am/app/) can show a balance and
 * compose a payment, but it must never hold a key: a key in a webview lives in
 * browser storage a cleared cache destroys, or on our servers, which would make
 * us a custodian of other people's money. So the key stays where it already is
 * -- AndroidKeyStore, created with setUserAuthenticationRequired(true), where
 * the hardware refuses to decrypt it without a device unlock -- and the request
 * travels instead, as a `pcoin:` URI.
 *
 * WHY IT IS NOT SendActivity. The manifest has always refused to export the
 * send screen, and the comment there is right: "a payment screen that any other
 * app can launch with extras is a phishing surface." Exporting it would let any
 * page on the phone put a destination and an amount in front of someone inside
 * the UI they trust, one tap from spending.
 *
 * So this screen is deliberately incapable of spending. It:
 *
 *   * parses the URI and REFUSES anything it cannot fully understand, rather
 *     than passing a half-read request forward,
 *   * shows the destination in monospace and the amount in the largest type on
 *     the screen, because a lookalike address is the attack and the eye is the
 *     only defence against it,
 *   * names where the request came from, and says plainly that it came from
 *     outside the app,
 *   * has no Send button at all. Its forward action opens the ordinary Send
 *     screen with the fields filled, where the existing review step and the
 *     Keystore unlock both still stand between this and any money moving.
 *
 * Nothing here is a substitute for those two gates. It is one more thing in
 * front of them, aimed at the case they do not cover: a person who is confirming
 * a payment they never meant to make.
 */
class SignRequestActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_sign_request)

        val amountView: TextView = findViewById(R.id.sr_amount)
        val addressView: TextView = findViewById(R.id.sr_address)
        val originView: TextView = findViewById(R.id.sr_origin)
        val noteView: TextView = findViewById(R.id.sr_note)
        val warnView: TextView = findViewById(R.id.sr_warn)
        val continueButton: Button = findViewById(R.id.sr_continue)
        val cancelButton: Button = findViewById(R.id.sr_cancel)

        cancelButton.setOnClickListener { finish() }

        // The raw URI. `intent.dataString` rather than any extra: extras are
        // whatever the caller felt like sending, while the data URI is the one
        // thing the intent-filter actually matched on.
        val raw = intent?.dataString
        val target = PaymentUri.parse(raw)

        // A request that cannot be parsed resolves NOTHING. It is not treated
        // as "no amount" or as a bare address -- it is refused, because a
        // half-understood payment request is exactly the shape of an attempt to
        // slip something past the reader.
        if (target == null || target.address.isBlank()) {
            amountView.text = getString(R.string.sr_unreadable_amount)
            addressView.text = raw?.take(200) ?: ""
            warnView.setText(R.string.sr_unreadable)
            continueButton.visibility = View.GONE
            return
        }

        originView.text = describeOrigin()

        val sat = target.amountSat
        amountView.text = if (sat != null && sat > 0) {
            Amounts.toPlainString(sat) + " PCN"
        } else {
            getString(R.string.sr_amount_unset)
        }
        addressView.text = target.address

        if (sat == null || sat <= 0) {
            // Say so rather than showing a confident zero. An amount nobody
            // asked for is not an amount of nothing.
            noteView.setText(R.string.sr_no_amount_note)
            noteView.visibility = View.VISIBLE
        }

        continueButton.setOnClickListener {
            // Hands over ONLY the address, through the same internal factory the
            // address book uses. The amount is shown here and typed there on
            // purpose: it is the number most worth a person's second look, and
            // one they have entered themselves is one they have read.
            startActivity(SendActivity.intentFor(this, target.address))
            finish()
        }
    }

    /**
     * Who asked. Best effort and honest about it: `referrer` is set by the
     * launching app and an app can lie about it, so this never claims more than
     * "this came from outside", which is the part that is always true.
     */
    private fun describeOrigin(): String {
        val from: Uri? = try { referrer } catch (_: Throwable) { null }
        val host = from?.host ?: from?.schemeSpecificPart
        return if (host.isNullOrBlank()) {
            getString(R.string.sr_origin_unknown)
        } else {
            getString(R.string.sr_origin_named, host)
        }
    }

    companion object {
        /** For tests and for anything in-app that wants to exercise the screen. */
        fun intentFor(ctx: Context, uri: String): Intent =
            Intent(ctx, SignRequestActivity::class.java).setData(Uri.parse(uri))
    }
}
