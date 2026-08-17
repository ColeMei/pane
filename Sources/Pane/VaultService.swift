import Foundation
import PaneKit

/// All vault I/O, on one serial queue, with every result handed back on the main thread.
///
/// The queue is not an optimisation. Decision 13 measured an evicted iCloud note taking **1.862 s**
/// to read, and a note being downloaded 5–20 s; either one on the main thread costs the 100 ms bar
/// outright. Serial rather than concurrent so that a write, the FSEvents reaction to that write, and
/// the index refresh behind it cannot interleave — the ordering is the correctness argument.
///
/// `NoteIndex` is owned here and touched only from `queue`.
final class VaultService: @unchecked Sendable {

    private let queue = DispatchQueue(label: "dev.colemei.pane.vault", qos: .userInitiated)
    private let index = NoteIndex()

    /// Only read or written on `queue`.
    private var vaultURL: URL

    init(vault: URL) {
        vaultURL = vault
    }

    func setVault(_ url: URL) {
        queue.async { self.vaultURL = url }
    }

    // MARK: - Listing

    struct Snapshot: Sendable {
        var rows: [SwitcherRow]
        var total: Int
        var query: String
    }

    /// Refreshes the index and returns the switcher's rows for `query`.
    ///
    /// Refresh and query in one hop rather than two: they always happen together, and splitting them
    /// would put a round trip through the main thread in the middle of every keystroke in the search
    /// field.
    func rows(
        query: String,
        state: AppState,
        current: String?,
        refresh: Bool = true,
        completion: @escaping @MainActor (Snapshot) -> Void
    ) {
        queue.async {
            if refresh { _ = try? self.index.refresh(vault: self.vaultURL) }
            let rows = self.index.rows(query: query, state: state, current: current)
            let total = self.index.filenames.count
            DispatchQueue.main.async {
                MainActor.assumeIsolated { completion(Snapshot(rows: rows, total: total, query: query)) }
            }
        }
    }

