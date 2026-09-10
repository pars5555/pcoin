import SwiftUI
import PCoinKit

/// PCoin Wallet for iPhone.
///
/// A light client: keys and signing on the device, chain data over HTTP from
/// explorer.pc.am. It does NOT run a node, unlike the Android wallet, because
/// iOS forbids an app from exec-ing a separate executable and forbids JIT. That
/// one architectural difference is the reason for `ExplorerClient`,
/// `WalletScanner`, `Address` and `TxBuilder` -- everything the node used to do.
///
/// THERE IS NO MINER AND ONE MUST NEVER BE ADDED. Apple prohibits on-device
/// mining; the Android project compiles mining out of its wallet flavour and
/// there is no iOS equivalent to compile in.
@main
struct PCoinWalletApp: App {

    @StateObject private var store = WalletStore()
    /// The payment request currently being reviewed, if any.
    @State private var pendingRequest: PaymentRequest?

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                // Both doors into this screen. The custom scheme is what other
                // apps on the phone use; the universal link is what a Telegram
                // mini app uses, because it runs in a sandboxed iframe and
                // cannot navigate to a custom scheme at all. The hop page at
                // site/pay/index.html exists for exactly that.
                .onOpenURL { url in handle(url) }
                .onAppear {
                    #if DEBUG
                    // A UI test may hand the app a payment URI directly. It goes
                    // through `handle(_:)`, the SAME function `onOpenURL` calls,
                    // so `PaymentRequest` parsing, the refusal rules and
                    // `SignRequestView` are all exercised exactly as they are
                    // for a real link.
                    //
                    // What this does NOT exercise is iOS own scheme dispatch --
                    // that is proven separately by `xcrun simctl openurl`, which
                    // makes the system offer "Open in PCoin Wallet?". Driving
                    // that dialog from inside XCUITest goes through Safari and
                    // is flaky about keyboard focus, which is a property of
                    // Safari rather than of this app.
                    //
                    // Compiled out of every release build.
                    let args = ProcessInfo.processInfo.arguments
                    if let i = args.firstIndex(of: "-uiTestOpenURL"),
                       i + 1 < args.count,
                       let url = URL(string: args[i + 1]) {
                        handle(url)
                    }
                    #endif
                }
                .sheet(item: $pendingRequest) { request in
                    SignRequestView(request: request)
                        .environmentObject(store)
                }
        }
    }

    private func handle(_ url: URL) {
        // EVERYTHING goes through the review screen. Nothing is allowed to
        // reach the send form straight from a URL: the Android manifest has
        // always refused to export the send screen, and the comment there is
        // right -- "a payment screen that any other app can launch with extras
        // is a phishing surface".
        pendingRequest = PaymentRequest(url: url)
    }
}

/// A request that arrived from outside the app.
///
/// Carries the RAW text, deliberately. `SignRequestView` is the thing that
/// decides what it means, so that the parse and the refusal happen in one place
/// where they can be read together.
struct PaymentRequest: Identifiable {
    let id = UUID()
    let raw: String
    /// The host that sent us here, if the system said. Best effort and honest
    /// about it: an app can lie about this, so nothing claims more than "this
    /// came from outside", which is the part that is always true.
    let origin: String?

    init(url: URL) {
        // A universal link carries the request in the query, e.g.
        // https://pc.am/pay?to=pc1...&amount=1.5 . A custom-scheme URL is the
        // request itself.
        if url.scheme == "https" || url.scheme == "http" {
            let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let items = comps?.queryItems ?? []
            let to = items.first { $0.name == "to" || $0.name == "address" }?.value
            let amount = items.first { $0.name == "amount" }?.value
            if let to = to {
                var s = "pcoin:" + to
                if let a = amount, !a.isEmpty { s += "?amount=" + a }
                raw = s
            } else {
                // Nothing recognisable. Passed through unchanged so the review
                // screen refuses it and says so, rather than this initialiser
                // quietly inventing something.
                raw = url.absoluteString
            }
            origin = url.host
        } else {
            raw = url.absoluteString
            origin = nil
        }
    }

    init(raw: String, origin: String? = nil) {
        self.raw = raw
        self.origin = origin
    }
}
