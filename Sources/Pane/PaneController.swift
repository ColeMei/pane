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
        case conflict(sibling: String)
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
            case .conflict(let sibling):
                return "This note changed elsewhere. Your version is in \(sibling)."
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

    // MARK: Layout

    private var lastContentHeight: CGFloat = PanePanel.defaultHeight
    private var switcherIsOpen = false
    private var actionsIsOpen = false
    private var actionsPaneHeight: CGFloat = 0

    /// Pane height while the switcher is open: it is absolutely positioned 54 px down and can be
    /// 430 px tall, so a pane sized to a three-line note has to grow to hold it. Recorded in the
    /// brief as a gap filled during the build.
    private static let switcherPaneHeight: CGFloat = 54 + 430 + 16

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
        panel.setFrameOrigin(CGPoint(x: -30_000, y: -30_000))
        panel.orderFront(nil)
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

    /// The hotkey. Rule 5: a pinned pane ignores the dismiss half of it.
    func toggle() {
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
        // The height the note wanted may have moved while the pane was away — an external edit, or a
        // note switched from the menu bar. Reconciling here rather than waiting for the web layer's
        // next report keeps the first frame the user sees the right size.
        applyContentHeight(heightWanted)

        editor.call("setFocused", [true])
        editor.focusEditor()

        if currentFilename == nil {
            openLastUsedNote()
        }
    }

    func dismiss() {
        flush(trigger: .dismissed)
        rememberFrame()
        panel.dismiss()
        editor.call("setFocused", [false])

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
        vault.rows(query: "", state: state.value, current: nil) { [weak self] snapshot in
            guard let self else { return }
            if let first = snapshot.rows.first {
                self.open(first.filename)
            } else {
                self.createNote(title: "")
            }
        }
    }

    func open(_ filename: String) {
        guard filename != currentFilename else {
            editor.focusEditor()
            return
        }
        flush(trigger: .noteSwitched)

        vault.load(filename) { [weak self] result in
            guard let self else { return }
            switch result {
            case .loaded(let text, let hash):
                self.adopt(filename: filename, text: text, hash: hash)

            case .downloading:
                // Decision 13: never read an evicted note on the main thread, and never pretend a
                // download is instant — it is 5–20 s even for a tiny file.
                self.showBanner(.downloading)
                self.vault.download(filename) { [weak self] downloaded in
                    guard let self else { return }
                    if case .loaded(let text, let hash) = downloaded {
                        self.adopt(filename: filename, text: text, hash: hash)
                    } else {
                        self.showBanner(.problem("Could not download \(filename) from iCloud."))
                    }
                }

            case .missing:
                self.state.update { $0.notes.removeValue(forKey: filename) }
                self.checkVaultStillThere()

            case .failed(let message):
                self.showBanner(.problem("Could not open \(filename): \(message)"))
            }
        }
    }

    private func adopt(filename: String, text: String, hash: String) {
        currentFilename = filename
        bufferText = text
        baselineHash = hash

        state.update { $0.recordOpen(filename, at: Date()) }
        var pane = paneState
        pane.noteFilename = filename
        paneState = pane

        let noteState = state.value.note(filename)
        panel.applyCollectionBehaviour(pinned: noteState.isPinned)

        editor.call("loadNote", [filename, text, noteState.caretOffset, noteState.isPinned])
        hideBanner()
        if isVisible { editor.focusEditor() }
    }

    func createNote(title: String) {
        flush(trigger: .noteSwitched)
        vault.create(title: title) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let filename):
                self.currentFilename = nil        // force `open` past its no-op guard
                self.open(filename)
            case .failure(let error):
                self.showBanner(.problem("Could not create a note: \(error.localizedDescription)"))
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
        vault.delete(filename) { [weak self] ok in
            guard let self, ok else { return }
            self.state.update { $0.notes.removeValue(forKey: filename) }
            self.onPinsChanged?()

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

            switch result {
            case .written(let hash):
                if filename == self.currentFilename { self.baselineHash = hash }

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
                    self.showBanner(.conflict(sibling: sibling))
                }

            case .failed(let message):
                self.showBanner(.problem("Could not save: \(message)"))
                self.checkVaultStillThere()
            }

            if self.writeRequestedWhileWriting {
                self.writeRequestedWhileWriting = false
                self.flush(trigger: trigger)
            }
        }
    }

    // MARK: - External changes

    /// Reacts to the vault changing underneath us. Called on the main thread by the watcher.
    func vaultChanged(filenames: [String]) {
        refreshSwitcherIfOpen()

        guard let current = currentFilename, filenames.contains(current) else { return }

        vault.diskHash(current) { [weak self] hash in
            guard let self, current == self.currentFilename else { return }
            guard let diskHash = hash else { return }   // gone or evicted — not our call to make here

            switch VaultSync.react(
                diskHash: diskHash,
                baselineHash: self.baselineHash,
                bufferHash: self.bufferHash
            ) {
            case .ignoreEcho, .noChange:
                break

            case .adoptBaseline:
                self.baselineHash = diskHash

            case .reload:
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
                // Push our version out now; `VaultIO.write` sees the mismatch and makes the sibling.
                self.flush(trigger: .reloadPending)
            }
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
        vault.rows(query: query, state: state.value, current: currentFilename) { [weak self] snapshot in
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

    func openSwitcher() {
        if !isVisible { summon() }
        editor.call("openSwitcher")
    }

    // MARK: - Banner

    private func showBanner(_ banner: Banner) {
        editor.call("showBanner", [banner.kind, banner.text])
    }

    private func hideBanner() {
        editor.call("hideBanner")
    }

    // MARK: - Geometry

    /// The height the pane should be right now: the note's, unless an overlay needs more room.
    private var heightWanted: CGFloat {
        var wanted = lastContentHeight
        if switcherIsOpen { wanted = max(wanted, Self.switcherPaneHeight) }
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
        // flickers between the two answers for as long as the mouse is down. The height the drag
        // lands on is recorded in `windowDidEndLiveResize` and becomes the floor (decision 29), so
        // nothing is lost by staying out of the way until then.
        guard !panel.inLiveResize else { return }
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let current = panel.rememberedFrame ?? panel.frame

        // A height the user dragged to is a floor, not a suggestion. Without this, rule 2 shrinks the
        // pane back to the note's own height on the very next keystroke and the resize handle does
        // nothing you can see.
        let floored = max(desired, paneState.manualHeight.map { CGFloat($0) } ?? 0)

        let growth = PanelGeometry.grown(
            from: current,
            toContentHeight: floored,
            visibleFrame: screen.visibleFrame
        )
        guard abs(growth.frame.height - current.height) >= 1 else { return }
        panel.applyHeight(growth.frame)
    }

    // MARK: - Settings

    func applySettings() {
        editor.isTranslucent = settings.value.translucentPanes
        applyHiddenFromCapture()

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
        // a save panel behind every other window is a hang as far as the user is concerned.
        NSApp.activate(ignoringOtherApps: true)

        panel.begin { [weak self] response in
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
            if currentFilename == nil { openLastUsedNote() }

        case .edited(let text, let caret):
            bufferText = text
            if let filename = currentFilename {
                state.update { $0.recordCaret(filename, offset: caret) }
                vault.noteBufferChanged(filename: filename, text: text)
            }
            scheduleWrite()

        case .caret(let caret, let scrollLine):
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

        case .contentHeight(let height):
            lastContentHeight = height
            // An overlay is holding the pane open at its own height; shrinking to the note's height
            // now would clip the thing the user is looking at.
            guard !switcherIsOpen, !actionsIsOpen else { return }
            applyContentHeight(height)

        case .switcherOpen(let open):
            switcherIsOpen = open
            applyContentHeight(open ? max(lastContentHeight, Self.switcherPaneHeight) : lastContentHeight)

        case .actionsOpen(let open, let height):
            actionsIsOpen = open
            // The panel is positioned 54 px down like the switcher, and wants the same 16 px of pane
            // below it. Its height is measured rather than assumed because filtering changes it.
            actionsPaneHeight = open ? 54 + height + 16 : 0
            applyContentHeight(open ? max(lastContentHeight, actionsPaneHeight) : lastContentHeight)

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

        case .dragRegions(let titleBar, let exclusions):
            editor.setDragRegions(titleBar: titleBar, exclusions: exclusions)

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

    func windowDidEndLiveResize(_ notification: Notification) {
        var pane = paneState
        // Only a *drag* gets here — programmatic `setFrame` does not fire live-resize notifications —
        // so this is unambiguously the user asking for a height.
        pane.manualHeight = Double(panel.frame.height)
        paneState = pane
        rememberFrame()

        // Auto-sizing was suppressed for the whole drag; reconcile once now that it is over, so a
        // pane dragged shorter than its note immediately grows back to the new floor.
        applyContentHeight(heightWanted)
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
