import Foundation
import SwiftUI
import PCoinKit

/// The one object every screen reads.
///
/// TWO RULES SHAPE THIS WHOLE FILE, and they are the ones this project has paid
/// for:
///
/// 1. **A read that failed resolves nothing.** `snapshot` is what was last
///    successfully read; a failure sets `lastFailure` and leaves `snapshot`
///    exactly as it was, with its own timestamp. The screen then shows the old
///    number, honestly labelled as old, next to the failure. It never shows a
///    fresh-looking zero.
/// 2. **Unknown is its own state.** `snapshot == nil` means nobody has managed
///    to read a balance yet, and every screen renders that as an em dash. There
///    is no zero-valued default anywhere in here.
@MainActor
final class WalletStore: ObservableObject {

    // MARK: - published state

    /// The last SUCCESSFUL read. nil means not known, which is not zero.
    @Published private(set) var snapshot: WalletSnapshot?
    /// Set when a read failed. Stands until a newer read succeeds.
    @Published private(set) var lastFailure: String?
    @Published private(set) var isRefreshing = false
    /// The receive address, available before any network call.
    @Published private(set) var receiveAddress: String?
    /// True once a wallet exists on this phone.
    @Published private(set) var hasWallet: Bool

    let addressBook: AddressBookStore
    let prefs: Prefs

    private let seedStore: SeedStore
    private let watchStore: WatchOnlyStore
    private let client: ExplorerClient
    private var refreshTask: Task<Void, Never>?

    init(
        seedStore: SeedStore = SeedStore(),
        watchStore: WatchOnlyStore = WatchOnlyStore(),
        client: ExplorerClient = ExplorerClient(),
        prefs: Prefs = Prefs(),
        addressBook: AddressBookStore = AddressBookStore()
    ) {
        self.seedStore = seedStore
        self.watchStore = watchStore
        self.client = client
        self.prefs = prefs
        self.addressBook = addressBook
        self.hasWallet = seedStore.exists()
        self.receiveAddress = prefs.receiveAddress

        #if DEBUG
        // The ONE test hook in this app, and it is compiled out of every
        // release build.
        //
        // It does exactly one thing -- forget the wallet -- so that a UI test
        // can start from "no wallet on this phone", which is one of the three
        // payment-link cases and cannot be reached any other way. It CANNOT
        // create a wallet and it CANNOT spend: a launch argument that installs
        // a key would be a back door into the only thing this app protects, and
        // `PaymentLinkUITests` goes through the real setup buttons instead.
        if ProcessInfo.processInfo.arguments.contains("-uiTestResetWallet") {
            seedStore.destroy()
            watchStore.destroy()
            prefs.clearWalletIdentity()
            self.hasWallet = false
            self.receiveAddress = nil
        }
        #endif
    }

    // MARK: - wallet lifecycle

    /// Does a wallet exist? Asked without any prompt -- see `SeedStore.exists`.
    func refreshWalletPresence() {
        hasWallet = seedStore.exists()
        if !hasWallet { receiveAddress = nil }
    }

    /// Create a brand new wallet and return its twelve words, once, for writing
    /// down. They are not returned again without an unlock.
    func createWallet() throws -> [String] {
        let bip39 = try Bip39.english()
        let words = try bip39.generate(wordCount: 12)
        try adopt(words: words, bip39: bip39, replacingExisting: false)
        return words
    }

    /// Restore from twelve words somebody typed.
    func restoreWallet(words: [String]) throws {
        let bip39 = try Bip39.english()
        switch bip39.validate(words) {
        case .ok:
            break
        case .badWordCount(let n):
            throw RestoreError.wordCount(n)
        case .unknownWords(let positions):
            throw RestoreError.unknownWord(positions.first ?? 0, words[positions.first ?? 0])
        case .checksumFailed:
            throw RestoreError.checksum
        }
        try adopt(words: words, bip39: bip39, replacingExisting: true)
    }

    enum RestoreError: Swift.Error, Equatable {
        case wordCount(Int)
        case unknownWord(Int, String)
        case checksum
    }

    private func adopt(words: [String], bip39: Bip39, replacingExisting: Bool) throws {
        // Derive first, store second. If the derivation throws there is no
        // half-made wallet in the Keychain -- a phrase with no wallet built from
        // it is the "setup was never finished" state the Android app has a
        // whole warning string for.
        let keys = try PcoinDerivation.accountKeys(
            bip39: bip39, mnemonic: words, network: .mainnet
        )
        defer { keys.wipe() }
        let address = try keys.receiveAddress()

        try seedStore.save(mnemonic: words, replacingExisting: replacingExisting)

        if prefs.masterFingerprint != nil, prefs.masterFingerprint != keys.masterFingerprintHex {
            // A different wallet was restored over this one. Its cached address
            // and its "written down" claim belong to the old wallet and would be
            // wrong here, so they go -- deliberately, from a user action.
            prefs.clearWalletIdentity()
        }
        // The watch-only half, cached ungated so reading a balance never
        // prompts. See WatchOnlyStore for why that is safe and what it costs.
        if let watch = keys.watchOnly() {
            watchStore.save(
                xpub: watch.accountXpub(), masterFingerprintHex: keys.masterFingerprintHex
            )
        }
        prefs.masterFingerprint = keys.masterFingerprintHex
        prefs.receiveAddress = address
        prefs.walletCreatedAt = prefs.walletCreatedAt ?? Date()
        receiveAddress = address
        hasWallet = true
        snapshot = nil
        lastFailure = nil
    }

