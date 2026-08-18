import AppKit
import PaneKit

/// Design frame 3a — the Storage tab.
///
/// Decision 21 is the load-bearing part: **the Sync radio picks where the vault lives, not a
/// protocol.** Off, iCloud Drive and the dimmed Peer-to-peer are all folder locations, and decision 7
/// survives intact — no server, no account, no sync code ships behind any of them. The radio exists
/// so that a future engine is one more row rather than a redesign.
///
/// Which means selecting a row has to actually move the vault, and that is the one genuinely
/// destructive thing in this window. It goes through a confirmation that names both paths and says
/// what happens to the notes, in the same posture as decision 27: at a filesystem moment, use the
/// system's own chrome and tell the truth.
@MainActor
final class StorageSettingsViewController: NSViewController {

    private let settings: SettingsStore

    /// Called when the vault location changed, so the app can re-point the watcher and the index.
    var onVaultChanged: ((URL) -> Void)?

    private var pathField: NSTextField!
    private var offRadio: NSButton!
    private var iCloudRadio: NSButton!
    private var syncNote: NSTextField!

    init(settings: SettingsStore) {
        self.settings = settings
        super.init(nibName: nil, bundle: nil)
        title = "Storage"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    /// `~/Library/Mobile Documents/com~apple~CloudDocs/Pane`.
    ///
    /// Built from the literal container name rather than from `url(forUbiquityContainerIdentifier:)`,
    /// which decision 13 measured returning nil here: unsigned means no ubiquity entitlement. The
    /// folder is still perfectly writable — Pane is just a non-sandboxed app writing into a synced
    /// directory, which is the whole architecture.
    static var iCloudDriveVault: URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Mobile Documents/com~apple~CloudDocs/Pane")
    }

    static func isInICloudDrive(_ url: URL) -> Bool {
        url.standardizedFileURL.path.contains("/Library/Mobile Documents/com~apple~CloudDocs/")
    }

    override func loadView() {
        let form = SettingsForm(labelWidth: 150)
        let current = settings.value

        // ---- location ----------------------------------------------------------------------
        pathField = SettingsForm.pathField(current.vaultPath)
        let change = SettingsForm.push("Change…", target: self, action: #selector(chooseFolder))
        let folderRow = NSStackView(views: [pathField, change])
        folderRow.orientation = .horizontal
        folderRow.spacing = 8
        // Fixed rather than a minimum: the label column is 150 and the tab is 540, so a field free to
        // grow pushes Change… past the window edge and drags every other row's alignment with it.
        pathField.widthAnchor.constraint(equalToConstant: 216).isActive = true
        form.row("Notes folder", folderRow)

        form.row("Format", SettingsForm.note("Markdown (.md)"))

        form.separator()

        // ---- sync --------------------------------------------------------------------------
        offRadio = SettingsForm.radio(
            "Off — this Mac only", target: self, action: #selector(syncChanged), tag: 0
        )
        iCloudRadio = SettingsForm.radio(
            "iCloud Drive", target: self, action: #selector(syncChanged), tag: 1
        )

        syncNote = NSTextField(labelWithString: "")
        syncNote.font = .systemFont(ofSize: 11)
        syncNote.textColor = .secondaryLabelColor

        let peer = SettingsForm.radio(
            "Peer-to-peer     SOON", target: self, action: #selector(syncChanged), tag: 2
        )
        peer.isEnabled = false

        form.row("Sync", stacked: [offRadio, iCloudRadio, syncNote, peer])

        form.separator()

        // ---- recently deleted --------------------------------------------------------------
        let retention = SettingsForm.popUp(
            Settings.recentlyDeletedOptions.map { "Keep \($0) days" },
            target: self,
            action: #selector(retentionChanged)
        )
        retention.selectItem(
            at: Settings.recentlyDeletedOptions.firstIndex(of: current.recentlyDeletedDays) ?? 1
        )
        form.row("Recently Deleted", retention)

        view = form.makeContentView()
        refresh(current)
    }

    func settingsChanged(_ new: Settings) {
        refresh(new)
    }

    private func refresh(_ current: Settings) {
        pathField?.stringValue = current.vaultPath
        let iCloud = Self.isInICloudDrive(current.vaultURL)
        offRadio?.state = iCloud ? .off : .on
        iCloudRadio?.state = iCloud ? .on : .off
        syncNote?.stringValue = iCloud
            ? "Synced by iCloud Drive."
            : ""
        syncNote?.isHidden = !iCloud
    }

    // MARK: - Actions

    @objc private func retentionChanged(_ sender: NSPopUpButton) {
        let days = Settings.recentlyDeletedOptions[sender.indexOfSelectedItem]
        settings.update { $0.recentlyDeletedDays = days }
    }

    @objc private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Use This Folder"
        panel.message = "Choose the folder your notes live in."
        panel.directoryURL = settings.value.vaultURL

        guard panel.runModal() == .OK, let chosen = panel.url else { return }
        // Picking a folder by hand is a statement about where the notes already are, so nothing
        // moves — unlike the Sync radio, which is a statement about where they should be.
        adopt(chosen, movingNotes: false)
    }

