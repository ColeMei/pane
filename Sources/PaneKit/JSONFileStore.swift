import Foundation

/// Reads and writes one JSON file in Application Support, and refuses to lose its contents.
///
/// Both files this backs — `state.json` and `settings.json` — are rewritten often and are the only
/// record of things the user cannot reconstruct (pins, caret positions, a hand-edited hotkey). So
/// the rules are: never write partially, never delete a file we failed to understand, and never let
/// either failure stop the app from launching.
public final class JSONFileStore<Value: Codable> {

    public enum Outcome: Equatable, Sendable {
        /// No file yet — first launch.
        case fresh
        case loaded
        /// The file could not be decoded. It was moved aside to `backup` and defaults were used.
        case recovered(backup: URL, reason: String)
    }

    public let url: URL

    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(url: URL) {
        self.url = url

        encoder = JSONEncoder()
        // Pretty-printed and key-sorted because these files are meant to be opened and read: the
        // settings file is the hotkey editor v0.1 ships instead of a recorder, and a state file a
        // user can inspect is one they can trust.
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601

        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    /// Standard location: `~/Library/Application Support/Pane/<name>`.
    public static func inApplicationSupport(
        _ name: String,
        appName: String = "Pane",
        fileManager: FileManager = .default
    ) throws -> JSONFileStore<Value> {
        let base = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return JSONFileStore(url: base.appendingPathComponent(appName).appendingPathComponent(name))
    }

    // MARK: - Load

    /// Loads the file, falling back to `defaultValue` when it is missing or unreadable.
    ///
    /// A file that fails to decode is *moved aside*, never overwritten in place. If a future version
    /// of Pane, or a hand edit, produces something this build cannot parse, the bytes survive on
    /// disk under a name the user can find — and the next save writes a fresh file rather than
    /// silently clobbering the one that might still be recoverable.
    public func load(default defaultValue: @autoclosure () -> Value) -> (value: Value, outcome: Outcome) {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return (defaultValue(), .fresh)
        }

        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            return (defaultValue(), recover(reason: "could not be read: \(error.localizedDescription)"))
        }

        // An empty file is what a crash mid-write, or an iCloud placeholder, looks like. Treat it as
        // damage rather than as "no settings", so the previous contents get preserved for inspection.
        guard !data.isEmpty else {
            return (defaultValue(), recover(reason: "was empty"))
        }

        do {
            return (try decoder.decode(Value.self, from: data), .loaded)
        } catch {
            return (defaultValue(), recover(reason: "could not be parsed: \(error)"))
        }
    }

    private func recover(reason: String) -> Outcome {
        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withYear, .withMonth, .withDay, .withTime, .withDashSeparatorInDate]
        let name = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension
        let backup = url
            .deletingLastPathComponent()
            .appendingPathComponent("\(name)-damaged-\(Int(Date().timeIntervalSince1970)).\(ext)")

        try? FileManager.default.moveItem(at: url, to: backup)
        return .recovered(backup: backup, reason: reason)
    }

    // MARK: - Save

    /// Writes atomically: the file on disk is either the previous version or the new one, never a
    /// half-written mixture. Application Support is not synced, so a plain atomic replace is enough
    /// here — the vault, which *is* synced, goes through `NSFileCoordinator` instead.
    public func save(_ value: Value) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try encoder.encode(value).write(to: url, options: .atomic)
    }
}
