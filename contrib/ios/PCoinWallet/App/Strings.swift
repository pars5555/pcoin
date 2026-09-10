import Foundation

/// Every user-visible string in the app, in one file.
///
/// THE WORDING IS PART OF THE PRODUCT, NOT DECORATION. Each string below is
/// copied from `contrib/android/app/src/wallet/res/values/strings.xml`, and the
/// Android resource name is on the line above it so the two can be diffed by
/// anybody, in either direction. The brief for this app is "identical to the
/// Android one", and the sentences a person actually reads are most of what
/// "identical" means to them.
///
/// Where a string had to change, it is marked `IOS:` with the reason. There are
/// only a handful, and they are all places where the Android sentence describes
/// something that is not true on iOS -- an Android battery setting, or a node
/// running inside the app.
///
/// Not localised, deliberately, exactly as Android is not: this wallet ships one
/// language, and a half-translated wallet is worse than an English one.
enum S {

    // MARK: app

    /// app_name
    static let appName = "PCoin Wallet"

    // MARK: main screen -- wallet_*

    /// wallet_title
    static let walletTitle = "My PCoin"
    /// wallet_available
    static let available = "Available to spend"
    /// wallet_amount_unknown -- an em dash, never 0.00000000
    static let amountUnknown = "\u{2014}"
    /// wallet_refresh
    static let refreshBalance = "Refresh balance"
    /// wallet_refresh_busy
    static let refreshBusy = "Checking\u{2026}"
    /// wallet_checked_never
    static let checkedNever = "Not checked yet"
    /// wallet_checked_just_now
    static let checkedJustNow = "Updated just now"
    /// wallet_checked_ago
    static func checkedAgo(_ ago: String) -> String { "Updated \(ago) ago" }
    /// wallet_check_failed
    static let checkFailed =
        "Could not check just now. Your coins are safe; this is only the reading."
    /// wallet_note_pending
    static func notePending(_ amount: String) -> String { "\(amount) arriving, not yet confirmed" }
    /// wallet_note_immature
    static func noteImmature(_ amount: String, _ blocks: Int) -> String {
        "\(amount) newly mined, spendable in \(blocks) more blocks"
    }
    /// wallet_note_both
    static func noteBoth(_ pending: String, _ immature: String, _ blocks: Int) -> String {
        "\(pending) arriving \u{00B7} \(immature) spendable in \(blocks) more blocks"
    }
    /// wallet_note_immature_unknown
    static func noteImmatureUnknown(_ amount: String) -> String {
        "\(amount) newly mined, not spendable yet"
    }
    /// wallet_receive_title
    static let receiveTitle = "Receive"
    /// wallet_receive_hint
    static let receiveHint = "Share this address to be paid. It is yours and does not change."
    /// wallet_address_unknown
    static let addressUnknown = "No address yet. Finish setting up your wallet."
    /// wallet_copy
    static let copy = "Copy"
    /// wallet_share
    static let share = "Share"
    /// wallet_copied
    static let copied = "Address copied"
    /// wallet_share_subject
    static let shareSubject = "My PCoin address"
    /// wallet_backup_title
    static let backupTitle = "Write down your recovery phrase"
    /// wallet_backup_body
    static let backupBody =
        "Twelve words are the only way to get this wallet back if the phone is lost or the app is removed."
    /// wallet_backup_action
    static let backupAction = "Show my phrase"
    /// wallet_qr_description
    static let qrDescription = "QR code of your receiving address"
    /// wallet_phrase_title
    static let phraseTitle = "Recovery phrase"
    /// wallet_phrase_body
    static let phraseBody =
        "Your twelve words restore this wallet on any device. Check them against your paper copy whenever you want."
    /// wallet_send
    static let send = "Send"
    /// wallet_history
    static let history = "History"
    /// wallet_addresses
    static let addresses = "Address book"
    /// wallet_version
    static func version(_ name: String, _ code: Int) -> String { "v\(name) (\(code))" }

    // IOS: the Android chain line reads "Block %1$d - %2$d peers", describing
    // the node running inside the app. There is no node inside this app, so
    // claiming a peer count would be claiming something this wallet cannot know.
    // The line names the explorer instead, which is what it is actually reading.
    static func chainLine(height: Int) -> String { "Block \(height) \u{00B7} via explorer.pc.am" }
    /// wallet_chain_line_unknown
    static let chainLineUnknown = "Not connected yet"