    /// Read the twelve words back. Prompts.
    func revealMnemonic(reason: String = S.backupGateReason) throws -> [String] {
        try seedStore.loadMnemonic(reason: reason)
    }

    func forgetWallet() {
        seedStore.destroy()
        watchStore.destroy()
        prefs.clearWalletIdentity()
        snapshot = nil
        lastFailure = nil
        receiveAddress = nil
        hasWallet = false
    }

    var seedProtection: SeedStore.Protection? { seedStore.protection }

    // MARK: - reading the chain

    /// Ask for a fresh reading.
    ///
    /// Never opens a second scan while one is in flight. On failure the previous
    /// snapshot stays exactly as it was -- it is still the last thing that was
    /// actually true -- and the failure is published alongside it.
    func refresh() {
        guard hasWallet, refreshTask == nil else { return }
        isRefreshing = true
        refreshTask = Task { [weak self] in
            guard let self else { return }
            defer {
                Task { @MainActor in
                    self.isRefreshing = false
                    self.refreshTask = nil
                }
            }
            do {
                // WATCH-ONLY. Reading a balance must never prompt for Face ID,
                // and it never needs to: the account xpub derives every address
                // this wallet owns and can spend nothing.
                let keys = try self.watchOnlyKeys()
                let scanner = WalletScanner(client: self.client, keys: keys)
                let snap = try await scanner.scan()
                await MainActor.run {
                    self.snapshot = snap
                    self.lastFailure = nil
                    self.prefs.lastGoodReadAt = snap.readAt
                    self.prefs.lastKnownHeight = snap.index.indexedHeight
                    self.prefs.receiveAddress = snap.receiveAddress
                    self.receiveAddress = snap.receiveAddress
                }
            } catch {
                await MainActor.run { self.lastFailure = WalletStore.describe(error) }
            }
        }
    }

    /// The watch-only keys, from the ungated cache.
    ///
    /// If the cache is missing -- an upgrade from a build before it existed, or
    /// a Keychain that lost it -- this is the ONE place that falls back to the
    /// phrase, rebuilds the cache, and never has to again. It is not a silent
    /// downgrade: it prompts once, visibly, and fixes itself.
    private func watchOnlyKeys() throws -> PcoinDerivation.WatchOnlyKeys {
        if let k = watchStore.keys() { return k }
        let words = try seedStore.loadMnemonic(reason: "Unlock once to set up balance reading")
        let bip39 = try Bip39.english()
        let keys = try PcoinDerivation.accountKeys(
            bip39: bip39, mnemonic: words, network: .mainnet
        )
        defer { keys.wipe() }
        guard let watch = keys.watchOnly() else {
            throw SeedStore.StoreError.corrupted("the account key would not serialise")
        }
        watchStore.save(
            xpub: watch.accountXpub(), masterFingerprintHex: keys.masterFingerprintHex
        )
        return watch
    }

    // MARK: - history

    enum HistoryState: Equatable {
        case never
        case loading
        case loaded([WalletTx])
        /// Stands until a newer read succeeds. A failed read resolves nothing,
        /// so it never becomes an empty list -- "no activity" and "could not
        /// read your activity" are different sentences on the screen.
        case failed(String)
    }

    @Published private(set) var historyState: HistoryState = .never

    func loadHistory() async {
        guard let snap = snapshot else {
            // No successful balance read yet, so there are no addresses to ask
            // about. Refresh first; this is not an error.
            refresh()
            return
        }
        if case .loading = historyState { return }
        historyState = .loading
        do {
            let loader = HistoryLoader(client: client)
            let txs = try await loader.load(addresses: snap.addresses)
            historyState = .loaded(txs)
        } catch {
            historyState = .failed(WalletStore.describe(error))
        }
    }

    // MARK: - sending

