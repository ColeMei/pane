import AppKit
import Foundation
import PaneKit

/// One pane: a window, a web view, and the note currently in it.
///
/// Deliberately not a singleton and deliberately not "the editor" — decision 14 says a note is an
/// independently ownable pane, and the way that survives contact with a v0.1 that shows one pane is
/// for this type to hold no static state and know nothing about how many of it exist. Everything it
/// needs — the vault, the shared state file — is handed in.
@MainActor
final class PaneController: NSObject {

    /// What the pane is telling the user about itself, in one line above the editor.
    ///
    /// The design record never drew any of these (the brief says so out loud), so they are built here
    /// against decision 22's chrome rules: one row, no button that has to be dismissed before typing
    /// resumes, and nothing that looks like an error — because in two of the three cases nothing
    /// went wrong.
    enum Banner {
        case conflict
        case downloading
        case problem(String)

        var kind: String {
            switch self {
            case .conflict: return "conflict"
            case .downloading: return "downloading"
            case .problem: return "problem"
            }
        }

        var text: String {
            switch self {
            case .conflict:
                // Decision 76: the name of the thing that happened, and nothing after it.
                //
                // This used to go on to print the sibling's filename, and **the filename was the
                // half that got cut**: decision 2's names are long by construction and the conflict
                // stamp doubles them, so a 434pt pane rendered "…Your version is in
                // 2026-08-23-1002…" — all of the prose and none of the payload. Seen the first time
                // the banner ever fired for real.
                //
                // Nothing is lost by dropping it. The pane is already editing the sibling
                // (decision 25), so your text is on screen; ⌥⌘R reveals the file it is in; and the
                // switcher lists both. A row that cannot fit the fact it is carrying is better off
                // carrying the state instead.
                return "This note changed elsewhere."
            case .downloading:
                return "Downloading from iCloud…"
            case .problem(let message):
                return message
            }
        }
    }

    let panel = PanePanel()
    let editor = EditorWebView(frame: .zero)

    private let vault: VaultService
    private let state: StateStore
    private let settings: SettingsStore

    /// Called when pins change, so the menu bar's pinned section can be rebuilt.
    var onPinsChanged: (() -> Void)?
    /// Called when the vault turns out to be gone (decision 13).
    var onVaultMissing: (() -> Void)?
    /// Called by ⌘K's Settings… row. The window belongs to the app, not to a pane — decision 16 —
    /// so the pane asks rather than owning one.
    var onOpenSettings: (() -> Void)?

    private var paneID: UUID

    // MARK: Buffer

    private(set) var currentFilename: String?
    private var bufferText = ""
    /// Hash of the bytes we believe are on disk. `nil` means "we have not read this file yet", which
    /// `VaultSync.react` treats differently from "we read it and it was empty".
    private var baselineHash: String?

    /// The buffer hashed the way `VaultIO.write` will store it — trailing newline normalised.
    ///
    /// Every comparison between the buffer and `baselineHash` must go through this. `baselineHash`
    /// holds the hash of what is on disk, and what goes on disk is normalised (decision 10), so a
    /// raw `ContentHash.of(bufferText)` differs from it by exactly one newline on most notes. The
    /// guard in `flush` would then never match, and the pane would rewrite the file every 500 ms for
    /// as long as it was open.
    private var bufferHash: String {
        ContentHash.of(MarkdownDocument.normalizeTrailingNewline(bufferText))
    }

    private var writeTimer: DispatchWorkItem?
    private var isWriting = false
    private var writeRequestedWhileWriting = false

    /// A note that has been asked for but not yet written — no file, no name, no state entry.
    ///
    /// ⌘N used to create the file immediately, and decision 2 freezes a filename at creation from
    /// whatever the first line says at that moment. On a note that does not exist yet the first line
    /// says nothing, so **every note anyone ever made with ⌘N was called `untitled` for life** — the
    /// "first few words" half of the scheme had never once run — and a note started and then
    /// abandoned left a permanent zero-length file behind it.
    ///
    /// Decision 2 is untouched by this: the name is still frozen at creation and still never
    /// changes. Creation simply moves from the keystroke that asks for a note to the first write of
    /// one, which is the first moment there is anything to name it after. It also means a note you
    /// asked for and did not write in leaves nothing at all, which is what it should have done.
    private var isDraft = false

    /// One create in flight at a time, for `flush`'s reason: two would make two files.
    private var isMaterialising = false

    /// One mid-session download at a time (decision 105a). FSEvents bursts arrive in twos.
    private var isDownloadingCurrent = false

    /// The note whose filename is still following its first line (decision 103), if any.
    ///
    /// Set for a note **this pane created**, and cleared by the first of: dismiss, a note switch,
    /// quit, an external write, an external rename, or a hand rename through ⌘K. That list is the
    /// rule — the name follows only while Pane is the only thing that has touched the file and the
    /// note has not been left. Once anything else knows this file by path, renaming under it is
    /// decision 74's trap extended to a process we do not control.
    private var unsettledName: String?

    /// Carries "this note was just created here" across the async `open` that follows a create.
    /// `adopt` is shared by every way into a note, and only this one starts the name unsettled.
    private var pendingCreatedName: String?

    /// The caret offset the editor last reported, whether or not there is a file to record it under.
    ///
    /// `recordCaret` is keyed on `currentFilename`, and a draft has none for the whole of its life
    /// — so everything typed before the first write left no caret behind, and the state entry
    /// `adoptDraft` creates started at 0. Any reload before the next keystroke then put the caret at
    /// the top of the note (decision 11 says it restores to the exact offset), and what was typed
    /// next went into the **title**, which decision 103 renames the file after.
    private var lastReportedCaret = 0

    // MARK: Layout

    private var lastContentHeight: CGFloat = PanePanel.defaultHeight
    private let autoSizeBadge = AutoSizeBadge()
    private var mouseMonitors: [Any] = []
    private var isHovered = false
    private var isCloseHovered = false
    private var switcherIsOpen = false
    private var actionsIsOpen = false
    private var actionsPaneHeight: CGFloat = 0

    /// Pane height while the switcher is open, measured by the panel rather than assumed here.
    ///
    /// This was a constant — `paneHeight(forOverlay: 54 + 430 + 34)` — and it was wrong twice over.
    /// It fed in the 54px top offset that `paneHeight(forOverlay:)` adds for itself, and it assumed
    /// a full 430px list whatever the vault held: ⌘P grew the pane to 691pt on a six-note vault and
    /// left a 370pt panel floating in the middle of it. ⌘K has reported its own height since
    /// decision 45; this is the switcher finally doing the same, which is also the last thing the
    /// two overlays did differently.
    private var switcherPaneHeight: CGFloat = 0

    init(vault: VaultService, state: StateStore, settings: SettingsStore) {
        self.vault = vault
        self.state = state
        self.settings = settings

        // Reuse the pane the last session left behind, so its remembered frames come back with it.
        if let existing = state.value.panes.first {
            paneID = existing.id
        } else {
            let fresh = PaneState()
            paneID = fresh.id
            state.update { $0.panes = [fresh] }
        }

        super.init()

        panel.delegate = self
        panel.contentView = editor
        editor.frame = panel.contentLayoutRect
        editor.autoresizingMask = [.width, .height]
        editor.delegate = self
        editor.load()

        // Offscreen from the start: the web view has to be laid out and warm before the first
        // summon, and the first summon must not be the first time anything renders.
        //
        // Through the panel rather than by setting the origin here, because "offscreen" is a state
        // the panel defends and not just a coordinate — see `PanePanel.parkBeforeFirstSummon`.
        panel.parkBeforeFirstSummon()
    }

    // MARK: - Pane state

    private var paneState: PaneState {
        get { state.value.panes.first { $0.id == paneID } ?? PaneState(id: paneID) }
        set {
            state.update { s in
                if let i = s.panes.firstIndex(where: { $0.id == paneID }) {
                    s.panes[i] = newValue
                } else {
                    s.panes.append(newValue)
                }
            }
        }
    }

