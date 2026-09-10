import Foundation

// MARK: - the index block, which every response carries

/// The freshness block the explorer attaches to every answer.
///
/// READ IT EVERY TIME. A stale index is not an error; it is an old answer that
/// looks current, and a wallet that spends off one double-spends itself.
public struct IndexStatus: Decodable, Equatable {
    public let chain: String
    public let status: String
    public let indexedHeight: Int
    public let nodeHeight: Int?
    public let blocksBehind: Int?
    public let stale: Bool
    public let staleReasons: [String]?
    public let nodeReachable: Bool?
    public let lastPollAgeSeconds: Double?
    public let blocksBehindNow: Int?

    /// LIFETIME COUNTERS. Present so they can be shown on a diagnostics screen
    /// and for no other purpose.
    ///
    /// NEVER GATE ON THESE. They only ever go up. Six PCoin payment rails gated
    /// on `blocksUnwound == 0`; one ordinary 1-block reorg at height 5801 set it
    /// to 1 permanently and all six silently refused to credit anything for
    /// three and a half days while exiting clean every tick. The live API
    /// reports `reorg_count: 1, blocks_unwound: 1` today, so a wallet shipping
    /// that gate would refuse to work from its first run.
    ///
    /// For a real mid-reorg signal, compare the CHANGE between two reads.
    public let reorgCount: Int?
    public let blocksUnwound: Int?

    /// The gate. Exactly the three things that describe "this answer is current".
    public var isTrustworthy: Bool {
        !stale && (nodeReachable ?? false) && (blocksBehindNow ?? blocksBehind ?? 1) == 0
    }

    /// Why it is not, in words a person can act on.
    public var untrustworthyReason: String? {
        if isTrustworthy { return nil }
        if nodeReachable == false { return "the explorer cannot reach its node" }
        if stale {
            let why = (staleReasons ?? []).joined(separator: ", ")
            return why.isEmpty ? "the index is stale" : "the index is stale: " + why
        }
        let behind = blocksBehindNow ?? blocksBehind ?? 0
        if behind > 0 { return "the index is \(behind) block(s) behind the node" }
        return "the index did not say it was current"
    }
}

// MARK: - responses

public struct ConfirmedBalance: Decodable, Equatable {
    public let matureSat: Int64
    public let immatureSat: Int64
    public let pendingSpendSat: Int64
    public let spendableSat: Int64
    public let utxoCount: Int
    public let asOfHeight: Int
    public let maturityBlocks: Int
}

public struct UnconfirmedBalance: Decodable, Equatable {
    public let known: Bool
    public let fresh: Bool?
    public let txCount: Int
    public let receivingSat: Int64
    public let spendingSat: Int64
}

public struct AddressBalance: Decodable, Equatable {
    public let confirmed: ConfirmedBalance
    public let unconfirmed: UnconfirmedBalance
    public let lifetime: Lifetime?

    public struct Lifetime: Decodable, Equatable {
        public let txCount: Int
        public let firstHeight: Int?
        public let lastHeight: Int?
        public let receivedSat: Int64
        public let sentSat: Int64
    }
}

public struct HistoryItem: Decodable, Equatable, Identifiable {
    public let txid: String
    public let height: Int?
    public let blockHash: String?
    public let time: Int64?
    public let confirmations: Int?
    public let nIn: Int?
    public let nOut: Int?
    public let receivedSat: Int64
    public let sentSat: Int64
    public let netSat: Int64

    public var id: String { txid }

    /// nil when the wallet has not been told, which is not the same as zero.
    public var isConfirmed: Bool? {
        guard let c = confirmations else { return nil }
        return c > 0
    }
}

public struct AddressReport: Decodable, Equatable {
    public let address: String
    public let used: Bool
    public let balance: AddressBalance
    public let history: HistoryPage?
    public let unconfirmedHistory: UnconfirmedHistory?

    public struct HistoryPage: Decodable, Equatable {
        public let items: [HistoryItem]
        public let total: Int
        public let hasMore: Bool
        public let offset: Int?
        public let limit: Int?
    }

    public struct UnconfirmedHistory: Decodable, Equatable {
        public let known: Bool
        public let items: [HistoryItem]
        public let count: Int
    }
}

public struct AddressResponse: Decodable {
    public let index: IndexStatus
    public let address: String
    public let used: Bool
    public let balance: AddressBalance
    public let history: AddressReport.HistoryPage?
    public let unconfirmedHistory: AddressReport.UnconfirmedHistory?
}

