import Foundation

/// Which copy of Pane this is: the one someone uses, or the one someone is debugging.
///
/// The two used to be the same app as far as macOS was concerned — same bundle identifier, so the
/// same `~/Library/Application Support/Pane`, so **the same `settings.json`, `state.json` and
/// Recently Deleted folder**. That is fine until you want the debug build pointed somewhere safe:
/// `vaultPath` is a setting, and a setting lives in the file both builds read, so pointing the debug
/// build at a scratch vault silently repointed the daily one too. Decision 30's own hazard — a vault
/// re-pointed at an empty folder is indistinguishable from a vault that got destroyed — reached from
/// the one direction nobody was watching, because it is a development path rather than a user one.
///
/// So a scratch build gets its own everything. It is not a mode the app switches into at runtime;
/// it is stamped into `Info.plist` by `Scripts/build-app.sh --debug` and read once, which means it
/// cannot be turned on by accident and cannot be turned off by a stale setting.
///
/// **This is the second reason to keep the two apart, and the first one is already in the record:**
/// "test against a scratch vault, never the real one — synthetic input into a pane that is showing a
/// real note will edit that note, and did once." A rule that depends on remembering to repoint a
/// shared file is a rule that gets forgotten on the session where it matters.
public enum BuildProfile: Sendable, Equatable {

    /// A release build: `~/Library/Application Support/Pane`, vault defaults to `~/Documents/Pane`.
    case release

    /// A debug build: its own support folder, and a vault outside `~/Documents`.
    ///
    /// Outside `~/Documents` on purpose. Ad-hoc signing gives every rebuild a new cdhash and TCC
    /// keys consent to the binary, so a debug build under `~/Documents` re-triggers the
    /// Documents-folder prompt on every build — and while that prompt is up the app reads and writes
    /// nothing, which presents as the app ignoring every keystroke rather than as a permission
    /// dialog. `~/Pane-scratch` never meets it.
    case scratch

    /// The `Info.plist` key `Scripts/build-app.sh --debug` stamps.
    public static let infoKey = "PaneScratchBuild"

    /// Resolved once from the bundle. A test harness or a probe has no such key and is `.release`,
    /// which is what keeps `PaneKitTests` free of any opinion about where this machine keeps things.
    public static let current: BuildProfile = {
        let flagged = Bundle.main.object(forInfoDictionaryKey: infoKey) as? Bool ?? false
        return flagged ? .scratch : .release
    }()

    /// The folder under Application Support. Named so the two are told apart in the Finder at a
    /// glance, which matters the first time you go looking for which `state.json` you just broke.
    public var supportDirectoryName: String {
        switch self {
        case .release: "Pane"
        case .scratch: "Pane (Debug)"
        }
    }

    /// Where a fresh install puts the vault. Only ever a *default* — once `settings.json` exists it
    /// carries the answer, and the Storage tab can move it (decision 30).
    public var defaultVaultPath: String {
        switch self {
        case .release: "~/Documents/Pane"
        case .scratch: "~/Pane-scratch"
        }
    }
}
