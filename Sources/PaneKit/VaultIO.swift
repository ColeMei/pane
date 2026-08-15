import Darwin
import Foundation

public enum VaultError: Error, Equatable {
    case notUTF8(URL)
    case vaultMissing(URL)
    case downloadTimedOut(URL)
    case coordination(String)
}

/// Whether a note's bytes are actually here.
///
/// The distinction that matters is `evicted`: the file exists, reports its real name and its real
/// size, and reading it would silently work — after blocking for seconds while iCloud fetches it.
public enum NoteAvailability: Equatable, Sendable {
    case available
    /// Present in the listing, absent from the disk. The size is the real server-side size, not zero.
    case evicted(logicalSize: Int)
    case missing
}

/// Reading and writing notes in the vault.
///
/// Two hazards shape everything here, and both were measured on this machine rather than assumed:
///
/// **1. Evicted notes hang, they do not truncate.** Decision 13 was written expecting an evicted note
/// to read as a zero-length stub whose write-back would destroy it everywhere. On macOS 26 that is
/// not what happens — an evicted note is an APFS *dataless* file with a correct name and a correct
/// `st_size`, and reading it returns complete correct bytes after blocking (1.862 s, measured, for a
/// 93-byte file). The data-loss path is closed by the OS. The hang is not, and a 1.8 s stall on the
/// main thread would obliterate the 100 ms bar. Detection also still covers macOS 14/15, which are
/// the deployment floor and could not be tested, and third-party file providers.
///
/// **2. Writes land in a folder a sync daemon is watching.** Hence coordination and atomic replace:
/// a half-written file is exactly what iCloud or Syncthing will happily propagate.
public enum VaultIO {

    // MARK: - Availability

    /// Whether a note can be read without blocking. Performs no data read, so it can never itself
    /// trigger a download.
    public static func availability(of url: URL) -> NoteAvailability {
        var url = url
        // Foundation documents that URL caches resource values. A fresh eviction was reported
        // correctly without this in testing, but the call is cheap insurance against a stale answer
        // to the one question that must not be answered stale.
        url.removeAllCachedResourceValues()

        let keys: Set<URLResourceKey> = [
            .isRegularFileKey, .fileSizeKey, .fileAllocatedSizeKey,
            .isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey,
        ]
        guard let values = try? url.resourceValues(forKeys: keys), values.isRegularFile == true else {
            return .missing
        }

        let logicalSize = values.fileSize ?? 0

        // iCloud's own answer, when it has one.
        //
        // Only `.notDownloaded` means evicted. `.current` and `.downloaded` are BOTH readable —
        // `.downloaded` means "present, but a newer version exists remotely", and testing for
        // `== .current` alone would block on a perfectly readable file.
        if values.isUbiquitousItem == true,
           values.ubiquitousItemDownloadingStatus == .notDownloaded {
            return .evicted(logicalSize: logicalSize)
        }

        // Belt and braces: real size, zero allocated blocks, is what a dataless file looks like from
        // the outside regardless of which provider made it. This is the arm that covers Dropbox and
        // OneDrive, which may set SF_DATALESS without populating iCloud's keys.
        if logicalSize > 0, (values.fileAllocatedSize ?? 0) == 0 {
            return .evicted(logicalSize: logicalSize)
        }

        return .available
    }

    // MARK: - Reading

    /// `sys/resource.h`. Not surfaced as Swift constants, so they are spelled out — and the values
    /// were confirmed against the SDK header rather than guessed, because guessing produced `EINVAL`.
    private static let ioPolicyTypeMaterializeDatalessFiles: Int32 = 3  // IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES
    private static let ioPolicyScopeThread: Int32 = 1                   // IOPOL_SCOPE_THREAD
    private static let ioPolicyMaterializeOff: Int32 = 1                // IOPOL_MATERIALIZE_DATALESS_FILES_OFF