    // IOS: replaces wallet_node_* , which describe an in-app node syncing.
    static let indexUpToDate = "Up to date"
    static func indexNotCurrent(_ why: String) -> String { "Not up to date \u{2014} \(why)." }

    // MARK: setup -- setup_*, done_*

    /// setup_title
    static let setupTitle = "Set up your wallet"
    /// setup_intro -- IOS: "phone" kept, "uninstalled" kept; both are true here.
    static let setupIntro =
        "This app holds PCoin on this phone. A 12-word recovery phrase is the only way to get your coins back if the phone is lost, reset, or the app is uninstalled."
    static let setupCreate = "Create a new wallet"
    static let setupRestore = "Restore from a recovery phrase"
    static let setupWriteTitle = "Write these twelve words down"
    static let setupWriteBody =
        "In this order, on paper. Anyone who has them has your coins, and nobody can get them back for you."
    static let setupConfirm = "I have written them down"
    static let setupRestoreTitle = "Enter your recovery phrase"
    static let setupRestoreBody =
        "Twelve words, in order, separated by spaces. Case does not matter."
    static let setupRestoreAction = "Restore this wallet"
    static let setupErrWordCount = "A recovery phrase is twelve words. That is %@."
    static let setupErrUnknownWord = "%@ is not one of the 2048 recovery-phrase words."
    static let setupErrChecksum =
        "Those twelve words do not check out as a recovery phrase. One of them is wrong, and the check cannot say which \u{2014} compare all twelve against your paper copy."
    /// done_created
    static func doneCreated(_ address: String) -> String {
        "Your wallet is set up. Coins sent to this address are yours:\n\n\(address)\n\nThis address comes from your recovery phrase, so those words bring it back on any device."
    }
    /// done_restored
    static func doneRestored(_ address: String, _ note: String) -> String {
        "Your wallet has been restored. Your address is:\n\n\(address)\n\n\(note)"
    }

    // MARK: send -- send_*

    /// send_title
    static let sendTitle = "Send PCoin"
    /// send_available
    static func sendAvailable(_ amount: String) -> String { "Available to spend: \(amount)" }
    /// send_available_unknown
    static let sendAvailableUnknown = "Waiting for your balance\u{2026}"
    /// send_to_label
    static let sendToLabel = "To this address"
    /// send_to_hint
    static let sendToHint = "pc1\u{2026}"
    /// send_amount_label
    static let sendAmountLabel = "Amount"
    /// send_amount_hint
    static let sendAmountHint = "0.00000000"
    /// send_max
    static let sendMax = "MAX"
    /// send_fee_label
    static let sendFeeLabel = "Network fee rate"
    /// send_fee_normal
    static let feeNormal = "Normal"
    /// send_fee_fast
    static let feeFast = "Fast"
    /// send_fee_very_fast
    static let feeVeryFast = "Very fast"
    /// send_fee_hint
    static let sendFeeHint =
        "Fixed rates: 1, 5 or 20 sat per vbyte. Normal is enough unless the network is busy."
    /// send_review
    static let sendReview = "Check this send"
    /// send_check_title
    static let sendCheckTitle = "Check before sending"
    /// send_check_hint
    static let sendCheckHint =
        "Nothing has been sent yet. These are the real figures from the transaction that was just built."
    /// send_review_amount
    static func reviewAmount(_ a: String) -> String { "Amount: \(a)" }
    /// send_review_fee
    static func reviewFee(_ a: String) -> String { "Network fee: \(a)" }
    /// send_review_total
    static func reviewTotal(_ a: String) -> String { "Leaves your wallet: \(a)" }
    /// send_review_all
    static let reviewAll = "Sending everything, minus the fee"
    /// send_review_named
    static func reviewNamed(_ n: String) -> String { "Your name for this address: \(n)" }
    /// send_confirm
    static let sendConfirm = "Send now"
    /// send_back
    static let sendBack = "Change something"
    /// send_preparing
    static let sendPreparing = "Checking\u{2026}"
    /// send_sending
    static let sendSending = "Sending\u{2026}"
    /// send_ok_title
    static let sendOkTitle = "Sent"
    /// send_ok_body
    static let sendOkBody =
        "Your payment is on its way. It will show as confirmed once it is in a block."
    /// send_failed_title
    static let sendFailedTitle = "Not sent"
    /// send_done
    static let sendDone = "Done"
    /// send_err_no_address
    static let errNoAddress = "Enter the address you want to pay."
    /// send_err_amount_empty
    static let errAmountEmpty = "Enter an amount, or tap MAX."
    /// send_err_amount_bad
    static let errAmountBad = "That is not an amount. Use digits and a dot, like 1.5"
    /// send_err_amount_decimals
    static let errAmountDecimals = "PCoin has 8 decimal places. That is more."
    /// send_err_amount_zero
    static let errAmountZero = "Enter an amount greater than zero."
    /// send_err_amount_negative
    static let errAmountNegative = "Enter a positive amount."
    /// send_err_amount_huge
    static let errAmountHuge = "That is more PCoin than will ever exist."
    /// send_err_amount_dust
    static let errAmountDust = "That amount is too small to send."
    /// send_known_address
    static func knownAddress(_ n: String) -> String { "Saved as \(n)" }
    /// send_unknown_address
    static let unknownAddress = "Not in your address book"
    /// send_book_label
    static let sendBookLabel = "Or pay someone you have named"
    /// send_result_to
    static func resultTo(_ a: String) -> String { "Paid to \(a)" }
    /// send_save_title
    static let saveTitle = "Name this address?"
    /// send_save_body
    static let saveBody =
        "Save it and you can pay it by name next time, without pasting anything."
    /// send_saved_confirmation
    static func savedAs(_ n: String) -> String { "Saved as \(n)" }
    /// send_paid_named
    static func paidNamed(_ n: String) -> String { "You paid \(n)" }