    var isPinned: Bool {
        guard let currentFilename else { return false }
        return state.value.note(currentFilename).isPinned
    }

    // MARK: - Summon and dismiss

    var isVisible: Bool { panel.isSummoned }

    /// When the last toggle ran, so one press cannot be delivered twice — see the note on the menu
    /// bar's summon item. Carbon and AppKit can both hand us the same combination while the Settings
    /// window is frontmost, and two toggles in a row is a summon that immediately dismisses itself.
    private var lastToggle = Date.distantPast

    /// The hotkey. Rule 5: a pinned pane ignores the dismiss half of it.
    func toggle() {
        guard Date().timeIntervalSince(lastToggle) > 0.25 else { return }
        lastToggle = Date()

        if isVisible {
            guard !isPinned || settings.value.dismissMode == .escapeOnly else {
                // Pinned and already up: put the caret back rather than doing nothing, so the
                // hotkey still has an effect the user can feel.
                editor.focusEditor()
                return
            }
            dismiss()
        } else {
            summon()
        }
    }

    func summon() {
        // The active display is the one the pointer is on — Spotlight's convention, and the only
        // definition that matches where the user is looking.
        //
        // `NSScreen.main` is the fallback rather than the first choice on purpose: it means "the
        // screen with the key window", and Pane's whole trick is not owning the key window, so it
        // reports whichever display the *other* app is on. That is right often enough to hide the
        // bug and wrong exactly when the user has moved.
        let pointer = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(pointer) }
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let screen else { return }

        let frame = PanelGeometry.restore(
            remembered: paneState.frames[Self.displayKey(screen)]?.rect,
            titleBarHeight: PanePanel.titleBarHeight,
            screens: NSScreen.screens.map(\.visibleFrame),
            activeVisibleFrame: screen.visibleFrame,
            defaultWidth: PanePanel.defaultWidth,
            defaultHeight: max(PanelGeometry.minimumHeight, lastContentHeight)
        )

        panel.summon(at: frame, pinned: isPinned)
        // Decision 41: the chrome follows the cursor, and summoning moves the pane rather than the
        // cursor — so a pane that opens under a stationary pointer gets no `mouseenter` and would
        // sit dimmed until the mouse moved. Only Swift knows the new frame and the pointer at once.
        isHovered = frame.contains(NSEvent.mouseLocation)
        editor.call("setHover", [isHovered])
        refreshCloseHover()
        // The height the note wanted may have moved while the pane was away — an external edit, or a
        // note switched from the menu bar. Reconciling here rather than waiting for the web layer's
        // next report keeps the first frame the user sees the right size.
        applyContentHeight(heightWanted)

        editor.call("setFocused", [true])
        // A summon is a new sitting with the note, and undo belongs to the sitting — see
        // `resetHistory`. Without it ⌘Z reaches back across the dismissal and can empty a note that
        // was written in one burst.
        editor.call("resetHistory")
        editor.focusEditor()

