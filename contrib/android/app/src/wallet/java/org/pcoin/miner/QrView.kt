package org.pcoin.miner

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View

/**
 * Draws a [Qr] symbol.
 *
 * Always black on white, never themed. A dark-mode QR with inverted colours is
 * unreadable to a good many scanners, which assume dark modules on a light
 * background, and the four-module quiet zone is drawn as part of the view for
 * the same reason -- a code butted against a coloured card is a code that does
 * not scan. The white plate is therefore deliberate, not an oversight in the
 * dark theme.
 *
 * Modules are drawn on integer pixel boundaries computed from a floor-divided
 * scale, so no module is a fraction of a pixel wider than its neighbour. Letting
 * the canvas scale a bitmap instead produces exactly the soft edges that make a
 * camera hunt.
 */
class QrView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    private val dark = Paint().apply { color = Color.BLACK; isAntiAlias = false }
    private val light = Paint().apply { color = Color.WHITE; isAntiAlias = false }

    private var matrix: Qr.Matrix? = null

    /** @param text null or unencodable hides the view rather than drawing junk. */
    fun setContent(text: String?) {
        matrix = text?.takeIf { it.isNotBlank() }?.let { Qr.encode(it) }
        visibility = if (matrix == null) GONE else VISIBLE
        requestLayout()
        invalidate()
    }

    override fun onMeasure(widthSpec: Int, heightSpec: Int) {
        // Square, and as large as the width allows.
        val w = MeasureSpec.getSize(widthSpec)
        setMeasuredDimension(w, w)
    }

    override fun onDraw(canvas: Canvas) {
        val m = matrix ?: return
        val modules = m.size + 2 * QUIET
        // Integer module size; the remainder becomes a slightly larger margin
        // rather than uneven modules.
        val scale = minOf(width, height) / modules
        if (scale <= 0) return
        val drawn = scale * modules
        val ox = (width - drawn) / 2
        val oy = (height - drawn) / 2

        canvas.drawRect(
            ox.toFloat(), oy.toFloat(), (ox + drawn).toFloat(), (oy + drawn).toFloat(), light,
        )
        for (y in 0 until m.size) {
            for (x in 0 until m.size) {
                if (!m[x, y]) continue
                val left = ox + (x + QUIET) * scale
                val top = oy + (y + QUIET) * scale
                canvas.drawRect(
                    left.toFloat(), top.toFloat(),
                    (left + scale).toFloat(), (top + scale).toFloat(), dark,
                )
            }
        }
    }

    private companion object {
        /** The spec's quiet zone. Fewer than four modules and scanners struggle. */
        const val QUIET = 4
    }
}
