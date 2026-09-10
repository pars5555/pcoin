import SwiftUI
import PCoinKit

/// Names somebody gave addresses.
///
/// THE ADDRESS IS ALWAYS SHOWN NEXT TO THE NAME. That is the Android `book_intro`
/// promise and it is not decoration: nothing can check that an address belongs
/// to who you think, so a name is a note, not a fact, and a list that showed
/// only names would be a list that hides the one thing worth reading.
struct AddressBookView: View {

    @EnvironmentObject private var store: WalletStore
    @Environment(\.dismiss) private var dismiss

    /// When set, tapping a row picks that address instead of managing it.
    var pick: ((String) -> Void)?

    @State private var editing: AddressBookEntry?
    @State private var adding = false
    @State private var removing: AddressBookEntry?

    var body: some View {
        List {
            Section {
                Text(S.bookIntro)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if store.addressBook.entries.isEmpty {
                Section { Text(S.bookEmpty).foregroundStyle(.secondary) }
            } else {
                Section(pick == nil ? S.bookTitle : S.bookPickHint) {
                    ForEach(store.addressBook.entries) { e in
                        Button {
                            if let pick = pick {
                                pick(e.address)
                                dismiss()
                            }
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(e.name).font(.body.weight(.medium))
                                Text(e.address)
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                        .swipeActions {
                            Button(S.bookRemove, role: .destructive) { removing = e }
                            Button(S.bookRename) { editing = e }.tint(.blue)
                        }
                        .contextMenu {
                            Button(S.bookCopy) { UIPasteboard.general.string = e.address }
                            Button(S.bookRename) { editing = e }
                            Button(S.bookRemove, role: .destructive) { removing = e }
                        }
                    }
                }
            }

            Section {
                Button(S.bookAdd) { adding = true }
            }
        }
        .navigationTitle(S.bookTitle)
        .sheet(isPresented: $adding) {
            EditEntryView(title: S.bookAddTitle, entry: nil)
                .environmentObject(store)
        }
        .sheet(item: $editing) { e in
            EditEntryView(title: S.bookRenameTitle, entry: e)
                .environmentObject(store)
        }
        .alert(S.bookRemoveTitle, isPresented: .init(
            get: { removing != nil },
            set: { if !$0 { removing = nil } }
        ), presenting: removing) { e in
            Button(S.bookRemove, role: .destructive) {
                store.addressBook.remove(address: e.address)
                removing = nil
            }
            Button(S.bookCancel, role: .cancel) { removing = nil }
        } message: { e in
            Text(S.bookRemoveBody(e.name, e.address))
        }
    }
}

struct EditEntryView: View {
    let title: String
    let entry: AddressBookEntry?

    @EnvironmentObject private var store: WalletStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var address = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section(S.bookNameLabel) {
                    TextField(S.bookNameHint, text: $name)
                }
                Section(S.bookAddressLabel) {
                    TextField(S.bookAddressHint, text: $address)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(entry != nil)
                }
                if let e = error { Section { ErrorLine(e) } }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(S.bookCancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(S.bookSave) { save() }
                }
            }
            .onAppear {
                name = entry?.name ?? ""
                address = entry?.address ?? ""
            }
        }
    }

    private func save() {
        error = nil
        do {
            try store.addressBook.save(address: address, name: name)
            dismiss()
        } catch let e as AddressBookStore.SaveError {
            switch e {
            case .emptyName: error = S.bookErrEmpty
            case .nameTooLong(let n): error = S.bookErrLong(n)
            case .duplicateName: error = S.bookErrDuplicate
            case .full(let n): error = S.bookErrFull(n)
            case .emptyAddress: error = S.bookErrAddress
            case .addressTooShort: error = S.bookErrAddressShort
            case .addressHasSpaces: error = S.bookErrAddressSpaces
            case .addressInvalid(let f): error = WalletStore.describe(addressFailure: f)
            }
        } catch {
            self.error = WalletStore.describe(error)
        }
    }
}
