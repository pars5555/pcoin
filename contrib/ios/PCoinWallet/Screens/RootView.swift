import SwiftUI

/// Which screen the app opens on.
///
/// A wallet with no wallet is a setup problem, not a home screen -- the same
/// rule the Android `MainActivity` opens with.
///
/// THE SETUP FLOW OWNS ITS OWN EXIT, and that is not a style choice. This view
/// used to switch on `store.hasWallet` directly, and `createWallet()` sets that
/// flag the instant the key is stored -- which is BEFORE the twelve words have
/// been shown. The result was a brand-new wallet whose recovery phrase was
/// generated and then never displayed: the setup screen was swapped for the home
/// screen the moment the key existed, and the one screen a new wallet cannot
/// skip was skipped. Caught on a simulator on 2026-09-10 by a UI test that
/// printed what was actually on screen instead of only what was missing.
///
/// So the decision is made once, on appear, and only setup itself may clear it.
struct RootView: View {
    @EnvironmentObject private var store: WalletStore

    /// nil until the first appearance decides it. Never recomputed from
    /// `hasWallet` while setup is running.
    @State private var inSetup: Bool?

    var body: some View {
        Group {
            if inSetup ?? !store.hasWallet {
                NavigationStack {
                    SetupView(onFinished: { inSetup = false })
                }
            } else {
                MainView()
            }
        }
        .onAppear {
            store.refreshWalletPresence()
            if inSetup == nil { inSetup = !store.hasWallet }
        }
        .onChange(of: store.hasWallet) { has in
            // One direction only. A wallet REMOVED from Settings must send the
            // app back to setup; a wallet APPEARING must not take the setup
            // flow off screen, because that is exactly the bug above.
            if !has { inSetup = true }
        }
    }
}
