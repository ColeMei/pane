import Foundation

/// The things the user chooses, as opposed to the things Pane remembers (`AppState`).
///
/// Kept in a separate `settings.json` because the two files have different owners. State is written
/// constantly by the app and is nobody's business to edit; settings are written rarely and are, per
/// decision 12, explicitly meant to be edited by hand — v0.1 ships no hotkey recorder, and the
/// promise that stands in for one is that changing the combo is a one-line edit.
public struct Settings: Codable, Equatable, Sendable {

    public static let currentSchemaVersion = 1

    public var schemaVersion: Int

    // MARK: Storage

    /// Where the notes live. Stored with `~` intact so the file reads the way the user thinks about
    /// it, and so a vault under the home directory survives the account being renamed.
    public var vaultPath: String

    public static let defaultVaultPath = "~/Documents/Pane"

    public var vaultURL: URL {
        URL(fileURLWithPath: (vaultPath as NSString).expandingTildeInPath)
    }

    /// Optional housekeeping: delete notes untouched for this many days. Off by default, and
    /// deliberately opt-in — a notes app that silently deletes is not one you can trust with the
    /// thought you had four months ago.
    public var deleteAfterDays: Int?

    // MARK: Hotkey

    public var summonHotkey: Hotkey

    public enum DismissMode: String, Codable, Equatable, Sendable {
        /// The design's default: the summon hotkey toggles the pane away again.
        case sameHotkeyToggles
        /// For people who bind summon to something they also want to press while the pane is open.
        case escapeOnly
    }

    public var dismissMode: DismissMode

    // MARK: Launch

    public var launchAtLogin: Bool
    public var showMenuBarIcon: Bool

    /// Off by default — Pane lives in the menu bar. On, it takes a Dock icon and joins ⌘Tab, which
    /// some people want and which costs nothing to offer.
    public var showDockIcon: Bool

    // MARK: Appearance

    public enum Appearance: String, Codable, Equatable, Sendable {
        case system, light, dark
    }

    /// Light and dark both ship in v0.1 (design frame 1f). The *switcher* for them is part of the
    /// deferred Settings window, so until that lands this is the one-line edit.
    public var appearance: Appearance

    /// Editor body text size in points. The design's ⌘= / ⌘− live in the deferred Settings window;
    /// the value is honoured now.
    public var textSize: Double

    /// Translucent panes. Turning this off swaps the vibrancy material for a flat background —
    /// the design's own props block does exactly this.
    public var translucentPanes: Bool

    // MARK: Defaults

    public init(
        schemaVersion: Int = Settings.currentSchemaVersion,
        vaultPath: String = Settings.defaultVaultPath,
        deleteAfterDays: Int? = nil,
        summonHotkey: Hotkey = .defaultSummon,
        dismissMode: DismissMode = .sameHotkeyToggles,
        launchAtLogin: Bool = false,
        showMenuBarIcon: Bool = true,
        showDockIcon: Bool = false,
        appearance: Appearance = .system,
        textSize: Double = 15,
        translucentPanes: Bool = true
    ) {
        self.schemaVersion = schemaVersion
        self.vaultPath = vaultPath
        self.deleteAfterDays = deleteAfterDays
        self.summonHotkey = summonHotkey
        self.dismissMode = dismissMode
        self.launchAtLogin = launchAtLogin
        self.showMenuBarIcon = showMenuBarIcon
        self.showDockIcon = showDockIcon
        self.appearance = appearance
        self.textSize = textSize
        self.translucentPanes = translucentPanes
    }

    /// Every key is optional on the way in. This file is meant to be hand-edited, which means it
    /// will sometimes be hand-broken: a missing key, a stray comma removed along with the line it
    /// was on. One bad field should cost that field's value, not the launch.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Settings()
        schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? d.schemaVersion
        vaultPath = try c.decodeIfPresent(String.self, forKey: .vaultPath) ?? d.vaultPath
        deleteAfterDays = try c.decodeIfPresent(Int.self, forKey: .deleteAfterDays)
        summonHotkey = try c.decodeIfPresent(Hotkey.self, forKey: .summonHotkey) ?? d.summonHotkey
        dismissMode = try c.decodeIfPresent(DismissMode.self, forKey: .dismissMode) ?? d.dismissMode
        launchAtLogin = try c.decodeIfPresent(Bool.self, forKey: .launchAtLogin) ?? d.launchAtLogin
        showMenuBarIcon = try c.decodeIfPresent(Bool.self, forKey: .showMenuBarIcon) ?? d.showMenuBarIcon
        showDockIcon = try c.decodeIfPresent(Bool.self, forKey: .showDockIcon) ?? d.showDockIcon
        appearance = try c.decodeIfPresent(Appearance.self, forKey: .appearance) ?? d.appearance
        textSize = try c.decodeIfPresent(Double.self, forKey: .textSize) ?? d.textSize
        translucentPanes = try c.decodeIfPresent(Bool.self, forKey: .translucentPanes) ?? d.translucentPanes

        // Clamp rather than reject: a hand-typed 0 or 9999 should land somewhere sensible.
        textSize = min(max(textSize, 10), 32)
        if let days = deleteAfterDays, days < 1 { deleteAfterDays = nil }
    }
}
