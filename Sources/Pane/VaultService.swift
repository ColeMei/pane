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

    /// Waiting for iCloud happens here rather than on `queue`.
    ///
    /// `VaultIO.materialize` is a poll: it sleeps for up to two minutes doing nothing but stat-ing a
    /// file. On the serial queue that wait sits in front of every write. Measured on the running app
    /// with a download in flight — everything typed into the note that was still on screen stayed in
    /// the buffer, the word count rising, with not a byte on disk until the download finished; and
    /// `drain` at quit is bounded at two seconds, so quitting during one lost the lot.
    ///
    /// The ordering argument for the serial queue is about work that *touches* the vault — a write,
    /// the FSEvents reaction to it, the index refresh behind it. A wait touches nothing, so it does
    /// not belong in that line. The `load` that follows the wait still does.
    private let downloads = DispatchQueue(label: "dev.colemei.pane.vault.download", qos: .utility)

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
        order: Settings.NoteOrder = .modified,
        refresh: Bool = true,
        completion: @escaping @MainActor (Snapshot) -> Void
    ) {
        queue.async {
            if refresh { _ = try? self.index.refresh(vault: self.vaultURL) }
            let rows = self.index.rows(query: query, state: state, current: current, order: order)
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
        // `vaultURL` is only read on `queue`, so the hop out to wait is taken from inside it.
        queue.async {
            let url = self.vaultURL.appendingPathComponent(filename)
            self.downloads.async {
                do {
                    try VaultIO.materialize(url)
                } catch {
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated { completion(.failed(String(describing: error))) }
                    }
                    return
                }
                // Back onto the serial queue for the read, the index update and everything after.
                self.load(filename, completion: completion)
            }
        }
    }

    /// What is on disk right now, without materialising anything.
    ///
    /// Used by the watcher to tell our own echo from someone else's write — and, since decision 105,
    /// to notice that the open note has been evicted. This used to be `diskHash` returning an
    /// optional, and `nil` meant "gone **or** evicted, not our call to make here": the caller simply
    /// bailed, so if iCloud dataless-ed the note you were looking at, the pane went on showing stale
    /// text with no banner and no way to know. "Downloading…" fired only on *open*, never mid-session.
    enum DiskState: Sendable {
        case available(hash: String)
        case evicted
        case missing
        /// There, not evicted, and unreadable — a permissions problem or a torn write. The caller
        /// does nothing, which is what the old `nil` did for every one of these cases.
        case unreadable
    }

    func diskState(_ filename: String, completion: @escaping @MainActor (DiskState) -> Void) {
        queue.async {
            let url = self.vaultURL.appendingPathComponent(filename)
            let state: DiskState
            switch VaultIO.availability(of: url) {
            case .missing:
                state = .missing
            case .evicted:
                state = .evicted
            case .available:
                if let data = try? VaultIO.readWithoutMaterializing(url) {
                    state = .available(hash: ContentHash.of(data))
                } else {
                    state = .unreadable
                }
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(state) } }
        }
    }

    /// iCloud's own unresolved conflict versions of a note, written out as ordinary siblings
    /// (decision 105). Returns the names it created, which is empty in the overwhelmingly common case.
    func harvestConflicts(_ filename: String, completion: @escaping @MainActor ([String]) -> Void) {
        queue.async {
            let url = self.vaultURL.appendingPathComponent(filename)
            let written = VaultIO.harvestConflictVersions(of: url).map(\.lastPathComponent)
            if !written.isEmpty { _ = try? self.index.refresh(vault: self.vaultURL) }
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(written) } }
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

    /// Waits for everything already enqueued to finish. For quit, and only for quit.
    ///
    /// `flush` enqueues a write and returns, which is right everywhere except at the moment the
    /// process is about to stop existing: `applicationWillTerminate` calls `flush(trigger:
    /// .quitting)` and then returns, and whether the write ever ran was down to how long macOS
    /// happened to take to tear the process down. That was a bounded risk while every note already
    /// had a file — you could lose the last half-second of typing. A draft has no file at all
    /// (see `PaneController.isDraft`), so the same race loses the whole note.
    ///
    /// Bounded rather than a bare `queue.sync`: `materialize` polls iCloud for up to two minutes on
    /// this queue, and a quit that hangs for two minutes is a worse bug than the one being fixed.
    /// Two seconds is far more than a local write needs and short enough not to read as a hang.
    func drain(timeout: TimeInterval = 2) {
        let finished = DispatchSemaphore(value: 0)
        queue.async { finished.signal() }
        _ = finished.wait(timeout: .now() + timeout)
    }

    // MARK: - Creating and deleting

    /// Writes `text` into a brand-new note and hands back the name it landed under, plus the hash
    /// of the bytes now on disk.
    ///
    /// The one place a note is created, for all three callers — ⌘N's first write, Duplicate Note,
    /// and the switcher's "no results, press ⏎". Decision 2 freezes the filename at creation and
    /// derives it from the note's own first line, so creation and naming are the same act and there
    /// is no version of this that takes a title separately from the text it names.
    ///
    /// There used to be a second entry point, `create(title:)`, which wrote `""` whenever the title
    /// was empty — which is what ⌘N always passed. So every note made with ⌘N was named from an
    /// empty first line (`untitled`, for life) and started as a zero-length file, under a comment
    /// claiming the vault should never hold one. Both are gone with the overload: nothing calls this
    /// without text any more.
    func create(
        text: String,
        completion: @escaping @MainActor (Result<(filename: String, hash: String), any Error>) -> Void
    ) {
        queue.async {
            let result: Result<(filename: String, hash: String), any Error>
            do {
                let existing = Set(
                    (try? VaultIO.listNotes(in: self.vaultURL))?.map(\.lastPathComponent) ?? []
                )
                let filename = NoteFilename.unique(
                    title: MarkdownDocument.title(of: text),
                    date: Date(),
                    existing: existing
                )
                let outcome = try VaultIO.write(
                    text: text,
                    to: self.vaultURL.appendingPathComponent(filename),
                    expectedHash: nil
                )
                self.index.update(filename: filename, text: text, modified: Date())
                switch outcome {
                case .written(let hash):
                    result = .success((filename: filename, hash: hash))
                case .conflicted:
                    // `expectedHash` is nil, so `VaultIO.write` cannot take this branch. Spelled out
                    // rather than force-unwrapped so that a future change to the write path fails
                    // here instead of silently losing the hash.
                    result = .failure(VaultError.coordination("a new note reported a conflict"))
                }
            } catch {
                result = .failure(error)
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(result) } }
        }
    }

    // MARK: - Renaming

    enum RenameResult: Sendable {
        case renamed(to: String)
        /// The name it wants is taken, or the file is not where we left it. Not an error the user
        /// needs told about — the name simply stays as it is.
        case declined
        case failed(String)
    }

    /// Moves a note to a new name in the same vault (decision 103).
    ///
    /// On `queue` like every other vault operation, which is what makes the ordering against a write
    /// and against the FSEvents reaction to that write an argument rather than a race. The caller is
    /// responsible for having flushed first — decision 56's rule, the one ⌃X and every vault
    /// re-point already follow — and for the auto-rename path that is automatic, because it runs off
    /// the back of the write completing.
    ///
    /// Coordinated `.forMoving` / `.forReplacing` so a sync provider is told the item's identity is
    /// changing rather than inferring a delete plus a create from the two events.
    func rename(
        _ filename: String,
        to newName: String,
        text: String,
        completion: @escaping @MainActor (RenameResult) -> Void
    ) {
        queue.async {
            let source = self.vaultURL.appendingPathComponent(filename)
            let destination = self.vaultURL.appendingPathComponent(newName)
            var result: RenameResult = .declined

            guard filename != newName,
                  FileManager.default.fileExists(atPath: source.path),
                  !FileManager.default.fileExists(atPath: destination.path)
            else {
                DispatchQueue.main.async { MainActor.assumeIsolated { completion(.declined) } }
                return
            }

            var coordinationError: NSError?
            let coordinator = NSFileCoordinator(filePresenter: nil)
            coordinator.coordinate(
                writingItemAt: source, options: .forMoving,
                writingItemAt: destination, options: .forReplacing,
                error: &coordinationError
            ) { from, to in
                do {
                    // Announced separately from the coordination: the move is what the provider
                    // needs to hear about, and `itemAt:didMoveTo:` is how it is told.
                    coordinator.item(at: from, willMoveTo: to)
                    try FileManager.default.moveItem(at: from, to: to)
                    coordinator.item(at: from, didMoveTo: to)
                    self.index.forget(filename)
                    self.index.update(filename: newName, text: text, modified: Date())
                    result = .renamed(to: newName)
                } catch {
                    result = .failed(String(describing: error))
                }
            }
            if let coordinationError {
                result = .failed(coordinationError.localizedDescription)
            }

            DispatchQueue.main.async { MainActor.assumeIsolated { completion(result) } }
        }
    }

    /// The name decision 103 says this note should now have, applied. Nil title changes are cheap:
    /// `NoteNaming.rename` returns nil and nothing touches the disk.
    ///
    /// The listing has to happen here rather than in `PaneController` because `existing` is a read of
    /// the vault, and every read of the vault goes on this queue.
    func renameFollowingTitle(
        _ filename: String,
        title: String,
        text: String,
        completion: @escaping @MainActor (RenameResult) -> Void
    ) {
        queue.async {
            let existing = Set(
                (try? VaultIO.listNotes(in: self.vaultURL))?.map(\.lastPathComponent) ?? []
            )
            guard let wanted = NoteNaming.rename(
                current: filename, title: title, existing: existing
            ) else {
                DispatchQueue.main.async { MainActor.assumeIsolated { completion(.declined) } }
                return
            }
            self.rename(filename, to: wanted, text: text, completion: completion)
        }
    }

    /// Where a note went when something outside Pane renamed it.
    ///
    /// The identity test is the content hash, because a rename is the one vault event that changes a
    /// note's name and nothing else. Requires **exactly one** match: two files with identical bytes
    /// in one FSEvents burst is a copy, not a move, and guessing between them would point the pane
    /// at the wrong one and take the caret and the pin with it.
    func findRenamed(
        of filename: String,
        among candidates: [String],
        matching hash: String,
        completion: @escaping @MainActor (String?) -> Void
    ) {
        queue.async {
            // FSEvents coalesces, so a burst naming a file that still exists is an ordinary edit
            // somewhere else in the vault. Reading it here rather than inferring it from the burst.
            let missing = VaultIO.availability(
                of: self.vaultURL.appendingPathComponent(filename)
            ) == .missing

            var hashes: [String: String] = [:]
            if missing {
                for name in candidates where name != filename && NoteFilename.isNoteFile(name) {
                    let url = self.vaultURL.appendingPathComponent(name)
                    guard VaultIO.availability(of: url) == .available,
                          let data = try? VaultIO.readWithoutMaterializing(url)
                    else { continue }
                    hashes[name] = ContentHash.of(data)
                }
            }

            // The decision itself is pure and lives in PaneKit, where it is tested.
            let answer = VaultSync.renameTarget(
                of: filename, originalIsMissing: missing, candidates: hashes, baselineHash: hash
            )
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(answer) } }
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

    /// Keeps the buffer's text in Recently Deleted for a note that is already gone from the vault.
    ///
    /// Decision 117. `delete` above moves a file; this one has no file to move, because the machine
    /// that deleted the note took it. What is left is the text in this process, and if it differs
    /// from what the vault last held, this is the only copy of it anywhere.
    ///
    /// On the serial queue like every other vault operation, which is also what orders it against a
    /// write already in flight (decision 56).
    func keepDeleted(_ filename: String, text: String, completion: @escaping @MainActor (Bool) -> Void) {
        queue.async {
            var ok = false
            if let store = self.deletedStore {
                ok = (try? RecentlyDeleted.keep(text, as: filename, into: store)) != nil
            }
            self.index.forget(filename)
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(ok) } }
        }
    }

    /// Drops a note from the index without touching any file — it is already gone from the vault.
    func forgetIndexed(_ filename: String, completion: @escaping @MainActor () -> Void) {
        queue.async {
            self.index.forget(filename)
            DispatchQueue.main.async { MainActor.assumeIsolated { completion() } }
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
