package org.pcoin.miner

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

/**
 * The address book.
 *
 * Two roles, chosen by how it was started:
 *
 *   BROWSE   opened from the wallet home screen. Tapping a name opens Send with
 *            that address filled in.
 *   PICK     opened from Send with [intentPick]. Tapping a name returns it and
 *            finishes; Send fills its own field.
 *
 * Both end at the same place -- an address in the compose field of a send that
 * still has to be reviewed. Nothing on this screen sends anything, and nothing
 * here is consulted at the moment of paying. See [AddressBook] for why that
 * separation is deliberate rather than incidental.
 *
 * The lower list is drawn from wallet history over RPC. It follows the same
 * rule as HistoryActivity: a failed read says the read failed and LEAVES the
 * rest of the screen alone. It never renders "nothing to name" out of a
 * question that could not be asked.
 */
class AddressBookActivity : AppCompatActivity() {

    private lateinit var store: AddressBookStore
    private lateinit var prefs: Prefs
    private val ui = Handler(Looper.getMainLooper())

    private lateinit var savedHint: TextView
    private lateinit var savedRows: LinearLayout
    private lateinit var addButton: Button
    private lateinit var recentStatus: TextView
    private lateinit var recentRows: LinearLayout

    private var picking = false
    private var loadingRecent = false

    /**
     * The last history read, kept so a name saved from the lower list can be
     * removed from it without asking the node again.
     *
     * This is display state, not a record of anything: it is replaced wholesale
     * by the next successful read and never consulted to decide anything.
     */
    private var recent: List<String> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = AddressBookStore(this)
        prefs = Prefs(this)
        picking = intent?.getBooleanExtra(EXTRA_PICK, false) == true
        setContentView(R.layout.activity_addressbook)

        savedHint = findViewById(R.id.book_saved_hint)
        savedRows = findViewById(R.id.book_saved_rows)
        addButton = findViewById(R.id.book_add_button)
        recentStatus = findViewById(R.id.book_recent_status)
        recentRows = findViewById(R.id.book_recent_rows)

        addButton.setOnClickListener { promptAdd() }

