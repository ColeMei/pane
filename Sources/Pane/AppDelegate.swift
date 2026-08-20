import AppKit
import PaneKit
import ServiceManagement

/// Wires the app together and owns everything with a process lifetime.
///
/// Deliberately thin. The pane knows how to be a pane, the vault service knows how to touch files,
/// and this type knows only the order things have to happen in on launch — which is the one piece of
/// logic that genuinely belongs to "the application" rather than to any part of it.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {

    private let settings = SettingsStore()
    private let state = StateStore()

    private var vault: VaultService!
    private var pane: PaneController!
    private var menuBar: MenuBarController!
    private var hotkey: GlobalHotkey!
    private var watcher: VaultWatcher?
    private var settingsWindow: SettingsWindowController?

    /// Where `vault` is currently pointed, so a settings change can tell a vault move from any other
    /// edit. Read back from the service instead would mean hopping onto its queue to answer a
    /// question the main actor already knows.
    private var currentVaultURL: URL?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        applyDockIcon()

        // Decision 13, and the order matters: the vault has to be resolved before anything tries to
        // read a note out of it, and "create it" is only ever allowed to happen once.
        guard prepareVault() else { return }

        vault = VaultService(vault: settings.value.vaultURL)
        currentVaultURL = settings.value.vaultURL
        pane = PaneController(vault: vault, state: state, settings: settings)
        pane.onPinsChanged = { [weak self] in self?.refreshMenuBar() }
        pane.onVaultMissing = { [weak self] in self?.handleVaultMissing() }
        pane.onOpenSettings = { [weak self] in self?.openSettingsWindow() }

        installMenuBarItem()
        installHotkey()
        startWatching()
        applyLaunchAtLogin()

        settings.onChange = { [weak self] new in self?.settingsChanged(new) }
        // Decision 12's promise — "changing the hotkey is a one-line edit" — only holds if the edit
        // takes effect. The Settings window is the ordinary way in now, but the file is still there
        // and still documented, so it still has to work.
        settings.watchForHandEdits()

        pruneStateForMissingNotes()

        // Decision 20's retention, enforced at the only moment it can be: Pane is not running most
        // of the time, so there is no timer that could have fired. Launch is when the clock is read.
        vault.purgeDeleted(keepingDays: settings.value.recentlyDeletedDays)

        installPresetThemes()
    }

    /// Copies the bundled preset themes into the Themes folder, the first time there is no folder.
    ///
    /// Decision 19 says a theme is a CSS file in a folder, and the folder shipped empty — so the
    /// mechanism existed and had nothing in it to select, which reads as a feature that does not
    /// work rather than one waiting for you to write CSS. The presets are the worked examples.
    ///
    /// **Only when the folder is absent**, never file by file. A preset the user deleted is a
    /// decision, and an app that puts it back every launch is arguing with them; a preset they
    /// edited is theirs, and overwriting it would be worse. Absent folder means first run — or a
    /// user who cleared it out entirely, who gets them back, which is the one case where restoring
    /// is the friendlier reading.
    private func installPresetThemes() {
        let folder = settings.themesFolder
        guard !FileManager.default.fileExists(atPath: folder.path) else { return }
        guard let bundled = Bundle.main.resourceURL?.appendingPathComponent("Themes"),
            let presets = try? FileManager.default.contentsOfDirectory(
                at: bundled, includingPropertiesForKeys: nil
            )
        else { return }

        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for preset in presets where preset.pathExtension == "css" {
            try? FileManager.default.copyItem(
                at: preset,
                to: folder.appendingPathComponent(preset.lastPathComponent)
            )
        }
    }

    // MARK: - Settings

    /// Re-applies everything after a settings change, from either the window or a hand edit.
    ///
    /// Everything, rather than a diff: there are a dozen settings and re-applying all of them costs
    /// less than the bookkeeping to know which one moved — and gets the case where several changed at
    /// once, which Restore Defaults does by design.
    private func settingsChanged(_ new: Settings) {
        // The vault path is the one setting that is not a preference — it is which files the app is
        // looking at. Everything else here re-applies in place; this has to re-point the service,
        // restart the watcher and reopen a note, in that order.
        //
        // Missing from the first version of this method, which made decision 32's promise a
        // half-truth: every key in settings.json reloaded live except the one whose stale value is
        // most visible, and a hand-edited vaultPath silently did nothing until the next launch.
        if new.vaultURL.standardizedFileURL != currentVaultURL?.standardizedFileURL {
            // Write what is on screen before the service points anywhere else — decision 56's rule,
            // reached from the other direction. Without it, an edit still inside the 500 ms debounce
            // when the vault path changes is written against the *new* folder under the old note's
            // name, or not at all. Safe rather than a race for the same reason: vault I/O is one
            // serial queue, so this write runs with the old location before `setVault` changes it.
            pane?.flush(trigger: .noteSwitched)
            currentVaultURL = new.vaultURL
            vault?.setVault(new.vaultURL)
            startWatching()
            pane?.openLastUsedNote()
        }

        if hotkey?.registered != new.summonHotkey { installHotkey() }
        applyMenuShortcuts()
        applyDockIcon()
        applyLaunchAtLogin()
        applyMenuBarIconVisibility()
        pane?.applySettings()
        settingsWindow?.settingsChanged(new)
        menuBar?.rebuild(hotkey: new.summonHotkey)
        // Shortening the retention should take effect now rather than at the next launch — the
        // reason someone reaches for that control is usually that they want something gone.
        vault?.purgeDeleted(keepingDays: new.recentlyDeletedDays)
    }

    /// Decision 16's window, replacing the settings *file* the menu item used to open.
    ///
    /// That substitute was honest while there was no window — better than an item greyed out for a
    /// whole release — and it retires here rather than lingering as a second way to do the same job.
    private func openSettingsWindow() {
        if settingsWindow == nil {
            settingsWindow = SettingsWindowController(
                settings: settings,
                // Before *Move Notes* moves anything, so what is on screen is written while the
                // buffer still points at a file that exists (decision 73).
                onWillMoveNotes: { [weak self] in self?.pane.flush(trigger: .noteSwitched) }
            ) { [weak self] url in
                guard let self else { return }
                // Same as the hand-edited path above, and this is the one people actually use: the
                // Sync radio and "Notes folder" both land here, and *Move Notes* (decision 30) moves
                // the file the buffer is pointing at.
                self.pane.flush(trigger: .noteSwitched)
                self.vault.setVault(url)
                self.startWatching()
                self.pane.openLastUsedNote()
                self.refreshMenuBar()
            }
        }
        settingsWindow?.present()
    }

    /// The Dock icon is off by default (Pane lives in the menu bar) and switches the activation
    /// policy at runtime rather than through `Info.plist`, so turning it on does not need a relaunch.
    private func applyDockIcon() {
        let wanted: NSApplication.ActivationPolicy = settings.value.showDockIcon ? .regular : .accessory
        guard NSApp.activationPolicy() != wanted else { return }
        NSApp.setActivationPolicy(wanted)
    }

    private func applyMenuBarIconVisibility() {
        if settings.value.showMenuBarIcon {
            if menuBar == nil { installMenuBarItem() }
        } else {
            menuBar = nil
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Decision 10's third immediate flush. Everything else is recoverable; unsaved text is not.
        pane?.flush(trigger: .quitting)
        // And wait for it. Decision 10 lists quit as an immediate flush, but "immediate" only meant
        // "enqueued immediately" — see `VaultService.drain`. A draft note exists nowhere but in the
        // buffer until that write lands, which is what makes the difference load-bearing.
        vault?.drain()
        state.save()
        watcher?.stop()
    }

    /// Pane has no Dock icon by default, but if `showDockIcon` is on, clicking it should summon
    /// rather than do nothing.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        pane?.summon()
        return true
    }

    // MARK: - Vault

    /// - Returns: false when the app cannot continue without the user choosing a folder, in which
    ///   case the chooser has been put on screen and launch resumes from its completion.
    private func prepareVault() -> Bool {
        let url = settings.value.vaultURL
        switch VaultLifecycle.situation(vault: url, everCreated: state.value.vaultEverCreated) {
        case .ready:
            state.update { $0.vaultEverCreated = true }
            return true

        case .firstLaunch:
            do {
                try VaultLifecycle.create(vault: url)
                state.update { $0.vaultEverCreated = true }
                return true
            } catch {
                presentVaultChooser(
                    message: "Pane could not create a notes folder at \(url.path).",
                    detail: error.localizedDescription
                )
                return false
            }

        case .vaultMissing(let missing):
            presentVaultChooser(
                message: "Pane can't find your notes folder.",
                detail: """
                    It was at \(missing.path) and isn't there now. Pane won't create a new one on \
                    top of it — that would look exactly like an empty vault whether your notes are \
                    safe elsewhere or not. Choose where they are, or pick a new folder to start again.
                    """
            )
            return false

        case .pathIsNotADirectory(let path):
            presentVaultChooser(
                message: "Your notes folder is a file.",
                detail: "\(path.path) exists but isn't a folder. Choose a folder for your notes."
            )
            return false
        }
    }

    private func handleVaultMissing() {
        guard case .vaultMissing = VaultLifecycle.situation(
            vault: settings.value.vaultURL,
            everCreated: state.value.vaultEverCreated
        ) else { return }

        presentVaultChooser(
            message: "Pane can't find your notes folder.",
            detail: "It was at \(settings.value.vaultURL.path) and isn't there now."
        )
    }

    /// The "choose vault" state (decision 13), as a panel rather than a designed pane.
    ///
    /// The design record never drew this one and the brief says so. Using AppKit's own alert and open
    /// panel here is a deliberate choice, not a shortcut: this is the one moment Pane is allowed to
    /// activate, the user is at their least patient, and a familiar system dialog says "your files
    /// are a filesystem problem, and you are in charge of it" better than bespoke chrome would.
    private func presentVaultChooser(message: String, detail: String) {
        NSApp.activate(ignoringOtherApps: true)

        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = detail
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Choose Folder…")
        alert.addButton(withTitle: "Quit Pane")

        guard alert.runModal() == .alertFirstButtonReturn else {
            NSApp.terminate(nil)
            return
        }

        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Use This Folder"
        panel.message = "Choose the folder your notes live in."

        guard panel.runModal() == .OK, let chosen = panel.url else {
            presentVaultChooser(message: message, detail: detail)
            return
        }

        settings.update { $0.vaultPath = chosen.path }
        state.update { $0.vaultEverCreated = true }

        if vault == nil {
            applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        } else {
            vault.setVault(chosen)
            startWatching()
            pane.openLastUsedNote()
        }
    }

    private func startWatching() {
        watcher?.stop()
        let watcher = VaultWatcher { [weak self] paths in
            let names = VaultWatcher.noteFilenames(in: paths)
            guard !names.isEmpty else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.pane?.vaultChanged(filenames: names)
                    self?.refreshMenuBar()
                }
            }
        }
        watcher.start(watching: settings.value.vaultURL)
        self.watcher = watcher
    }

    /// Drops caret offsets and pins for notes that are no longer in the vault.
    ///
    /// Only ever from a listing that succeeded, and never for a note that is merely evicted —
    /// `AppState.forgetNotes` documents why: a slow sync is not a deletion.
    private func pruneStateForMissingNotes() {
        vault.present { [weak self] present in
            guard let self, !present.isEmpty else { return }
            self.state.update { $0.forgetNotes(missingFrom: present) }
            self.refreshMenuBar()
        }
    }

    // MARK: - Hotkey

    private func installHotkey() {
        hotkey = GlobalHotkey { [weak self] in self?.pane.toggle() }

        guard hotkey.register(settings.value.summonHotkey) else {
            let combo = settings.value.summonHotkey.displayString
            NSLog("Pane: could not register %@ — another app already owns it", combo)

            // Not fatal, and not a modal on launch either: the menu bar item still summons the pane,
            // and an app that blocks the screen at login over a hotkey conflict is worse than one
            // you have to click once.
            menuBar?.rebuild(hotkey: settings.value.summonHotkey)
            return
        }
    }

    // MARK: - Menu bar

    private func installMenuBarItem() {
        guard settings.value.showMenuBarIcon else { return }

        menuBar = MenuBarController(hotkey: settings.value.summonHotkey)
        menuBar.pinnedNotes = { [weak self] in self?.pinnedNotes() ?? [] }
        menuBar.onShow = { [weak self] in self?.pane.summon() }
        menuBar.onNewNote = { [weak self] in
            self?.pane.summon()
            self?.pane.createNote(title: "")
        }
        menuBar.onBrowse = { [weak self] in self?.pane.openSwitcher() }
        menuBar.onActions = { [weak self] in self?.pane.openActions() }
        menuBar.onSettings = { [weak self] in self?.openSettingsWindow() }
        // Summon first: the pinned section exists so a pinned note is one click away from anywhere,
        // and opening one into a pane that is still offscreen would be a click that does nothing.
        menuBar.onOpenNote = { [weak self] filename in
            self?.pane.summon()
            self?.pane.open(filename)
        }
    }

    /// Note titles by filename, kept warm for the menu bar.
    ///
    /// The menu builds synchronously when it opens, and a title is the first line of a file — so it
    /// has to already be here. Refreshed whenever the vault changes, which is also the only time it
    /// can go stale.
    private var titles: [String: String] = [:]

    private func refreshMenuBar() {
        vault.titles { [weak self] titles in
            guard let self else { return }
            self.titles = titles
            self.menuBar?.rebuild(hotkey: self.settings.value.summonHotkey)
        }
    }

    private func pinnedNotes() -> [(filename: String, title: String)] {
        state.value.notes
            .filter(\.value.isPinned)
            .sorted { ($0.value.lastOpened ?? .distantPast) > ($1.value.lastOpened ?? .distantPast) }
            .map { (filename: $0.key, title: titles[$0.key] ?? "") }
    }

    // MARK: - Login item

    private func applyLaunchAtLogin() {
        do {
            switch (settings.value.launchAtLogin, SMAppService.mainApp.status) {
            case (true, .enabled), (false, .notRegistered), (false, .notFound):
                break
            case (true, _):
                try SMAppService.mainApp.register()
            case (false, _):
                try SMAppService.mainApp.unregister()
            }
        } catch {
            NSLog("Pane: could not update the login item — %@", String(describing: error))
        }
    }

    // MARK: - Main menu

    /// An accessory app never shows a menu bar, but `NSApp.mainMenu` is still what routes ⌘C, ⌘V and
    /// ⌘Z to the first responder. Without this the pane would be a text editor you cannot paste into.
    private func installMainMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "Settings…",
            action: #selector(openSettings),
            keyEquivalent: ","
        ).target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Pane", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "File")
        newNoteItem = fileMenu.addItem(withTitle: "New Note", action: #selector(newNote), keyEquivalent: "")
        newNoteItem?.target = self
        browseNotesItem = fileMenu.addItem(withTitle: "Browse Notes…", action: #selector(browseNotes), keyEquivalent: "")
        browseNotesItem?.target = self
        applyMenuShortcuts()
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Close Pane", action: #selector(closePane), keyEquivalent: "w").target = self
        fileItem.submenu = fileMenu
        main.addItem(fileItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        NSApp.mainMenu = main
    }

    /// The two File-menu items whose keys are rebindable. See `applyMenuShortcuts`.
    private var newNoteItem: NSMenuItem?
    private var browseNotesItem: NSMenuItem?

    /// Points the File menu at whatever New Note and Browse Notes are actually bound to.
    ///
    /// These were `keyEquivalent: "n"` and `"p"`, spelled here and nowhere near
    /// `Settings.shortcutActions` — so they were the two rebindable actions that could not be
    /// rebound. Recording a new key in the Shortcuts tab moved the editor's binding and left the
    /// menu holding ⌘N, which means the old key kept working and the recorder could not free it.
    /// Exactly the class of defect decisions 47 and 49 are about: a key printed in one place and
    /// meaning something else in another.
    private func applyMenuShortcuts() {
        let map: [(NSMenuItem?, String)] = [
            (newNoteItem, "newNote"),
            (browseNotesItem, "browseNotes"),
        ]
        for (item, action) in map {
            guard let item else { continue }
            guard let combo = Settings.menuKeyEquivalent(for: settings.value.shortcut(action)) else {
                // A binding this cannot express — the item keeps its title and loses its key rather
                // than advertising one it does not have.
                item.keyEquivalent = ""
                item.keyEquivalentModifierMask = []
                continue
            }
            item.keyEquivalent = combo.key
            var mask: NSEvent.ModifierFlags = []
            if combo.modifiers.contains(.command) { mask.insert(.command) }
            if combo.modifiers.contains(.shift) { mask.insert(.shift) }
            if combo.modifiers.contains(.option) { mask.insert(.option) }
            if combo.modifiers.contains(.control) { mask.insert(.control) }
            item.keyEquivalentModifierMask = mask
        }
    }

    @objc private func newNote() {
        pane?.summon()
        pane?.createNote(title: "")
    }

    @objc private func browseNotes() {
        pane?.openSwitcher()
    }

    @objc private func closePane() {
        pane?.dismiss()
    }

    @objc private func openSettings() {
        openSettingsWindow()
    }
}
