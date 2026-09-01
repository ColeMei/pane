import CryptoKit
import Foundation

/// Content hashing, used to tell our own writes apart from everyone else's.
///
/// Decision 10 is explicit that echoes are filtered by hash and **not** by modification time. mtime
/// is the obvious choice and the wrong one: an atomic replace changes it, sync daemons rewrite it,
/// and two edits inside the same second can leave it unchanged — so it produces both false alarms
/// and misses. A hash answers the only question worth asking, which is whether the bytes on disk are
/// the bytes we last wrote.
public enum ContentHash {

    public static func of(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Hashes the UTF-8 encoding, which is what actually reaches the disk. Hashing the `String`
    /// instead would make two byte sequences that normalise to the same characters compare equal,
    /// and this whole mechanism exists to notice byte-level differences.
    public static func of(_ text: String) -> String {
        of(Data(text.utf8))
    }
}

/// What to do when the file underneath an open note has changed.
///
/// This is decision 8, which defers conflict *handling* but not conflict *detection*: v0.1 must
/// notice and must refuse to clobber. The one thing it may never do is stop accepting keystrokes —
/// a notes panel that goes read-only has failed at the only thing it does, and losing a race to
/// another machine is not a reason to stop typing on this one.
public enum VaultSync {

    public enum Reaction: Equatable, Sendable {
        /// The bytes on disk are the bytes we wrote. Our own FSEvents echo; do nothing.
        case ignoreEcho

        /// Nothing changed that we did not already know about.
        case noChange

        /// Someone else wrote, and we have nothing unsaved. Reload silently — there is nothing to
        /// lose, and a prompt would be noise.
        case reload

        /// Someone else wrote *and* we have unsaved edits. Write ours to a sibling, keep the buffer
        /// exactly as it is, and say so in one line.
        case writeConflictSibling

        /// Disk and buffer already agree, by whatever route. Adopt disk as the new baseline and say
        /// nothing.
        case adoptBaseline
    }

    /// Which file the open note moved to, when something outside Pane renamed it (decision 103).
    ///
    /// A rename is the one vault event that changes a note's *name* and nothing else, so the test is
    /// the content hash: whichever newly-seen file holds the bytes we last wrote is the note.
    ///
    /// **Exactly one match, or nothing.** Two files with identical bytes in one FSEvents burst is a
    /// copy, not a move, and guessing between them would take the caret and the pin to the wrong
    /// one. Nothing is also the right answer when the original is still there — a burst that names
    /// other files is an ordinary edit elsewhere in the vault.
    ///
    /// - Parameters:
    ///   - filename: the open note's name.
    ///   - originalIsMissing: whether that file is actually gone. A burst alone does not say so;
    ///     FSEvents coalesces, and it reports directories as often as files.
    ///   - candidates: every other name in the burst that is still present, with its hash.
    ///   - baselineHash: the bytes we last read from or wrote to the open note.
    public static func renameTarget(
        of filename: String,
        originalIsMissing: Bool,
        candidates: [String: String],
        baselineHash: String
    ) -> String? {
        guard originalIsMissing else { return nil }

        let matches = candidates
            .filter { $0.key != filename && $0.value == baselineHash }
            .map(\.key)

        return matches.count == 1 ? matches[0] : nil
    }

    /// Decides what a change on disk means.
    ///
    /// - Parameters:
    ///   - diskHash: hash of the bytes currently on disk.
    ///   - baselineHash: hash of the bytes we last read from or wrote to this file — what we believe
    ///     disk contained a moment ago.
    ///   - bufferHash: hash of what is in the editor right now.
    public static func react(
        diskHash: String,
        baselineHash: String?,
        bufferHash: String
    ) -> Reaction {
        // Nothing to compare against yet — first read of a file we have never seen.
        guard let baselineHash else {
            return diskHash == bufferHash ? .adoptBaseline : .reload
        }

        if diskHash == baselineHash {
            // Disk still holds what we last put there. If the buffer has moved on, that is simply an
            // unsaved edit waiting for the debounce, not a conflict.
            return .noChange
        }

        // Disk changed. Did we already have these exact bytes?
        if diskHash == bufferHash {
            // Someone wrote what we were going to write, or our own atomic replace raced ahead of
            // the baseline update. Either way there is nothing to reconcile.
            return .adoptBaseline
        }

        // Disk changed underneath us. The buffer decides whether that costs anything.
        return bufferHash == baselineHash ? .reload : .writeConflictSibling
    }

    /// Convenience over the raw hashes, for callers holding text.
    public static func react(
        disk: String,
        baseline: String?,
        buffer: String
    ) -> Reaction {
        react(
            diskHash: ContentHash.of(disk),
            baselineHash: baseline.map(ContentHash.of),
            bufferHash: ContentHash.of(buffer)
        )
    }
}

/// When bytes are allowed to hit the disk.
///
/// Decision 10: 500 ms after typing stops, and immediately on dismiss, blur and quit. The debounce
/// keeps a sync daemon from seeing a write per keystroke; the three immediate flushes are the moments
/// that actually matter, because a panel that is summoned and banished constantly is a panel whose
/// content must be safe the instant it goes away.
public enum WritePolicy {

    public static let debounce: TimeInterval = 0.5

    public enum Trigger: Equatable, Sendable {
        case typingStopped
        case dismissed
        case lostFocus
        case quitting
        case noteSwitched
        /// The vault watcher wants a clean file before it reloads.
        case reloadPending

        /// Whether this trigger waits out the debounce or writes now.
        public var isImmediate: Bool {
            switch self {
            case .typingStopped: return false
            case .dismissed, .lostFocus, .quitting, .noteSwitched, .reloadPending: return true
            }
        }
    }

    /// How long to wait before writing, given what prompted it.
    public static func delay(for trigger: Trigger) -> TimeInterval {
        trigger.isImmediate ? 0 : debounce
    }
}
