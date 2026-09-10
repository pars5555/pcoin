import SwiftUI
import PCoinKit

/// Creating or restoring a wallet.
///
/// The twelve words are shown ONCE, at creation, and the app will not move on
/// until somebody says they have written them down. That claim is theirs and
/// nothing can check it -- which is why the home screen keeps offering the
/// backup card until they make it, and why `Prefs.phraseWrittenDown` is filed
/// under authoritative intent rather than derived display.
struct SetupView: View {

    /// Called when setup is genuinely finished -- after the twelve words have
    /// been shown and acknowledged, not when the key is stored.
    ///
    /// `RootView` passes this so the setup flow controls its own exit. Without
    /// it, the root switched to the home screen the instant `hasWallet` became
    /// true, which is before the phrase is displayed. See RootView.
    var onFinished: (() -> Void)?

    @EnvironmentObject private var store: WalletStore
    @Environment(\.dismiss) private var dismiss

    private enum Step: Equatable {
        case choose
        case showWords([String])
        case restore
        case done(String)
    }

    @State private var step: Step = .choose
    @State private var typed = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                switch step {
                case .choose: choose
                case .showWords(let w): showWords(w)
                case .restore: restore
                case .done(let a): done(a)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(S.setupTitle)
        .navigationBarTitleDisplayMode(.large)
    }

    // MARK: - choose

    private var choose: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(S.setupIntro)
                .fixedSize(horizontal: false, vertical: true)

            Button(S.setupCreate) {
                error = nil
                busy = true
                do {
                    let words = try store.createWallet()
                    step = .showWords(words)
                } catch {
                    self.error = WalletStore.describe(error)
                }
                busy = false
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .frame(maxWidth: .infinity)
            .disabled(busy)

            Button(S.setupRestore) { error = nil; step = .restore }
                .frame(maxWidth: .infinity)

            if let e = error { ErrorLine(e) }
        }
    }

    // MARK: - the words

    private func showWords(_ words: [String]) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(S.setupWriteTitle).font(.title3.bold())
            Text(S.setupWriteBody).fixedSize(horizontal: false, vertical: true)

            // Numbered, because the ORDER is part of the phrase and a list
            // somebody copies out of order restores nothing.
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                ForEach(Array(words.enumerated()), id: \.offset) { i, w in
                    HStack(spacing: 8) {
                        Text("\(i + 1)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(width: 20, alignment: .trailing)
                        Text(w).font(.system(.body, design: .monospaced))
                        Spacer()
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 8)
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }

            // No copy button and no screenshot helper, deliberately. A phrase in
            // the clipboard is a phrase every app on the phone can read.
            WarningBanner(text: S.backupRevealBody, tone: .stop)

            Button(S.setupConfirm) {
                store.prefs.phraseWrittenDown = true
                step = .done(store.receiveAddress ?? "")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: - restore

    private var restore: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(S.setupRestoreTitle).font(.title3.bold())
            Text(S.setupRestoreBody).fixedSize(horizontal: false, vertical: true)

            TextEditor(text: $typed)
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: 120)
                .padding(6)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            if let e = error { ErrorLine(e) }

            Button(S.setupRestoreAction) {
                error = nil
                let words = Bip39.splitWords(typed)
                do {
                    try store.restoreWallet(words: words)
                    step = .done(store.receiveAddress ?? "")
                } catch let e as WalletStore.RestoreError {
                    switch e {
                    case .wordCount(let n):
                        error = String(format: S.setupErrWordCount, "\(n)")
                    case .unknownWord(_, let w):
                        error = String(format: S.setupErrUnknownWord, w)
                    case .checksum:
                        // The checksum CANNOT say which word is wrong: it is a
                        // hash over the whole phrase. Pointing at one would be
                        // guessing, and a confident wrong hint sends somebody
                        // off correcting a word that was fine.
                        error = S.setupErrChecksum
                    }
                } catch {
                    self.error = WalletStore.describe(error)
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: - done

    private func done(_ address: String) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(S.doneCreated(address))
                .fixedSize(horizontal: false, vertical: true)
            Button(S.sendDone) {
                store.refreshWalletPresence()
                store.refresh()
                // Both, because this screen is reached two ways: as the root
                // (RootView, which needs the callback) and pushed from the
                // payment-request screen (which needs the dismiss).
                onFinished?()
                dismiss()
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .frame(maxWidth: .infinity)
        }
    }
}

struct ErrorLine: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
    }
}
