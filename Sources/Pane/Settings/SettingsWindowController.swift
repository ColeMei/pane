import AppKit
import PaneKit

/// Design frames 2c and 3a–3c — Settings, as a real window.
///
/// Decision 16: **a real window, not a pane.** Standard macOS chrome, toolbar tabs, ⌘W to close, and
/// the one thing in Pane that is allowed to activate the app. That is the point rather than a
/// concession — settings change rarely, and putting them in a pane would cost the pane chrome it has
/// to carry every second of every day for a window opened twice a year.
///
/// `NSTabViewController` in `.toolbar` style is the frame's chrome exactly: icon above label. Written
/// out by hand it would be a toolbar delegate, a tab view and a pile of size animations; the platform
/// already has all three and gets them right.
///
/// The one thing taken off it is per-tab sizing — see `preferredContentSize` below. The window is one
/// size, and the tab that does not fit scrolls.
@MainActor
final class SettingsWindowController: NSWindowController, NSWindowDelegate {

    private let settings: SettingsStore
    private let general: GeneralSettingsViewController
    private let storage: StorageSettingsViewController
    private let appearance: AppearanceSettingsViewController
    private let shortcuts: ShortcutsSettingsViewController
    private let about: AboutSettingsViewController

    init(
        settings: SettingsStore,
        onWillMoveNotes: @escaping () -> Void,
        onVaultChanged: @escaping (URL) -> Void
    ) {
        self.settings = settings
        general = GeneralSettingsViewController(settings: settings)
        storage = StorageSettingsViewController(settings: settings)
        appearance = AppearanceSettingsViewController(settings: settings)
        shortcuts = ShortcutsSettingsViewController(settings: settings)
        about = AboutSettingsViewController()
        storage.onWillMoveNotes = onWillMoveNotes
        storage.onVaultChanged = onVaultChanged

        let tabs = NSTabViewController()
        tabs.tabStyle = .toolbar
        for controller in [general, storage, appearance, shortcuts, about] as [NSViewController] {
            tabs.addTabViewItem(NSTabViewItem(viewController: controller))
        }
        // SF Symbols matching the frame's own glyphs: gear, folder, half-filled circle, keyboard.
        // About is the one tab the frames do not draw, and takes the system's own about glyph.
        let symbols = ["gearshape", "folder", "circle.lefthalf.filled", "keyboard", "info.circle"]
        for (item, symbol) in zip(tabs.tabViewItems, symbols) {
            item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: item.label)
        }

        // One window size for all five tabs, computed rather than chosen.
        //
        // Per-tab sizing is `NSTabViewController`'s standard behaviour and it was fine while the
        // tabs were within a hundred points of each other. Shortcuts is not: it is roughly twice the
        // tallest of the rest, so switching to it threw the window open and switching away snapped
        // it shut, with the tab bar moving under the pointer as you read it. About was the same
        // fault sideways, at 380 wide against everyone else's 540.
        //
        // So the window is the size of the tallest tab that has to fit whole, and Shortcuts — the
        // one tab that does not — scrolls inside it. Taking the max rather than writing a number
        // down is decision 82's rule: a constant tuned against today's tallest tab is wrong the
        // first time a row is added to another one.
        //
        // Loading all five views up front is the cost, and it is the right trade here: a settings
        // window is opened rarely and never on the hot path, and a lazily-loaded tab would have to
        // guess its own size before it had one.
        let sized = [general, storage, appearance, about] as [NSViewController]
        let height = sized.map(\.view.fittingSize.height).max() ?? PanePanel.defaultHeight
        let size = NSSize(width: SettingsForm.contentWidth, height: height)
        for controller in [general, storage, appearance, shortcuts, about] as [NSViewController] {
            controller.preferredContentSize = size
        }

        let window = NSWindow(contentViewController: tabs)
        // Deliberately *not* `.fullSizeContentView`: with it, the content view extends under the
        // toolbar and the first two rows of every tab render behind the tab buttons. A preference
        // window wants the toolbar to occupy its own band, which is the default.
        window.styleMask = [.titled, .closable]
        window.toolbarStyle = .preference
        window.title = "Pane Settings"
        window.isReleasedWhenClosed = false
        window.center()

        super.init(window: window)
        window.delegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    /// Brings the window up, activating the app.
    ///
    /// The only `NSApp.activate` in the product besides the vault chooser. Everything else about Pane
    /// is built not to do this; a settings window that opened behind the app you were using would be
    /// a window you cannot find.
    func present() {
        // The pane is `.floating` and this is an ordinary window, so without this it opens *behind*
        // the pane with its first rows covered. See `PanePanel.stepAside`.
        PanePanel.stepAside()
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }

    /// And the pane goes back to floating the moment this window is gone.
    func windowWillClose(_ notification: Notification) {
        PanePanel.resumeFloating()
    }

    /// Pushes a change into every tab, so a value edited on one tab — or in `settings.json` while
    /// this window is open — is not stale on the others.
    func settingsChanged(_ new: Settings) {
        general.settingsChanged(new)
        storage.settingsChanged(new)
        appearance.settingsChanged(new)
        shortcuts.settingsChanged(new)
        about.settingsChanged(new)
    }
}
