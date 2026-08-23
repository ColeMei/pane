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

    /// Called immediately before *Move Notes* touches a file, so the buffer can be written while it
    /// still knows where it lives. See `adopt`.
    var onWillMoveNotes: (() -> Void)?

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

        guard PanePanel.steppingAside({ panel.runModal() }) == .OK, let chosen = panel.url else { return }
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

        // Decision 76, reaching the one modal it had not. This ran to three paragraphs, and the
        // third — "Nothing about this turns on a sync service. It only chooses which folder the
        // notes live in…" — was decision 21's *argument*, which belongs in the brief rather than in
        // front of somebody who has just clicked a radio button. The first paragraph restated the
        // title. What decision 30 actually requires is the source, the destination and the count,
        // and all three survive in one sentence each.
        let alert = NSAlert()
        alert.messageText = "Move your notes to \(Self.short(destination))?"
        //
        // Only one of the two paths is spelled out, and it is the **source** — because that is the
        // one notes can be left behind in, and therefore the one you would have to go and find. The
        // destination is named in the title and was just chosen in a radio or an open panel. Spelled
        // out, `~/Library/Mobile Documents/com~apple~CloudDocs/Pane` took six of the alert's lines
        // on its own, which is most of what "too much to read" meant.
        alert.informativeText = noteCount == 0
            ? "Pane will use \(Self.tilde(destination)) from now on."
            : """
                Your \(noteCount) note\(noteCount == 1 ? "" : "s") can move to \
                \(Self.short(destination)), or stay in \(Self.tilde(source)) and leave Pane with \
                an empty folder.
                """
        alert.alertStyle = .informational
        if noteCount > 0 { alert.addButton(withTitle: "Move Notes") }
        // "Just Point There" was jargon for a thing the user was not thinking about — pointing. The
        // question on screen is what happens to the *notes*, so both answers are verbs about the
        // notes and the pair reads as one choice.
        alert.addButton(withTitle: noteCount > 0 ? "Leave Them" : "Continue")
        alert.addButton(withTitle: "Cancel")

        let response = PanePanel.steppingAside { alert.runModal() }
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
            if movingNotes {
                // Decision 56, reached from the one direction its amendment missed.
                //
                // The flush that protects this path is the one `settings.update` below triggers —
                // and it runs *after* the files have already moved, so it writes to the old vault
                // under a name that is no longer there, `VaultIO.write` reads that as "missing" and
                // recreates it, and you are left with a resurrected copy in the old folder holding
                // your newest text while the moved copy is stale. Flushing first is the whole fix:
                // the write lands in the old vault on the file that is still in it, and the move
                // then carries it across with everything else.
                onWillMoveNotes?()
                try moveNotes(from: settings.value.vaultURL, to: destination)
            }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Pane could not use that folder."
            alert.informativeText = error.localizedDescription
            alert.alertStyle = .warning
            PanePanel.steppingAside { alert.runModal() }
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

    /// A path a person can read in a sentence. `/Users/colemei/Pane` is four words of noise before
    /// the one that matters.
    private static func tilde(_ url: URL) -> String {
        (url.path as NSString).abbreviatingWithTildeInPath
    }
}