        recentStatus.text = getString(R.string.book_recent_loading)
        renderSaved()
        loadRecent()
    }

    override fun onResume() {
        super.onResume()
        // Covers coming back from a send that named an address: the name
        // appears above, and the address stops being offered below. Both are
        // recomputed from what is stored, so neither can disagree with it.
        renderSaved()
        renderRecent(recent)
    }

    // -------------------------------------------------------------- saved list

    private fun renderSaved() {
        val entries = AddressBook.ordered(store.load())
        savedRows.removeAllViews()

        savedHint.text =
            if (entries.isEmpty()) getString(R.string.book_empty)
            else getString(R.string.book_pick_hint)

        val inflater = LayoutInflater.from(this)
        for (e in entries) {
            val v = inflater.inflate(R.layout.row_book, savedRows, false)
            v.findViewById<TextView>(R.id.row_book_name).text = e.name
            v.findViewById<TextView>(R.id.row_book_address).text = e.address
            v.findViewById<View>(R.id.row_book_tap).setOnClickListener { choose(e) }
            v.findViewById<Button>(R.id.row_book_rename).setOnClickListener { promptRename(e) }
            v.findViewById<Button>(R.id.row_book_remove).setOnClickListener { confirmRemove(e) }
            savedRows.addView(v)
        }
    }

    private fun choose(entry: AddressBook.Entry) {
        if (picking) {
            setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_ADDRESS, entry.address))
            finish()
        } else {
            startActivity(SendActivity.intentFor(this, entry.address))
        }
    }

    private fun confirmRemove(entry: AddressBook.Entry) {
        AlertDialog.Builder(this)
            .setTitle(R.string.book_remove_title)
            .setMessage(getString(R.string.book_remove_body, entry.name, entry.address))
            .setNegativeButton(R.string.book_cancel, null)
            .setPositiveButton(R.string.book_remove) { _, _ ->
                store.remove(entry.address)
                Toast.makeText(this, R.string.book_removed_toast, Toast.LENGTH_SHORT).show()
                renderSaved()
                // The address rejoins the lower list, because it is once again
                // an address this wallet has paid and has no name for.
                renderRecent(recent)
            }
            .show()
    }

    // ------------------------------------------------------------ recent list

    /**
     * Addresses this wallet has paid that have no name yet.
     *
     * Derived from `listtransactions` every time, stored nowhere. That is what
     * makes it correct with no bookkeeping: it cannot claim an address was paid
     * that was not, and it cannot go stale against a book that changed.
     */
    private fun loadRecent() {
        if (loadingRecent) return
        loadingRecent = true
        val wallet = prefs.payoutWallet
        Thread {
            var list: List<ForwardEngine.HistoryEntry>? = null
            var err: String? = null
            try {
                list = MinerService.engine()?.listHistory(wallet, HISTORY_LIMIT)
                    ?: throw IllegalStateException(getString(R.string.history_no_service))
            } catch (e: Exception) {
                err = e.message ?: e.javaClass.simpleName
            }
            val got = list
            ui.post {
                loadingRecent = false
                if (got == null) {
                    // Not "nothing to name": the question was never answered.
                    recentStatus.text = getString(R.string.book_recent_failed, err.orEmpty())
                    recentStatus.visibility = View.VISIBLE
                } else {
                    renderRecent(AddressBook.unnamedRecipients(got, store.load()))
                }
            }
        }.start()
    }

    private fun renderRecent(addresses: List<String>) {
        recent = addresses
        recentRows.removeAllViews()

        // Re-filter against the book on every draw: an address named a moment
        // ago on this screen is no longer unnamed, and the list must not offer
        // to name it a second time.
        val entries = store.load()
        val unnamed = addresses.filter { AddressBook.find(entries, it) == null }

        recentStatus.text = if (unnamed.isEmpty()) getString(R.string.book_recent_none) else ""
        recentStatus.visibility = if (unnamed.isEmpty()) View.VISIBLE else View.GONE

        val inflater = LayoutInflater.from(this)
        for (a in unnamed) {
            val v = inflater.inflate(R.layout.row_book_recent, recentRows, false)
            v.findViewById<TextView>(R.id.row_recent_address).text = a
            v.findViewById<Button>(R.id.row_recent_name).setOnClickListener { promptName(a) }
            recentRows.addView(v)
        }
    }

    // --------------------------------------------------------------- dialogs

    private fun promptAdd() = showEntryDialog(
        titleRes = R.string.book_dialog_add_title,
        address = null,
        currentName = null,
    )

    private fun promptName(address: String) = showEntryDialog(
        titleRes = R.string.book_dialog_name_title,
        address = address,
        currentName = null,
    )

    private fun promptRename(entry: AddressBook.Entry) = showEntryDialog(
        titleRes = R.string.book_dialog_rename_title,
        address = entry.address,
        currentName = entry.name,
    )

    /**
     * One dialog for naming, renaming and adding.
     *
     * The positive button is wired AFTER show(), deliberately: the default
     * listener dismisses the dialog before it returns, so a name rejected for
     * being a duplicate would close the dialog and lose what was typed. This
     * way the dialog stays open with the error under the field.
     */
    private fun showEntryDialog(titleRes: Int, address: String?, currentName: String?) {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_book_entry, null)
        val addressBlock = view.findViewById<LinearLayout>(R.id.dialog_address_block)
        val addressField = view.findViewById<EditText>(R.id.dialog_address_field)
        val addressReadonly = view.findViewById<TextView>(R.id.dialog_address_readonly)
        val nameField = view.findViewById<EditText>(R.id.dialog_name_field)
        val error = view.findViewById<TextView>(R.id.dialog_error)

        if (address == null) {
            addressBlock.visibility = View.VISIBLE
        } else {
            addressReadonly.visibility = View.VISIBLE
            addressReadonly.text = address
        }
        currentName?.let {
            nameField.setText(it)
            nameField.setSelection(it.length)
        }

        val dialog = AlertDialog.Builder(this)
            .setTitle(titleRes)
            .setView(view)
            .setNegativeButton(R.string.book_cancel, null)
            .setPositiveButton(R.string.book_save, null)
            .show()

        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val typed = address ?: addressField.text?.toString()?.trim().orEmpty()
            // Checked only when it was typed here. An address that came from
            // the book or from wallet history has already been through
            // whatever check applies to it, and re-testing its shape could
            // refuse to rename an entry that is perfectly real.
            if (address == null) {
                addressProblem(typed)?.let { msg ->
                    error.text = msg
                    error.visibility = View.VISIBLE
                    return@setOnClickListener
                }
            }

            val name = nameField.text?.toString()
            // `replacing` is this address's own key, so renaming an entry to a
            // name it already has is not a clash with itself.
            val problem = AddressBook.nameProblem(name, store.load(), AddressBook.key(typed))
            if (problem != null) {
                error.text = nameProblemText(problem)
                error.visibility = View.VISIBLE
                return@setOnClickListener
            }

            val clean = AddressBook.cleanName(name)
            store.put(typed, clean)
            dialog.dismiss()
            Toast.makeText(this, getString(R.string.book_saved_toast, clean), Toast.LENGTH_SHORT).show()
            renderSaved()
            renderRecent(recent)
        }
    }

    /**
     * Shape checks only, and only for an address typed by hand here.
     *
     * The node is the authority on whether a string is a PCoin address, and it
     * gets the final say at the moment of sending, where prepareSend refuses
     * anything validateaddress rejects before a single byte is signed. What
     * these two checks catch is the obvious slip -- a name pasted into the
     * address box, an address with a line break in it -- while the node may
     * still be catching up and unable to answer at all. A book entry is only
     * ever a suggestion for a field, so it does not need the node's blessing
     * to be stored, and blocking on an RPC that might fail would mean a wallet
     * that cannot save a name while it is syncing.
     */
    private fun addressProblem(address: String): String? = when {
        address.isEmpty() -> getString(R.string.book_err_address)
        address.any { it.isWhitespace() } -> getString(R.string.book_err_address_spaces)
        address.length < AddressBook.LOOKS_LIKE_ADDRESS -> getString(R.string.book_err_address_short)
        else -> null
    }

    private fun nameProblemText(p: AddressBook.NameProblem): String = when (p) {
        AddressBook.NameProblem.EMPTY -> getString(R.string.book_err_empty)
        AddressBook.NameProblem.TOO_LONG -> getString(R.string.book_err_long, AddressBook.MAX_NAME)
        AddressBook.NameProblem.DUPLICATE -> getString(R.string.book_err_duplicate)
        AddressBook.NameProblem.BOOK_FULL -> getString(R.string.book_err_full, AddressBook.MAX_ENTRIES)
    }

    companion object {
        const val EXTRA_ADDRESS = "org.pcoin.miner.extra.ADDRESS"
        private const val EXTRA_PICK = "org.pcoin.miner.extra.PICK"

        /** Browse: tapping a name starts a send. */
        fun intent(ctx: Context): Intent = Intent(ctx, AddressBookActivity::class.java)

        /** Pick: tapping a name returns it to the caller in [EXTRA_ADDRESS]. */
        fun intentPick(ctx: Context): Intent =
            Intent(ctx, AddressBookActivity::class.java).putExtra(EXTRA_PICK, true)

        /** Same cap HistoryActivity uses, and for the same reason. */
        private const val HISTORY_LIMIT = 50
    }
}
