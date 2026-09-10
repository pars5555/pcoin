import SwiftUI
import PCoinKit

/// Activity: payments in and out, searchable, exactly as the Android
/// `HistoryActivity` is.
///
/// TWO RULES FROM THE ANDROID SCREEN SURVIVE HERE UNCHANGED:
///
///  * A confirmation count that could not be read is an em dash, never zero. An
///    unanswerable question turned into a definite "not confirmed" is what
///    authorises spending the same coins twice, and it has cost this project
///    money once already.
///  * Nothing is turned into a time estimate. "Waiting to be included in a
///    block" is honest; "about 20 minutes" would be a guess, on a chain whose
///    block spacing is noisy in both directions.
struct HistoryView: View {

    @EnvironmentObject private var store: WalletStore
    @State private var search = ""
    @State private var filter: Filter = .all

    private enum Filter: String, CaseIterable {
        case all, sent, received
        var label: String {
            switch self {
            case .all: return S.filterAll
            case .sent: return S.filterSent
            case .received: return S.filterReceived
            }
        }
    }

    var body: some View {
        List {
            switch store.historyState {
            case .never, .loading:
                Section { Text(S.historyLoading).foregroundStyle(.secondary) }
            case .failed(let why):
                Section { ErrorLine(S.historyFailed(why)) }
            case .loaded(let all):
                let shown = filtered(all)
                if shown.isEmpty {
                    Section {
                        Text(search.isEmpty ? S.historyEmpty : S.noMatches(all.count))
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        ForEach(shown) { tx in
                            HistoryRow(tx: tx)
                        }
                    } header: {
                        Text(S.historyTapHint)
                    } footer: {
                        Text(S.countFiltered(shown.count, all.count))
                    }
                }
            }
        }
        .searchable(text: $search, prompt: S.searchHint)
        .navigationTitle(S.historyTitle)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Picker("", selection: $filter) {
                    ForEach(Filter.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.menu)
            }
        }
        .refreshable { await store.loadHistory() }
        .task { await store.loadHistory() }
    }

    private func filtered(_ all: [WalletTx]) -> [WalletTx] {
        all.filter { tx in
            switch filter {
            case .all: return true
            case .sent: return tx.netSat < 0
            case .received: return tx.netSat >= 0
            }
        }
        .filter { tx in
            guard !search.isEmpty else { return true }
            let q = search.lowercased()
            if tx.txid.lowercased().contains(q) { return true }
            if tx.ownAddresses.contains(where: { $0.lowercased().contains(q) }) { return true }
            for a in tx.ownAddresses {
                if let n = store.addressBook.name(for: a), n.lowercased().contains(q) {
                    return true
                }
            }
            return false
        }
    }
}

struct HistoryRow: View {
    let tx: WalletTx
    @EnvironmentObject private var store: WalletStore
    @State private var showCopied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title).font(.body.weight(.medium))
                Spacer()
                Text((tx.isIncoming ? "+" : "\u{2212}") + Fmt.coinsSat(abs(tx.netSat)))
                    .font(.body.monospacedDigit())
                    .foregroundStyle(tx.isIncoming ? Color.green : Color.primary)
            }
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(status)
                .font(.caption2)
                .foregroundStyle(tx.isUnconfirmed ? Color.orange : Color.secondary)
        }
        .padding(.vertical, 2)
        .contextMenu {
            Button(S.copyTxid) { UIPasteboard.general.string = tx.txid; showCopied = true }
            if let a = tx.ownAddresses.first {
                Button(S.copyAddress) { UIPasteboard.general.string = a; showCopied = true }
            }
        }
        .alert(S.copiedTxid, isPresented: $showCopied) { Button("OK", role: .cancel) { } }
    }

    private var title: String { tx.isIncoming ? S.received : S.sent }

    private var subtitle: String {
        // The wallet own addresses this touched. Named where a name exists, and
        // the address shown otherwise -- never a name with no address behind it.
        let first = tx.ownAddresses.first ?? tx.txid
        if let n = store.addressBook.name(for: first) { return n + " \u{00B7} " + Fmt.shortAddress(first) }
        return Fmt.shortAddress(first)
    }

    private var status: String {
        if tx.isUnconfirmed { return S.statusPending }
        // nil confirmations is an em dash, deliberately. See Fmt.confirmations.
        var s = Fmt.confirmations(tx.confirmations)
        if let h = tx.height { s += " \u{00B7} block \(h)" }
        return s
    }
}
