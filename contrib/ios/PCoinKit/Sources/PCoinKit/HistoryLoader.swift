import Foundation

/// One transaction, as this wallet saw it, aggregated across every address of
/// its own that the transaction touched.
public struct WalletTx: Equatable, Identifiable {
    public let txid: String
    public let height: Int?
    public let time: Int64?
    /// nil means NOT KNOWN, and it is rendered as an em dash. It is never zero:
    /// an unanswerable question turned into a definite "not confirmed" is what
    /// authorises spending the same coins twice.
    public let confirmations: Int?
    /// Positive into the wallet, negative out of it.
    public let netSat: Int64
    public let receivedSat: Int64
    public let sentSat: Int64
    /// The wallet own addresses this transaction touched.
    public let ownAddresses: [String]
    public let isUnconfirmed: Bool

    public var id: String { txid }
    public var isIncoming: Bool { netSat >= 0 }
}

/// Reads the transaction history for a whole wallet.
///
/// One HTTP call per USED address, and none at all for the rest -- a fresh
/// wallet with forty derived addresses and no history costs nothing. Rows are
/// merged by txid, because one payment routinely touches several of the wallet
/// own addresses (a spend from two coins with change is three of them) and
/// showing it three times would be showing three payments that did not happen.
public struct HistoryLoader {

    private let client: ExplorerClient

    public init(client: ExplorerClient) {
        self.client = client
    }

    public func load(
        addresses: [DerivedAddress],
        perAddressLimit: Int = 50
    ) async throws -> [WalletTx] {
        let used = addresses.filter { $0.used || $0.lifetimeTxCount > 0 }
        var merged = [String: Builder]()

        for a in used {
            let answer = try await client.address(a.address, historyLimit: perAddressLimit)
            let confirmed = answer.history?.items ?? []
            let pending = answer.unconfirmedHistory?.items ?? []
            for item in confirmed + pending {
                let isPending = answer.unconfirmedHistory?.items.contains(item) ?? false
                merged[item.txid, default: Builder(txid: item.txid)]
                    .add(item, address: a.address, unconfirmed: isPending)
            }
        }

        return merged.values.map { $0.build() }.sorted { lhs, rhs in
            // Unconfirmed first, then by height descending. Height is used
            // rather than time BECAUSE BLOCK TIMESTAMPS ARE NOT MONOTONIC IN
            // HEIGHT on this chain -- sorting by time genuinely reorders blocks.
            switch (lhs.height, rhs.height) {
            case (nil, nil): return lhs.txid < rhs.txid
            case (nil, _): return true
            case (_, nil): return false
            case (let l?, let r?): return l == r ? lhs.txid < rhs.txid : l > r
            }
        }
    }

    private final class Builder {
        let txid: String
        var height: Int?
        var time: Int64?
        var confirmations: Int?
        var confirmationsKnown = false
        var received: Int64 = 0
        var sent: Int64 = 0
        var addresses = [String]()
        var unconfirmed = false

        init(txid: String) { self.txid = txid }

        func add(_ item: HistoryItem, address: String, unconfirmed: Bool) {
            height = height ?? item.height
            time = time ?? item.time
            // The first address to report a confirmation count settles it; a
            // later nil does NOT clear it, because "this address did not say"
            // is not "there are none".
            if let c = item.confirmations, !confirmationsKnown {
                confirmations = c
                confirmationsKnown = true
            }
            received += item.receivedSat
            sent += item.sentSat
            if !addresses.contains(address) { addresses.append(address) }
            if unconfirmed { self.unconfirmed = true }
        }

        func build() -> WalletTx {
            WalletTx(
                txid: txid,
                height: height,
                time: time,
                confirmations: confirmationsKnown ? confirmations : nil,
                netSat: received - sent,
                receivedSat: received,
                sentSat: sent,
                ownAddresses: addresses,
                isUnconfirmed: unconfirmed || height == nil
            )
        }
    }
}
