import Foundation

/// Where a deleted note waits before it is really gone — decision 20's behaviour.
///
/// The setting for this shipped in v0.1 and the behaviour did not, which made the Storage tab's
/// retention control the one place in Pane that claimed something the code did not do. This is that
/// code.
///
/// **The holding folder is not in the vault.** A deleted note left among the notes would still be
/// listed, still be searched, and — the real problem — would still sync, so "delete" on one Mac
/// would propagate a file that the other Mac then shows you again. It lives beside `state.json` in
/// Application Support for the same reason that does (decision 11): it is this machine's business,
/// not the vault's.
///
/// **There is no index file.** The deletion date is carried in the stored filename, which keeps
/// decision 1 true one level down: the folder is the database, and a folder you can read, sort and
/// rescue notes out of by hand in the Finder is worth more than a JSON sidecar that can drift from
/// the files it describes. It also means a note dragged out manually is simply restored, with
/// nothing left holding a stale reference to it.
public enum RecentlyDeleted {

    /// `~/Library/Application Support/Pane/Recently Deleted`. Spaces and all — this folder is meant
    /// to be found by a person who is looking for it.
    public static let folderName = "Recently Deleted"

    public static func store(inAppSupport appSupport: URL) -> URL {
        appSupport.appendingPathComponent(folderName, isDirectory: true)
    }

    /// `~/Library/Application Support/Pane/Recently Deleted`, resolved the same way `JSONFileStore`
    /// resolves `state.json` — so the two land beside each other rather than in two ideas of where
    /// Application Support is.
    public static func standardStore(
        appName: String = "Pane",
        fileManager: FileManager = .default
    ) throws -> URL {
        let base = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return store(inAppSupport: base.appendingPathComponent(appName))
    }

    public enum Failure: Error, Equatable {
        case notFound(String)
        case coordination(String)
        case move(String)
    }

    // MARK: - Stored names

    /// `20260816-014530--2026-08-11-1453-standup.md`
    ///
    /// The prefix is fixed-width on purpose: 15 characters of timestamp and a two-character
    /// separator, so the original name is recovered by counting rather than by searching for a
    /// delimiter. Note filenames are themselves full of hyphens (decision 2), and any parser that
    /// went looking for one would eventually pick the wrong one.
    static let prefixWidth = 17

    private static func stamp(_ date: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return String(
            format: "%04d%02d%02d-%02d%02d%02d",
            c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0, c.second ?? 0
        )
    }

    public static func storedName(
        original: String,
        deletedAt: Date,
        timeZone: TimeZone = .current
    ) -> String {
        "\(stamp(deletedAt, timeZone: timeZone))--\(original)"
    }

    /// The inverse. Returns `nil` for anything that does not carry the prefix, which is how a file
    /// the user dropped in here themselves is left alone by both the list and the purge.
    public static func parse(storedName: String, timeZone: TimeZone = .current) -> DeletedNote? {
        guard storedName.count > prefixWidth else { return nil }

        let stampText = String(storedName.prefix(15))
        let separator = storedName.dropFirst(15).prefix(2)
        guard separator == "--" else { return nil }

        let digits = stampText.split(separator: "-")
        guard digits.count == 2, digits[0].count == 8, digits[1].count == 6,
              stampText.allSatisfy({ $0.isNumber || $0 == "-" })
        else { return nil }

        func number(_ text: Substring, _ range: Range<Int>) -> Int? {
            let chars = Array(text)
            guard range.upperBound <= chars.count else { return nil }
            return Int(String(chars[range]))
        }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var components = DateComponents()
        components.year = number(digits[0], 0..<4)
        components.month = number(digits[0], 4..<6)
        components.day = number(digits[0], 6..<8)
        components.hour = number(digits[1], 0..<2)
        components.minute = number(digits[1], 2..<4)
        components.second = number(digits[1], 4..<6)

        guard let date = calendar.date(from: components) else { return nil }

        return DeletedNote(
            storedName: storedName,
            originalName: String(storedName.dropFirst(prefixWidth)),
            deletedAt: date
        )
    }

    // MARK: - Deleting

    /// Moves `filename` out of the vault and into the holding folder.
    ///
    /// Coordinated as a move rather than done with a bare `moveItem`: the source is in the vault,
    /// which sits under iCloud or Syncthing (decision 10), and a provider that was not told the
    /// item's identity changed treats a move as delete-plus-create.
    @discardableResult
    public static func accept(
        _ filename: String,
        from vault: URL,
        into store: URL,
        at now: Date = Date(),
        timeZone: TimeZone = .current
    ) throws -> DeletedNote {
        let source = vault.appendingPathComponent(filename)
        guard FileManager.default.fileExists(atPath: source.path) else {
            throw Failure.notFound(filename)
        }

        try FileManager.default.createDirectory(at: store, withIntermediateDirectories: true)

        // Two deletes of the same note inside one second would collide. Walking the clock forward
        // keeps the name fixed-width — which the parser depends on — and costs at most a few seconds
        // of accuracy on a retention measured in days.
        var stampedAt = now
        var name = storedName(original: filename, deletedAt: stampedAt, timeZone: timeZone)
        while FileManager.default.fileExists(atPath: store.appendingPathComponent(name).path) {
            stampedAt = stampedAt.addingTimeInterval(1)
            name = storedName(original: filename, deletedAt: stampedAt, timeZone: timeZone)
        }

        try move(from: source, to: store.appendingPathComponent(name))
        return DeletedNote(storedName: name, originalName: filename, deletedAt: stampedAt)
    }