public struct AddressesResponse: Decodable {
    public let index: IndexStatus
    public let addresses: [AddressReport]
    public let maxAddresses: Int?
}

public struct UtxoRow: Decodable, Equatable {
    public let txid: String
    public let vout: UInt32
    public let height: Int?
    public let confirmations: Int
    public let isCoinbase: Bool
    public let mature: Bool
    public let spentInMempool: Bool
    public let spendable: Bool
    public let status: String
    public let scriptHex: String
    public let scriptType: String?
    public let valueSat: Int64
}

public struct UtxosResponse: Decodable {
    public let index: IndexStatus
    public let address: String
    public let utxos: [UtxoRow]
    public let count: Int
    public let total: Int
    public let hasMore: Bool
    public let offset: Int?
    public let asOfHeight: Int?
}

public struct StatusResponse: Decodable {
    public let index: IndexStatus
    public let chain: ChainInfo?

    public struct ChainInfo: Decodable {
        public let height: Int
        public let bestHash: String?
        public let blockTime: Int64?
    }
}

/// What the broadcast endpoint says.
///
/// It answers a bigger question than "did a node take this": it says whether the
/// NETWORK has the transaction. Those are different claims, and the difference
/// is the point -- a transaction can enter the mempool of a node with zero peers
/// and go nowhere while the client is told "sent".
public struct BroadcastResponse: Decodable {
    public let txid: String?
    public let acceptedByNode: Bool?
    public let error: Detail?
    public let network: Network?
    public let tx: TxFacts?

    public struct Detail: Decodable {
        public let code: String
        public let message: String
        public let rpcCode: Int?
        public let detail: String?
    }

    public struct Network: Decodable {
        /// THREE-VALUED, AND IT MUST STAY THAT WAY.
        ///
        ///   true  -- it crossed the network
        ///   false -- a fact: rejected, or the node has no peers so nobody has it
        ///   nil   -- UNKNOWN. Never success, never failure.
        ///
        /// `?? false` here tells somebody their payment failed when it may be
        /// confirming. There is no default for this value and there must not be.
        public let hasIt: Bool?
        public let state: String?
        public let peers: Int?
        public let detail: String?
    }

    public struct TxFacts: Decodable {
        public let vsize: Int?
        public let inputCount: Int?
        public let outputCount: Int?
    }
}

/// The three outcomes of a broadcast, kept apart.
public enum BroadcastOutcome: Equatable {
    /// The network has it.
    case sent(txid: String)
    /// A FACT: the node answered and said no, with a reason.
    case rejected(txid: String?, reason: String, detail: String?)
    /// UNKNOWN. The submission went through and nobody can yet say whether the
    /// network has it. This is NOT a failure, and the wallet must not tell
    /// anybody it is one -- the transaction may be confirming right now.
    case notYetConfirmed(txid: String, detail: String?)

    public var txid: String? {
        switch self {
        case .sent(let t): return t
        case .rejected(let t, _, _): return t
        case .notYetConfirmed(let t, _): return t
        }
    }
}

/// The structured error the API returns, which is worth surfacing verbatim: the
/// broadcast refusal explains itself better than any message this app could
/// invent for it.
public struct APIErrorBody: Decodable {
    public struct Detail: Decodable {
        public let code: String
        public let message: String
    }
    public let error: Detail
}

// MARK: - errors

/// Every way asking can fail, kept apart on purpose.
///
/// There is no `case unknown` that collapses into a zero anywhere downstream. A
/// failed, timed-out or refused read resolves NOTHING: it can never advance a
/// record, clear one, or authorise a send. That rule has cost this project money
/// twice, and this enum is where it is enforced -- there is simply no value in
/// here that a caller could mistake for an answer.
public enum ExplorerError: Swift.Error, Equatable {
    /// Could not ask at all. Says nothing whatsoever about the chain.
    case couldNotAsk(String)
    case httpStatus(Int, body: String?)
    case malformedAnswer(String)
    /// The API answered, and the answer was a refusal it explained itself.
    case refused(code: String, message: String)
    /// The answer arrived but describes a view of the chain that is not current.
    case indexNotCurrent(reason: String)

    public var isBroadcastUnavailable: Bool {
        if case .refused(let code, _) = self { return code == "broadcast_unavailable" }
        return false
    }

