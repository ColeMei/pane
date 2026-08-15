import AppKit
import Foundation
import PaneKit

/// Holds `AppState` in memory and writes it to disk without doing so on every keystroke.
///
/// Caret offsets change constantly (decision 11 restores them exactly, so they are recorded on every
/// selection change) and `state.json` is pretty-printed for a human to read. Writing it synchronously
/// per keystroke would be the one piece of I/O on the hot path. Instead it coalesces, and flushes for
/// real at the three moments that matter — dismiss, blur and quit — which are the same three moments
/// the note itself is flushed (decision 10).
@MainActor
final class StateStore {

    private let store: JSONFileStore<AppState>
    private var pending: DispatchWorkItem?

    /// Long enough to swallow a burst of caret moves, short enough that a crash costs at most a
    /// couple of seconds of "where the caret was" — which is recoverable knowledge, unlike the note.
    private static let coalesceInterval: TimeInterval = 2.0

    private(set) var value: AppState

    let loadOutcome: JSONFileStore<AppState>.Outcome

    init() {
        let store = (try? JSONFileStore<AppState>.inApplicationSupport("state.json"))
            ?? JSONFileStore<AppState>(
                url: URL(fileURLWithPath: NSHomeDirectory())
                    .appendingPathComponent("Library/Application Support/Pane/state.json")
            )
        self.store = store
        (value, loadOutcome) = store.load(default: AppState())
    }

    /// Mutates the state and schedules a save.
    func update(_ body: (inout AppState) -> Void) {
        body(&value)
        scheduleSave()
    }

    private func scheduleSave() {
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.save() }
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.coalesceInterval, execute: work)
    }

    func save() {
        pending?.cancel()
        pending = nil
        do {
            try store.save(value)
        } catch {
            NSLog("Pane: could not save state — %@", String(describing: error))
        }
    }
}

/// The same treatment for `settings.json`, minus the coalescing — settings change rarely, and the
/// file is still hand-editable (decision 12) even though the Settings window (decision 16) is now
/// the ordinary way in.
@MainActor
final class SettingsStore {

    private let store: JSONFileStore<Settings>
    private(set) var value: Settings

    var url: URL { store.url }

    /// Called after any change, whether it came from the Settings window or from the file being
    /// edited underneath us. The whole app re-reads from `value` rather than being handed a diff:
    /// there are a dozen settings and applying all of them is cheaper than working out which one
    /// moved.
    var onChange: ((Settings) -> Void)?

    /// Where themes live (decision 19). Beside `settings.json`, not in the vault — a theme is a
    /// property of this machine, and putting CSS in the notes folder would sync it and would put a
    /// non-note in a flat vault of notes.
    var themesFolder: URL {
        store.url.deletingLastPathComponent().appendingPathComponent("Themes")
    }

    init() {
        let store = (try? JSONFileStore<Settings>.inApplicationSupport("settings.json"))
            ?? JSONFileStore<Settings>(
                url: URL(fileURLWithPath: NSHomeDirectory())
                    .appendingPathComponent("Library/Application Support/Pane/settings.json")
            )
        self.store = store
        let (value, outcome) = store.load(default: Settings())
        self.value = value

        // First launch, or a file we had to move aside: write the defaults back out so that the
        // promise "changing the hotkey is a one-line edit" has a line to edit.
        if outcome != .loaded {
            try? store.save(value)
        }
    }

    func update(_ body: (inout Settings) -> Void) {
        let before = value
        body(&value)
        guard value != before else { return }

        // Written before the callback runs, so anything the callback triggers — re-registering the
        // hotkey, switching vaults — is acting on a decision that already survived a crash.
        try? store.save(value)
        lastWrittenOnDisk = value
        onChange?(value)
    }

    // MARK: - Hand edits

    /// The last value this process put on disk, so a file-change event can tell our own write from
    /// somebody opening the file in an editor. The same question `VaultSync` asks about notes, and
    /// the same answer: compare content, not timestamps.
    private var lastWrittenOnDisk: Settings?

    /// Re-reads `settings.json` after it changed underneath us.
    ///
    /// Decision 12's promise — "changing the hotkey is a one-line edit" — was only half true while
    /// this file was read once at launch: the edit landed and nothing happened until the next
    /// relaunch, with nothing on screen to say so.
    func reloadFromDisk() {
        let (fresh, outcome) = store.load(default: value)
        guard outcome == .loaded, fresh != value, fresh != lastWrittenOnDisk else { return }
        value = fresh
        onChange?(fresh)
    }

    /// Watches `settings.json` for hand edits.
    ///
    /// The containing directory rather than the file: an atomic save — which is what every editor
    /// does — replaces the inode, so a watch on the file itself stops firing after the first change.
    func watchForHandEdits() {
        watcher?.stop()
        let watcher = VaultWatcher { [weak self] paths in
            guard paths.contains(where: { $0.hasSuffix("settings.json") }) else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.reloadFromDisk() }
            }
        }
        watcher.start(watching: store.url.deletingLastPathComponent())
        self.watcher = watcher
    }

    private var watcher: VaultWatcher?
}
