import XCTest

/// The three payment-link cases from §3 of the brief, exercised against the real
/// app on a real (simulated) device.
///
/// `PaymentUriTests` already asserts the RULES with no device at all. This
/// asserts the SCREENS: that the review screen actually renders, that the amount
/// really is prefilled, and -- the part a logic test cannot check -- that the
/// Continue button is ABSENT rather than merely disabled in the two cases where
/// nothing may be paid.
///
/// Each case sets the app up from scratch through the REAL setup buttons -- no
/// back door installs a key -- and then hands it the payment URI.
///
/// HOW THE URI ARRIVES, STATED PRECISELY, because it is not quite the real door.
/// It is delivered through `handle(_:)`, the same function `onOpenURL` calls, so
/// `PaymentRequest` parsing, the refusal rules and `SignRequestView` are all
/// exercised exactly as for a real link. What is NOT exercised here is iOS own
/// scheme dispatch.
///
/// That half is proven separately and by hand:
///
///     xcrun simctl openurl booted "pcoin:pc1qnfk...?amount=7.25"
///
/// makes the system offer "Open in PCoin Wallet?", which is the registration
/// working. Driving that dialog from inside XCUITest has to go through Safari,
/// and Safari address-bar focus is unreliable under test -- a property of
/// Safari, not of this app, and not worth making the suite flaky for.
final class PaymentLinkUITests: XCTestCase {

    private let address = "pc1qnfk7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j"

    override func setUp() {
        continueAfterFailure = false
    }

    /// Launch with a clean slate. `-uiTestResetWallet` is read only by the test
    /// hook in the app and does exactly one thing: it forgets the wallet. It
    /// cannot create one and it cannot spend.
    private func launch(freshWallet: Bool, openURL uri: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestResetWallet"]
        app.launch()
        if freshWallet {
            // Through the real setup flow, tapping the real buttons. There is
            // deliberately no back door that installs a key.
            let create = app.buttons["Create a new wallet"]
            XCTAssertTrue(create.waitForExistence(timeout: 20), "setup screen: \(visibleText(app))")
            create.tap()
            let confirm = app.buttons["I have written them down"]
            if !confirm.waitForExistence(timeout: 30) {
                // Say WHAT is on screen rather than only that the expected thing
                // is not. The setup screen shows any failure as an error line, so
                // this turns a silent timeout into the actual reason.
                XCTFail("the twelve words never appeared. On screen: \(visibleText(app))")
                return app
            }
            confirm.tap()
            let done = app.buttons["Done"]
            XCTAssertTrue(done.waitForExistence(timeout: 20), "setup finished")
            done.tap()
        }
        if let uri = uri {
            // Relaunch carrying the request. It is delivered through the same
            // `handle(_:)` the system calls for a real `pcoin:` URL -- see the
            // note in PCoinWalletApp for what that does and does not prove.
            app.terminate()
            app.launchArguments = ["-uiTestOpenURL", uri]
            app.launch()
        }
        return app
    }

    /// Everything readable on screen, for a failure message that explains itself.
    private func visibleText(_ app: XCUIApplication) -> String {
        let texts = app.staticTexts.allElementsBoundByIndex.prefix(25).map { $0.label }
        let buttons = app.buttons.allElementsBoundByIndex.prefix(15).map { "[\($0.label)]" }
        return (texts + buttons).joined(separator: " | ")
    }

    /// CASE 1 -- valid link, wallet set up.
    /// Expected: review shows 7.25000000 PCN, Continue leads to a prefilled Send.
    func testValidLinkWithWallet() {
        let app = launch(freshWallet: true, openURL: "pcoin:\(address)?amount=7.25")

        XCTAssertTrue(
            app.staticTexts["7.25000000 PCN"].waitForExistence(timeout: 20),
            "the amount must be shown, in the largest type on the screen"
        )
        XCTAssertTrue(app.staticTexts[address].exists, "the destination, in full")
        let carryOn = app.buttons["Continue to Send"]
        XCTAssertTrue(carryOn.exists, "a payable request offers Continue")

        carryOn.tap()
        // FIX 1: PREFILLED, not retyped.
        XCTAssertTrue(
            app.textFields["7.25000000"].waitForExistence(timeout: 10)
                || app.staticTexts["7.25000000"].exists,
            "the amount must arrive in the send form already filled in"
        )
    }

    /// CASE 2 -- valid link, NO wallet.
    /// Expected: it explains, offers "Set up a wallet" and the store link, and
    /// there is NO Continue button at all.
    func testValidLinkWithNoWallet() {
        let app = launch(freshWallet: false, openURL: "pcoin:\(address)?amount=7.25")

        XCTAssertTrue(
            app.staticTexts["No wallet yet"].waitForExistence(timeout: 20),
            "it must say there is no wallet, not show a payment it cannot make"
        )
        XCTAssertTrue(app.buttons["Set up a wallet"].exists, "the useful action, offered first")
        XCTAssertTrue(
            app.buttons["Get PCoin Wallet on the App Store"].exists,
            "and the store link underneath"
        )
        // ABSENT, not disabled. A send screen that cannot send and does not say
        // why reads as "the payment failed" rather than "you have no wallet".
        XCTAssertFalse(app.buttons["Continue to Send"].exists, "there must be no way forward")
    }

    /// CASE 3 -- one stray escape in the address.
    /// Expected: refused outright, with the exact sentence, and no Continue.
    func testMalformedAddressIsRefused() {
        // One stray escape, exactly as it arrived on hardware.
        let app = launch(freshWallet: true, openURL: "pcoin:\(address)%5C?amount=7.25")

        XCTAssertTrue(
            app.staticTexts["Unreadable"].waitForExistence(timeout: 20),
            "a half-understood request must be refused, not half-shown"
        )
        let refusal = app.staticTexts.containing(
            NSPredicate(format: "label BEGINSWITH %@", "This request could not be read")
        ).firstMatch
        XCTAssertTrue(refusal.exists, "the refusal must say why and that nothing was sent")
        XCTAssertFalse(app.buttons["Continue to Send"].exists)
        // And the amount must NOT be shown as if it were a real request.
        XCTAssertFalse(app.staticTexts["7.25000000 PCN"].exists)
    }
}
