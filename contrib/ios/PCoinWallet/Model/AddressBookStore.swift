import Foundation
import PCoinKit

/// A name somebody gave an address.
struct AddressBookEntry: Codable, Equatable, Identifiable {
    let address: String
    var name: String
    var addedAt: Date

    var id: String { address }
}

/// Names for addresses, kept on this phone.
///
/// THE NAME PROVES NOTHING AND THE UI SAYS SO. The Android `book_intro` string
/// is the contract: "Names are kept on this phone and mean nothing to anyone
/// else. Nothing can check that an address belongs to who you think, so the
/// address is always shown next to its name -- read it before you send." Every
/// screen that shows a name shows the address with it, and the review screen
/// shows the address in full.
///
/// Stored as JSON in Application Support, not in the Keychain: these are not
/// secrets, and a Keychain item would survive an uninstall, which would be a
/// surprise. It is also the file the export/import path reads and writes.
final class AddressBookStore: ObservableObject {

    /// Matches the Android limits, so an exported book imports cleanly both ways.
    static let maxEntries = 500
    static let maxNameLength = 40

    enum SaveError: Swift.Error, Equatable {
        case emptyName
        case nameTooLong(Int)
        case duplicateName
        case full(Int)
        case emptyAddress
        case addressTooShort
        case addressHasSpaces
        case addressInvalid(Address.Failure)
    }

    @Published private(set) var entries: [AddressBookEntry] = []

    private let url: URL

    init(filename: String = "addressbook.json") {
        let dir = (try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        )) ?? URL(fileURLWithPath: NSTemporaryDirectory())
        self.url = dir.appendingPathComponent(filename)
        load()
    }

    // MARK: - reading

    /// The name for an address, matched the way Android matches: case-folded
    /// for bech32, exact for base58.
    ///
    /// Base58 IS case-sensitive, so folding it would let two different addresses
    /// collide into one name -- and the name is what somebody reads before
    /// paying.
    func name(for address: String) -> String? {
        let k = AddressBookStore.key(address)
        return entries.first { AddressBookStore.key($0.address) == k }?.name
    }

    static func key(_ address: String) -> String {
        address.lowercased().hasPrefix("pc1") ? address.lowercased() : address
    }

    // MARK: - writing

    @discardableResult
    func save(address rawAddress: String, name rawName: String) throws -> AddressBookEntry {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        let address = rawAddress.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !name.isEmpty else { throw SaveError.emptyName }
        guard name.count <= AddressBookStore.maxNameLength else {
            throw SaveError.nameTooLong(AddressBookStore.maxNameLength)
        }
        guard !address.isEmpty else { throw SaveError.emptyAddress }
        guard !address.contains(where: { $0.isWhitespace }) else {
            throw SaveError.addressHasSpaces
        }
        guard address.count >= 20 else { throw SaveError.addressTooShort }
        if case .failure(let f) = Address.parse(address) {
            throw SaveError.addressInvalid(f)
        }

        let key = AddressBookStore.key(address)
        // A duplicate NAME on a different address is refused: two entries with
        // one name would make the list unable to say which one is about to be
        // paid. A duplicate ADDRESS is a rename, which is fine.
        if entries.contains(where: {
            $0.name.caseInsensitiveCompare(name) == .orderedSame
                && AddressBookStore.key($0.address) != key
        }) {
            throw SaveError.duplicateName
        }

        if let i = entries.firstIndex(where: { AddressBookStore.key($0.address) == key }) {
            entries[i].name = name
            persist()
            return entries[i]
        }
        guard entries.count < AddressBookStore.maxEntries else {
            throw SaveError.full(AddressBookStore.maxEntries)
        }
        let e = AddressBookEntry(address: address, name: name, addedAt: Date())
        entries.append(e)
        entries.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        persist()
        return e
    }

    func remove(address: String) {
        let k = AddressBookStore.key(address)
        entries.removeAll { AddressBookStore.key($0.address) == k }
        persist()
    }

    // MARK: - export and import

    /// The file holds only names and addresses -- no keys, no phrase.
    func exportData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(entries)
    }

    struct ImportResult: Equatable {
        let added: Int
        let alreadyHere: Int
        let skipped: Int
    }

    /// Importing never changes names already held.
    ///
    /// That is the Android promise, in `book_export_hint`, and it is the safe
    /// direction: a file somebody found on a laptop must not silently rename the
    /// counterparty they are about to pay.
    func importData(_ data: Data) throws -> ImportResult {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let incoming = try decoder.decode([AddressBookEntry].self, from: data)
        var added = 0, already = 0, skipped = 0
        for e in incoming {
            let k = AddressBookStore.key(e.address)
            if entries.contains(where: { AddressBookStore.key($0.address) == k }) {
                already += 1
                continue
            }
            do {
                try save(address: e.address, name: e.name)
                added += 1
            } catch {
                skipped += 1
            }
        }
        return ImportResult(added: added, alreadyHere: already, skipped: skipped)
    }

    // MARK: - disk

    private func load() {
        guard let data = try? Data(contentsOf: url) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        // A book that will not parse is left alone rather than replaced with an
        // empty one: losing every name because of one bad byte is not a
        // recovery, it is a second failure.
        if let loaded = try? decoder.decode([AddressBookEntry].self, from: data) {
            entries = loaded
        }
    }

    private func persist() {
        guard let data = try? exportData() else { return }
        // Temp file plus a single rename, so an interrupted write can never
        // leave a truncated book.
        let tmp = url.appendingPathExtension("tmp")
        do {
            try data.write(to: tmp, options: .atomic)
            _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
        } catch {
            try? data.write(to: url, options: .atomic)
        }
    }
}