    // MARK: - Listing

    /// Newest first — the order a "get it back" list wants, and the order the switcher already
    /// presents notes in.
    public static func list(in store: URL, timeZone: TimeZone = .current) -> [DeletedNote] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: store.path)) ?? []
        return names
            .compactMap { parse(storedName: $0, timeZone: timeZone) }
            .sorted { $0.deletedAt > $1.deletedAt }
    }

    // MARK: - Restoring

    /// Puts a note back in the vault and returns the filename it landed under.
    ///
    /// If the original name is taken — you deleted a note and then made another one that froze to
    /// the same name — the restore is uniqued rather than refused. Decision 2 freezes a filename at
    /// creation; it does not promise the name is still free years later, and losing the restore is a
    /// worse answer than a note called `…-2.md`.
    @discardableResult
    public static func restore(
        _ storedName: String,
        from store: URL,
        into vault: URL,
        timeZone: TimeZone = .current
    ) throws -> String {
        guard let record = parse(storedName: storedName, timeZone: timeZone) else {
            throw Failure.notFound(storedName)
        }
        let source = store.appendingPathComponent(storedName)
        guard FileManager.default.fileExists(atPath: source.path) else {
            throw Failure.notFound(storedName)
        }

        try FileManager.default.createDirectory(at: vault, withIntermediateDirectories: true)

        let existing = Set(
            ((try? FileManager.default.contentsOfDirectory(atPath: vault.path)) ?? [])
                .map { $0.lowercased() }
        )

        var name = record.originalName
        if existing.contains(name.lowercased()) {
            let stem = (name as NSString).deletingPathExtension
            let ext = (name as NSString).pathExtension
            var n = 2
            while existing.contains("\(stem)-\(n).\(ext)".lowercased()) { n += 1 }
            name = "\(stem)-\(n).\(ext)"
        }

        try move(from: source, to: vault.appendingPathComponent(name))
        return name
    }

    // MARK: - Purging

    /// Deletes what has been here longer than `days`, and returns what it removed.
    ///
    /// This is the one place in Pane that unlinks a note for good, so it counts only from the moment
    /// the note was deleted — never from when it was written. That distinction is the whole reason
    /// decision 20 replaced "delete notes older than N days": a thought you had four months ago and
    /// never touched again is not garbage.
    @discardableResult
    public static func purge(
        in store: URL,
        keepingDays days: Int,
        now: Date = Date(),
        timeZone: TimeZone = .current
    ) -> [String] {
        guard days > 0 else { return [] }
        let cutoff = now.addingTimeInterval(-Double(days) * 86_400)

        var removed: [String] = []
        for record in list(in: store, timeZone: timeZone) where record.deletedAt < cutoff {
            let url = store.appendingPathComponent(record.storedName)
            if (try? FileManager.default.removeItem(at: url)) != nil {
                removed.append(record.storedName)
            }
        }
        return removed
    }

    // MARK: - Moving

    private static func move(from source: URL, to destination: URL) throws {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var moveError: (any Error)?

        coordinator.coordinate(
            writingItemAt: source,
            options: .forMoving,
            writingItemAt: destination,
            options: .forReplacing,
            error: &coordinationError
        ) { from, to in
            do {
                // The destination is uniqued by the callers, so an existing file here means someone
                // else got there between the check and now. Replacing would lose their copy.
                if FileManager.default.fileExists(atPath: to.path) {
                    throw Failure.move("\(to.lastPathComponent) already exists")
                }
                try FileManager.default.moveItem(at: from, to: to)
            } catch {
                moveError = error
            }
        }

        if let coordinationError { throw Failure.coordination(coordinationError.localizedDescription) }
        if let moveError { throw moveError }
    }
}

/// One note in the holding folder. Everything here is recovered from the filename.
public struct DeletedNote: Equatable, Sendable {
    /// The name inside the holding folder, timestamp prefix and all. The identifier for restore.
    public let storedName: String
    /// The vault filename it will go back to.
    public let originalName: String
    public let deletedAt: Date

    public init(storedName: String, originalName: String, deletedAt: Date) {
        self.storedName = storedName
        self.originalName = originalName
        self.deletedAt = deletedAt
    }
}
