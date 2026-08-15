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
/// file is meant to be hand-edited (decision 12), so Pane writes it once at launch to make sure it
/// exists and otherwise leaves it alone.
@MainActor
final class SettingsStore {

    private let store: JSONFileStore<Settings>
    private(set) var value: Settings

    var url: URL { store.url }

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
        body(&value)
        try? store.save(value)
    }
}