        // Re-assert key status once the current event has finished.
        //
        // Summoning from the menu bar item ran inside `NSMenu`'s own tracking loop, and a menu
        // restores key status to whatever held it before when it closes — undoing the
        // `makeKeyAndOrderFront` above. The pane appeared, correctly, and then quietly did not take
        // a single keystroke, which looked like the hotkey working and the menu item being broken.
        // Idempotent on the hotkey path, which never had the problem.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.panel.isSummoned else { return }
            self.panel.makeKeyAndOrderFront(nil)
            self.editor.focusEditor()
        }

        // `isDraft` as well as the filename: a draft has no filename by design, and opening the
        // last-used note over the top of one would throw away whatever had been typed into it.
        if currentFilename == nil, !isDraft {
            openLastUsedNote()
        }

        startTrackingResizeEdge()
    }

    func dismiss() {
        flush(trigger: .dismissed)
        // Decision 103's freeze list, first entry. The write above still lands; only the *name*
        // stops following, so a note comes back on the next summon under the name you left it with.
        unsettledName = nil
        rememberFrame()
        panel.dismiss()
        editor.call("setFocused", [false])
        stopTrackingResizeEdge()

        // Hands the front back to whatever was there. Summoning never activated the app — measured:
        // `frontmostApplication` stays with the other app throughout — so in the common case this is
        // a no-op, and in the case where a click into the pane *did* activate us, it is the fix.
        if NSApp.isActive { NSApp.deactivate() }
    }

    private func rememberFrame() {
        guard let screen = panel.screen ?? NSScreen.main, let frame = panel.rememberedFrame else {
            return
        }
        var pane = paneState
        pane.frames[Self.displayKey(screen)] = StoredFrame(frame)
        paneState = pane
    }

    /// Stable-ish per-display key. The display ID survives sleep and resolution changes; the frame
    /// size is appended so that swapping a monitor for a different one at the same port does not
    /// silently inherit a frame sized for the old panel.
    private static func displayKey(_ screen: NSScreen) -> String {
        let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?
            .uint32Value ?? 0
        return "\(id)-\(Int(screen.frame.width))x\(Int(screen.frame.height))"
    }

    // MARK: - Notes

    func openLastUsedNote() {
        if let last = state.value.lastUsedFilename {
            open(last)
            return
        }
        // Nothing remembered: take whatever the vault has, most recent first.
        vault.rows(query: "", state: state.value, current: nil, order: settings.value.noteOrder) {
            [weak self] snapshot in
            guard let self else { return }
            if let first = snapshot.rows.first {
                self.open(first.filename)
            } else {
                self.createNote(title: "")
            }
        }
    }

    /// `recordingHistory` is false only when ⌘[ / ⌘] are the ones doing the opening — walking the
    /// history must not itself write history, or Back would just alternate between two notes forever.
    func open(_ filename: String, recordingHistory: Bool = true) {
        guard filename != currentFilename else {
            editor.focusEditor()
            return
        }
        flush(trigger: .noteSwitched)

        vault.load(filename) { [weak self] result in
            guard let self else { return }
            switch result {
            case .loaded(let text, let hash):
                self.adopt(
                    filename: filename, text: text, hash: hash, recordingHistory: recordingHistory)

            case .downloading:
                // Decision 13: never read an evicted note on the main thread, and never pretend a
                // download is instant — it is 5–20 s even for a tiny file.
                self.showBanner(.downloading)
                self.vault.download(filename) { [weak self] downloaded in
                    guard let self else { return }
                    if case .loaded(let text, let hash) = downloaded {
                        self.adopt(
                            filename: filename, text: text, hash: hash,
                            recordingHistory: recordingHistory)
                    } else {
                        self.showBanner(.problem("Could not download \(filename) from iCloud."))
                    }
                }

            case .missing:
                self.state.update { $0.notes.removeValue(forKey: filename) }
                self.checkVaultStillThere()

                // And then open something, because a pane bound to *no* note silently throws away
                // everything typed into it: `flush` returns at its first guard when there is no
                // filename, so the buffer fills up, the word count rises, and not one byte is ever
                // written. Reachable any time the last-used note is gone — deleted in the Finder
                // while Pane was closed, or the vault re-pointed at a folder that does not have it.
                //
                // This terminates: the line above drops the missing note from `notes`, so the next
                // pass picks a different one, and an empty vault ends at a draft rather than
                // another lookup.
                if self.currentFilename == nil, !self.isDraft { self.openLastUsedNote() }

            case .failed(let message):
                self.showBanner(.problem("Could not open \(filename): \(message)"))
            }
        }
    }

    private func adopt(
        filename: String, text: String, hash: String, recordingHistory: Bool = true
    ) {
        // Everything typed since `open` asked for this note belongs to the note that was on screen
        // while it was being fetched, and the next four lines replace the buffer holding it.
        //
        // `open` flushes too, which covers the ordinary case where a note loads in a millisecond.
        // A note that has to be **downloaded** does not: decision 13 measures that at 5–20 seconds,
        // and the pane goes on showing and accepting edits into the previous note for all of it
        // (decision 8 — the panel is never made read-only). Measured on the running app: type a
        // character while "Downloading from iCloud…" is up, let the download land inside the 500 ms
        // debounce, and the character is gone — the write timer fires after the buffer has already
        // been replaced, finds the new note's text against the new note's baseline, and declines.
        //
        // That is decision 10's write model wrong for the **fifth** time and silent for the fifth
        // time, and the shape is decisions 56 and 74's exactly: something replacing or moving the
        // buffer without putting what was in it somewhere first.
        if filename != currentFilename { flush(trigger: .noteSwitched) }

        // Recorded here rather than in `open` so the history can only ever contain notes that really
        // opened — a filename that turned out to be missing never reaches this line, which is what
        // keeps Back from walking onto a note that has since been deleted.
        if recordingHistory { recordVisit(filename) }
        // Opening a real note ends any draft. The draft's own text, if it had any, was written by
        // the `flush(trigger: .noteSwitched)` every caller of `open` runs first.
        isDraft = false
        currentFilename = filename
        bufferText = text
        baselineHash = hash
        // Arriving at a note settles its name unless this pane just made it. "The note has not been
        // left" is the rule, and a note switch is leaving it (decision 103).
        unsettledName = (filename == pendingCreatedName) ? filename : nil
        pendingCreatedName = nil

        state.update { $0.recordOpen(filename, at: Date()) }
        var pane = paneState
        pane.noteFilename = filename
        paneState = pane

        let noteState = state.value.note(filename)
        panel.applyCollectionBehaviour(pinned: noteState.isPinned)

        editor.call("loadNote", [filename, text, noteState.caretOffset, noteState.isPinned])
        hideBanner()
        if isVisible { editor.focusEditor() }

        // Decision 105b, on load as well as on a vault change: a losing version can have been filed
        // days ago, while this note was not open, and nothing would ever have surfaced it. After
        // `hideBanner`, because finding one raises the banner.
        harvestConflicts(of: filename)
    }

    /// ⌘N, and the switcher's "no results — ⏎ makes one titled with what you typed".
    ///
    /// With a title the note is real immediately: the user has already said what it is called, so
    /// there is nothing to wait for. Without one — which is every ⌘N — the pane takes a draft and
    /// the file appears at the first write. See `isDraft`.
    func createNote(title: String) {
        flush(trigger: .noteSwitched)
        guard title.isEmpty else {
            createNote(text: title + "\n")
            return
        }
        beginDraft()
    }

    /// An empty pane pointing at nothing, ready to be typed into.
    private func beginDraft() {
        currentFilename = nil
        bufferText = ""
        baselineHash = nil
        isDraft = true

        var pane = paneState
        pane.noteFilename = nil
        paneState = pane

        // Empty filename rather than a made-up one: the web layer reads it as "no note", so ⌃X and
        // the pin decline rather than acting on a file that does not exist.
        editor.call("loadNote", ["", "", 0, false])
        hideBanner()
        if isVisible { editor.focusEditor() }
    }

    /// Creates a note that already has its text — a duplicate, or a switcher query.
    private func createNote(text: String) {
        vault.create(text: text) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let created):
                self.currentFilename = nil        // force `open` past its no-op guard
                // A note made from a switcher query is named from the query, and the user carries on
                // typing the first line — so its name is as unsettled as a draft's (decision 103).
                self.pendingCreatedName = created.filename
                self.open(created.filename)
            case .failure(let error):
                self.showBanner(.problem("Could not create a note: \(error.localizedDescription)"))
                self.checkVaultStillThere()
            }
        }
    }

    /// Turns a draft into a real note, naming it from what has been typed.
    ///
    /// An empty draft is deliberately not written: a note you asked for and did not write in should
    /// leave nothing behind rather than a zero-length file whose name is frozen forever. Whitespace
    /// counts as empty for the same reason — a stray Return is not a note.
    private func materialiseDraft() {
        let text = bufferText
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard !isMaterialising else { return }
        isMaterialising = true

        vault.create(text: text) { [weak self] result in
            guard let self else { return }
            self.isMaterialising = false
            switch result {
            case .success(let created):
                // A note may have been opened while the create was in flight, which makes this
                // draft somebody else's problem — it is already on disk and no longer on screen.
                guard self.isDraft else { return }
                self.isDraft = false
                self.adoptDraft(filename: created.filename, hash: created.hash)
            case .failure(let error):
                self.showBanner(.problem("Could not create a note: \(error.localizedDescription)"))
                self.checkVaultStillThere()
            }
        }
    }

    /// Points the pane at the file a draft just became, **without reloading it**.
    ///
    /// Deliberately not `adopt`: the buffer is already on screen and the user is typing in it, so
    /// sending `loadNote` would replace the document under their hands and move the caret. All that
    /// changes here is which file the buffer belongs to.
    private func adoptDraft(filename: String, hash: String) {
        recordVisit(filename)
        currentFilename = filename
        baselineHash = hash
        // Decision 103. This is the exact case the decision exists for: the file has just appeared
        // under whatever the first line said at the 500 ms pause, which is very often half a title.
        unsettledName = filename

        state.update {
            $0.recordOpen(filename, at: Date())
            // Seeded from the caret the editor last reported, because a draft has no filename to
            // record one under: `.edited` keys `recordCaret` on `currentFilename`, which is nil for
            // the whole of a draft's life. Without this the entry starts at 0, and a reload arriving
            // before the next keystroke — an external write, an eviction — puts the caret at the top
            // of the note. What is typed next then goes into the **title**, which decision 103 uses
            // to rename the file.
            $0.recordCaret(filename, offset: lastReportedCaret)
        }
        var pane = paneState
        pane.noteFilename = filename
        paneState = pane

        editor.call("setNoteFilename", [filename])
        onPinsChanged?()
        refreshSwitcherIfOpen()

        // Typing carried on while the create was in flight, so what is on disk is already behind.
        if bufferHash != baselineHash { scheduleWrite() }
    }

    /// ⌘D. Raycast's key, carried across for the reason decision 39 gives.
    ///
    /// The buffer comes from the web layer rather than being re-read from disk, so a duplicate taken
    /// mid-sentence contains the sentence — the same argument Copy as Markdown makes against the
    /// 500 ms write debounce. The original is flushed first so both copies exist in full.
    private func duplicate(text: String) {
        flush(trigger: .noteSwitched)
        vault.create(text: text) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let created):
                self.currentFilename = nil        // force `open` past its no-op guard
                // A copy is named after the note it came from, and retitling the copy is most of
                // why anyone makes one — so its name follows too, until the copy is left
                // (decision 103). Without this a duplicate keeps the original's slug for life.
                self.pendingCreatedName = created.filename
                self.open(created.filename)
                // Decision 50's rule, which had only ever been applied to ⌃X: an action with a
                // consequence that says nothing reads as "nothing happened". ⌘D is the worst case
                // for it — the copy opens looking exactly like the note you were just in, so
                // without this the only evidence anything happened is a filename you cannot see.
                //
                // One word, because that is the whole of what needs saying (decision 76).
                self.editor.call("showToast", ["Duplicated"])
            case .failure(let error):
                self.showBanner(.problem("Could not duplicate the note: \(error.localizedDescription)"))
                self.checkVaultStillThere()
            }
        }
    }

    func togglePin(_ filename: String?) {
        guard let filename = filename ?? currentFilename else { return }
        var pinned = false
        state.update { pinned = $0.togglePin(filename) }

        if filename == currentFilename {
            editor.call("setPinned", [pinned])
            panel.applyCollectionBehaviour(pinned: pinned)
        }
        onPinsChanged?()
        refreshSwitcherIfOpen()
    }

    private func delete(_ filename: String) {
        // Write what is on screen before moving the file — decision 10's immediate-flush list had
        // dismiss, blur and quit on it and not this, which made ⌃X the one action that could lose
        // typing. Measured: type a sentence, press ⌃X inside the 500 ms debounce, and the copy that
        // lands in Recently Deleted is the *previous* text — for a note created moments ago, a
        // zero-length file. Decision 35 made deleting recoverable and this made it recover the wrong
        // thing, which is worse than not being recoverable at all.
        //
        // Ordering is what makes this safe rather than a race: all vault I/O is one serial queue, so
        // the write enqueued here runs to completion before the move enqueued below starts. The
        // retry flag is cleared for the same reason — a write that lands *after* the move would put
        // the note back in the vault, which is the same bug wearing the opposite mask.
        if filename == currentFilename {
            flush(trigger: .noteSwitched)
            writeRequestedWhileWriting = false
        }

        vault.delete(filename) { [weak self] ok in
            guard let self, ok else { return }
            self.state.update { $0.notes.removeValue(forKey: filename) }
            self.onPinsChanged?()

            // Deleting was silent, which reads as "nothing happened" for the one action where you
            // most want to know that it did — and where the next thought is "can I get it back?".
            // So the message names the place rather than just confirming: ⌃X is one keystroke away
            // from ⌘X, and the answer to hitting it by accident should be on screen, not in the
            // documentation. Floating, so it costs no height (see `.pane__toast`).
            self.editor.call("showToast", ["Moved to Recently Deleted"])

            if filename == self.currentFilename {
                self.currentFilename = nil
                self.baselineHash = nil
                self.bufferText = ""
                self.openLastUsedNote()
            }
            self.refreshSwitcherIfOpen()
        }
    }

    // MARK: - Writing

    /// Decision 10: 500 ms after typing stops, and immediately on dismiss, blur, quit and note
    /// switch.
    private func scheduleWrite() {
        writeTimer?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.flush(trigger: .typingStopped) }
        }
        writeTimer = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + WritePolicy.delay(for: .typingStopped),
            execute: work
        )
    }

    func flush(trigger: WritePolicy.Trigger) {
        writeTimer?.cancel()
        writeTimer = nil

        // A draft has no file to write to yet, so the write *is* the creation (see `isDraft`).
        // Every trigger reaches here — typing stopped, dismiss, blur, quit, note switch — which is
        // what makes "the file appears at the first write" true rather than aspirational.
        if isDraft {
            materialiseDraft()
            return
        }

        guard let filename = currentFilename else { return }
        guard bufferHash != baselineHash else { return }

        // One write in flight at a time. A second request while the first is coordinating would race
        // the baseline update and could produce a conflict sibling out of our own two writes.
        guard !isWriting else {
            writeRequestedWhileWriting = true
            return
        }
        isWriting = true

        let text = bufferText
        vault.write(text: text, to: filename, expectedHash: baselineHash) { [weak self] result in
            guard let self else { return }
            self.isWriting = false
            var didWrite = false

            switch result {
            case .written(let hash):
                if filename == self.currentFilename { self.baselineHash = hash }
                didWrite = true

            case .conflicted(let sibling, let hash):
                // Decision 8. The original keeps the other machine's version; our text is now in the
                // sibling, so the pane follows its own words there rather than sitting on a file it
                // is no longer allowed to write. Nothing is lost and nothing goes read-only.
                if filename == self.currentFilename {
                    self.currentFilename = sibling
                    self.baselineHash = hash
                    self.state.update { s in
                        var moved = s.note(filename)
                        moved.lastOpened = Date()
                        s.notes[sibling] = moved
                    }
                    var pane = self.paneState
                    pane.noteFilename = sibling
                    self.paneState = pane

                    // And tell the web layer, which otherwise goes on holding the *original*
                    // filename — `loadNote` is the only thing that sets it and this path
                    // deliberately does not reload (the buffer is already correct and reloading
                    // would move the caret). The two layers then disagree about which file is open,
                    // and every message that names a file is wrong: ⌃X would delete the original,
                    // the one now holding the other machine's version, and ⇧⌘P would pin it.
                    self.editor.call("setNoteFilename", [sibling])
                    self.showBanner(.conflict)
                }

            case .failed(let message):
                self.showBanner(.problem("Could not save: \(message)"))
                self.checkVaultStillThere()
            }

            if self.writeRequestedWhileWriting {
                self.writeRequestedWhileWriting = false
                self.flush(trigger: trigger)
            } else if didWrite {
                // Decision 103, and deliberately here rather than in the `.written` case above: the
                // bytes have to be on disk under the old name before anything moves, **and** no
                // further write may be pending. A write requested during this one is enqueued for
                // the *old* filename, and the vault queue is serial — so renaming first would put
                // that write behind the move, where `VaultIO.write`'s `case .missing: break`
                // recreates the old name. That is the very duplicate this decision came to fix,
                // arriving by a different door.
                self.considerRename()
            }
        }
    }

    // MARK: - The filename follows the title (decision 103)

    /// Asks whether this note's name should move, and moves it if so.
    ///
    /// Piggybacks the 500 ms write debounce rather than running a timer of its own: the question
    /// "has the title changed" only has a new answer when the text has changed, which is exactly
    /// when a write happens.
    private func considerRename() {
        guard let filename = currentFilename, unsettledName == filename, !isWriting else { return }

        let text = bufferText
        holdingTheWriteGate { done in
            vault.renameFollowingTitle(
                filename, title: MarkdownDocument.title(of: text), text: text
            ) { [weak self] result in
                defer { done() }
                guard let self, case .renamed(let newName) = result else { return }
                // The pane may have moved on while the move was on the queue.
                guard self.currentFilename == filename else { return }
                self.repoint(from: filename, to: newName)
                // Still unsettled: the title can go on changing, and so can the name.
                self.unsettledName = newName
            }
        }
    }

    /// Runs a file move under the same gate a write runs under.
    ///
    /// `isWriting` is not really "a write is in flight" — it is "nothing else may write to this
    /// note's name right now", and a rename needs exactly that. Without it a `scheduleWrite` timer
    /// firing mid-move enqueues a write for the *old* filename behind the move on the serial vault
    /// queue, and `VaultIO.write` recreates a note it finds missing. Anything deferred this way is
    /// flushed once the name has settled, so nothing is dropped — only delayed by one hop.
    private func holdingTheWriteGate(_ body: (@escaping @MainActor () -> Void) -> Void) {
        isWriting = true
        body { [weak self] in
            guard let self else { return }
            self.isWriting = false
            if self.writeRequestedWhileWriting {
                self.writeRequestedWhileWriting = false
                self.flush(trigger: .typingStopped)
            }
        }
    }

    /// Points everything that knows this note by name at its new one.
    ///
    /// **This is decision 74's list**, and it has now been got wrong twice — Move Notes wrote to the
    /// old folder, and after a conflict the editor did not know which file it was in, so ⌃X would
    /// have deleted the original. One function so there is one list: the pane's own pointer, the
    /// state entry carrying the caret, the pin and `lastOpened`, the pane record, the visit history,
    /// the web layer's copy of the name, the menu bar's pins, and an open switcher.
    ///
    /// `baselineHash` is deliberately untouched: a rename moves the same bytes, so what is on disk
    /// still matches what we last wrote. `NoteIndex` moves inside `VaultService.rename`, on the
    /// queue that owns it.
    private func repoint(from old: String, to new: String) {
        currentFilename = new

        state.update { s in
            if let moved = s.notes.removeValue(forKey: old) { s.notes[new] = moved }
        }

        var pane = paneState
        pane.noteFilename = new
        paneState = pane

        // Back and Forward hold filenames, so an un-rewritten entry is a ⌘[ onto a file that no
        // longer exists — which `open` would then treat as a missing note and drop from state.
        for index in history.indices where history[index] == old { history[index] = new }

        // The web layer is told for the same reason the conflict path tells it: `loadNote` is the
        // only other thing that sets this, and this path must not reload (it would move the caret).
        editor.call("setNoteFilename", [new])
        onPinsChanged?()
        refreshSwitcherIfOpen()
    }

    /// ⌘K's "Rename File…" — the escape hatch for a title improved an hour later.
    ///
    /// Only the slug is editable. The timestamp is the creation time and decision 2's real content,
    /// so it is shown and not offered; a rename that could rewrite it would be a different feature.
    private func renameFileByHand() {
        guard let filename = currentFilename else { return }

        let stem = (filename as NSString).deletingPathExtension
        let chars = Array(stem)
        let hasTimestamp = NoteFilename.creationDate(from: filename) != nil
        let prefix = hasTimestamp ? String(chars.prefix(NoteFilename.timestampWidth + 1)) : ""
        let editable = String(stem.dropFirst(prefix.count))

        // A dialog you have to type into has to be reachable, and Pane never activates on its own —
        // so this joins Settings and the vault chooser as a place where it does. `steppingAside` is
        // decision 91: the pane floats above everything, including this, until it is told not to.
        NSApp.activate(ignoringOtherApps: true)

        let alert = NSAlert()
        alert.messageText = "Rename File"
        // The frozen half, shown so it is clear what is not on offer.
        alert.informativeText = hasTimestamp
            ? "\(prefix)…\u{2009}.\(NoteFilename.fileExtension)"
            : filename
        alert.addButton(withTitle: "Rename")
        alert.addButton(withTitle: "Cancel")

        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 22))
        field.stringValue = editable
        alert.accessoryView = field
        alert.window.initialFirstResponder = field

        guard PanePanel.steppingAside({ alert.runModal() }) == .alertFirstButtonReturn else { return }

        let typed = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        // An empty field is a slip, not a request for a note called `untitled` — and unlike the
        // automatic rename this one cannot be undone by typing the next character.
        guard !typed.isEmpty else { return }
        // Through `slug` rather than taken literally: what the user types is a title, and the same
        // rules that make a filename out of a first line make one out of this.
        let slug = NoteFilename.slug(from: typed)
        let newName = NoteFilename.unique(
            stem: prefix + slug,
            existing: [] // uniquing against the vault happens in `VaultService.rename`, which refuses
                         // an existing destination — asking twice would race the answer anyway.
        )
        guard newName != filename else { return }

        // Decision 56: flush before the file moves. The same rule ⌃X and every vault re-point follow,
        // and the one this path can actually break — there may be up to 500 ms of typing outstanding.
        flush(trigger: .noteSwitched)
        let text = bufferText
        holdingTheWriteGate { done in
            vault.rename(filename, to: newName, text: text) { [weak self] result in
                defer { done() }
                guard let self else { return }
                switch result {
                case .renamed(let moved):
                    guard self.currentFilename == filename else { return }
                    self.repoint(from: filename, to: moved)
                    // The user has chosen a name. Nothing may move it again.
                    self.unsettledName = nil
                case .declined:
                    self.showBanner(.problem("A note is already called that."))
                case .failed(let message):
                    self.showBanner(.problem("Could not rename: \(message)"))
                }
            }
        }
    }

    // MARK: - External changes

    /// Reacts to the vault changing underneath us. Called on the main thread by the watcher.
    func vaultChanged(filenames: [String]) {
        refreshSwitcherIfOpen()

        guard let current = currentFilename else { return }
        guard filenames.contains(current) else {
            // The burst does not name the open note, so nothing here is about it — unless the note
            // is gone from the vault entirely, which is what a rename in Finder looks like from
            // here. Decision 103's external-rename half.
            followExternalRename(of: current, within: filenames) {}
            return
        }

        vault.diskState(current) { [weak self] disk in
            guard let self, current == self.currentFilename else { return }

            let diskHash: String
            switch disk {
            case .unreadable:
                return

            case .missing:
                // A rename usually names *both* paths in one burst, so this is where following one
                // most often starts — the old name is in `filenames` and gone from disk.
                self.followExternalRename(of: current, within: filenames) { [weak self] in
                    guard let self else { return }
                    // Genuinely gone. The state entry deliberately stays: `VaultIO.write` recreates a
                    // note deleted elsewhere rather than dropping what is in the buffer, and throwing
                    // the caret and the pin away here would strand a note that is about to come back.
                    self.checkVaultStillThere()
                }
                return

            case .evicted:
                // Decision 105a. The open note has been dataless-ed under us — "Optimize Mac Storage"
                // reclaiming it, or a remote update arriving as a placeholder. Before this the pane
                // showed stale text with no banner: "downloading…" only ever fired on `open`.
                self.reloadEvictedNote(current)
                return

            case .available(let hash):
                diskHash = hash
            }

            // Decision 105b. iCloud files a losing version rather than telling anyone, and it can
            // arrive long after the edit that caused it — which is why this is here as well as on
            // load, and why Pane's own hash conflict does not cover it.
            self.harvestConflicts(of: current)

            switch VaultSync.react(
                diskHash: diskHash,
                baselineHash: self.baselineHash,
                bufferHash: self.bufferHash
            ) {
            case .ignoreEcho, .noChange:
                break

            case .adoptBaseline:
                self.baselineHash = diskHash
                // Somebody else's write, byte-identical to our buffer but not to our baseline. It is
                // still somebody else: decision 103 freezes the name (another tool knows this file
                // by path now, and renaming under it is decision 74's trap one process further out).
                self.freezeNameOnExternalWrite(current)

            case .reload:
                self.freezeNameOnExternalWrite(current)
                self.vault.load(current) { [weak self] result in
                    guard let self, case .loaded(let text, let hash) = result else { return }
                    guard current == self.currentFilename else { return }
                    self.bufferText = text
                    self.baselineHash = hash
                    let noteState = self.state.value.note(current)
                    self.editor.call(
                        "loadNote",
                        [current, text, min(noteState.caretOffset, text.utf16.count), noteState.isPinned]
                    )
                }

            case .writeConflictSibling:
                self.freezeNameOnExternalWrite(current)
                // Push our version out now; `VaultIO.write` sees the mismatch and makes the sibling.
                self.flush(trigger: .reloadPending)
            }
        }
    }

    /// Decision 103's freeze list: an external write ends the name's freedom to move.
    private func freezeNameOnExternalWrite(_ filename: String) {
        guard unsettledName == filename else { return }
        unsettledName = nil
    }

    /// Decision 105a: the open note was evicted, so fetch it back and adopt it.
    ///
    /// Routed into the paths `open()` already has rather than new ones — the same
    /// `.downloading` banner, the same `vault.download`, the same `adopt`.
    private func reloadEvictedNote(_ filename: String) {
        // Unsaved edits over bytes we have never seen is decision 8's case exactly, and the answer is
        // already written: flush, and `VaultIO.write` sees `.evicted` and makes the conflict sibling
        // rather than destroying content that only exists on another machine. Downloading here would
        // replace the buffer with the remote text and take the unsaved edits with it.
        guard bufferHash == baselineHash else {
            flush(trigger: .reloadPending)
            return
        }

        // FSEvents bursts arrive in twos and threes; without this the pane starts a second download
        // on top of the first and the banner flickers between them.
        guard !isDownloadingCurrent else { return }
        isDownloadingCurrent = true

        freezeNameOnExternalWrite(filename)
        showBanner(.downloading)
        vault.download(filename) { [weak self] result in
            guard let self else { return }
            self.isDownloadingCurrent = false
            guard filename == self.currentFilename else { return }
            if case .loaded(let text, let hash) = result {
                self.adopt(filename: filename, text: text, hash: hash, recordingHistory: false)
            } else {
                self.showBanner(.problem("Could not download \(filename) from iCloud."))
            }
        }
    }

    /// Decision 105b: writes out iCloud's own losing versions as ordinary siblings.
    ///
    /// The banner is the one decision 8 already ships, and the loser is a normal note in a flat
    /// vault — so this adds no UI at all. Silent when there is nothing, which is nearly always.
    private func harvestConflicts(of filename: String) {
        vault.harvestConflicts(filename) { [weak self] written in
            guard let self, !written.isEmpty else { return }
            self.showBanner(.conflict)
            self.refreshSwitcherIfOpen()
        }
    }

    /// Follows the open note when something outside Pane renamed its file.
    ///
    /// Today this **silently duplicates the note**: `vaultChanged` only reacts when the burst names
    /// the current filename, so a rename was ignored; the pane went on pointing at the dead name;
    /// and `VaultIO.write` takes `case .missing: break` — "recreating a note deleted elsewhere is
    /// fine" — and writes the old name back. You end up with both files, and `state.json` keeps the
    /// caret and the pin on the dead one.
    ///
    /// The fix is the move decision 25 already makes for a conflict sibling: the buffer follows its
    /// text. And then the name freezes, because the user has chosen one.
    private func followExternalRename(
        of filename: String,
        within burst: [String],
        otherwise: @escaping @MainActor () -> Void
    ) {
        guard let hash = baselineHash else {
            otherwise()
            return
        }

        vault.findRenamed(of: filename, among: burst, matching: hash) { [weak self] moved in
            guard let self, self.currentFilename == filename else { return }
            guard let moved else {
                otherwise()
                return
            }
            self.repoint(from: filename, to: moved)
            // The user has chosen a name (decision 103's freeze list).
            self.unsettledName = nil
        }
    }

    /// Decision 13: a vault that is simply gone must never be silently recreated.
    private func checkVaultStillThere() {
        var isDirectory: ObjCBool = false
        let vaultURL = settings.value.vaultURL
        let exists = FileManager.default.fileExists(atPath: vaultURL.path, isDirectory: &isDirectory)
        if !exists || !isDirectory.boolValue { onVaultMissing?() }
    }

    // MARK: - Switcher

    private func refreshSwitcherIfOpen() {
        guard switcherIsOpen else { return }
        sendRows(query: lastQuery)
    }

    private var lastQuery = ""

    private func sendRows(query: String) {
        lastQuery = query
        vault.rows(
            query: query,
            state: state.value,
            current: currentFilename,
            order: settings.value.noteOrder
        ) { [weak self] snapshot in
            guard let self else { return }
            self.editor.callJSON(
                "showNotes",
                [
                    EditorWebView.encode(snapshot.rows),
                    String(snapshot.total),
                    EditorWebView.encode(snapshot.query),
                ]
            )
        }
    }

    // MARK: - History

    /// Notes visited in this pane, oldest first; `historyIndex` points at the one on screen.
    ///
    /// ⌘[ and ⌘] are the reference's keys, verified on the running app — it carries the feature but
    /// exposes no ⌘K row for it, so Pane does the same and decision 17's panel stays at fourteen.
    ///
    /// In memory rather than in `state.json`: this describes one sitting with the app, and a Back
    /// that reaches across a relaunch into notes you have forgotten visiting is a worse answer than
    /// one that starts fresh. It is also the reason there is no schema change here.
    private var history: [String] = []
    private var historyIndex = -1

    /// Long enough that Back never runs out in a real session, short enough to stay a rounding error
    /// in a process that runs for weeks.
    private static let historyLimit = 50

    private func recordVisit(_ filename: String) {
        // Opening something new from the middle of the history discards what was ahead, exactly as a
        // browser does: those entries describe a future that has now not happened.
        if historyIndex >= 0, historyIndex < history.count - 1 {
            history.removeSubrange((historyIndex + 1)...)
        }
        guard history.last != filename else { return }
        history.append(filename)
        if history.count > Self.historyLimit { history.removeFirst(history.count - Self.historyLimit) }
        historyIndex = history.count - 1
    }

    func goBack() {
        guard historyIndex > 0 else { return }
        historyIndex -= 1
        open(history[historyIndex], recordingHistory: false)
    }

    func goForward() {
        guard historyIndex >= 0, historyIndex < history.count - 1 else { return }
        historyIndex += 1
        open(history[historyIndex], recordingHistory: false)
    }

    func openSwitcher() {
        if !isVisible { summon() }
        editor.call("openSwitcher")
    }

    func openActions() {
        if !isVisible { summon() }
        editor.call("openActions")
    }

    // MARK: - Banner

    private func showBanner(_ banner: Banner) {
        editor.call("showBanner", [banner.kind, banner.text])
    }

    private func hideBanner() {
        editor.call("hideBanner")
    }

    // MARK: - Geometry

    /// The height the pane should be right now.
    ///
    /// With auto-sizing on that is the note's height; with it off it is the height the user dragged
    /// to, and the note scrolls (decision 40). **An open overlay overrides both**, because the
    /// switcher and ⌘K are drawn inside this window and a panel clipped by its own pane is not a
    /// size anyone asked for. Closing the overlay returns to whichever answer the mode gives.
    private var heightWanted: CGFloat {
        var wanted = paneState.autoSizing
            ? lastContentHeight
            : CGFloat(paneState.manualHeight ?? Double(lastContentHeight))
        if switcherIsOpen { wanted = max(wanted, switcherPaneHeight) }
        if actionsIsOpen { wanted = max(wanted, actionsPaneHeight) }
        return wanted
    }

    private func applyContentHeight(_ desired: CGFloat) {
        // Only while on screen. Offscreen the panel's frame is 30,000 points below every display, so
        // `grown` would measure it against a screen it is nowhere near and clamp every note to the
        // 120 pt minimum. The height is reconciled on the next summon instead.
        guard panel.isSummoned else { return }

        // Never while the user is dragging the resize handle. Auto-sizing and a live drag are two
        // things setting the same frame: the drag resizes the window, the web layer's ResizeObserver
        // reports a new content height, this sets the frame back, the observer fires again. The pane
        // flickers between the two answers for as long as the mouse is down. The drag's own height
        // is taken in `windowDidEndLiveResize`, so nothing is lost by staying out of the way.
        guard !panel.inLiveResize else { return }
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let current = panel.rememberedFrame ?? panel.frame

        let growth = PanelGeometry.grown(
            from: current,
            toContentHeight: desired,
            visibleFrame: screen.visibleFrame
        )
        guard abs(growth.frame.height - current.height) >= 1 else { return }
        panel.applyHeight(growth.frame)
    }

    // MARK: - Settings

    func applySettings() {
        editor.isTranslucent = settings.value.translucentPanes
        panel.showsOnEverySpace = settings.value.showOnEverySpace
        applyHiddenFromCapture()
        // Not a setting — pane state — but this runs on `ready`, which is the one moment the web
        // layer needs telling. Its ⌘K label is otherwise wrong until the row is pressed once.
        editor.call("setAutoSizing", [paneState.autoSizing])
        editor.call("setOnEverySpace", [settings.value.showOnEverySpace])

        // The material picks its light or dark variant from the window's appearance, so the two have
        // to be told the same thing — otherwise a dark-mode pane gets a light blur behind dark text.
        panel.appearance = switch settings.value.appearance {
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        case .system: nil
        }

        editor.call(
            "applySettings",
            [[
                "appearance": settings.value.appearance.rawValue,
                "accent": settings.value.accent,
                "textSize": settings.value.textSize,
                "translucent": settings.value.translucentPanes,
                "shortcuts": settings.value.shortcuts,
                // Decision 19: a theme is a CSS file, so what crosses the bridge is the file's
                // contents. Read here rather than fetched by the web layer — the page is loaded from
                // a file URL with read access scoped to the bundle, and widening that scope to reach
                // Application Support would be a much bigger hole than passing a string.
                "themeCSS": loadThemeCSS(),
            ]]
        )

        // `settings.json` reloads live (decision 32), and the switcher is the one surface whose
        // *content* a setting changes. An open list would otherwise keep the old order until it was
        // closed and reopened, which reads as the setting not having taken.
        if switcherIsOpen { sendRows(query: lastQuery) }
    }

    // MARK: - Hide from Screen Capture

    /// Frame 2a's "Hide While Screen Sharing", decided by decision 36.
    ///
    /// The design's label implies detection: notice a screen-sharing session, hide until it ends.
    /// `NSWindow.sharingType = .none` is better than that and simpler — the window is excluded from
    /// capture at the window-server level, so there is no session to detect, no race between the
    /// share starting and the pane reacting, and no Screen Recording permission, which decision 9
    /// would otherwise have made this row impossible to build at all.
    private func applyHiddenFromCapture() {
        let hidden = settings.value.hideFromScreenCapture
        panel.sharingType = hidden ? .none : .readOnly
        editor.call("setHiddenFromCapture", [hidden])
    }

    private func setHiddenFromCapture(_ hidden: Bool) {
        settings.update { $0.hideFromScreenCapture = hidden }
        // `settings.update` comes back through `applySettings`, but not synchronously, and the ⌘K
        // row's label is read the moment the panel next opens.
        applyHiddenFromCapture()

        // The one setting in Pane whose effect is invisible *by definition* — it changes what other
        // processes can see, so pressing ⇧⌘H changed nothing at all on screen and the only way to
        // find out whether it had worked was to take a screenshot. Same toast as ⌃X's, decision 50.
        editor.call(
            "showToast",
            [hidden ? "Hidden from screen capture" : "Visible in screen capture"]
        )
    }

    // MARK: - Export

    /// Frame 2a's Export…, and the one row whose meaning had to be decided rather than implemented
    /// (decision 37). The note is already a file the user owns, and Reveal in Finder already reaches
    /// it, so "export the markdown" would be a save panel wrapped around a copy they could make in
    /// the Finder. What they cannot get anywhere else is the *rendered* note.
    private func exportNote(text: String) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.html]
        panel.nameFieldStringValue = MarkdownDocument.title(of: text).isEmpty
            ? "Note.html"
            : "\(MarkdownDocument.title(of: text)).html"
        panel.canCreateDirectories = true
        panel.title = "Export Note"

        // The one place other than "choose vault" (decision 27) where Pane activates on purpose:
        // a save panel behind every other window is a hang as far as the user is concerned. And
        // activating is not enough on its own — the pane is `.floating`, so the panel came up behind
        // it with the Save button under its edge until `stepAside` (see `PanePanel`).
        PanePanel.stepAside()
        NSApp.activate(ignoringOtherApps: true)

        panel.begin { [weak self] response in
            PanePanel.resumeFloating()
            guard response == .OK, let url = panel.url, let self else { return }
            let html = MarkdownExport.html(
                from: text,
                title: MarkdownDocument.title(of: text),
                accent: self.settings.value.accent
            )
            try? html.data(using: .utf8)?.write(to: url, options: .atomic)
        }
    }

    /// The selected theme's stylesheet, or empty for Pane's own.
    ///
    /// Failure is silent and falls back to the default: a theme is a file the user dropped in a
    /// folder, so a malformed or deleted one is an ordinary Tuesday, not an error worth a banner.
    private func loadThemeCSS() -> String {
        let name = settings.value.markdownTheme
        guard !name.isEmpty else { return "" }
        let url = settings.themesFolder.appendingPathComponent(name)
        return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    }
}

