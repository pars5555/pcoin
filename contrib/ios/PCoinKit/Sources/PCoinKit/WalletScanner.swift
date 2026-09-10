import Foundation

/// One address the wallet owns, with whatever the explorer last said about it.
public struct DerivedAddress: Equatable, Identifiable {
    public let chain: UInt32
    public let index: UInt32
    public let address: String
    public let used: Bool
    public let spendableSat: Int64
    public let immatureSat: Int64
    public let pendingIncomingSat: Int64
    public let lifetimeTxCount: Int

    public var id: String { address }
    public var isChange: Bool { chain == PcoinDerivation.chainInternal }
}

/// Everything the screens draw, as of one successful read.
///
/// A snapshot only exists when a read actually SUCCEEDED. There is no
/// "empty" snapshot and no zero-valued default, because the home screen must
/// never render an unread balance as a number: the Android wallet shows an em
/// dash for exactly this and this app does the same. The view model holds
/// `WalletSnapshot?` and nil means "not known", which is its own state.
public struct WalletSnapshot: Equatable {
    public let index: IndexStatus
    public let readAt: Date
    public let receiveAddress: String
    public let nextChangeAddress: String
    public let addresses: [DerivedAddress]
    public let utxos: [SpendableUtxo]
    /// Confirmed, mature, not already spent by something in the mempool.
    public let spendableSat: Int64
    /// Mined and not yet 100 blocks old.
    public let immatureSat: Int64
    /// Arriving, unconfirmed.
    public let pendingIncomingSat: Int64
    /// True when the scan stopped at its cap rather than at the gap limit, so
    /// the totals could be short. Surfaced, never swallowed.
    public let scanComplete: Bool

    public var hasImmature: Bool { immatureSat > 0 }
    public var hasPending: Bool { pendingIncomingSat > 0 }
}

/// Finds the wallet addresses and totals them, over HTTP.
///
/// THE GAP LIMIT IS A REAL CONSTRAINT HERE, unlike on Android. There, the node
/// is handed `wpkh(...)` descriptors with a 1000-address range and rescans them
/// locally, which costs nothing because the node already has the whole chain. A
/// light client has to ASK about each address, so it walks in windows and stops
/// after `gapLimit` consecutive unused ones -- with a floor, so a wallet whose
/// first few addresses happen to be unused is never wrongly declared empty.
public struct WalletScanner {

    public enum ScanError: Swift.Error, Equatable {
        case indexNotCurrent(reason: String)
    }

    private let client: ExplorerClient
    private let keys: PcoinDerivation.WatchOnlyKeys

    /// Takes the WATCH-ONLY keys, deliberately.
    ///
    /// A balance read cannot spend, so it has no business holding anything that
    /// could. This is also what keeps the home screen from prompting for Face ID
    /// -- see `Bip32Public.swift` for the whole argument.
    public init(client: ExplorerClient, keys: PcoinDerivation.WatchOnlyKeys) {
        self.client = client
        self.keys = keys
    }