    // send_gate_* -- the unlock. IOS: "screen lock" becomes Face ID / Touch ID /
    // passcode, because that is what the device calls it.
    /// send_gate_title
    static let gateTitle = "Confirm this payment"
    /// send_gate_subtitle
    static let gateSubtitle = "Unlock to send your PCoin"
    /// send_gate_cancelled
    static let gateCancelled = "Not sent. You cancelled the unlock."
    /// send_gate_failed
    static let gateFailed = "Not sent. The unlock did not succeed."
    /// send_gate_unavailable -- IOS wording for the same condition
    static let gateUnavailable =
        "This iPhone has no passcode, so nothing can stand between someone holding it and sending your coins. Set a passcode in Settings."
    /// send_lock_unknown
    static func lockUnknown(_ why: String) -> String {
        "Not sent: \(why)\n\nThis iPhone would not say whether it has a passcode, and sending without knowing that is not something this app will do. Try again, or restart the phone."
    }

    // IOS ONLY: there is no local node, so a send goes out through the public
    // relay and can end in a state Android never has -- "nobody can yet say".
    // These three sentences keep the three outcomes apart.

    /// A FACT: the network answered and said no. The coins are untouched.
    static func sendRejected(_ reason: String) -> String {
        "The network refused this payment, so nothing has been sent and your coins are untouched.\n\nReason: \(reason)"
    }

    /// UNKNOWN. Never phrased as a failure -- it may be confirming right now.
    static let sendUnknownTitle = "Not confirmed yet"
    static func sendUnknownBody(_ txid: String) -> String {
        "Your payment was signed and handed to the network, and it is not yet possible to confirm that the network has it. This is NOT a failure \u{2014} it may already be on its way.\n\nDo not send it again. Check your activity in a few minutes.\n\n\(txid)"
    }
    static func sendCouldNotAsk(_ why: String) -> String {
        "This phone could not reach the network to find out what happened, so whether the payment went out is unknown. It may well have.\n\nDo not send it again \u{2014} check your activity in a few minutes first.\n\n\(why)"
    }

    /// Kept for the case the relay is ever reconfigured back to refusing.
    static let broadcastUnavailableTitle = "Not sent"
    static let broadcastUnavailableBody =
        "Your payment was built and signed on this phone, and it was NOT sent: the public broadcast service is refusing to relay it right now. Nothing has left your wallet and your coins are untouched. This is a problem at the PCoin end, not with your wallet or your phone \u{2014} try again later."

    // MARK: history -- history_*

