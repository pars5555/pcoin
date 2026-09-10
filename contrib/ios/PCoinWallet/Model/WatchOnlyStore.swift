import Foundation
import Security
import PCoinKit

/// The account xpub, cached so the wallet can read its own balance without
/// asking anybody to unlock anything.
///
/// UNGATED ON PURPOSE, and the purpose is worth stating because "ungated" reads
/// like a mistake. An account xpub can derive every address this wallet owns and
/// can spend NOTHING -- spending needs the private half, which is in
/// `SeedStore` behind the Secure Enclave. Putting the xpub behind Face ID would
/// mean a biometric prompt every time the home screen refreshed a balance, which
/// nobody expects and which the Android wallet does not do either.
///
/// What it does cost is privacy: anyone who obtains this learns every address the
/// wallet has used and can watch its balance forever. So it is still a Keychain
/// item, still `...ThisDeviceOnly` so it never travels in an iCloud backup, and
/// still deleted when the wallet is removed.
final class WatchOnlyStore {

    private let service = "am.pc.pcoinwallet.watch"
    private let account = "accountxpub.v1"
    private let fingerprintAccount = "fingerprint.v1"

    struct Cached {
        let xpub: String
        let masterFingerprintHex: String
    }

    func save(xpub: String, masterFingerprintHex: String) {
        write(account, xpub)
        write(fingerprintAccount, masterFingerprintHex)
    }

    func load() -> Cached? {
        guard let xpub = read(account), let fp = read(fingerprintAccount) else { return nil }
        return Cached(xpub: xpub, masterFingerprintHex: fp)
    }

    /// The watch-only keys, ready to derive addresses.
    ///
    /// nil when nothing is cached OR when what is cached does not parse. A
    /// cached value that will not parse is treated as absent rather than
    /// repaired: the caller then rebuilds it from the phrase, which is the one
    /// source that is definitely right.
    func keys(network: PcoinDerivation.Network = .mainnet) -> PcoinDerivation.WatchOnlyKeys? {
        guard let c = load() else { return nil }
        return PcoinDerivation.WatchOnlyKeys.parse(
            xpub: c.xpub, masterFingerprintHex: c.masterFingerprintHex, network: network
        )
    }

    func destroy() {
        delete(account)
        delete(fingerprintAccount)
    }

    // MARK: - keychain

    private func write(_ key: String, _ value: String) {
        let data = Data(value.utf8)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    private func read(_ key: String) -> String? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
              let d = item as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    private func delete(_ key: String) {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(q as CFDictionary)
    }
}
