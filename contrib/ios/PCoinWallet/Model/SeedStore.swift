import Foundation
import LocalAuthentication
import Security
import PCoinKit

/// Where the twelve words live.
///
/// THE ANDROID PROPERTY, BUILT THE SAME WAY RATHER THAN IMITATED. On Android the
/// phrase is AES-256-GCM ciphertext under a key that lives in AndroidKeyStore and
/// never leaves it, created with `setUserAuthenticationRequired(true)` -- so the
/// cipher PHYSICALLY CANNOT produce plaintext without a fresh device unlock. A
/// rooted device cannot skip past a boolean callback, because there is no
/// boolean.
///
/// The iOS counterpart is a Secure Enclave P-256 key created with an access
/// control of `.userPresence`, used to ECIES-wrap the phrase. The private half
/// is generated inside the Enclave and cannot be exported; `SecKeyCreateDecrypted
/// Data` on it is what triggers Face ID / Touch ID / passcode, and it returns
/// nothing at all if that fails. The gate is the KEY, not a screen. A biometric
/// prompt whose success branch merely calls our own `unlock()` would be theatre,
/// and this is deliberately not that.
///
/// The wrapped blob is a Keychain item with `kSecAttrAccessibleWhenUnlocked
/// ThisDeviceOnly`. `...ThisDeviceOnly` is the important half: the phrase must
/// not travel in an iCloud Keychain backup.
///
/// THE PHRASE IS NEVER LOGGED, never put in a notification, never written
/// anywhere else. See `Redact`, and `RedactTests`, which is what keeps that true
/// rather than intended.
final class SeedStore {

    enum Protection: String {
        /// A Secure Enclave key gates decryption. What ships.
        case secureEnclave
        /// No Enclave, but the system still gates the item: a Keychain access
        /// control of `.userPresence`, so a passcode or biometric is required to
        /// read it. The key is simply not Enclave-resident.
        case keychainUserPresence
        /// NOT GATED AT ALL. Reachable only on the Simulator, and only when the
        /// simulated device has no passcode -- which is the default, and which
        /// makes `.userPresence` impossible to satisfy rather than merely
        /// inconvenient.
        ///
        /// The alternative was an app that cannot create a wallet on a
        /// simulator, which would make the whole thing untestable without a
        /// device. This is the lesser evil, and it is contained three ways:
        /// `#if targetEnvironment(simulator)` keeps it out of every device
        /// binary, the mode is recorded and displayed in Settings, and
        /// `WalletWarnings` raises it. A security property that quietly
        /// degrades is worse than one that was never claimed.
        case simulatorUngated
    }

    enum StoreError: Swift.Error, Equatable {
        case alreadyExists
        case notFound
        /// The user cancelled the unlock, or it did not succeed. Resolves
        /// NOTHING: it is not "there is no phrase".
        case authenticationFailed(String)
        case keychain(OSStatus)
        case secureEnclaveUnavailable(String)
        case corrupted(String)
    }

    private let service = "am.pc.pcoinwallet.seed"
    private let blobAccount = "phrase.v1"
    private let keyTag = "am.pc.pcoinwallet.seedkey.v1".data(using: .utf8)!
    private let modeDefaultsKey = "seedstore.protection.v1"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    // MARK: - what the UI asks without unlocking anything