    /// history_title
    static let historyTitle = "Activity"
    /// history_refresh
    static let historyRefresh = "Refresh"
    /// history_loading
    static let historyLoading = "Loading your activity\u{2026}"
    /// history_empty
    static let historyEmpty = "Nothing yet. Payments in and out will appear here."
    /// history_failed
    static func historyFailed(_ why: String) -> String { "Could not load your activity: \(why)" }
    /// history_received
    static let received = "Received"
    /// history_sent
    static let sent = "Sent"
    /// history_mined
    static let mined = "Mined"
    /// history_maturing
    static let maturing = "Mined \u{2014} not spendable yet"
    /// history_status_pending
    static let statusPending = "Waiting to be included in a block"
    /// history_tap_hint
    static let historyTapHint = "Tap a payment for details"
    /// history_paid_to
    static let paidTo = "Paid to"
    /// history_pay_this
    static let payThis = "Pay this address"
    /// history_pay_again
    static let payAgain = "Send again"
    /// history_search_hint
    static let searchHint = "Search address, transaction id or name"
    /// history_filter_all
    static let filterAll = "All"
    /// history_filter_sent
    static let filterSent = "Sent"
    /// history_filter_received
    static let filterReceived = "Received"
    /// history_copy_txid
    static let copyTxid = "Copy transaction id"
    /// history_copy_address
    static let copyAddress = "Copy address"
    /// history_copied_txid
    static let copiedTxid = "Transaction id copied."
    /// history_copied_address
    static let copiedAddress = "Address copied."
    /// history_no_matches
    static func noMatches(_ total: Int) -> String { "Nothing matches, across all \(total) transactions." }
    /// history_count_filtered
    static func countFiltered(_ shown: Int, _ total: Int) -> String {
        "\(shown) of \(total) transactions."
    }

    // MARK: address book -- book_*

    /// book_title
    static let bookTitle = "Address book"
    /// book_intro
    static let bookIntro =
        "Names are kept on this phone and mean nothing to anyone else. Nothing can check that an address belongs to who you think, so the address is always shown next to its name \u{2014} read it before you send."
    /// book_empty
    static let bookEmpty = "No names yet. Name an address after you pay it, or add one below."
    /// book_add
    static let bookAdd = "Add an address"
    /// book_rename
    static let bookRename = "Rename"
    /// book_copy
    static let bookCopy = "Copy address"
    /// book_send
    static let bookSend = "Send to this address"
    /// book_copied
    static let bookCopied = "Address copied."
    /// book_remove
    static let bookRemove = "Remove"
    /// book_pick_hint
    static let bookPickHint = "Tap a name to pay it"
    /// book_dialog_add_title
    static let bookAddTitle = "Add an address"
    /// book_dialog_rename_title
    static let bookRenameTitle = "Rename"
    /// book_name_label
    static let bookNameLabel = "Name"
    /// book_name_hint
    static let bookNameHint = "Market"
    /// book_address_label
    static let bookAddressLabel = "Address"
    /// book_address_hint
    static let bookAddressHint = "pc1\u{2026}"
    /// book_save
    static let bookSave = "Save"
    /// book_cancel
    static let bookCancel = "Cancel"
    /// book_saved_toast
    static func bookSavedToast(_ n: String) -> String { "Saved as \(n)" }
    /// book_removed_toast
    static let bookRemovedToast = "Name removed. Your payments are untouched."
    /// book_remove_title
    static let bookRemoveTitle = "Remove this name?"
    /// book_remove_body
    static func bookRemoveBody(_ name: String, _ address: String) -> String {
        "\(name)\n\(address)\n\nThis removes the name only. Payments you have already made are not affected and the address still appears in your activity."
    }
    /// book_err_empty
    static let bookErrEmpty = "Type a name."
    /// book_err_long
    static func bookErrLong(_ n: Int) -> String { "A name can be up to \(n) characters." }
    /// book_err_duplicate
    static let bookErrDuplicate =
        "Another address already has that name. Two entries with one name would make the list unable to tell you which one you are about to pay."
    /// book_err_full
    static func bookErrFull(_ n: Int) -> String {
        "Your address book is full at \(n) names. Remove one to add another."
    }
    /// book_err_address
    static let bookErrAddress = "Type the address you want to name."
    /// book_err_address_short
    static let bookErrAddressShort = "That is too short to be a PCoin address."
    /// book_err_address_spaces
    static let bookErrAddressSpaces = "A PCoin address has no spaces in it."

