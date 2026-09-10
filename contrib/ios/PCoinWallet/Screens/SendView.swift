import SwiftUI
import PCoinKit

/// Sending PCoin.
///
/// THREE GATES, in this order, and none of them is decoration:
///
///  1. The address is validated locally -- there is no node to ask -- and a
///     failure says WHICH kind of failure it was.
///  2. The transaction is built and SIGNED, and only then are the figures shown.
///     The review line promises "These are the real figures from the transaction
///     that was just built", so they have to be measured from the real bytes.
///  3. Nothing is broadcast until the review screen is confirmed.
///
/// THE UNLOCK HAPPENS ONE SCREEN EARLIER THAN ON ANDROID, and this is the one
/// user-visible ordering difference in the app. Android can show real figures
/// without an unlock because the node inside it holds the key and builds the
/// transaction. Here, building means signing, which means the key. Nothing has
/// left the wallet at that point -- the words on the review screen are still
/// literally true -- but the Face ID prompt arrives at "Check this send" rather
/// than at "Send now".
struct SendView: View {

    @EnvironmentObject private var store: WalletStore
    @Environment(\.dismiss) private var dismiss

    var prefilledAddress: String?
    var prefilledAmountSat: Int64?

    @State private var address = ""
    @State private var amountText = ""
    @State private var sendEverything = false
    @State private var feeRate: FeeRate = .normal
    @State private var error: String?
    @State private var plan: PlannedSend?
    @State private var busy = false
    @State private var showScanner = false
    @State private var result: SendResult?

    /// THREE OUTCOMES, NOT TWO. The broadcast endpoint answers "the network has
    /// it", "the network rejected it", and "nobody can yet say", and the third
    /// is a real state a person has to be told about honestly. Folding it into
    /// either of the others is the bug this whole app is written to avoid.
    private enum SendResult: Identifiable {
        case sent(txid: String, plan: PlannedSend)
        case rejected(reason: String, detail: String?)
        case unconfirmed(txid: String, detail: String?)
        /// Could not even ask. Says nothing about the payment.
        case couldNotAsk(String)

        var id: String {
            switch self {
            case .sent(let t, _): return "sent:" + t
            case .rejected(let r, _): return "rejected:" + r
            case .unconfirmed(let t, _): return "unknown:" + t
            case .couldNotAsk(let m): return "ask:" + m
            }
        }
    }