    /// Reads a file, failing immediately rather than blocking if it turns out to be evicted.
    ///
    /// `availability(of:)` is checked first, but a file can be evicted in the microseconds between
    /// that check and this read. The I/O policy closes the gap: with materialisation disabled for
    /// this thread, a dataless read returns `EDEADLK` at once instead of stalling for seconds.
    ///
    /// The result is the property the whole vault rests on — **a read either returns complete,
    /// correct bytes or it fails loudly. It can never return a short read.**
    public static func readWithoutMaterializing(_ url: URL) throws -> Data {
        // Thread-scoped, and NSFileCoordinator makes no promise about which thread runs the accessor,
        // so the policy is set inside the block rather than around the coordinate() call.
        let previous = getiopolicy_np(ioPolicyTypeMaterializeDatalessFiles, ioPolicyScopeThread)
        setiopolicy_np(ioPolicyTypeMaterializeDatalessFiles, ioPolicyScopeThread, ioPolicyMaterializeOff)
        defer {
            setiopolicy_np(ioPolicyTypeMaterializeDatalessFiles, ioPolicyScopeThread, previous)
        }
        return try Data(contentsOf: url, options: [.uncached])
    }

    /// Loads a note, normalised for display, together with the hash of what is actually on disk.
    ///
    /// The returned hash is of the **raw bytes**, deliberately not of the normalised text. Hashing
    /// the normalised form instead would make the very next conflict check compare a normalised hash
    /// against un-normalised disk bytes, see a mismatch, and write a spurious `-conflict-` sibling on
    /// first open of every file with a stray trailing newline. That bug is one line away.
    public static func loadText(_ url: URL) throws -> (text: String, diskHash: String) {
        var readError: (any Error)?
        var data: Data?

        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        coordinator.coordinate(readingItemAt: url, options: [.withoutChanges], error: &coordinationError) { actual in
            do { data = try readWithoutMaterializing(actual) } catch { readError = error }
        }

        if let coordinationError { throw VaultError.coordination(coordinationError.localizedDescription) }
        if let readError { throw readError }
        guard let data else { throw VaultError.coordination("no data and no error") }
        guard let raw = String(data: data, encoding: .utf8) else { throw VaultError.notUTF8(url) }

        return (MarkdownDocument.normalizeTrailingNewline(raw), ContentHash.of(data))
    }

    // MARK: - Writing

    public enum WriteOutcome: Equatable, Sendable {
        /// Written; the value is the hash now on disk, which becomes the new baseline.
        case written(hash: String)
        /// The file changed underneath us and the buffer had unsaved edits, so our version went to a
        /// sibling and the original was left alone (decision 8).
        case conflicted(sibling: URL, hash: String)
    }