    public var displayMessage: String {
        switch self {
        case .couldNotAsk(let d): return "Could not reach the network: \(d)"
        case .httpStatus(let c, _): return "The server answered \(c)."
        case .malformedAnswer(let d): return "The answer could not be read: \(d)"
        case .refused(_, let m): return m
        case .indexNotCurrent(let r): return "Not up to date -- \(r)."
        }
    }
}

// MARK: - the client

/// The one place this app talks to the network.
///
/// Async and throwing. There is deliberately no variant that returns an optional
/// or a default: `try await` forces every call site to say what it does when the
/// answer does not arrive, which is the whole point.
public actor ExplorerClient {

    public struct Config: Sendable {
        public var base: URL
        /// A second instance, asked only when corroboration is worth the extra
        /// round trip. The payment rails use explorer2 for exactly this.
        public var corroborationBase: URL?
        public var timeout: TimeInterval

        public init(
            base: URL = URL(string: "https://explorer.pc.am/api")!,
            corroborationBase: URL? = URL(string: "https://explorer2.pc.am/api"),
            timeout: TimeInterval = 20
        ) {
            self.base = base
            self.corroborationBase = corroborationBase
            self.timeout = timeout
        }
    }

    private let config: Config
    private let session: URLSession
    private let decoder: JSONDecoder

    public init(config: Config = Config()) {
        self.config = config
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = config.timeout
        c.timeoutIntervalForResource = config.timeout * 2
        c.waitsForConnectivity = false
        c.urlCache = nil
        // A cached balance is a stale balance wearing a fresh one clothes.
        c.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        self.session = URLSession(configuration: c)
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        self.decoder = d
    }

    // MARK: reads

    public func status() async throws -> StatusResponse {
        try await get("status", as: StatusResponse.self)
    }

    public func address(_ addr: String, historyLimit: Int = 25) async throws -> AddressResponse {
        try await get("address/\(addr)?limit=\(historyLimit)", as: AddressResponse.self)
    }

    public func addressHistory(
        _ addr: String, limit: Int = 25, offset: Int = 0
    ) async throws -> AddressResponse {
        try await get("address/\(addr)/txs?limit=\(limit)&offset=\(offset)", as: AddressResponse.self)
    }

    /// NOTE THE PLURAL. `/utxo` is a 404 and always has been.
    public func utxos(_ addr: String, limit: Int = 200, offset: Int = 0) async throws -> UtxosResponse {
        try await get("address/\(addr)/utxos?limit=\(limit)&offset=\(offset)", as: UtxosResponse.self)
    }

    /// Every UTXO for one address, following `has_more`.
    ///
    /// Bounded: a wallet that walks an unbounded list on a screen refresh is a
    /// wallet that hangs. If the cap is hit the caller is told, rather than
    /// silently handed a partial set it would treat as the whole balance.
    public func allUtxos(_ addr: String, cap: Int = 1000) async throws -> (rows: [UtxoRow], complete: Bool, index: IndexStatus) {
        var rows = [UtxoRow]()
        var offset = 0
        var lastIndex: IndexStatus?
        while rows.count < cap {
            let page = try await utxos(addr, limit: 200, offset: offset)
            lastIndex = page.index
            rows.append(contentsOf: page.utxos)
            if !page.hasMore { break }
            offset += page.utxos.count
            if page.utxos.isEmpty { break }
        }
        guard let idx = lastIndex else {
            throw ExplorerError.malformedAnswer("no index block in the utxo response")
        }
        return (rows, rows.count < cap, idx)
    }

    /// The gap-limit scan. 20-200 addresses do not fit in a URL, hence the POST.
    public func addresses(_ addrs: [String]) async throws -> AddressesResponse {
        let body = try JSONSerialization.data(withJSONObject: ["addresses": addrs])
        return try await post("addresses", body: body, as: AddressesResponse.self)
    }

    public func transaction(_ txid: String) async throws -> Data {
        try await rawGet("tx/\(txid)")
    }

    // MARK: broadcast

    /// Hand a signed transaction to the network.
    ///
    /// Returns a three-way outcome rather than a txid or a throw, because the
    /// endpoint genuinely has three answers and flattening them is how a wallet
    /// tells somebody their payment failed while it is confirming.
    ///
    /// Two nodes sit behind this: a `-disablewallet` RELAY that holds no keys
    /// and cannot hold any, and a separate WITNESS node that was not submitted
    /// to and independently answers "does the network have this". That is why
    /// the answer is about the network rather than about one mempool.
    ///
    /// RETRYING IS SAFE AND YOU SHOULD. The txid is computed from the submitted
    /// bytes BEFORE the node is contacted, so a lost HTTP response does not lose
    /// the transaction, and `sendrawtransaction` on something already in the
    /// mempool is not an error. A lost response is not a failure. There is a
    /// broadcast rate limit separate from the read limit, so back off rather
    /// than retrying in a tight loop.
    public func broadcast(rawHex: String) async throws -> BroadcastOutcome {
        let body = try JSONSerialization.data(withJSONObject: ["hex": rawHex])
        let data = try await postRaw("tx", body: body)
        let r: BroadcastResponse
        do {
            r = try decoder.decode(BroadcastResponse.self, from: data)
        } catch {
            // A body that will not parse resolves NOTHING. It is not a rejection.
            throw ExplorerError.malformedAnswer("the broadcast answer could not be read")
        }

        // A structured refusal that is ABOUT THE SERVICE rather than about this
        // transaction -- the old broadcast_unavailable, or a rate limit -- is
        // not an answer about the payment and must not read as one.
        if let e = r.error, r.txid == nil, r.acceptedByNode == nil {
            throw ExplorerError.refused(code: e.code, message: e.message)
        }

        switch r.network?.hasIt {
        case .some(true):
            guard let txid = r.txid else {
                throw ExplorerError.malformedAnswer("the network has it but no txid was given")
            }
            return .sent(txid: txid)
        case .some(false):
            return .rejected(
                txid: r.txid,
                reason: r.error?.message ?? r.network?.state ?? "the network does not have it",
                detail: r.error?.detail ?? r.network?.detail
            )
        case .none:
            // UNKNOWN. Deliberately its own case, and deliberately not an error.
            guard let txid = r.txid else {
                throw ExplorerError.malformedAnswer("no txid and no network answer")
            }
            return .notYetConfirmed(txid: txid, detail: r.network?.detail)
        }
    }

    // MARK: plumbing

    private func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        try decode(try await rawGet(path), as: type)
    }

    private func rawGet(_ path: String) async throws -> Data {
        guard let url = URL(string: config.base.absoluteString + "/" + path) else {
            throw ExplorerError.couldNotAsk("bad URL for \(path)")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await perform(req)
    }

    private func post<T: Decodable>(_ path: String, body: Data, as type: T.Type) async throws -> T {
        guard let req = request(path, body: body) else {
            throw ExplorerError.couldNotAsk("bad URL for \(path)")
        }
        return try decode(try await perform(req), as: type)
    }

    /// POST without the generic error handling.
    ///
    /// The broadcast endpoint answers a REJECTION under HTTP 400 with a body
    /// that is a real answer about the transaction -- a txid, a reason, a
    /// network verdict. Running that through `perform` would turn the most
    /// informative response the API produces into a bare status code.
    private func postRaw(_ path: String, body: Data) async throws -> Data {
        guard let req = request(path, body: body) else {
            throw ExplorerError.couldNotAsk("bad URL for \(path)")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw ExplorerError.couldNotAsk((error as NSError).localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw ExplorerError.malformedAnswer("not an HTTP response")
        }
        // 5xx and 429 are about the SERVICE, not about this transaction.
        if http.statusCode >= 500 || http.statusCode == 429 {
            if let b = try? decoder.decode(APIErrorBody.self, from: data) {
                throw ExplorerError.refused(code: b.error.code, message: b.error.message)
            }
            throw ExplorerError.httpStatus(
                http.statusCode, body: String(data: data.prefix(400), encoding: .utf8)
            )
        }
        return data
    }

    private func request(_ path: String, body: Data) -> URLRequest? {
        guard let url = URL(string: config.base.absoluteString + "/" + path) else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.httpBody = body
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        return req
    }

    private func perform(_ req: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            // Could not ask. This is the case that must never turn into a
            // number: it resolves nothing at all.
            throw ExplorerError.couldNotAsk((error as NSError).localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw ExplorerError.malformedAnswer("not an HTTP response")
        }
        // A structured refusal can arrive with a non-2xx status, and its message
        // is more useful than the status. Look for it first.
        if let body = try? decoder.decode(APIErrorBody.self, from: data) {
            throw ExplorerError.refused(code: body.error.code, message: body.error.message)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw ExplorerError.httpStatus(
                http.statusCode, body: String(data: data.prefix(400), encoding: .utf8)
            )
        }
        return data
    }

    private func decode<T: Decodable>(_ data: Data, as type: T.Type) throws -> T {
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw ExplorerError.malformedAnswer(String(describing: error).prefix(200).description)
        }
    }
}
