import SwiftUI
import AVFoundation
import AudioToolbox
import PCoinKit

/// Scanning a QR code.
///
/// The camera and the decoder live here; `PaymentUri` decides what the decoded
/// TEXT means. That split is the same one the Android app makes, and it is what
/// lets every rule about what counts as an address be tested with no camera and
/// no device.
///
/// A SCAN IS A FASTER WAY TO FILL A TEXT FIELD AND NOTHING MORE. It does not
/// authorise anything, and the review step still shows the destination in full.
struct ScanView: View {

    let onScan: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var permission: Permission = .unknown
    @State private var torchOn = false

    private enum Permission { case unknown, granted, denied, noCamera }

    var body: some View {
        NavigationStack {
            ZStack {
                switch permission {
                case .granted:
                    CameraPreview(torchOn: torchOn) { text in
                        onScan(text)
                        dismiss()
                    }
                    .ignoresSafeArea()
                    VStack {
                        Spacer()
                        Text(S.scanHint)
                            .font(.footnote)
                            .padding(10)
                            .background(.ultraThinMaterial)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .padding(.bottom, 40)
                    }
                case .denied:
                    // Says what still works, rather than only what does not.
                    Text(S.scanNoPermission).padding(24).multilineTextAlignment(.center)
                case .noCamera:
                    Text(S.scanNoCamera).padding(24).multilineTextAlignment(.center)
                case .unknown:
                    ProgressView()
                }
            }
            .navigationTitle(S.scanTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(S.scanCancel) { dismiss() }
                }
                if permission == .granted {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(torchOn ? S.torchOff : S.torchOn) { torchOn.toggle() }
                    }
                }
            }
            .task { await requestAccess() }
        }
    }

    private func requestAccess() async {
        guard AVCaptureDevice.default(for: .video) != nil else {
            permission = .noCamera
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            permission = .granted
        case .notDetermined:
            permission = await AVCaptureDevice.requestAccess(for: .video) ? .granted : .denied
        default:
            permission = .denied
        }
    }
}

/// The AVFoundation session, wrapped for SwiftUI.
struct CameraPreview: UIViewControllerRepresentable {
    let torchOn: Bool
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerViewController {
        let vc = ScannerViewController()
        vc.onScan = onScan
        return vc
    }

    func updateUIViewController(_ vc: ScannerViewController, context: Context) {
        vc.setTorch(torchOn)
    }
}

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {

    var onScan: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    /// One code per presentation. A scanner that fires repeatedly can push the
    /// same request forward twice while somebody is still reading it.
    private var handled = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        preview = layer
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if !session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning { session.stopRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    func setTorch(_ on: Bool) {
        guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else { return }
        try? device.lockForConfiguration()
        device.torchMode = on ? .on : .off
        device.unlockForConfiguration()
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !handled,
              let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let text = obj.stringValue else { return }
        handled = true
        AudioServicesPlaySystemSound(1057)
        onScan?(text)
    }
}