    @objc private func syncChanged(_ sender: NSButton) {
        let destination = sender.tag == 1 ? Self.iCloudDriveVault
            : URL(fileURLWithPath: (Settings.defaultVaultPath as NSString).expandingTildeInPath)
        let source = settings.value.vaultURL

        guard destination.standardizedFileURL != source.standardizedFileURL else { return }

        let noteCount = (try? VaultIO.listNotes(in: source))?.count ?? 0

        let notes: String
        if noteCount == 0 {
            notes = "There are no notes to move."
        } else {
            let plural = noteCount == 1 ? "" : "s"
            notes = """
                Your \(noteCount) note\(plural) can move there with it, or stay where they are at \
                \(source.path) — Pane will start with an empty folder if they stay.
                """
        }

        let alert = NSAlert()
        alert.messageText = "Move your notes to \(Self.short(destination))?"
        alert.informativeText = """
            Pane will point at \(destination.path) from now on.

            \(notes)

            Nothing about this turns on a sync service. It only chooses which folder the notes live \
            in; iCloud Drive syncs that folder because it is inside iCloud Drive.
            """
        alert.alertStyle = .informational
        if noteCount > 0 { alert.addButton(withTitle: "Move Notes") }
        alert.addButton(withTitle: noteCount > 0 ? "Just Point There" : "Continue")
        alert.addButton(withTitle: "Cancel")

        let response = alert.runModal()
        let cancel: NSApplication.ModalResponse = noteCount > 0 ? .alertThirdButtonReturn : .alertSecondButtonReturn
        guard response != cancel else {
            refresh(settings.value)  // put the radio back where it was
            return
        }

        adopt(destination, movingNotes: noteCount > 0 && response == .alertFirstButtonReturn)
    }

    // MARK: - Moving

    private func adopt(_ destination: URL, movingNotes: Bool) {
        do {
            try FileManager.default.createDirectory(
                at: destination, withIntermediateDirectories: true
            )
            if movingNotes { try moveNotes(from: settings.value.vaultURL, to: destination) }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Pane could not use that folder."
            alert.informativeText = error.localizedDescription
            alert.alertStyle = .warning
            alert.runModal()
            refresh(settings.value)
            return
        }

        settings.update { $0.vaultPath = Self.tildified(destination) }
        onVaultChanged?(destination)
        refresh(settings.value)
    }

    /// Moves every `.md` file across, and stops at the first failure rather than continuing.
    ///
    /// A half-moved vault is recoverable — both folders are right there and every note is a plain
    /// file — but only if the move stops and says so. Carrying on past an error would scatter the
    /// notes across two folders and report success.
    private func moveNotes(from source: URL, to destination: URL) throws {
        for note in try VaultIO.listNotes(in: source) {
            let target = destination.appendingPathComponent(note.lastPathComponent)
            guard !FileManager.default.fileExists(atPath: target.path) else {
                // Same filename on both sides. Frozen filenames (decision 2) make this a genuine
                // collision rather than a coincidence, so leave both alone and let the user look.
                continue
            }
            try FileManager.default.moveItem(at: note, to: target)
        }
    }

    private static func tildified(_ url: URL) -> String {
        let home = NSHomeDirectory()
        let path = url.standardizedFileURL.path
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }

    private static func short(_ url: URL) -> String {
        isInICloudDrive(url) ? "iCloud Drive" : url.lastPathComponent
    }
}