// MARK: - Web layer

extension PaneController: EditorWebViewDelegate {

    func editor(_ editor: EditorWebView, didReceive message: PaneMessage) {
        switch message {
        case .ready:
            editor.markReady()
            applySettings()
            if currentFilename == nil, !isDraft { openLastUsedNote() }

        case .edited(let text, let caret):
            bufferText = text
            lastReportedCaret = caret
            if let filename = currentFilename {
                state.update { $0.recordCaret(filename, offset: caret) }
                vault.noteBufferChanged(filename: filename, text: text)
            }
            scheduleWrite()

        case .caret(let caret, let scrollLine):
            lastReportedCaret = caret
            guard let filename = currentFilename else { return }
            state.update { $0.recordCaret(filename, offset: caret, scrollLine: scrollLine) }

        case .requestNotes(let query):
            sendRows(query: query)

        case .openNote(let filename):
            open(filename)

        case .createNote(let title):
            createNote(title: title)

        case .togglePin(let filename):
            togglePin(filename)

        case .deleteNote(let filename):
            delete(filename)

        case .close:
            dismiss()

        // All three of these go through `heightWanted` rather than working out a height themselves.
        // Doing the arithmetic here was how closing an overlay came to ignore the mode: it handed
        // back the *note's* height, so a pane the user had dragged small stayed at panel height once
        // the note was taller than the drag — and, worse, typing resized a pane whose whole point
        // was that it had stopped resizing.
        case .contentHeight(let height):
            lastContentHeight = height
            applyContentHeight(heightWanted)

        case .switcherOpen(let open, let height):
            switcherIsOpen = open
            // Zero on open, because the rows are a round trip away and there is nothing to measure
            // yet; the first render sends the real one. Holding the previous value until then keeps
            // a re-opened switcher from collapsing the pane for a frame.
            if !open {
                switcherPaneHeight = 0
            } else if height > 0 {
                switcherPaneHeight = PanelGeometry.paneHeight(forOverlay: height)
            }
            applyContentHeight(heightWanted)

        case .actionsOpen(let open, let height):
            actionsIsOpen = open
            // Its height is measured rather than assumed, because filtering changes it. What the
            // pane grows to is not that plus two literals — see `paneHeight(forOverlay:)`, which
            // grows to a height the placement rule in overlay.ts is happy with.
            actionsPaneHeight = open ? PanelGeometry.paneHeight(forOverlay: height) : 0
            applyContentHeight(heightWanted)

        case .renameFile:
            renameFileByHand()

        case .revealInFinder:
            guard let filename = currentFilename else { return }
            NSWorkspace.shared.activateFileViewerSelecting(
                [settings.value.vaultURL.appendingPathComponent(filename)]
            )

        case .openSettings:
            onOpenSettings?()

        case .copyAsMarkdown(let text):
            // The markdown *is* the note (decision 5), so there is nothing to convert — which is the
            // whole reason frame 2a has this row where Raycast has "copy deeplink".
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)

        case .exportNote(let text):
            exportNote(text: text)

        case .toggleHideFromCapture:
            setHiddenFromCapture(!settings.value.hideFromScreenCapture)

        case .toggleAutoSizing:
            toggleAutoSizing()

        case .toggleSpaceBehaviour:
            let now = !settings.value.showOnEverySpace
            settings.update { $0.showOnEverySpace = now }
            // Decision 73's rule, reached by a second route: what this changes is invisible until
            // you switch Space, so without a line the key reads as having done nothing at all.
            editor.call("showToast", [now ? "Showing on every Space" : "Keeping to this Space"])

        case .duplicateNote(let text):
            duplicate(text: text)

        case .requestDeleted:
            vault.deletedRows { [weak self] rows in
                self?.editor.callJSON("showDeleted", [EditorWebView.encode(rows)])
            }

        case .restoreDeleted(let storedName):
            vault.restoreDeleted(storedName) { [weak self] restored in
                guard let self, let restored else { return }
                // Opening it is the point. A restore that puts the note back but leaves you looking
                // at a different one makes you go and find it again.
                self.open(restored)
            }

        case .navigate(let back):
            back ? goBack() : goForward()

        case .textSize(let action):
            // Clamped to the same bounds `Settings` enforces on a hand-edited file, so the keyboard
            // and the file cannot disagree about what is a legal size. Writing it through
            // `settings.update` is what persists it and pushes it back down via `applySettings`.
            settings.update {
                switch action {
                case "in": $0.textSize = min($0.textSize + 1, Settings.textSizeRange.upperBound)
                case "out": $0.textSize = max($0.textSize - 1, Settings.textSizeRange.lowerBound)
                default: $0.textSize = Settings().textSize
                }
            }

        case .forgetDeleted(let storedName):
            vault.forgetDeleted(storedName) { [weak self] ok in
                guard let self, ok else { return }
                // The list stays open — purging is a tidying pass, and closing the panel after each
                // one would make clearing several a chore. Re-fetch rather than removing the row in
                // the web layer, so what is on screen is the folder rather than our idea of it.
                self.vault.deletedRows { [weak self] rows in
                    self?.editor.callJSON("showDeleted", [EditorWebView.encode(rows)])
                }
            }

        case .dragRegions(let titleBar, let exclusions, let close):
            editor.setDragRegions(titleBar: titleBar, exclusions: exclusions, close: close)
            // The dot may have moved under a stationary pointer — the pin entering the bar, the
            // pane resizing. Same reason `summon` seeds hover rather than waiting for an event.
            refreshCloseHover()

        case .headingMenu(let button, let level):
            showHeadingMenu(below: button, current: level)
        }
    }

    /// The format bar's heading list, as a real menu hanging below the button.
    ///
    /// Native for two reasons the web layer cannot solve. It has to render *past the pane's bottom
    /// edge* — the format bar is the last row, and anything drawn in the web view is clipped to the
    /// window, which is why the DOM version had to open upward over the note. And it has to go away
    /// on its own: an outside click, Escape, the app deactivating, the pane being dismissed. AppKit
    /// owns all of that; hand-rolling it in the page means remembering every one of those cases.
    private func showHeadingMenu(below button: CGRect, current: Int?) {
        let menu = NSMenu()
        menu.autoenablesItems = false

        for level in 1...3 {
            let item = NSMenuItem(
                title: "Heading \(level)",
                action: #selector(chooseHeading(_:)),
                keyEquivalent: "\(level)"
            )
            item.keyEquivalentModifierMask = [.option, .command]
            item.target = self
            item.tag = level
            // A tick on the level the caret is already in, so the menu reports state as well as
            // offering actions.
            item.state = current == level ? .on : .off
            menu.addItem(item)
        }

        // CSS pixels, top-left origin, into the view's bottom-left coordinates. The anchor is the
        // button's bottom-left corner, so the menu drops from directly under it — and AppKit flips it
        // upward by itself when the pane is close enough to the bottom of the screen that it would
        // not fit.
        let anchor = CGPoint(x: button.minX, y: editor.bounds.height - button.maxY)
        menu.popUp(positioning: nil, at: anchor, in: editor)
    }

    @objc private func chooseHeading(_ sender: NSMenuItem) {
        editor.call("setHeadingLevel", [sender.tag])
        editor.focusEditor()
    }
}