    /// Writes a note, refusing to clobber a file that changed underneath.
    ///
    /// The collision check happens *inside* the coordination block so nothing can slip between the
    /// check and the replace. `NSFileCoordinator` closes that window against other coordinated
    /// writers; a non-coordinated writer (a shell redirect, a Linux Syncthing peer) can still race,
    /// which is an accepted v0.1 gap — the sibling policy means the worst case is a stray file, never
    /// lost text.
    ///
    /// - Parameter expectedHash: what we believe is on disk. `nil` writes unconditionally.
    @discardableResult
    public static func write(
        text: String,
        to url: URL,
        expectedHash: String?,
        now: Date = Date()
    ) throws -> WriteOutcome {
        // Decision 10's "exactly one trailing newline" applies on the way *out* as well as on the way
        // in, and for a while it did not. Normalising only on load looks sufficient and is not: the
        // caret can sit past the final newline (⌘↓ goes there), so typing at the end of a note
        // produced a file with no trailing newline at all. POSIX-incorrect, and it put a
        // "\ No newline at end of file" line into the diff of every note edited at its end — in a
        // vault kept under git, which is exactly how the byte-for-byte bar is meant to be checked.
        //
        // The returned hash is of these normalised bytes, because they are what lands on disk. Any
        // caller comparing a buffer against it has to normalise the buffer the same way, or the two
        // never agree and the note is rewritten on every debounce forever.
        let normalized = MarkdownDocument.normalizeTrailingNewline(text)
        let data = Data(normalized.utf8)
        let newHash = ContentHash.of(data)

        var outcome: WriteOutcome?
        var thrown: (any Error)?

        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?

        // `.forReplacing` tells the coordinator — and through it any sync provider — that the item's
        // identity is about to change. An atomic write is temp-file-plus-rename, so the inode really
        // does change, and a provider that was not told treats it as delete-plus-create.
        coordinator.coordinate(writingItemAt: url, options: .forReplacing, error: &coordinationError) { actual in
            do {
                if let expectedHash {
                    switch availability(of: actual) {
                    case .missing:
                        break  // recreating a note deleted elsewhere is fine

                    case .evicted:
                        // We have never seen these bytes. Writing over them would destroy content
                        // that only exists on another machine — never do it.
                        let sibling = conflictURL(for: actual, now: now)
                        try data.write(to: sibling, options: [.atomic])
                        outcome = .conflicted(sibling: sibling, hash: newHash)
                        return

                    case .available:
                        let onDisk = try readWithoutMaterializing(actual)
                        if ContentHash.of(onDisk) != expectedHash {
                            let sibling = conflictURL(for: actual, now: now)
                            try data.write(to: sibling, options: [.atomic])
                            outcome = .conflicted(sibling: sibling, hash: newHash)
                            return
                        }
                    }
                }

                // Atomic rather than FileManager.replaceItemAt: both were measured byte-identical,
                // and this one has no temp-directory lifetime to leak. Note the temp file lands in
                // the destination directory as `.dat.nosyncXXXX`, which the watcher must filter.
                try data.write(to: actual, options: [.atomic])
                outcome = .written(hash: newHash)
            } catch {
                thrown = error
            }
        }

        if let coordinationError { throw VaultError.coordination(coordinationError.localizedDescription) }
        if let thrown { throw thrown }
        guard let outcome else { throw VaultError.coordination("write produced no outcome") }
        return outcome
    }

    /// `<stem>-conflict-<timestamp>.md`, beside the original, as an ordinary note the user can open.
    public static func conflictURL(for url: URL, now: Date = Date()) -> URL {
        url.deletingLastPathComponent()
            .appendingPathComponent(
                NoteFilename.conflictSibling(for: url.lastPathComponent, date: now)
            )
    }

    // MARK: - Downloading

    /// Asks iCloud for an evicted note and waits for it.
    ///
    /// Polls, because `NSMetadataQuery` cannot serve this configuration: Pane is unsigned, so it has
    /// no ubiquity container, so every ubiquitous query scope is empty — and a plain-directory scope
    /// finds the file but reports `nil` for every ubiquitous attribute. `URLResourceValues` is the
    /// only thing that answers accurately here.
    ///
    /// Expect this to take **seconds**. Measured: 5–20 s for a 93-byte file, and
    /// `ubiquitousItemIsDownloading` was never once true during it — which is why progress is driven
    /// off the *status*, and why "downloading…" is a real UI state rather than a flicker.
    public static func materialize(
        _ url: URL,
        timeout: TimeInterval = 120,
        pollInterval: TimeInterval = 0.25,
        onProgress: ((TimeInterval) -> Void)? = nil
    ) throws {
        guard case .evicted = availability(of: url) else { return }

        // Control-tested: without this call the file stays `.notDownloaded` indefinitely. It really
        // is what starts the transfer.
        try FileManager.default.startDownloadingUbiquitousItem(at: url)

        let start = Date()
        while Date().timeIntervalSince(start) < timeout {
            Thread.sleep(forTimeInterval: pollInterval)
            switch availability(of: url) {
            case .available: return
            case .missing: throw VaultError.vaultMissing(url)
            case .evicted: onProgress?(Date().timeIntervalSince(start))
            }
        }
        throw VaultError.downloadTimedOut(url)
    }

    // MARK: - Listing

    /// Every note in the vault, unsorted. Dot-files are skipped, which also skips `.dat.nosync…`
    /// write temporaries and any legacy `.icloud` stub.
    public static func listNotes(in vault: URL) throws -> [URL] {
        let names = try FileManager.default.contentsOfDirectory(atPath: vault.path)
        return names
            .filter(NoteFilename.isNoteFile)
            .map { vault.appendingPathComponent($0) }
    }
}
