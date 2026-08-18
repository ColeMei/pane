import AppKit
import PaneKit

/// Design frame 2c — the General tab.
///
/// Everything here is about how Pane behaves before you have typed anything: how you summon it, how
/// it goes away, and whether it announces itself in the menu bar and the Dock.
///
/// One thing the frame draws that this tab does not: "Notes folder". Turn 2 put it here, and Turn 3
/// then added a whole Storage tab that opens with the same control. Two Change… buttons onto the
/// same open panel is a duplicate rather than a convenience, so it lives in Storage — the tab named
/// after it — and this tab ends at the Dock.
@MainActor
final class GeneralSettingsViewController: NSViewController {

    private let settings: SettingsStore
    private var recorder: HotkeyRecorderView!

    init(settings: SettingsStore) {
        self.settings = settings
        super.init(nibName: nil, bundle: nil)
        title = "General"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let form = SettingsForm(labelWidth: 170)
        let current = settings.value

        // ---- summon ------------------------------------------------------------------------
        recorder = HotkeyRecorderView(hotkey: current.summonHotkey)
        recorder.onRecord = { [weak self] hotkey in
            self?.settings.update { $0.summonHotkey = hotkey }
        }
        let recorderRow = NSStackView(views: [recorder])
        recorderRow.orientation = .horizontal
        recorderRow.spacing = 8
        form.row("Summon hotkey", recorderRow)

        // ---- dismiss -----------------------------------------------------------------------
        let toggles = SettingsForm.radio(
            "Same hotkey toggles", target: self, action: #selector(dismissModeChanged), tag: 0
        )
        let escOnly = SettingsForm.radio(
            "Esc only", target: self, action: #selector(dismissModeChanged), tag: 1
        )
        (current.dismissMode == .sameHotkeyToggles ? toggles : escOnly).state = .on
        form.row("Dismiss", stacked: [toggles, escOnly])

        form.separator()

        // ---- launch ------------------------------------------------------------------------
        let login = SettingsForm.checkbox(
            "Start Pane at login", target: self, action: #selector(launchAtLoginChanged)
        )
        login.state = current.launchAtLogin ? .on : .off
        form.row("Launch", login)

        let menuBar = SettingsForm.checkbox(
            "Show menu bar icon", target: self, action: #selector(showMenuBarIconChanged)
        )
        menuBar.state = current.showMenuBarIcon ? .on : .off
        form.row("", menuBar)

        // ---- dock --------------------------------------------------------------------------
        let dock = SettingsForm.checkbox(
            "Show Dock icon", target: self, action: #selector(showDockIconChanged)
        )
        dock.state = current.showDockIcon ? .on : .off
        form.row("Dock", dock)
        form.hint("Adds Pane to the Dock and to ⌘Tab.")

        view = form.makeContentView()
    }

    /// Keeps the recorder honest when the hotkey changed somewhere else — a hand edit to
    /// `settings.json` while this window is open, or Restore Defaults on the Shortcuts tab.
    func settingsChanged(_ new: Settings) {
        recorder?.setHotkey(new.summonHotkey)
    }

    // MARK: - Actions

    @objc private func dismissModeChanged(_ sender: NSButton) {
        settings.update { $0.dismissMode = sender.tag == 0 ? .sameHotkeyToggles : .escapeOnly }
    }

    @objc private func launchAtLoginChanged(_ sender: NSButton) {
        settings.update { $0.launchAtLogin = sender.state == .on }
    }

    @objc private func showMenuBarIconChanged(_ sender: NSButton) {
        settings.update { $0.showMenuBarIcon = sender.state == .on }
    }

    @objc private func showDockIconChanged(_ sender: NSButton) {
        settings.update { $0.showDockIcon = sender.state == .on }
    }
}
