package org.pcoin.miner

import android.app.Activity
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Keep a screen's content clear of the status bar, the navigation bar and the
 * on-screen keyboard.
 *
 * WHY THIS IS NEEDED AT ALL, since every screen already declares
 * `windowSoftInputMode="adjustResize"`: from **targetSdk 35** Android draws
 * every app edge-to-edge and stops resizing the window for the system bars or
 * the IME. `adjustResize` quietly becomes a no-op. The symptoms are the two
 * this fixes, and they were both reported on a Z Flip 5:
 *
 *   * the bottom button (Send, Save, Restore) sits UNDER the navigation bar,
 *     so tapping it hits the system instead of the app;
 *   * tapping a text field opens the keyboard OVER the field being typed into,
 *     because the window no longer shrinks.
 *
 * Padding `android.R.id.content` rather than each layout's own root keeps this
 * layout-agnostic: no screen needs an id on its root, and a screen added later
 * gets the behaviour by calling one function.
 *
 * The insets are CONSUMED. Nothing in this app draws behind the bars on
 * purpose, so passing them down would only invite a child to pad a second time
 * and double the gap.
 */
fun Activity.padForSystemBars() {
    val content = findViewById<View>(android.R.id.content) ?: return
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
        // systemBars covers status + navigation (and the 3-button bar's taller
        // variant); ime is the keyboard. Taking the union means the padding is
        // whichever is currently larger at the bottom, which is exactly right:
        // when the keyboard is up it already covers the navigation bar.
        val pad = insets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime()
        )
        v.setPadding(pad.left, pad.top, pad.right, pad.bottom)
        WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
}
