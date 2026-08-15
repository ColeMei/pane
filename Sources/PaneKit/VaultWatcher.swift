import CoreServices
import Foundation

/// Watches the vault folder and says when something in it changed.
///
/// Lives in PaneKit rather than in the app target because FSEvents is CoreServices, not AppKit — it
/// needs no window server, so it can be exercised by the suite like everything else here.
///
/// What this deliberately does **not** do is decide what a change *means*. It reports paths; the
/// caller compares content hashes and asks `VaultSync` (decision 10 — echoes are filtered by hash,
/// never by mtime). Keeping the two apart is what makes the interesting half testable without a
/// filesystem event ever firing.
public final class VaultWatcher {

    /// Coalescing window handed to FSEvents. A save from another editor often arrives as several
    /// events (temp file, rename, attribute change); 0.2 s turns that burst into one callback while
    /// staying far below the point where a change feels stale.
    public static let latency: CFTimeInterval = 0.2

    private let queue: DispatchQueue
    private let handler: @Sendable ([String]) -> Void
    private var stream: FSEventStreamRef?

    /// - Parameter handler: called on `queue` with the changed paths. Never called on the main
    ///   thread — reading those files is the caller's job and must not happen there either.
    public init(
        queue: DispatchQueue = DispatchQueue(label: "dev.colemei.pane.vault-watcher"),
        handler: @escaping @Sendable ([String]) -> Void
    ) {
        self.queue = queue
        self.handler = handler
    }

    deinit {
        // Not `stop()`: that is main-actor-agnostic here, but deinit may run anywhere, and the
        // FSEvents teardown sequence is safe from any thread once the stream is no longer scheduled.
        teardown()
    }

    public var isRunning: Bool { stream != nil }

    /// Starts watching `directory`. Restarts cleanly if already running.
    ///
    /// - Returns: whether the stream started. FSEvents can refuse — most plausibly for a path that
    ///   does not exist yet — and a watcher that silently failed to watch is a class of bug that
    ///   only shows up as "external edits sometimes don't appear".
    @discardableResult
    public func start(watching directory: URL) -> Bool {
        stop()

        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )

        let callback: FSEventStreamCallback = { _, info, count, paths, _, _ in
            guard let info else { return }
            let watcher = Unmanaged<VaultWatcher>.fromOpaque(info).takeUnretainedValue()

            // `.UseCFTypes` makes this a CFArray of CFStrings rather than a C string array.
            guard let cfPaths = unsafeBitCast(paths, to: NSArray.self) as? [String] else { return }
            watcher.handler(Array(cfPaths.prefix(count)))
        }

        let flags = UInt32(
            kFSEventStreamCreateFlagUseCFTypes
                | kFSEventStreamCreateFlagFileEvents
                // Report the first event in a burst immediately instead of at the end of the latency
                // window. An external edit should land in under a second, not after it.
                | kFSEventStreamCreateFlagNoDefer
                | kFSEventStreamCreateFlagIgnoreSelf
        )

        guard let created = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            [directory.path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            Self.latency,
            flags
        ) else {
            return false
        }

        FSEventStreamSetDispatchQueue(created, queue)
        guard FSEventStreamStart(created) else {
            FSEventStreamInvalidate(created)
            FSEventStreamRelease(created)
            return false
        }

        stream = created
        return true
    }

    public func stop() {
        teardown()
    }

    private func teardown() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }

    /// Whether a changed path is one the vault cares about.
    ///
    /// Pure, and separated from the stream on purpose: this is the part with edge cases worth
    /// testing. `.md` only, no dot-files — which also drops the `.dat.nosyncXXXX` temporaries an
    /// atomic write leaves in the destination directory, and which would otherwise register as a
    /// change to a note that does not exist.
    public static func isRelevant(path: String) -> Bool {
        NoteFilename.isNoteFile((path as NSString).lastPathComponent)
    }

    /// The note filenames worth reacting to, deduplicated and in a stable order.
    public static func noteFilenames(in paths: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for path in paths where isRelevant(path: path) {
            let name = (path as NSString).lastPathComponent
            if seen.insert(name).inserted { out.append(name) }
        }
        return out
    }
}

// FSEventStreamRef is a CoreFoundation handle; the class guards it behind its own queue discipline.
extension VaultWatcher: @unchecked Sendable {}