// MARK: - Window

extension PaneController: NSWindowDelegate {

    /// A drag is what turns auto-sizing off — decision 40, and Raycast Notes' behaviour exactly.
    ///
    /// Only a *drag* reaches here: programmatic `setFrame` fires no live-resize notification. So
    /// this is unambiguously the user stating a height, and the only reading of that which is not a
    /// lie is "stop resizing my window". Under the old floor rule this method recorded the height
    /// and then immediately grew back past it on any note taller than the pane.
    ///
    /// An overlay is not a statement of intent: the switcher and ⌘K resize the pane themselves, and
    /// dragging while one is open would otherwise pin the pane at panel height forever.
    /// The pill goes away for the length of the drag and comes back at the new bottom edge.
    ///
    /// Leaving it up would pin it to where the pane's bottom *was*, so it would sit in the middle of
    /// the window being resized — and no mouse-moved events arrive during a drag to correct it,
    /// because the pointer is reported as dragging rather than moving.
    func windowWillStartLiveResize(_ notification: Notification) {
        autoSizeBadge.suppressDuringResize()
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        defer { refreshAutoSizeBadge() }
        guard !switcherIsOpen, !actionsIsOpen else { return }

        var pane = paneState
        pane.autoSizing = false
        pane.manualHeight = Double(panel.frame.height)
        paneState = pane
        rememberFrame()

        // The mode changed without anyone pressing the row, so the row's label is now a lie until
        // it is told. This is the only path that turns auto-sizing off silently, which is exactly
        // why it is the one that must announce it.
        editor.call("setAutoSizing", [false])
    }