    /// Build and sign a payment, without sending it.
    ///
    /// PROMPTS, and one screen earlier than Android does. The reason is
    /// structural: the review screen promises "These are the real figures from
    /// the transaction that was just built", and on iOS building a transaction
    /// means signing it, which means the key. Android can show real figures
    /// without an unlock because the node inside the app holds the key and
    /// builds the transaction for it.
    ///
    /// Nothing has left the wallet when this returns. The broadcast is a
    /// separate, later call.
    func prepare(
        toAddress raw: String,
        amountSat: Int64?,
        feeRate: FeeRate
    ) async throws -> PlannedSend {
        guard let snap = snapshot else { throw SendError.balanceNotRead }
        guard snap.index.isTrustworthy else {
            throw SendError.indexNotCurrent(snap.index.untrustworthyReason ?? "unknown")
        }
        let destination: Address
        switch Address.parse(raw) {
        case .success(let a): destination = a
        case .failure(let f): throw SendError.badAddress(f)
        }

        let words = try seedStore.loadMnemonic(reason: S.gateSubtitle)
        let bip39 = try Bip39.english()
        let keys = try PcoinDerivation.accountKeys(bip39: bip39, mnemonic: words, network: .mainnet)
        defer { keys.wipe() }

        return try TxBuilder.plan(
            utxos: snap.utxos,
            to: destination,
            amountSat: amountSat,
            feeRate: feeRate,
            changeAddress: snap.nextChangeAddress,
            signer: { chain, index in try keys.privateKey(chain: chain, index: index) }
        )
    }

    /// Hand a signed transaction to the network.
    ///
    /// Returns the outcome UNFLATTENED. The endpoint answers three different
    /// things -- the network has it, the network rejected it, or nobody can yet
    /// say -- and the third one is the one that will tempt somebody into a bug.
    /// `?? false` on it tells a person their payment failed while it may be
    /// confirming, which is the same collapse of unknown into no that has cost
    /// this project money twice.
    ///
    /// A transport failure THROWS, and that is also not a failure of the
    /// payment: the txid is computed from the submitted bytes before the node is
    /// contacted, so a lost response has lost nothing. `retryBroadcast` is safe
    /// to call with the same plan.
    func broadcast(_ plan: PlannedSend) async throws -> BroadcastOutcome {
        do {
            return try await client.broadcast(rawHex: plan.rawHex)
        } catch let e as ExplorerError where e.isBroadcastUnavailable {
            throw SendError.broadcastUnavailable
        }
    }

    enum SendError: Swift.Error, Equatable {
        case balanceNotRead
        case indexNotCurrent(String)
        case badAddress(Address.Failure)
        /// Kept, though the relay node now exists. If the service is ever
        /// reconfigured back into that state the wallet must say so plainly
        /// rather than reporting a generic failure.
        case broadcastUnavailable
    }

    // MARK: - error wording

    static func describe(_ error: Swift.Error) -> String {
        if let e = error as? ExplorerError { return e.displayMessage }
        if let e = error as? WalletScanner.ScanError {
            switch e {
            case .indexNotCurrent(let why): return S.indexNotCurrent(why)
            }
        }
        if let e = error as? SeedStore.StoreError {
            switch e {
            case .authenticationFailed: return S.gateCancelled
            case .notFound: return S.addressUnknown
            case .alreadyExists: return "There is already a wallet on this phone."
            case .keychain(let s): return "The keychain refused: \(s)."
            case .secureEnclaveUnavailable(let w): return "Secure storage is unavailable: \(w)"
            case .corrupted(let w): return "The stored wallet could not be read: \(w)"
            }
        }
        if let e = error as? SendError {
            switch e {
            case .balanceNotRead: return S.sendAvailableUnknown
            case .indexNotCurrent(let why): return S.indexNotCurrent(why)
            case .badAddress(let f): return WalletStore.describe(addressFailure: f)
            case .broadcastUnavailable: return S.broadcastUnavailableBody
            }
        }
        if let e = error as? SendPlanError {
            switch e {
            case .noSpendableCoins:
                return "There are no confirmed coins to spend yet."
            case .insufficientFunds(let need, let have):
                return "That needs \(Fmt.coinsSat(need)) including the fee, and there is \(Fmt.coinsSat(have))."
            case .amountIsDust:
                return S.errAmountDust
            case .feeExceedsBalance:
                return "The fee would be more than the whole balance."
            case .unsignableInput:
                return "One of your coins is in a form this wallet cannot sign."
            case .signingFailed, .selfCheckFailed:
                return "The payment could not be signed. Nothing has been sent."
            }
        }
        return (error as NSError).localizedDescription
    }

    static func describe(addressFailure f: Address.Failure) -> String {
        switch f {
        case .notAnAddress:
            return "That is not a PCoin address."
        case .wrongNetwork(let detail):
            return "That address belongs to another chain (\(detail)), not PCoin."
        case .badChecksum:
            return "That address does not check out \u{2014} one character is probably wrong."
        case .malformedProgram:
            return "That address is the right shape but the wrong size."
        }
    }
}
