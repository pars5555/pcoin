import SwiftUI
import PCoinKit

/// Showing the twelve words back.
///
/// The unlock here is the Secure Enclave one, and it gates the KEY: the words
/// are ciphertext until the Enclave decrypts them, and the Enclave will not
/// decrypt without a fresh Face ID / Touch ID / passcode. There is no boolean in
/// this file that could be flipped to reveal them.
///
/// NO COPY BUTTON AND NO SHARE SHEET, deliberately. A recovery phrase in the
/// clipboard is a recovery phrase every app on the phone can read, and a phrase
/// in a share sheet is one keystroke from a chat window. The only way out of
/// this screen is a pen.
struct BackupView: View {

    @EnvironmentObject private var store: WalletStore
    @State private var words: [String]?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let w = words {
                    Text(S.phraseBody)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    LazyVGrid(
                        columns: [GridItem(.flexible()), GridItem(.flexible())],
                        spacing: 8
                    ) {
                        ForEach(Array(w.enumerated()), id: \.offset) { i, word in
                            HStack(spacing: 8) {
                                Text("\(i + 1)")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                                    .frame(width: 20, alignment: .trailing)
                                Text(word).font(.system(.body, design: .monospaced))
                                Spacer()
                            }
                            .padding(.vertical, 6)
                            .padding(.horizontal, 8)
                            .background(Color(.secondarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }

                    Button(S.backupHide) {
                        // Cleared from memory as soon as the screen is done with
                        // them. Best effort -- Swift strings are not wipeable --
                        // but the copy this view holds is the one that lives
                        // longest.
                        words = nil
                    }
                    .frame(maxWidth: .infinity)

                    if !store.prefs.phraseWrittenDown {
                        Button(S.setupConfirm) { store.prefs.phraseWrittenDown = true }
                            .buttonStyle(.borderedProminent)
                            .frame(maxWidth: .infinity)
                    }
                } else {
                    Text(S.backupRevealTitle).font(.title3.bold())
                    WarningBanner(text: S.backupRevealBody, tone: .stop)

                    if let e = error { ErrorLine(e) }

                    Button(busy ? S.refreshBusy : S.backupReveal) { reveal() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .frame(maxWidth: .infinity)
                        .disabled(busy)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(S.phraseTitle)
        .navigationBarTitleDisplayMode(.inline)
        // Hide the words when the app goes to the background, so they are not in
        // the app switcher snapshot.
        //
        // The single-parameter `onChange(of:perform:)` deliberately: the
        // two-parameter form is iOS 17+, and the deployment target here is 16.0
        // so the wallet reaches phones people actually still carry.
        .onChange(of: scenePhase) { phase in
            if phase != .active { words = nil }
        }
    }

    @Environment(\.scenePhase) private var scenePhase

    private func reveal() {
        error = nil
        busy = true
        do {
            words = try store.revealMnemonic()
        } catch {
            // A cancelled unlock resolves NOTHING. It does not mean there is no
            // phrase, and the message says so rather than implying the wallet
            // is gone.
            self.error = WalletStore.describe(error)
        }
        busy = false
    }
}