    /// ⇧⌘/ — frame 2a's thirteenth row, and Raycast's key for it.
    ///
    /// Turning it back on drops the dragged height, so the pane immediately fits its note again;
    /// that snap is the feedback that the mode changed.
    func toggleAutoSizing() {
        var pane = paneState
        pane.autoSizing.toggle()
        pane.manualHeight = pane.autoSizing ? nil : Double(panel.frame.height)
        paneState = pane

        editor.call("setAutoSizing", [pane.autoSizing])
        applyContentHeight(heightWanted)
        rememberFrame()
    }

    var isAutoSizing: Bool { paneState.autoSizing }

    // MARK: - The auto-size pill

    /// Watches the pointer only while the pane is on screen.
    ///
    /// Two monitors because one is not enough: the global one sees events delivered to *other* apps,
    /// which is where the pointer is most of the time given Pane never activates (decision 9), and
    /// the local one sees events that land on the pane itself. Neither needs a permission — the
    /// accessibility gate is on keyboard taps, not mouse observation.
    private func startTrackingResizeEdge() {
        guard mouseMonitors.isEmpty else { return }
        let refresh: @Sendable (NSEvent) -> Void = { [weak self] _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.refreshAutoSizeBadge() } }
        }
        if let global = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved], handler: refresh) {
            mouseMonitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved], handler: { event in
            refresh(event)
            return event
        }) {
            mouseMonitors.append(local)
        }
    }

    private func stopTrackingResizeEdge() {
        for monitor in mouseMonitors { NSEvent.removeMonitor(monitor) }
        mouseMonitors.removeAll()
        autoSizeBadge.hide()
    }

    /// Hover state, decided in Swift rather than in the page.
    ///
    /// The web layer's own `mouseenter`/`mouseleave` only fired once the pane had been clicked: a
    /// WKWebView in a window that is not key gets no mouse events at all, so the chrome stayed dim
    /// no matter where the pointer went — in exactly the situation decision 41 exists for, which is
    /// the pane sitting over another app you are working in. These monitors already watch the
    /// pointer for the pill and do not care which app is active, so hover comes from the same place.
    private func refreshHover() {
        guard panel.isSummoned else { return }
        let inside = panel.frame.contains(NSEvent.mouseLocation)
        if inside != isHovered {
            isHovered = inside
            editor.call("setHover", [inside])
        }
        // Outside the guard on purpose: the pointer moving *within* an already-hovered pane is
        // precisely the movement that takes it onto the dot, and an early return here would mean the
        // dot only ever lit on the stroke that entered the window.
        refreshCloseHover()
    }

    /// Decision 107: the close dot lights when the pointer is on it.
    ///
    /// Same read as `refreshHover`, one control down. `:hover` cannot do this — measured on
    /// 2026-09-01: with the pane in its real configuration (an accessory app's non-activating panel,
    /// not key, another app frontmost) the page received **zero** `mousemove` events with the cursor
    /// parked on the dot, and `:hover` matched nothing. The same probe with an ordinary key, active
    /// window saw 22 moves and eight `:hover` matches, so that is the app's situation rather than
    /// the apparatus. It is decision 41's finding exactly, which is why the plumbing was already here.
    private func refreshCloseHover() {
        let inside = isHovered
            && panel.isSummoned
            && (editor.closeButtonScreenRect()?.contains(NSEvent.mouseLocation) ?? false)
        guard inside != isCloseHovered else { return }
        isCloseHovered = inside
        editor.call("setCloseHover", [inside])
    }

    private func refreshAutoSizeBadge() {
        refreshHover()
        guard panel.isSummoned else {
            autoSizeBadge.hide()
            return
        }
        // Never over an open overlay: the switcher and ⌘K own the pane's whole height while they are
        // up, so the pill would be captioning a panel rather than the note.
        let frame = panel.frame
        let near = !switcherIsOpen && !actionsIsOpen
            && AutoSizeBadge.isNearResizeEdge(NSEvent.mouseLocation, of: frame)
        autoSizeBadge.update(near: frame, autoSizing: paneState.autoSizing, visible: near)
    }

    /// Rule 3, "stay put": the drag is the only thing that moves a pane, so the drag is the only
    /// thing worth recording. Persisting here rather than only at dismiss means the position also
    /// survives a crash or a force-quit.
    func windowDidMove(_ notification: Notification) {
        guard panel.isSummoned else { return }
        rememberFrame()
    }

    func windowDidBecomeKey(_ notification: Notification) {
        editor.call("setFocused", [true])
    }

    func windowDidResignKey(_ notification: Notification) {
        editor.call("setFocused", [false])
        // Decision 10's second immediate flush. Clicking away from the pane is exactly the moment a
        // half-typed thought must already be on disk.
        flush(trigger: .lostFocus)
        state.save()
    }
}
