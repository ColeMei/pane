import CoreGraphics
import Foundation

/// Everything Pane remembers about *how you were using* your notes, as opposed to what is in them.
///
/// This is the whole of decision 11: caret offsets, recency, pins, window geometry and the last-used
/// note live in `~/Library/Application Support/Pane/state.json`, outside the vault and never synced.
/// None of it may leak into a note file. Frontmatter would break the byte-for-byte bar, would sync,
/// and would make the vault Pane's private format rather than a folder of markdown the user owns.
///
/// The accepted consequence is that pins are per-machine — a pin says what you are working on *at
/// this desk*, which is not a property of the note.
public struct AppState: Codable, Equatable, Sendable {

    /// Bumped when a field changes meaning rather than merely being added. Additive changes keep the
    /// version: every property below has a default, so an older file decodes cleanly.
    public static let currentSchemaVersion = 1

    public var schemaVersion: Int

    /// Per-note state, keyed by the note's frozen filename — which never changes, which is exactly
    /// what makes it usable as a key (decision 2).
    public var notes: [String: NoteState]

    /// Open panes. A list, not a single optional, because a note is an independently ownable pane
    /// (decision 9). v0.1 shows one; nothing here assumes that.
    public var panes: [PaneState]

    public init(
        schemaVersion: Int = AppState.currentSchemaVersion,
        notes: [String: NoteState] = [:],
        panes: [PaneState] = []
    ) {
        self.schemaVersion = schemaVersion
        self.notes = notes
        self.panes = panes
    }

    // Hand-written so a state.json missing any key still decodes — a file written by an older build
    // must never cost the user their pins.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? Self.currentSchemaVersion
        notes = try c.decodeIfPresent([String: NoteState].self, forKey: .notes) ?? [:]
        panes = try c.decodeIfPresent([PaneState].self, forKey: .panes) ?? []
    }
}

// MARK: - Notes

public struct NoteState: Codable, Equatable, Sendable {

    /// Where the caret was when the pane was last dismissed, as a UTF-16 offset into the document —
    /// the unit both `NSTextView` and the web layer's `EditorState` count in, so it crosses the
    /// bridge without a conversion that could drift.
    ///
    /// Restored exactly, not reset to the end of the document: the workflow is returning to a
    /// half-finished thought, and end-of-document is only the right answer by coincidence
    /// (decision 11).
    public var caretOffset: Int

    /// The far end of a selection, when the user left one. `nil` means a plain caret.
    public var selectionAnchor: Int?

    /// First visible line, so a long note reopens where it was rather than scrolled to the top.
    public var scrollLine: Int

    /// When Pane last opened this note. Combined with the file's own modification date to order the
    /// switcher — see `lastActivity(modified:)`.
    public var lastOpened: Date?

    /// Pinned notes sort into the switcher's Pinned group, appear in the menu bar, and make the pane
    /// holding them ignore the dismiss hotkey.
    public var isPinned: Bool

    public init(
        caretOffset: Int = 0,
        selectionAnchor: Int? = nil,
        scrollLine: Int = 0,
        lastOpened: Date? = nil,
        isPinned: Bool = false
    ) {
        self.caretOffset = caretOffset
        self.selectionAnchor = selectionAnchor
        self.scrollLine = scrollLine
        self.lastOpened = lastOpened
        self.isPinned = isPinned
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        caretOffset = try c.decodeIfPresent(Int.self, forKey: .caretOffset) ?? 0
        selectionAnchor = try c.decodeIfPresent(Int.self, forKey: .selectionAnchor)
        scrollLine = try c.decodeIfPresent(Int.self, forKey: .scrollLine) ?? 0
        lastOpened = try c.decodeIfPresent(Date.self, forKey: .lastOpened)
        isPinned = try c.decodeIfPresent(Bool.self, forKey: .isPinned) ?? false
    }