    // MARK: scan -- scan_*

    /// scan_title
    static let scanTitle = "Scan a code"
    /// scan_button
    static let scanButton = "Scan"
    /// scan_hint
    static let scanHint = "Point the camera at a PCoin QR code."
    /// scan_cancel
    static let scanCancel = "Cancel"
    /// scan_torch_on
    static let torchOn = "Light on"
    /// scan_torch_off
    static let torchOff = "Light off"
    /// scan_no_permission
    static let scanNoPermission =
        "Without camera access this phone cannot scan. You can still paste an address or pick one from your address book."
    /// scan_no_camera
    static let scanNoCamera =
        "This phone camera could not be started. You can still paste an address or pick one from your address book."
    /// scan_not_payment
    static let scanNotPayment = "That code is not a PCoin address."
    /// scan_filled_amount
    static func scanFilledAmount(_ a: String) -> String {
        "Scanned an amount of \(a) \u{2014} check it before sending."
    }

    // MARK: settings -- set_*

    /// set_title
    static let settingsTitle = "Settings"
    /// set_version
    static func settingsVersion(_ name: String, _ code: Int) -> String {
        "PCoin Wallet \(name) (\(code))"
    }
    /// set_warn_header
    static let warnHeader = "Needs your attention"
    /// set_warn_none -- IOS: the Android sentence is about what Android is
    /// letting the app do in the background. iOS has no such settings, so the
    /// sentence would be describing a thing that does not exist.
    static let warnNone = "Nothing to fix."
    /// set_pref_header
    static let prefHeader = "Preferences"
    /// set_fee_title
    static let feeTitle = "Default sending speed"
    /// set_fee_body
    static let feeBody =
        "Which speed the send screen starts on. You can still change it for any individual payment."

    // MARK: sign request -- sr_*  (all three 0.2.20 fixes live here)

    /// sr_title
    static let srTitle = "Payment request"
    /// sr_origin_unknown
    static let srOriginUnknown = "This request came from outside the wallet."
    /// sr_origin_named
    static func srOriginNamed(_ host: String) -> String {
        "This request came from outside the wallet, via \(host)."
    }
    /// sr_warn
    static let srWarn =
        "Another app is asking you to send PCN. Nothing has been sent, and nothing can be sent from this screen. Read the address below and compare it with the one you expect."
    /// sr_amount_label
    static let srAmountLabel = "Amount requested"
    /// sr_to_label
    static let srToLabel = "To this address"
    /// sr_amount_unset
    static let srAmountUnset = "Not specified"
    /// sr_unreadable_amount
    static let srUnreadableAmount = "Unreadable"
    /// sr_unreadable
    static let srUnreadable =
        "This request could not be read, so it is being refused rather than half-understood. Nothing has been sent. If you were expecting to pay someone, open Send yourself and enter the details by hand."
    /// sr_no_amount_note
    static let srNoAmountNote =
        "No amount was requested, so you will enter one yourself on the next screen."
    /// sr_continue
    static let srContinue = "Continue to Send"
    /// sr_cancel
    static let srCancel = "Cancel"
    /// sr_no_wallet_amount
    static let srNoWalletAmount = "No wallet yet"
    /// sr_no_wallet -- IOS: "phone" kept; "Open PCoin Wallet" is redundant here
    /// because the app is already open, so it says what to do instead.
    static let srNoWallet =
        "There is no wallet on this phone yet, so this request cannot be paid. Nothing has been sent. Set up or restore a wallet, then tap the payment link again."
    /// sr_setup
    static let srSetup = "Set up a wallet"
    /// sr_store -- IOS: the App Store, not Google Play.
    static let srStore = "Get PCoin Wallet on the App Store"

    // MARK: backup -- backup_*

    /// backup_none_note
    static let backupNoneNote =
        "This wallet was created before recovery phrases existed. It still works and its coins are still yours, but there are no words that can bring it back if this phone is lost."
    static let backupRevealTitle = "Show my recovery phrase"
    static let backupRevealBody =
        "Anyone who sees these twelve words can take your coins. Make sure nobody is looking, and never type them into anything but a wallet you are restoring."
    static let backupReveal = "Show the words"
    static let backupHide = "Hide"
    static let backupGateReason = "Unlock to show your recovery phrase"
}
