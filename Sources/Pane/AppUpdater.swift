import AppKit
import PaneKit
import Sparkle

/// Installs updates, and only when asked.
///
/// **Sparkle as the installer and nothing else.** The news is Pane's own summon check (decision 136)
/// and stays that way; this runs when somebody presses "Update to X…", shows the release notes with
/// an Install button, and then downloads, verifies and swaps the app. Automatic checks are off in
/// Info.plist, so Sparkle never asks the network on its own.
///
/// **Every update is verified against our EdDSA key** (`SUPublicEDKey`) before it replaces anything.
/// Pane has no Apple Developer ID, so that signature is the only proof an update came from us; an
/// update without it, or with a wrong one, is refused.
///
/// A build without a feed and a key — a scratch build, or one made before the key existed — never
/// starts Sparkle, and "Update to X…" opens the release page as it always did.
@MainActor
final class AppUpdater: NSObject, SPUUpdaterDelegate {

    private var controller: SPUStandardUpdaterController?

    /// Where to go when installing does not work: the release page for the version on offer.
    var onFallback: (() -> Void)?

    override init() {
        super.init()
        let info = Bundle.main.infoDictionary ?? [:]
        guard info["SUFeedURL"] is String,
              let key = info["SUPublicEDKey"] as? String,
              !key.isEmpty, !key.hasPrefix("__")
        else { return }
        controller = SPUStandardUpdaterController(
            startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil
        )
    }

    /// Whether this build can install updates itself.
    var isAvailable: Bool { controller != nil }

    /// Sparkle's window: the release notes and an Install button, or "you're up to date".
    func checkForUpdates() {
        // An accessory app's windows open behind whatever is frontmost unless the app comes forward.
        NSApp.activate()
        controller?.checkForUpdates(nil)
    }

    // MARK: - SPUUpdaterDelegate

    /// Sparkle has shown its own alert by now. What is left is whether there is somewhere to go.
    func updater(_ updater: SPUUpdater, didAbortWithError error: any Error) {
        let error = error as NSError
        guard error.domain == SUSparkleErrorDomain,
              ReleaseCheck.fallsBackToReleasePage(sparkleErrorCode: error.code)
        else { return }
        onFallback?()
    }
}
