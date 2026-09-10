import SwiftUI
import PCoinKit

/// The PCoin Wallet home screen.
///
/// WHAT THIS SCREEN WILL NOT DO, copied from the Android `MainActivity` for the
/// same reasons:
///
///  * It never renders an unread value as a number. A balance nobody has managed
///    to read is an em dash, not 0.00000000. `store.snapshot == nil` is that
///    state and the whole screen keys off it.
///  * It never turns blocks into a time. Spacing on this chain is noisy and
///    routinely far from its 600 s target in both directions, so "spendable in
///    about 40 more blocks" is honest and "in about 8 hours" is a guess wearing
///    a number clothes.
///  * A failed refresh does not clear anything. The last good number stays,
///    labelled with when it was actually read, and the failure line stands
///    beside it until a newer read succeeds.
struct MainView: View {

    @EnvironmentObject private var store: WalletStore
    @State private var showCopied = false
    @State private var showShare = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    balanceCard
                    if !store.prefs.phraseWrittenDown { backupCard }
                    actions
                    receiveCard
                    chainLine
                }
                .padding(20)
            }
            .navigationTitle(S.walletTitle)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink { SettingsView() } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .refreshable { store.refresh() }
            .task { store.refresh() }
        }
    }

    // MARK: - balance

    private var balanceCard: some View {
        VStack(spacing: 8) {
            Text(S.available)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            // The one number on the screen, and it is an em dash until a read
            // has actually succeeded.
            Text(store.snapshot.map { Amounts.toPlainString($0.spendableSat) } ?? S.amountUnknown)
                .font(.system(size: 40, weight: .semibold, design: .rounded))
                .minimumScaleFactor(0.4)
                .lineLimit(1)
            Text("PCN").font(.caption).foregroundStyle(.secondary)

            if let note = balanceNote {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            Text(checkedLine)
                .font(.caption)
                // Spelled out as `Color` rather than the leading-dot shorthand:
                // a ternary of two different ShapeStyle types has no common
                // concrete type for the compiler to infer.
                .foregroundStyle(store.lastFailure == nil ? Color.secondary : Color.red)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Button(store.isRefreshing ? S.refreshBusy : S.refreshBalance) { store.refresh() }
                .disabled(store.isRefreshing)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    /// Immature and pending, stated separately, because they are different
    /// facts. Never folded into the spendable number.
    private var balanceNote: String? {
        guard let s = store.snapshot else { return nil }
        let pending = s.pendingIncomingSat
        let immature = s.immatureSat
        switch (pending > 0, immature > 0) {
        case (false, false):
            return nil
        case (true, false):
            return S.notePending(Fmt.coinsSat(pending))
        case (false, true):
            // The exact block count is not known per-address from the batch
            // read, so this says the honest thing rather than inventing one.
            return S.noteImmatureUnknown(Fmt.coinsSat(immature))
        case (true, true):
            return S.notePending(Fmt.coinsSat(pending)) + " \u{00B7} "
                + S.noteImmatureUnknown(Fmt.coinsSat(immature))
        }
    }

    private var checkedLine: String {
        if let f = store.lastFailure { return S.checkFailed + "\n" + f }
        guard let s = store.snapshot else { return S.checkedNever }
        let ago = Date().timeIntervalSince(s.readAt)
        return ago < 60 ? S.checkedJustNow : S.checkedAgo(Fmt.roughDuration(seconds: ago))
    }

    // MARK: - backup

    private var backupCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(S.backupTitle).font(.headline)
            Text(S.backupBody)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            NavigationLink(S.backupAction) { BackupView() }
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color.orange.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    // MARK: - actions

    private var actions: some View {
        HStack(spacing: 12) {
            NavigationLink { SendView() } label: {
                Label(S.send, systemImage: "arrow.up.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            NavigationLink { HistoryView() } label: {
                Label(S.history, systemImage: "clock")
                    .lineLimit(1)
                    // Without this the word wraps to "His-tory" on a narrow
                    // phone. Seen on a real screenshot, not guessed at.
                    .minimumScaleFactor(0.8)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)

            NavigationLink { AddressBookView() } label: {
                Label(S.addresses, systemImage: "person.text.rectangle")
                    .labelStyle(.iconOnly)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
    }

    // MARK: - receive

    private var receiveCard: some View {
        VStack(spacing: 12) {
            Text(S.receiveTitle).font(.headline)
            Text(S.receiveHint)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            if let a = store.receiveAddress {
                QRCodeView(text: PaymentUri.build(address: a))
                    .frame(width: 200, height: 200)
                    .accessibilityLabel(S.qrDescription)

                Text(a)
                    .font(.system(.footnote, design: .monospaced))
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)

                HStack(spacing: 12) {
                    Button {
                        UIPasteboard.general.string = a
                        showCopied = true
                    } label: {
                        Label(S.copy, systemImage: "doc.on.doc").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)

                    ShareLink(item: a, subject: Text(S.shareSubject)) {
                        Label(S.share, systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            } else {
                Text(S.addressUnknown)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .alert(S.copied, isPresented: $showCopied) {
            Button("OK", role: .cancel) { }
        }
    }

    // MARK: - chain line

    private var chainLine: some View {
        Group {
            if let s = store.snapshot {
                VStack(spacing: 2) {
                    Text(S.chainLine(height: s.index.indexedHeight))
                    if !s.index.isTrustworthy {
                        Text(S.indexNotCurrent(s.index.untrustworthyReason ?? ""))
                            .foregroundStyle(.orange)
                    }
                    if !s.scanComplete {
                        Text("This wallet has more addresses than one scan covers, so the total may be short.")
                            .foregroundStyle(.orange)
                            .multilineTextAlignment(.center)
                    }
                }
            } else {
                Text(S.chainLineUnknown)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}
