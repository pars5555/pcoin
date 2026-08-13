package org.pcoin.miner

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Scan a QR code and hand the text back. Sends nothing.
 *
 * The result of this screen is a STRING IN A TEXT FIELD, and that is the whole
 * of its authority. [PaymentUri] decides what the text means, the node still
 * validates the address in prepareSend, and the review step still shows the
 * destination that was actually built. A camera cannot make a bad address good,
 * and nothing here tries to.
 *
 * FIRE ONCE. A decode arrives on a background thread while frames keep coming,
 * so `done` latches: without it the same code decodes several times and
 * setResult/finish runs on a dead activity, or worse, a second result overwrites
 * the first after the caller has already read it.
 *
 * EVERY FRAME IS CLOSED. ImageAnalysis hands out a fixed pool of buffers; an
 * ImageProxy that is not closed stalls the pipeline within a few frames and the
 * preview freezes with no error anywhere. Hence the try/finally.
 */
class ScanActivity : AppCompatActivity() {

    private lateinit var previewView: PreviewView
    private lateinit var status: TextView
    private lateinit var torchButton: Button

    private var analysisExecutor: ExecutorService? = null
    private var provider: ProcessCameraProvider? = null
    private var camera: androidx.camera.core.Camera? = null
    private var torchOn = false

    private val done = AtomicBoolean(false)

    private val reader = MultiFormatReader().apply {
        setHints(
            mapOf(
                // QR only. Letting it hunt for every 1-D format as well makes
                // each frame slower and invites a barcode on the packaging to
                // be read as if it were a payment.
                DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                DecodeHintType.TRY_HARDER to true,
            )
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_scan)
        previewView = findViewById(R.id.scan_preview)
        status = findViewById(R.id.scan_status)
        torchButton = findViewById(R.id.scan_torch)
        findViewById<Button>(R.id.scan_cancel).setOnClickListener { finish() }
        torchButton.setOnClickListener { toggleTorch() }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED
        ) {
            start()
        } else {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_CAMERA) return
        if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            start()
        } else {
            // Refused is a complete answer, not an error. Say what it costs and
            // leave; the address can still be pasted or picked from the book.
            status.setText(R.string.scan_no_permission)
            torchButton.visibility = View.GONE
        }
    }

    private fun start() {
        status.setText(R.string.scan_hint)
        val executor = Executors.newSingleThreadExecutor()
        analysisExecutor = executor
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val p = try {
                future.get()
            } catch (t: Throwable) {
                Log.w(TAG, "camera provider: ${t.javaClass.simpleName}")
                status.setText(R.string.scan_no_camera)
                return@addListener
            }
            provider = p
            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }
            val analysis = ImageAnalysis.Builder()
                // Only the newest frame matters. Queuing them adds latency and
                // decodes a code the camera is no longer pointing at.
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also { it.setAnalyzer(executor) { image -> analyse(image) } }
            try {
                p.unbindAll()
                camera = p.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                torchButton.visibility =
                    if (camera?.cameraInfo?.hasFlashUnit() == true) View.VISIBLE else View.GONE
            } catch (t: Throwable) {
                Log.w(TAG, "bind failed: ${t.javaClass.simpleName}: ${t.message}")
                status.setText(R.string.scan_no_camera)
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun analyse(image: ImageProxy) {
        try {
            if (done.get()) return
            val text = decode(image) ?: return
            // Latch before touching the UI: frames are still arriving.
            if (!done.compareAndSet(false, true)) return
            runOnUiThread { deliver(text) }
        } finally {
            image.close()
        }
    }

    /**
     * Decode the luminance plane.
     *
     * `rowStride` is passed as the data width, not `image.width`. The Y plane is
     * padded to a hardware-friendly stride on many devices, and treating the
     * padding as pixels shears the image so nothing ever decodes -- on some
     * phones only, which makes it look like a camera problem rather than an
     * arithmetic one.
     */
    private fun decode(image: ImageProxy): String? {
        val plane = image.planes.firstOrNull() ?: return null
        val buffer = plane.buffer
        val data = ByteArray(buffer.remaining())
        buffer.get(data)
        val source = PlanarYUVLuminanceSource(
            data,
            plane.rowStride,
            image.height,
            0,
            0,
            image.width,
            image.height,
            false,
        )
        return try {
            reader.decodeWithState(BinaryBitmap(HybridBinarizer(source)))?.text
        } catch (t: Throwable) {
            // NotFoundException on most frames: that is what "no code in view"
            // looks like, not a failure worth reporting.
            null
        } finally {
            reader.reset()
        }
    }

    private fun deliver(text: String) {
        setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_TEXT, text))
        finish()
    }

    private fun toggleTorch() {
        val c = camera ?: return
        torchOn = !torchOn
        try {
            c.cameraControl.enableTorch(torchOn)
        } catch (t: Throwable) {
            Log.w(TAG, "torch: ${t.javaClass.simpleName}")
        }
        torchButton.setText(if (torchOn) R.string.scan_torch_off else R.string.scan_torch_on)
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            provider?.unbindAll()
        } catch (t: Throwable) {
            Log.w(TAG, "unbind: ${t.javaClass.simpleName}")
        }
        analysisExecutor?.shutdown()
    }

    companion object {
        const val EXTRA_TEXT = "org.pcoin.miner.extra.SCANNED_TEXT"
        private const val REQ_CAMERA = 4711
        private const val TAG = "PCoinScan"

        fun intent(ctx: Context): Intent = Intent(ctx, ScanActivity::class.java)
    }
}
