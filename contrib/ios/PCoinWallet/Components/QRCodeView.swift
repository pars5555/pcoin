import SwiftUI
import CoreImage
import CoreImage.CIFilterBuiltins

/// A QR code, generated on the device.
///
/// CoreImage, not a library and not a web service. A receive address rendered by
/// somebody else server is an address somebody else chose.
struct QRCodeView: View {
    let text: String

    var body: some View {
        if let image = QRCodeView.render(text) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .background(Color.white)
                .padding(8)
                .background(Color.white)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        } else {
            // Never a blank square pretending to be a code. If it could not be
            // rendered, the text is shown instead, because the text is the
            // thing that matters.
            Text(text)
                .font(.system(.caption2, design: .monospaced))
                .multilineTextAlignment(.center)
        }
    }

    static func render(_ text: String) -> UIImage? {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        // Medium correction: enough to survive a scuffed screen, without
        // inflating the code so far that a phone camera struggles.
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
