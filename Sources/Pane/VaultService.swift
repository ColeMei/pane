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

    /// Moves a note to the Trash rather than unlinking it.
    ///
    /// Decision 20 ships Recently Deleted later; until it does, the Finder's own Trash is the undo,
    /// and it is a much better one than nothing. `trashItem` also puts the note somewhere the user
    /// already knows how to look.
    func delete(_ filename: String, completion: @escaping @MainActor (Bool) -> Void) {
        queue.async {
            let url = self.vaultURL.appendingPathComponent(filename)
            let ok = (try? FileManager.default.trashItem(at: url, resultingItemURL: nil)) != nil
            if ok { self.index.forget(filename) }
            DispatchQueue.main.async { MainActor.assumeIsolated { completion(ok) } }
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
