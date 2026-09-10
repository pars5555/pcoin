import Foundation
import LocalAuthentication

/// The things that are actually wrong, and what to do about each.
///
/// THE ANDROID LIST DOES NOT TRANSFER, and pretending it does would be inventing
/// problems. `WalletWarnings.kt` warns about battery optimisation, "Pause app
/// activity if unused", and blocked notifications -- all three because the
/// Android wallet runs a NODE in the background and those settings stop it. This
/// app runs no node and needs no background work at all, so none of those
/// conditions exists here.
///
/// What CAN be wrong on iOS is a different list, and this is it.
///
/// EVERY CHECK FAILS OPEN, exactly as the Android one does. If the system will
/// not answer -- an API that throws, a device that will not say -- the warning is
/// NOT shown. An unanswerable question is not a problem found, and showing a
/// warning nobody can substantiate trains people to dismiss the badge, which is
/// worse than showing nothing.
enum WalletWarnings {

    struct Warning: Identifiable {
        let id: String
        let title: String
        let body: String
    }

    @MainActor
    static func all(store: WalletStore) -> [Warning] {
        var out = [Warning]()

        // 1. No device passcode. Real, and the most serious one here: without a
        //    passcode there is no user-presence gate for the Enclave key to
        //    require, so nothing stands between somebody holding the phone and
        //    the recovery phrase.
        if let noPasscode = deviceHasNoPasscode(), noPasscode {
            out.append(Warning(
                id: "passcode",
                title: "This iPhone has no passcode",
                body: S.gateUnavailable
            ))
        }

        // 2. The phrase has not been written down. The person own claim, so it
        //    is asked rather than detected, and it stands until they say so.
        if !store.prefs.phraseWrittenDown {
            out.append(Warning(
                id: "backup",
                title: S.backupTitle,
                body: S.backupBody
            ))
        }

        // 3. The key is not in the Secure Enclave. Expected on the Simulator and
        //    never expected on a real device, so it is stated rather than
        //    hidden -- a security property that quietly degraded is worse than
        //    one that was never claimed.
        switch store.seedProtection {
        case .keychainUserPresence:
            out.append(Warning(
                id: "enclave",
                title: "Your key is not in the Secure Enclave",
                body: "This device has no Secure Enclave, so the recovery phrase is protected by the system keychain and your passcode instead. On an iPhone this should never happen."
            ))
        case .simulatorUngated:
            out.append(Warning(
                id: "ungated",
                title: "Your recovery phrase is NOT protected",
                body: "This is a Simulator with no passcode, so nothing at all stands between anyone using this device and your twelve words. Never put real coins on a wallet in this state. This cannot happen on an iPhone."
            ))
        case .secureEnclave, .none:
            break
        }

        // 4. The explorer index is not current. Read from the last successful
        //    snapshot, so it says nothing at all when there has not been one.
        if let s = store.snapshot, !s.index.isTrustworthy {
            out.append(Warning(
                id: "index",
                title: "The explorer is not up to date",
                body: "Balances and history may be behind the chain, and this wallet will not build a payment until it is current. \(s.index.untrustworthyReason ?? "")"
            ))
        }

        return out
    }

    /// nil means the system would not say, which is NOT the same as "there is a
    /// passcode". The caller treats nil as no warning -- fail open -- but the
    /// distinction is kept here rather than collapsed at the source.
    private static func deviceHasNoPasscode() -> Bool? {
        let context = LAContext()
        var error: NSError?
        if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
            return false
        }
        guard let e = error else { return nil }
        if e.code == LAError.passcodeNotSet.rawValue { return true }
        // Any other reason -- biometry locked out, hardware unavailable -- is
        // not evidence about the passcode.
        return nil
    }
}
