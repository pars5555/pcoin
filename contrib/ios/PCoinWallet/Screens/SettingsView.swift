import SwiftUI
import PCoinKit

/// Settings, and the honest diagnostics that belong with them.
///
/// The Android settings screen leads with "Needs your attention" and lists what
/// Android is doing to the app that stops it working -- battery optimisation,
/// app hibernation, blocked notifications. NONE OF THOSE EXIST ON iOS, so
/// reproducing them would be inventing problems. `WalletWarnings` here lists the
/// things that genuinely can be wrong for THIS app, and every check fails open:
/// a question the system will not answer is not a problem found.
struct SettingsView: View {

    @EnvironmentObject private var store: WalletStore
    @State private var showForget = false

    var body: some View {
        List {
            warningsSection

            Section(S.prefHeader) {
                Picker(S.feeTitle, selection: Binding(
                    get: { store.prefs.defaultFeeRate },
                    set: { store.prefs.defaultFeeRate = $0 }
                )) {
                    Text(S.feeNormal).tag(FeeRate.normal)
                    Text(S.feeFast).tag(FeeRate.fast)
                    Text(S.feeVeryFast).tag(FeeRate.veryFast)
                }
                Text(S.feeBody).font(.footnote).foregroundStyle(.secondary)
            }

            Section(S.phraseTitle) {
                NavigationLink(S.backupAction) { BackupView() }
                Text(S.phraseBody).font(.footnote).foregroundStyle(.secondary)
            }

            diagnosticsSection

            Section {
                Button("Remove this wallet from this iPhone", role: .destructive) {
                    showForget = true
                }
            } footer: {
                Text("The coins are on the chain, not on this phone. With your twelve words you can restore this wallet anywhere. WITHOUT them, removing it here is permanent.")
            }
        }
        .navigationTitle(S.settingsTitle)
        .alert("Remove this wallet?", isPresented: $showForget) {
            Button("Remove", role: .destructive) { store.forgetWallet() }
            Button(S.bookCancel, role: .cancel) { }
        } message: {
            Text("This deletes the recovery phrase from this iPhone. If you have not written the twelve words down, the coins are gone.")
        }
    }

    private var warningsSection: some View {
        let warnings = WalletWarnings.all(store: store)
        return Section(S.warnHeader) {
            if warnings.isEmpty {
                Text(S.warnNone).foregroundStyle(.secondary)
            } else {
                ForEach(warnings) { w in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(w.title).font(.body.weight(.medium))
                        Text(w.body).font(.footnote).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    /// Facts, not reassurance. Every line is something that was actually read.
    private var diagnosticsSection: some View {
        Section("Diagnostics") {
            LabeledContent("Version", value: S.settingsVersion(
                Bundle.main.shortVersion, Bundle.main.buildNumber
            ))
            LabeledContent("Key storage", value: keyStorageDescription)
            if let s = store.snapshot {
                LabeledContent("Indexed height", value: String(s.index.indexedHeight))
                LabeledContent("Index fresh", value: s.index.isTrustworthy ? "yes" : "no")
                // Shown, and labelled as what they are. NEVER gated on -- these
                // are cumulative lifetime counters, and six PCoin payment rails
                // once refused every deposit for three and a half days because
                // one ordinary reorg set blocks_unwound to 1 permanently.
                LabeledContent(
                    "Reorgs seen (lifetime)",
                    value: "\(s.index.reorgCount.map(String.init) ?? Fmt.unknown)"
                )
                LabeledContent(
                    "Blocks unwound (lifetime)",
                    value: "\(s.index.blocksUnwound.map(String.init) ?? Fmt.unknown)"
                )
                LabeledContent("Addresses scanned", value: String(s.addresses.count))
                LabeledContent("Spendable coins", value: String(s.utxos.count))
            } else {
                Text("No successful read yet.").foregroundStyle(.secondary)
            }
        }
    }

    private var keyStorageDescription: String {
        switch store.seedProtection {
        case .secureEnclave: return "Secure Enclave"
        case .keychainUserPresence: return "Keychain (no Secure Enclave)"
        case .simulatorUngated: return "NOT GATED (Simulator, no passcode)"
        case .none: return Fmt.unknown
        }
    }
}

extension Bundle {
    var shortVersion: String {
        (infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0"
    }
    var buildNumber: Int {
        Int((infoDictionary?["CFBundleVersion"] as? String) ?? "0") ?? 0
    }
}