    var body: some View {
        Form {
            destinationSection
            amountSection
            feeSection
            if let e = error {
                Section { ErrorLine(e) }
            }
            Section {
                Button(busy ? S.sendPreparing : S.sendReview) { review() }
                    .disabled(busy)
                    .frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(S.sendTitle)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if address.isEmpty, let a = prefilledAddress { address = a }
            // Prefilled ONLY when the link actually named an amount. A link with
            // no amount must not write 0.00000000 into the box.
            if amountText.isEmpty, let sat = prefilledAmountSat, sat > 0 {
                amountText = Amounts.toPlainString(sat)
            }
        }
        .sheet(isPresented: $showScanner) {
            ScanView { scanned in
                showScanner = false
                guard let t = PaymentUri.parse(scanned) else {
                    error = S.scanNotPayment
                    return
                }
                address = t.address
                if let sat = t.amountSat, sat > 0 {
                    amountText = Amounts.toPlainString(sat)
                    error = S.scanFilledAmount(Fmt.coinsSat(sat))
                }
            }
        }
        .sheet(item: $plan) { p in
            ReviewView(plan: p) { confirmed in
                plan = nil
                if confirmed { send(p) }
            }
            .environmentObject(store)
        }
        .alert(item: $result) { r in
            switch r {
            case .sent(let txid, let p):
                return Alert(
                    title: Text(S.sendOkTitle),
                    message: Text(S.sendOkBody + "\n\n" + S.resultTo(p.destination.text)
                                  + "\n\n" + txid),
                    dismissButton: .default(Text(S.sendDone)) {
                        store.refresh()
                        dismiss()
                    }
                )
            case .rejected(let reason, let detail):
                // A FACT. The network answered and said no, so the coins are
                // untouched and it is safe to say so.
                return Alert(
                    title: Text(S.sendFailedTitle),
                    message: Text(S.sendRejected(reason) + (detail.map { "\n\n" + $0 } ?? "")),
                    dismissButton: .default(Text("OK"))
                )
            case .unconfirmed(let txid, let detail):
                // UNKNOWN. Not a failure. Saying "not sent" here would be a
                // confident wrong answer about somebody money.
                return Alert(
                    title: Text(S.sendUnknownTitle),
                    message: Text(S.sendUnknownBody(txid) + (detail.map { "\n\n" + $0 } ?? "")),
                    dismissButton: .default(Text(S.sendDone)) {
                        store.refresh()
                        dismiss()
                    }
                )
            case .couldNotAsk(let why):
                // The request may well have gone through. Retrying is safe --
                // the txid is fixed by the bytes, not by the response.
                return Alert(
                    title: Text(S.sendUnknownTitle),
                    message: Text(S.sendCouldNotAsk(why)),
                    dismissButton: .default(Text("OK"))
                )
            }
        }
    }

    // MARK: - sections

    private var destinationSection: some View {
        Section(S.sendToLabel) {
            HStack {
                TextField(S.sendToHint, text: $address)
                    .font(.system(.body, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button { showScanner = true } label: { Image(systemName: "qrcode.viewfinder") }
                    .buttonStyle(.borderless)
            }
            if !address.isEmpty {
                switch Address.parse(address) {
                case .success:
                    if let n = store.addressBook.name(for: address) {
                        Text(S.knownAddress(n)).font(.footnote).foregroundStyle(.secondary)
                    } else {
                        Text(S.unknownAddress).font(.footnote).foregroundStyle(.secondary)
                    }
                case .failure(let f):
                    Text(WalletStore.describe(addressFailure: f))
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            if !store.addressBook.entries.isEmpty {
                NavigationLink(S.sendBookLabel) {
                    AddressBookView(pick: { picked in address = picked })
                }
                .font(.footnote)
            }
        }
    }

    private var amountSection: some View {
        Section(S.sendAmountLabel) {
            HStack {
                TextField(S.sendAmountHint, text: $amountText)
                    .keyboardType(.decimalPad)
                    .disabled(sendEverything)
                Button(S.sendMax) {
                    sendEverything.toggle()
                    if sendEverything { amountText = "" }
                }
                .buttonStyle(.borderless)
                .foregroundStyle(sendEverything ? Color.accentColor : Color.secondary)
            }
            if sendEverything {
                Text(S.reviewAll).font(.footnote).foregroundStyle(.secondary)
            }
            // The available line, and an em dash when it has not been read.
            Text(store.snapshot.map { S.sendAvailable(Fmt.coinsSat($0.spendableSat)) }
                 ?? S.sendAvailableUnknown)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var feeSection: some View {
        Section(S.sendFeeLabel) {
            Picker(S.sendFeeLabel, selection: $feeRate) {
                Text(S.feeNormal).tag(FeeRate.normal)
                Text(S.feeFast).tag(FeeRate.fast)
                Text(S.feeVeryFast).tag(FeeRate.veryFast)
            }
            .pickerStyle(.segmented)
            Text(S.sendFeeHint).font(.footnote).foregroundStyle(.secondary)
        }
    }

    // MARK: - actions

    private func review() {
        error = nil
        guard !address.trimmingCharacters(in: .whitespaces).isEmpty else {
            error = S.errNoAddress
            return
        }
        var amountSat: Int64?
        if !sendEverything {
            switch Amounts.parse(amountText) {
            case .ok(let sat):
                amountSat = sat
            case .bad(let why):
                error = SendView.message(for: why)
                return
            }
        }
        busy = true
        Task {
            do {
                let p = try await store.prepare(
                    toAddress: address, amountSat: amountSat, feeRate: feeRate
                )
                await MainActor.run { plan = p; busy = false }
            } catch {
                await MainActor.run {
                    self.error = WalletStore.describe(error)
                    busy = false
                }
            }
        }
    }

    private func send(_ p: PlannedSend) {
        busy = true
        Task {
            do {
                let outcome = try await store.broadcast(p)
                await MainActor.run {
                    switch outcome {
                    case .sent(let txid):
                        result = .sent(txid: txid, plan: p)
                    case .rejected(_, let reason, let detail):
                        result = .rejected(reason: reason, detail: detail)
                    case .notYetConfirmed(let txid, let detail):
                        result = .unconfirmed(txid: txid, detail: detail)
                    }
                    busy = false
                }
            } catch {
                await MainActor.run {
                    // A throw here is a TRANSPORT failure, not a verdict on the
                    // payment. It is reported as unknown, because that is what
                    // it is.
                    result = .couldNotAsk(WalletStore.describe(error))
                    busy = false
                }
            }
        }
    }

    static func message(for reason: Amounts.Reason) -> String {
        switch reason {
        case .empty: return S.errAmountEmpty
        case .notANumber: return S.errAmountBad
        case .tooManyDecimals: return S.errAmountDecimals
        case .negative: return S.errAmountNegative
        case .zero: return S.errAmountZero
        case .dust: return S.errAmountDust
        case .tooLarge: return S.errAmountHuge
        }
    }
}

extension PlannedSend: Identifiable {
    public var id: String { txid }
}

/// The review step. Nothing has been sent when this is on screen.
struct ReviewView: View {
    let plan: PlannedSend
    let done: (Bool) -> Void

    @EnvironmentObject private var store: WalletStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(S.sendCheckHint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    AddressPanel(
                        label: S.sendToLabel,
                        address: plan.destination.text,
                        name: store.addressBook.name(for: plan.destination.text)
                    )

                    VStack(alignment: .leading, spacing: 6) {
                        Text(S.reviewAmount(Fmt.coinsSat(plan.amountSat)))
                            .font(.title3.weight(.semibold))
                        Text(S.reviewFee(Fmt.coinsSat(plan.feeSat)))
                        Text(S.reviewTotal(Fmt.coinsSat(plan.leavesWalletSat)))
                            .font(.body.weight(.semibold))
                        if plan.sendsEverything {
                            Text(S.reviewAll).font(.footnote).foregroundStyle(.secondary)
                        }
                        // The measured size and rate, so the fee is checkable
                        // rather than merely stated.
                        Text("\(plan.vsize) vbytes at \(String(format: "%.2f", plan.effectiveSatPerVbyte)) sat/vbyte")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Button(S.sendConfirm) { done(true); dismiss() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .frame(maxWidth: .infinity)

                    Button(S.sendBack) { done(false); dismiss() }
                        .frame(maxWidth: .infinity)
                }
                .padding(20)
            }
            .navigationTitle(S.sendCheckTitle)
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