    /// Is there a wallet on this phone?
    ///
    /// Answered WITHOUT decrypting anything and therefore without a prompt,
    /// which is what lets `SignRequestView` check for a wallet BEFORE it shows a
    /// payment request. Reads the item attributes only.
    func exists() -> Bool {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: blobAccount,
            kSecReturnData as String: false,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
        ]
        let status = SecItemCopyMatching(q as CFDictionary, nil)
        // `interactionNotAllowed` means the item is there and would have needed
        // a prompt. That is a YES, not a failure -- reading it as "no wallet"
        // is exactly the collapse of unknown into no that this project has paid
        // for twice.
        return status == errSecSuccess || status == errSecInteractionNotAllowed
    }

    /// Which protection the stored phrase was written under, if there is one.
    var protection: Protection? {
        guard exists() else { return nil }
        return defaults.string(forKey: modeDefaultsKey).flatMap(Protection.init(rawValue:))
    }

    // MARK: - writing

    /// Store a phrase.
    ///
    /// Refuses to replace an existing one unless the caller says so explicitly,
    /// exactly as the Windows tray `SeedStore.Save` does. Overwriting a
    /// recovery phrase by accident is not recoverable, so it cannot be the
    /// default.
    func save(mnemonic: [String], replacingExisting: Bool = false) throws {
        if exists() && !replacingExisting { throw StoreError.alreadyExists }

        let mode = try ensureKey()
        var plaintext = Array(mnemonic.joined(separator: " ").utf8)
        defer { Redact.wipe(&plaintext) }

        let blob: Data
        switch mode {
        case .secureEnclave:
            blob = try seal(Data(plaintext))
        case .keychainUserPresence, .simulatorUngated:
            // No Enclave key to wrap with; the Keychain item carries whatever
            // protection there is.
            blob = Data(plaintext)
        }

        // Written as delete-then-add rather than an update: an interrupted
        // update can leave an item whose attributes and data disagree, and the
        // one thing that must never happen here is a phrase that is present but
        // unreadable.
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: blobAccount,
        ]
        SecItemDelete(base as CFDictionary)

        var effectiveMode = mode
        var status = add(blob: blob, base: base, mode: mode)

        #if targetEnvironment(simulator)
        // A simulated device has no passcode by default, and `.userPresence`
        // cannot be satisfied without one -- `SecItemAdd` refuses rather than
        // prompting. Rather than make the app impossible to run on a simulator,
        // fall back once, loudly, and record it.
        //
        // ANY failure, not a hand-picked list of statuses. The first version of
        // this listed errSecAuthFailed and -25293, which are the same number, so
        // it covered two codes and missed whatever the simulator actually
        // returns. Guessing which error a platform will produce is how a
        // fallback ends up never firing.
        if status != errSecSuccess {
            effectiveMode = .simulatorUngated
            status = add(blob: blob, base: base, mode: effectiveMode)
        }
        #endif

        guard status == errSecSuccess else { throw StoreError.keychain(status) }
        defaults.set(effectiveMode.rawValue, forKey: modeDefaultsKey)
    }

    private func add(blob: Data, base: [String: Any], mode: Protection) -> OSStatus {
        var item = base
        item[kSecValueData as String] = blob

        switch mode {
        case .secureEnclave:
            // The blob is already unreadable without the Enclave key; the item
            // itself only needs to be device-bound and unlock-scoped.
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        case .keychainUserPresence:
            // No Enclave: the Keychain item itself carries the gate.
            var accessError: Unmanaged<CFError>?
            guard let control = SecAccessControlCreateWithFlags(
                nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .userPresence, &accessError
            ) else {
                return errSecParam
            }
            item[kSecAttrAccessControl as String] = control
        case .simulatorUngated:
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        }
        return SecItemAdd(item as CFDictionary, nil)
    }

    // MARK: - reading

    /// Read the phrase. Prompts, because it must.
    ///
    /// `reason` is what the system shows in the prompt. It is deliberately a
    /// parameter: "Unlock to send your PCoin" and "Unlock to show your recovery
    /// phrase" are different requests and a person should be told which one they
    /// are approving.
    func loadMnemonic(reason: String) throws -> [String] {
        let context = LAContext()
        context.localizedReason = reason
        // No grace period. A wallet that reuses an unlock from four minutes ago
        // is a wallet that spends on a phone somebody put down.
        context.touchIDAuthenticationAllowableReuseDuration = 0

        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: blobAccount,
            kSecReturnData as String: true,
            kSecUseAuthenticationContext as String: context,
        ]
        if #available(iOS 14.0, *) {
            query[kSecUseOperationPrompt as String] = reason
        }

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            break
        case errSecItemNotFound:
            throw StoreError.notFound
        case errSecUserCanceled, errSecAuthFailed:
            throw StoreError.authenticationFailed(String(status))
        default:
            throw StoreError.keychain(status)
        }
        guard let blob = item as? Data else {
            throw StoreError.corrupted("the keychain returned something that was not data")
        }

        let plaintext: Data
        switch protection ?? .secureEnclave {
        case .secureEnclave:
            plaintext = try open(blob, reason: reason, context: context)
        case .keychainUserPresence, .simulatorUngated:
            // The Keychain item itself carried the gate (or, on a simulator
            // with no passcode, carried none -- see Protection.simulatorUngated).
            plaintext = blob
        }

        guard let text = String(data: plaintext, encoding: .utf8) else {
            throw StoreError.corrupted("the stored phrase is not text")
        }
        let words = Bip39.splitWords(text)
        guard Bip39.validWordCounts.contains(words.count) else {
            throw StoreError.corrupted("the stored phrase is \(words.count) words")
        }
        return words
    }

    /// Remove the wallet from this phone.
    ///
    /// The caller is responsible for having made sure the words are written
    /// down; nothing here can check that. Deletes the Enclave key too, so the
    /// blob is unreadable even if a copy survives somewhere.
    func destroy() {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: blobAccount,
        ]
        SecItemDelete(q as CFDictionary)
        let keyQuery: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: keyTag,
        ]
        SecItemDelete(keyQuery as CFDictionary)
        defaults.removeObject(forKey: modeDefaultsKey)
    }

    // MARK: - the Secure Enclave key

    private static let algorithm: SecKeyAlgorithm = .eciesEncryptionCofactorVariableIVX963SHA256AESGCM

    /// Create the wrapping key if it is not there yet, and say which kind it is.
    private func ensureKey() throws -> Protection {
        if let existing = defaults.string(forKey: modeDefaultsKey),
           let mode = Protection(rawValue: existing),
           mode != .secureEnclave {
            // A store written without the Enclave is never read as though it
            // had one. Modes do not mix.
            return mode
        }
        if findKey() != nil { return .secureEnclave }

        var acError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage, .userPresence],
            &acError
        ) else {
            throw StoreError.keychain(errSecParam)
        }

        let attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: keyTag,
                kSecAttrAccessControl as String: access,
            ],
        ]
        var error: Unmanaged<CFError>?
        if SecKeyCreateRandomKey(attrs as CFDictionary, &error) != nil {
            return .secureEnclave
        }

        // No Enclave. On a real device that should not happen; on the Simulator
        // it is expected. Fall back LOUDLY -- the mode is recorded, shown in
        // Settings, and never mixed with an Enclave-written item.
        let why = (error?.takeRetainedValue()).map { String(describing: $0) } ?? "unknown"
        #if targetEnvironment(simulator)
        return .keychainUserPresence
        #else
        throw StoreError.secureEnclaveUnavailable(why)
        #endif
    }

    private func findKey() -> SecKey? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: keyTag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess else { return nil }
        // Force-cast is safe: kSecClassKey with kSecReturnRef returns a SecKey.
        return (item as! SecKey)
    }

    /// Wrap with the PUBLIC half, which needs no authentication -- so saving a
    /// phrase never prompts. Only reading it does.
    private func seal(_ plaintext: Data) throws -> Data {
        guard let priv = findKey(), let pub = SecKeyCopyPublicKey(priv) else {
            throw StoreError.secureEnclaveUnavailable("the wrapping key is missing")
        }
        var error: Unmanaged<CFError>?
        guard let ct = SecKeyCreateEncryptedData(
            pub, SeedStore.algorithm, plaintext as CFData, &error
        ) else {
            throw StoreError.corrupted(
                (error?.takeRetainedValue()).map { String(describing: $0) } ?? "encryption failed"
            )
        }
        return ct as Data
    }

    private func open(_ ciphertext: Data, reason: String, context: LAContext) throws -> Data {
        let q: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: keyTag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true,
            kSecUseAuthenticationContext as String: context,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        guard status == errSecSuccess, let priv = item as! SecKey? else {
            if status == errSecUserCanceled || status == errSecAuthFailed {
                throw StoreError.authenticationFailed(String(status))
            }
            throw StoreError.keychain(status)
        }
        var error: Unmanaged<CFError>?
        guard let pt = SecKeyCreateDecryptedData(
            priv, SeedStore.algorithm, ciphertext as CFData, &error
        ) else {
            // This is the branch a rooted-equivalent attack would have to get
            // past, and it cannot: the Enclave simply does not return the
            // plaintext. There is no boolean here to flip.
            let why = (error?.takeRetainedValue()).map { String(describing: $0) } ?? "unknown"
            throw StoreError.authenticationFailed(why)
        }
        return pt as Data
    }
}