    /// Every note filename currently in the vault, for state pruning and the menu bar.
    func present(completion: @escaping @MainActor (Set<String>) -> Void) {
        queue.async {
            let names = (try? self.index.refresh(vault: self.vaultURL)) ?? []
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(names) } }
        }
    }

    // MARK: - Reading

    enum LoadResult: Sendable {
        case loaded(text: String, hash: String)
        /// The note is an iCloud placeholder. The caller shows "downloading…" and calls
        /// `download(_:)`; it must not simply read the file, which would block for seconds.
        case downloading(logicalSize: Int)
        case missing
        case failed(String)
    }

    func load(_ filename: String, completion: @escaping @MainActor (LoadResult) -> Void) {
        queue.async {
            let url = self.vaultURL.appendingPathComponent(filename)
            let result: LoadResult
            switch VaultIO.availability(of: url) {
            case .missing:
                result = .missing
            case .evicted(let size):
                result = .downloading(logicalSize: size)
            case .available:
                do {
                    let (text, hash) = try VaultIO.loadText(url)
                    self.index.update(filename: filename, text: text, modified: Date())
                    result = .loaded(text: text, hash: hash)
                } catch {
                    result = .failed(String(describing: error))
                }
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(result) } }
        }
    }

    /// Asks iCloud for an evicted note. Takes seconds; the pane shows a banner meanwhile.
    func download(_ filename: String, completion: @escaping @MainActor (LoadResult) -> Void) {
        queue.async {
            let url = self.vaultURL.appendingPathComponent(filename)
            do {
                try VaultIO.materialize(url)
            } catch {
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { completion(.failed(String(describing: error))) }
                }
                return
            }
            self.load(filename, completion: completion)
        }
    }

    /// The hash of what is on disk right now, without materialising anything. Used by the watcher to
    /// tell our own echo from someone else's write.
    func diskHash(_ filename: String, completion: @escaping @MainActor (String?) -> Void) {
        queue.async {
            let url = self.vaultURL.appendingPathComponent(filename)
            var hash: String?
            if VaultIO.availability(of: url) == .available,
               let data = try? VaultIO.readWithoutMaterializing(url) {
                hash = ContentHash.of(data)
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(hash) } }
        }
    }

    // MARK: - Writing

    enum WriteResult: Sendable {
        case written(hash: String)
        case conflicted(sibling: String, hash: String)
        case failed(String)
    }

    func write(
        text: String,
        to filename: String,
        expectedHash: String?,
        completion: @escaping @MainActor (WriteResult) -> Void
    ) {
        queue.async {
            let url = self.vaultURL.appendingPathComponent(filename)
            let result: WriteResult
            do {
                switch try VaultIO.write(text: text, to: url, expectedHash: expectedHash) {
                case .written(let hash):
                    self.index.update(filename: filename, text: text, modified: Date())
                    result = .written(hash: hash)
                case .conflicted(let sibling, let hash):
                    result = .conflicted(sibling: sibling.lastPathComponent, hash: hash)
                }
            } catch {
                result = .failed(String(describing: error))
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(result) } }
        }
    }

    // MARK: - Creating and deleting

    /// Creates an empty note whose filename is frozen from `title` (decision 2).
    func create(title: String, completion: @escaping @MainActor (Result<String, any Error>) -> Void) {
        queue.async {
            let result: Result<String, any Error>
            do {
                let existing = Set(
                    (try? VaultIO.listNotes(in: self.vaultURL))?.map(\.lastPathComponent) ?? []
                )
                let filename = NoteFilename.unique(title: title, date: Date(), existing: existing)
                // A new note's body is its title line, so the file is never zero-length — an empty
                // file is indistinguishable from a truncated one, and the vault should never contain
                // something that looks like damage.
                let text = title.isEmpty ? "" : title + "\n"
                try VaultIO.write(
                    text: text,
                    to: self.vaultURL.appendingPathComponent(filename),
                    expectedHash: nil
                )
                self.index.update(filename: filename, text: text, modified: Date())
                result = .success(filename)
            } catch {
                result = .failure(error)
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(result) } }
        }
    }

    /// Copies `text` into a brand-new note and returns its filename.
    ///
    /// The copy gets its own frozen name derived from the same title, which `NoteFilename.unique`
    /// then disambiguates — so duplicating "Standup" twice gives `…-standup-2.md` and `…-standup-3.md`
    /// rather than anything trying to be clever about "copy of". Decision 2 freezes a name at
    /// creation; a duplicate is a creation.
    func duplicate(
        text: String,
        completion: @escaping @MainActor (Result<String, any Error>) -> Void
    ) {
        queue.async {
            let result: Result<String, any Error>
            do {
                let existing = Set(
                    (try? VaultIO.listNotes(in: self.vaultURL))?.map(\.lastPathComponent) ?? []
                )
                let filename = NoteFilename.unique(
                    title: MarkdownDocument.title(of: text),
                    date: Date(),
                    existing: existing
                )
                try VaultIO.write(
                    text: text,
                    to: self.vaultURL.appendingPathComponent(filename),
                    expectedHash: nil
                )
                self.index.update(filename: filename, text: text, modified: Date())
                result = .success(filename)
            } catch {
                result = .failure(error)
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(result) } }
        }
    }

    /// Moves a note into Recently Deleted rather than unlinking it (decision 20).
    ///
    /// This used to call `trashItem`, which was the honest stand-in while the retention control in
    /// Settings had nothing behind it. The Finder's Trash is a fine undo but it is not the one the
    /// Storage tab promises, and two undo systems for one action is worse than either alone.
    func delete(_ filename: String, completion: @escaping @MainActor (Bool) -> Void) {
        queue.async {
            var ok = false
            if let store = self.deletedStore {
                ok = (try? RecentlyDeleted.accept(filename, from: self.vaultURL, into: store)) != nil
            }
            if ok { self.index.forget(filename) }
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(ok) } }
        }
    }

    // MARK: - Recently Deleted

    /// Resolved once, and — like `vaultURL` and the index — only ever touched from `queue`, which is
    /// what makes a plain `lazy var` safe here. A failure means Application Support is unwritable,
    /// in which case delete fails rather than falling back to unlinking the note.
    private lazy var deletedStore: URL? = try? RecentlyDeleted.standardStore()

    /// The holding folder as switcher rows, so the restore list is the ⌘P list rather than a second
    /// piece of chrome that has to be designed, styled and learned separately.
    ///
    /// `filename` carries the *stored* name — the timestamped one — because that is what `restore`
    /// takes. The row's visible title comes from the note's own first line, as everywhere else.
    func deletedRows(completion: @escaping @MainActor ([SwitcherRow]) -> Void) {
        queue.async {
            let now = Date()
            guard let store = self.deletedStore else {
                DispatchQueue.main.async { MainActor.assumeIsolated { completion([]) } }
                return
            }
            var rows: [SwitcherRow] = []
            for record in RecentlyDeleted.list(in: store) {
                let url = store.appendingPathComponent(record.storedName)

                // A note evicted by iCloud before it was deleted is still dataless here, and reading
                // it would block for seconds (decision 13). The filename is a worse title than the
                // first line, and it is not worth a hang.
                var text = ""
                if VaultIO.availability(of: url) == .available,
                   let loaded = try? VaultIO.loadText(url) {
                    text = loaded.text
                }

                let summary = MarkdownDocument.summary(of: text)
                rows.append(
                    SwitcherRow(
                        filename: record.storedName,
                        title: summary.title.isEmpty ? record.originalName : summary.title,
                        time: NoteOrdering.relativeTime(record.deletedAt, now: now),
                        preview: summary.preview
                    )
                )
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(rows) } }
        }
    }

    /// Puts a deleted note back and hands over the filename it landed under, which is not
    /// necessarily the one it left as — see `RecentlyDeleted.restore`.
    func restoreDeleted(_ storedName: String, completion: @escaping @MainActor (String?) -> Void) {
        queue.async {
            var restored: String?
            if let store = self.deletedStore {
                restored = try? RecentlyDeleted.restore(storedName, from: store, into: self.vaultURL)
            }
            // The note is back in the vault but not in the index, so the switcher would not list it
            // until something else happened to refresh.
            if restored != nil { _ = try? self.index.refresh(vault: self.vaultURL) }
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(restored) } }
        }
    }

    /// Removes one deleted note for good, on request. See `RecentlyDeleted.forget`.
    ///
    /// No index refresh: this note is not in the vault and was never in the index. The switcher's
    /// deleted list is re-fetched by the caller instead, because it is built from the folder rather
    /// than from the index.
    func forgetDeleted(_ storedName: String, completion: @escaping @MainActor (Bool) -> Void) {
        queue.async {
            var ok = false
            if let store = self.deletedStore {
                ok = (try? RecentlyDeleted.forget(storedName, from: store)) != nil
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(ok) } }
        }
    }

    /// Runs at launch and whenever the retention setting changes. Cheap — it reads one directory
    /// listing and unlinks whatever has aged out.
    func purgeDeleted(keepingDays days: Int) {
        queue.async {
            guard let store = self.deletedStore else { return }
            _ = RecentlyDeleted.purge(in: store, keepingDays: days)
        }
    }

    // MARK: - Index upkeep

    /// Keeps the switcher's copy of a note in step with the buffer, so opening ⌘P right after typing
    /// a title shows the title you just typed.
    func noteBufferChanged(filename: String, text: String) {
        queue.async { self.index.update(filename: filename, text: text, modified: Date()) }
    }

    /// Every note's title, for the menu bar's pinned section.
    ///
    /// Pushed to the main thread as a snapshot rather than queried per item: `NSMenu` builds
    /// synchronously in `menuWillOpen`, and a menu that has to wait on file I/O to know what to call
    /// its own items is a menu that opens empty.
    func titles(completion: @escaping @MainActor ([String: String]) -> Void) {
        queue.async {
            var map: [String: String] = [:]
            for record in self.index.records { map[record.filename] = record.title }
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(map) } }
        }
    }
}
