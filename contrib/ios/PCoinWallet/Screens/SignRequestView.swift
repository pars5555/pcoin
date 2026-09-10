import SwiftUI
import PCoinKit

/// The one screen any other app is allowed to open.
///
/// WHY IT EXISTS. A Telegram mini app can show a balance and compose a payment,
/// but it must never hold a key: a key in a webview lives in browser storage a
/// cleared cache destroys, or on our servers, which would make us a custodian of
/// other people money. So the key stays where it already is -- behind the Secure
/// Enclave -- and the REQUEST travels instead, as a `pcoin:` URI or a
/// `https://pc.am/pay` link.
///
/// WHY IT IS NOT `SendView`. A payment screen that any other app can launch with
/// fields filled is a phishing surface. So this screen is deliberately incapable
/// of spending. It:
///
///   * parses the URI and REFUSES anything it cannot fully understand, rather
///     than passing a half-read request forward,
///   * shows the destination in monospace and the amount in the largest type on
///     the screen, because a lookalike address is the attack and the eye is the
///     only defence against it,
///   * names where the request came from, and says plainly that it came from
///     outside the app,
///   * has no Send button at all. Its forward action opens the ordinary Send
///     screen with the fields filled, where the review step and the unlock both
///     still stand between this and any money moving.
///
/// The three fixes shipped in Android 0.2.20 are all here, marked FIX 1/2/3.
struct SignRequestView: View {

    let request: PaymentRequest

    @EnvironmentObject private var store: WalletStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var goToSend = false
    @State private var goToSetup = false

    /// A request that cannot be parsed resolves NOTHING. It is not treated as
    /// "no amount" and not as a bare address -- it is refused, because a
    /// half-understood payment request is exactly the shape of an attempt to
    /// slip something past the reader.
    private var target: PaymentUri.Target? { PaymentUri.parse(request.raw) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let t = target, !t.address.isEmpty {
                        if store.hasWallet {
                            payable(t)
                        } else {
                            noWallet(t)
                        }
                    } else {
                        unreadable()
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(S.srTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(S.srCancel) { dismiss() }
                }
            }
            .navigationDestination(isPresented: $goToSend) {
                if let t = target {
                    // FIX 1: the amount is PREFILLED, not retyped.
                    //
                    // It used to be parsed, shown in the largest type on this
                    // screen, and then dropped -- every link produced a
                    // half-filled form. Prefilled only when the link actually
                    // names an amount: nil must not write 0.00000000 into the
                    // box, which would be a confident answer to a question
                    // nobody asked.
                    SendView(prefilledAddress: t.address, prefilledAmountSat: t.amountSat)
                        .environmentObject(store)
                }
            }
            .navigationDestination(isPresented: $goToSetup) {
                SetupView().environmentObject(store)
            }
        }
    }

    // MARK: - the three states

    @ViewBuilder
    private func payable(_ t: PaymentUri.Target) -> some View {
        Text(request.origin.map(S.srOriginNamed) ?? S.srOriginUnknown)
            .font(.subheadline)
            .foregroundStyle(.secondary)

        WarningBanner(text: S.srWarn)

        VStack(alignment: .leading, spacing: 6) {
            Text(S.srAmountLabel)
                .font(.caption)
                .foregroundStyle(.secondary)
            // The largest type on the screen, deliberately.
            Text(t.amountSat.map { Amounts.toPlainString($0) + " PCN" } ?? S.srAmountUnset)
                .font(.system(size: 34, weight: .semibold, design: .rounded))
                .minimumScaleFactor(0.5)
                .lineLimit(1)
        }

        if t.amountSat == nil || t.amountSat! <= 0 {
            // Say so rather than showing a confident zero. An amount nobody
            // asked for is not an amount of nothing.
            Text(S.srNoAmountNote)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }

        AddressPanel(label: S.srToLabel, address: t.address, name: store.addressBook.name(for: t.address))

        Button(S.srContinue) { goToSend = true }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .frame(maxWidth: .infinity)
    }

    /// FIX 2: NO WALLET, NO SEND SCREEN.
    ///
    /// Reported from a real phone 2026-09-10: a fresh install with no wallet set
    /// up still walked through to Send, which cannot send anything and does not
    /// explain why. Offering a payment screen to somebody who has no key is
    /// worse than refusing -- it reads as "the payment failed" rather than "the
    /// wallet was never set up".
    ///
    /// Checked BEFORE the request is displayed, so nobody reads an address and
    /// an amount and forms an intention they cannot act on.
    @ViewBuilder
    private func noWallet(_ t: PaymentUri.Target) -> some View {
        Text(S.srNoWalletAmount)
            .font(.system(size: 34, weight: .semibold, design: .rounded))

        WarningBanner(text: S.srNoWallet, tone: .stop)

        AddressPanel(label: S.srToLabel, address: t.address, name: nil)

        // The useful action, offered first: this app IS installed -- it could
        // not be drawing this screen otherwise -- so what is missing is a
        // wallet, not the app.
        Button(S.srSetup) { goToSetup = true }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .frame(maxWidth: .infinity)

        // And the store link underneath, for the case the button cannot help
        // with: a TestFlight build, or one that came from somewhere else.
        Button(S.srStore) {
            if let url = URL(string: "https://apps.apple.com/app/pcoin-wallet/id0000000000") {
                openURL(url)
            }
        }
        .font(.footnote)
        .frame(maxWidth: .infinity)

        // NO Continue button. Not disabled -- absent.
    }

    /// FIX 3: a malformed address is refused outright.
    ///
    /// Found on hardware: "...nq4j\?amount=7.25" -- one stray escape -- parsed
    /// as an address with a trailing backslash and was displayed as legitimate
    /// all the way to the send form. Windows already refused the same input, so
    /// the two wallets disagreed about what an address IS, which is the worst
    /// possible place to differ. This is the screen whose entire job is showing
    /// the true destination.
    @ViewBuilder
    private func unreadable() -> some View {
        Text(S.srUnreadableAmount)
            .font(.system(size: 34, weight: .semibold, design: .rounded))

        WarningBanner(text: S.srUnreadable, tone: .stop)

        VStack(alignment: .leading, spacing: 6) {
            Text(S.srToLabel)
                .font(.caption)
                .foregroundStyle(.secondary)
            // Shown truncated and unmistakably as raw text, so somebody can see
            // WHAT arrived without it being dressed up as an address.
            Text(String(request.raw.prefix(200)))
                .font(.system(.footnote, design: .monospaced))
                .textSelection(.enabled)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }

        // NO Continue button.
    }
}

/// The destination, shown the way a destination has to be shown: in full, in
/// monospace, never truncated.
struct AddressPanel: View {
    let label: String
    let address: String
    let name: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(address)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            if let n = name {
                // A name is a note somebody made on this phone. It is shown
                // BESIDE the address, never instead of it.
                Text(S.knownAddress(n))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Text(S.unknownAddress)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct WarningBanner: View {
    enum Tone { case caution, stop }
    let text: String
    var tone: Tone = .caution

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: tone == .stop ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(tone == .stop ? Color.red : Color.orange)
            Text(text)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background((tone == .stop ? Color.red : Color.orange).opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