    /// The timestamp the switcher both sorts and *displays* — the later of the file's modification
    /// date and the last time Pane opened it.
    ///
    /// One value for both jobs on purpose. Sorting by one and showing the other produces rows that
    /// contradict themselves: a note sitting under "Today" with "Jul 30" beside it.
    public func lastActivity(modified: Date) -> Date {
        guard let lastOpened else { return modified }
        return max(modified, lastOpened)
    }
}

// MARK: - Panes

public struct PaneState: Codable, Equatable, Sendable, Identifiable {

    public var id: UUID

    /// The note this pane is showing. `nil` for a pane that has not been pointed at one yet.
    public var noteFilename: String?

    /// Whether the format bar is open. Per pane, per the design's note that the state persists.
    public var showsFormatBar: Bool

    /// Remembered geometry, keyed by display. "Stay put" means a pane returns to where the user left
    /// it *on that screen* — plugging in a monitor must not shuffle the panes on the built-in one.
    public var frames: [String: StoredFrame]

    public init(
        id: UUID = UUID(),
        noteFilename: String? = nil,
        showsFormatBar: Bool = false,
        frames: [String: StoredFrame] = [:]
    ) {
        self.id = id
        self.noteFilename = noteFilename
        self.showsFormatBar = showsFormatBar
        self.frames = frames
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        noteFilename = try c.decodeIfPresent(String.self, forKey: .noteFilename)
        showsFormatBar = try c.decodeIfPresent(Bool.self, forKey: .showsFormatBar) ?? false
        frames = try c.decodeIfPresent([String: StoredFrame].self, forKey: .frames) ?? [:]
    }
}

/// A window frame in AppKit screen coordinates, stored as named fields rather than the array
/// `CGRect`'s synthesised conformance produces — state.json is a file a curious user will open, and
/// `[820, 512, 692, 400]` tells them nothing.
public struct StoredFrame: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public init(_ rect: CGRect) {
        self.init(
            x: Double(rect.origin.x),
            y: Double(rect.origin.y),
            width: Double(rect.size.width),
            height: Double(rect.size.height)
        )
    }

    public var rect: CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }
}

// MARK: - Convenience

extension AppState {

    public func note(_ filename: String) -> NoteState {
        notes[filename] ?? NoteState()
    }

    public var pinnedFilenames: [String] {
        notes.filter(\.value.isPinned).keys.sorted()
    }

    /// The note to open on the next summon: the one most recently opened.
    ///
    /// Reads from `notes` rather than from a dedicated "last used" field so there is one source of
    /// truth — a separate field would be a second place for the answer to be wrong.
    public var lastUsedFilename: String? {
        notes
            .compactMap { name, state in state.lastOpened.map { (name, $0) } }
            .max { $0.1 < $1.1 }?
            .0
    }

    public mutating func recordOpen(_ filename: String, at date: Date) {
        var s = notes[filename] ?? NoteState()
        s.lastOpened = date
        notes[filename] = s
    }

    public mutating func recordCaret(
        _ filename: String,
        offset: Int,
        anchor: Int? = nil,
        scrollLine: Int = 0
    ) {
        var s = notes[filename] ?? NoteState()
        s.caretOffset = max(0, offset)
        s.selectionAnchor = anchor.map { max(0, $0) }
        s.scrollLine = max(0, scrollLine)
        notes[filename] = s
    }

    @discardableResult
    public mutating func togglePin(_ filename: String) -> Bool {
        var s = notes[filename] ?? NoteState()
        s.isPinned.toggle()
        notes[filename] = s
        return s.isPinned
    }

    /// Drops state for notes that no longer exist, so a long-lived vault does not accumulate an
    /// entry for every note ever deleted.
    ///
    /// Deliberately *not* called while the vault is unreachable or a note is still downloading from
    /// iCloud — an evicted or temporarily missing note is not a deleted one, and forgetting its pin
    /// and caret because a sync was slow would be the same class of bug as decision 13's.
    public mutating func forgetNotes(missingFrom present: Set<String>) {
        notes = notes.filter { present.contains($0.key) }
        for i in panes.indices where panes[i].noteFilename.map({ !present.contains($0) }) ?? false {
            panes[i].noteFilename = nil
        }
    }
}
