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

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()

        // Decision 13, and the order matters: the vault has to be resolved before anything tries to
        // read a note out of it, and "create it" is only ever allowed to happen once.
        guard prepareVault() else { return }

        vault = VaultService(vault: settings.value.vaultURL)
        pane = PaneController(vault: vault, state: state, settings: settings)
        pane.onPinsChanged = { [weak self] in self?.refreshMenuBar() }
        pane.onVaultMissing = { [weak self] in self?.handleVaultMissing() }

        installMenuBarItem()
        installHotkey()
        startWatching()
        applyLaunchAtLogin()

        pruneStateForMissingNotes()
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Decision 10's third immediate flush. Everything else is recoverable; unsaved text is not.
        pane?.flush(trigger: .quitting)
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
        menuBar.onSettings = { [weak self] in self?.openSettingsFile() }
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

    /// Decision 16 defers the Settings window; decision 12's substitute stands until it lands, and
    /// the substitute is a file. So "Settings…" opens that file — which is a truthful thing for the
    /// menu item to do, and better than an item that is greyed out for a whole release.
    private func openSettingsFile() {
        NSWorkspace.shared.open(settings.url)
    }

    // MARK: - Login item

    private func applyLaunchAtLogin() {
        guard settings.value.launchAtLogin else { return }
        do {
            if SMAppService.mainApp.status != .enabled {
                try SMAppService.mainApp.register()
            }
        } catch {
            NSLog("Pane: could not register the login item — %@", String(describing: error))
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
        fileMenu.addItem(withTitle: "New Note", action: #selector(newNote), keyEquivalent: "n").target = self
        fileMenu.addItem(withTitle: "Browse Notes…", action: #selector(browseNotes), keyEquivalent: "p").target = self
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
        openSettingsFile()
    }
}