    /// One full read.
    ///
    /// Throws if the index is not current. That is deliberate and it is the
    /// difference between a wallet and a wallet that double-spends itself: an
    /// old answer that looks current is worse than no answer, so the caller is
    /// told it could not be read rather than handed numbers it would display as
    /// fact.
    public func scan(
        maxAddressesPerChain: Int = 200,
        requireCurrentIndex: Bool = true
    ) async throws -> WalletSnapshot {
        var derived = [DerivedAddress]()
        var lastIndex: IndexStatus?
        var complete = true

        for chain in [PcoinDerivation.chainExternal, PcoinDerivation.chainInternal] {
            var next: UInt32 = 0
            var unusedRun = 0
            var chainDone = false
            while !chainDone {
                let window = 40
                var batch = [String]()
                var coords = [(UInt32, UInt32)]()
                for i in 0..<window {
                    let idx = next + UInt32(i)
                    if idx >= UInt32(maxAddressesPerChain) { break }
                    batch.append(try keys.address(chain: chain, index: idx))
                    coords.append((chain, idx))
                }
                if batch.isEmpty {
                    complete = false
                    break
                }

                let answer = try await client.addresses(batch)
                lastIndex = answer.index
                if requireCurrentIndex, !answer.index.isTrustworthy {
                    throw ScanError.indexNotCurrent(
                        reason: answer.index.untrustworthyReason ?? "unknown"
                    )
                }
                // Answers are matched BY ADDRESS, never by position. A server
                // that reorders or drops one would otherwise silently attach
                // one address balance to a different key.
                var byAddress = [String: AddressReport]()
                for r in answer.addresses { byAddress[r.address] = r }

                for (i, addr) in batch.enumerated() {
                    guard let r = byAddress[addr] else {
                        throw ExplorerError.malformedAnswer(
                            "the batch answer left out an address that was asked about"
                        )
                    }
                    let (c, idx) = coords[i]
                    derived.append(DerivedAddress(
                        chain: c,
                        index: idx,
                        address: addr,
                        used: r.used,
                        spendableSat: r.balance.confirmed.spendableSat,
                        immatureSat: r.balance.confirmed.immatureSat,
                        pendingIncomingSat: r.balance.unconfirmed.receivingSat,
                        lifetimeTxCount: r.balance.lifetime?.txCount ?? 0
                    ))
                    if r.used {
                        unusedRun = 0
                    } else {
                        unusedRun += 1
                    }
                }
                next += UInt32(batch.count)
                if unusedRun >= PcoinDerivation.gapLimit
                    && next >= UInt32(PcoinDerivation.scanFloor) {
                    chainDone = true
                }
                if next >= UInt32(maxAddressesPerChain) {
                    chainDone = true
                    if unusedRun < PcoinDerivation.gapLimit { complete = false }
                }
            }
        }

        guard let index = lastIndex else {
            throw ExplorerError.malformedAnswer("no index block in any answer")
        }

        // UTXOs, only for addresses that actually hold something. Asking about
        // 200 empty addresses would be 200 round trips for nothing.
        var utxos = [SpendableUtxo]()
        for d in derived where d.spendableSat > 0 || d.immatureSat > 0 {
            let (rows, rowsComplete, _) = try await client.allUtxos(d.address)
            if !rowsComplete { complete = false }
            for r in rows {
                guard let script = [UInt8](hex: r.scriptHex) else { continue }
                utxos.append(SpendableUtxo(
                    outpoint: Transaction.OutPoint(txid: r.txid, vout: r.vout),
                    valueSat: r.valueSat,
                    scriptPubKey: script,
                    chain: d.chain,
                    index: d.index,
                    confirmations: r.confirmations,
                    isCoinbase: r.isCoinbase,
                    spendableAccordingToIndex: r.spendable && r.mature && !r.spentInMempool
                ))
            }
        }

        // The receive address never changes, exactly as the Android wallet says
        // on screen: "Share this address to be paid. It is yours and does not
        // change." Index 0, generated once, reused forever.
        let receive = try keys.address(chain: PcoinDerivation.chainExternal, index: 0)

        // Change goes to the first internal address with no history. If every
        // scanned one is used, fall back to the next index after them rather
        // than reusing one.
        let internalAddrs = derived.filter { $0.chain == PcoinDerivation.chainInternal }
        let firstUnusedChange = internalAddrs.first { !$0.used && $0.spendableSat == 0 }
        let changeAddress: String
        if let c = firstUnusedChange {
            changeAddress = c.address
        } else {
            let nextIdx = UInt32(internalAddrs.count)
            changeAddress = try keys.address(chain: PcoinDerivation.chainInternal, index: nextIdx)
        }

        return WalletSnapshot(
            index: index,
            readAt: Date(),
            receiveAddress: receive,
            nextChangeAddress: changeAddress,
            addresses: derived,
            utxos: utxos,
            spendableSat: derived.reduce(0) { $0 + $1.spendableSat },
            immatureSat: derived.reduce(0) { $0 + $1.immatureSat },
            pendingIncomingSat: derived.reduce(0) { $0 + $1.pendingIncomingSat },
            scanComplete: complete
        )
    }
}
