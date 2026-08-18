import Foundation

/// The things the user chooses, as opposed to the things Pane remembers (`AppState`).
///
/// Kept in a separate `settings.json` because the two files have different owners. State is written
/// constantly by the app and is nobody's business to edit; settings are written rarely and are, per
/// decision 12, explicitly meant to be edited by hand.
///
/// That hand-editing is no longer a stand-in for missing UI. The hotkey recorder shipped (decision
/// 15) and so did the Settings window, and decision 32 promoted this file rather than retiring it:
/// it is a peer of the window, the only interface that survives a feature having no control yet, the
/// only one usable over SSH or from dotfiles — and it reloads live.
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

    /// How long a deleted note stays recoverable (decision 20). The Storage tab's control.
    ///
    /// This replaced `deleteAfterDays`, which was the opposite feature wearing the same shape: that
    /// one deleted notes for the crime of being old, which is the thing a notes app must never do to
    /// a thought you had four months ago. This one only ever counts from the moment you asked.
    public var recentlyDeletedDays: Int

    public static let recentlyDeletedOptions = [7, 30, 90]

    // MARK: Hotkey

    public var summonHotkey: Hotkey

    public enum DismissMode: String, Codable, Equatable, Sendable {
        /// The design's default: the summon hotkey toggles the pane away again.
        case sameHotkeyToggles
        /// For people who bind summon to something they also want to press while the pane is open.
        case escapeOnly
    }

    public var dismissMode: DismissMode

    // MARK: In-pane shortcuts

    /// The shortcuts that work inside a pane, keyed by action — design frame 3c's table.
    ///
    /// Only the summon hotkey is global (Carbon, `GlobalHotkey`); these are ordinary key bindings the
    /// web layer installs, so they are stored as CodeMirror binding strings — `"Mod-p"` — rather than
    /// as `Hotkey`, which exists to carry Carbon key codes.
    ///
    /// A dictionary rather than one field per action for the reason the design gives for the table
    /// being a plain table: every future feature adds a row, never a new control. Unknown keys are
    /// kept on load so a newer Pane's settings file survives a downgrade.
    public var shortcuts: [String: String]

    /// Action key, the label the tab shows, and the binding Pane ships with.
    ///
    /// Deliberately only the actions that exist — decision 31. Of frame 3c's eight rows the only one
    /// still absent is Open in New Pane, which belongs to multi-pane (decision 18); a recordable row
    /// that binds nothing is worse than an absent one. Adding one back is one entry here, which is
    /// exactly what happened to Action Panel when ⌘K landed, and to Find in Note with decision 38.
    ///
    /// Most of these are also ⌘K rows, so the shortcut printed beside a row and the shortcut in this
    /// table are the same binding rather than two things that have to be kept in step.
    /// The rebindable in-pane shortcuts (design frame 3c).
    ///
    /// **These defaults are habit-compatible with Raycast Notes and that is deliberate** (decision
    /// 39). Raycast Notes is what Pane was built against and what its user is leaving, so every
    /// action both apps have carries the same key — checked row by row against Raycast's own ⌘K
    /// panel. Pane's extra rows sit on chords Raycast leaves free.
    ///
    /// So treat this table as frozen. A key here that reads better in isolation still costs a
    /// switcher their muscle memory, and a shortcut some *other* app has claimed system-wide is what
    /// the recorder is for (decision 15) — not a reason to move the shipped default.
    /// Every rebindable action, in the order the Shortcuts tab lists them — which is ⌘K's order,
    /// grouped the way ⌘K groups them. One list of sixteen rows sorted by nothing in particular is
    /// hard to look anything up in, and the panel had already settled what belongs beside what.
    public static let shortcutActions:
        [(key: String, label: String, standard: String, group: String)] = [
            ("newNote", "New Note", "Mod-n", "Notes"),
            ("duplicateNote", "Duplicate Note", "Mod-d", "Notes"),
            ("browseNotes", "Browse Notes", "Mod-p", "Notes"),
            ("navigateBack", "Back", "Mod-[", "Notes"),
            ("navigateForward", "Forward", "Mod-]", "Notes"),

            ("findInNote", "Find in Note", "Mod-f", "This note"),
            ("copyAsMarkdown", "Copy as Markdown", "Shift-Mod-c", "This note"),
            ("revealInFinder", "Reveal in Finder", "Alt-Mod-r", "This note"),
            ("exportNote", "Export…", "Shift-Mod-e", "This note"),
            ("deleteNote", "Delete Note", "Ctrl-x", "This note"),

            ("actionPanel", "Action Panel", "Mod-k", "The pane"),
            ("pinPane", "Pin Pane", "Shift-Mod-p", "The pane"),
            ("autoSizing", "Window Auto-sizing", "Shift-Mod-/", "The pane"),
            ("formatBar", "Show Format Bar", "Alt-Mod-,", "The pane"),
            ("hideFromCapture", "Hide from Screen Capture", "Shift-Mod-h", "The pane"),
        ]

    public static var standardShortcuts: [String: String] {
        Dictionary(uniqueKeysWithValues: shortcutActions.map { ($0.key, $0.standard) })
    }

    /// The binding for `action`, falling back to what Pane ships with.
    public func shortcut(_ action: String) -> String {
        shortcuts[action] ?? Settings.standardShortcuts[action] ?? ""
    }

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

    /// Light and dark both ship in v0.1 (design frame 1f), and the Appearance tab switches them.
    public var appearance: Appearance

    /// The accent, as the hex the web layer's `--accent` wants.
    ///
    /// Reserved for interactive state and for list markers (decisions 22 and 28) — never body text.
    /// Frame 3b offers four; any hex parses, because the value reaches CSS either way and refusing a
    /// hand-typed colour in a file built to be hand-edited would be pure ceremony.
    public var accent: String

    public static let accentOptions: [(name: String, hex: String)] = [
        ("Amber", "#c98a1f"), ("Indigo", "#5b67d8"), ("Teal", "#2f9e8f"), ("Graphite", "#6e7480"),
    ]

    /// Filename of the markdown theme CSS in the themes folder, or empty for Pane's own.
    ///
    /// Decision 19: a theme *is* a CSS file in a folder, so this is a filename rather than an enum —
    /// which is what lets a theme arrive without any new UI or any new code.
    public var markdownTheme: String

    /// Editor body text size in points. ⌘= / ⌘− adjust it from any pane, ⌘0 resets it.
    public var textSize: Double

    /// The only legal range, named once so the keyboard and a hand-edited file agree.
    public static let textSizeRange: ClosedRange<Double> = 10...32

    /// Translucent panes. Turning this off swaps the vibrancy material for a flat background —
    /// the design's own props block does exactly this.
    public var translucentPanes: Bool

    /// Frame 2a's "Hide While Screen Sharing", as `NSWindow.sharingType` (decision 36).
    ///
    /// A setting rather than a per-session toggle because the reason anyone turns it on — I present
    /// from this machine — outlives the pane, and a protection that quietly lapses on restart is
    /// worse than one that was never offered.
    public var hideFromScreenCapture: Bool

    // MARK: Defaults

    public init(
        schemaVersion: Int = Settings.currentSchemaVersion,
        vaultPath: String = Settings.defaultVaultPath,
        recentlyDeletedDays: Int = 30,
        summonHotkey: Hotkey = .defaultSummon,
        dismissMode: DismissMode = .sameHotkeyToggles,
        shortcuts: [String: String] = Settings.standardShortcuts,
        launchAtLogin: Bool = false,
        showMenuBarIcon: Bool = true,
        showDockIcon: Bool = false,
        appearance: Appearance = .system,
        accent: String = "#c98a1f",
        markdownTheme: String = "",
        textSize: Double = 15,
        translucentPanes: Bool = true,
        hideFromScreenCapture: Bool = false
    ) {
        self.schemaVersion = schemaVersion
        self.vaultPath = vaultPath
        self.recentlyDeletedDays = recentlyDeletedDays
        self.summonHotkey = summonHotkey
        self.dismissMode = dismissMode
        self.shortcuts = shortcuts
        self.launchAtLogin = launchAtLogin
        self.showMenuBarIcon = showMenuBarIcon
        self.showDockIcon = showDockIcon
        self.appearance = appearance
        self.accent = accent
        self.markdownTheme = markdownTheme
        self.textSize = textSize
        self.translucentPanes = translucentPanes
        self.hideFromScreenCapture = hideFromScreenCapture
    }

    /// Every key is optional on the way in. This file is meant to be hand-edited, which means it
    /// will sometimes be hand-broken: a missing key, a stray comma removed along with the line it
    /// was on. One bad field should cost that field's value, not the launch.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Settings()
        schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? d.schemaVersion
        vaultPath = try c.decodeIfPresent(String.self, forKey: .vaultPath) ?? d.vaultPath
        recentlyDeletedDays =
            try c.decodeIfPresent(Int.self, forKey: .recentlyDeletedDays) ?? d.recentlyDeletedDays
        summonHotkey = try c.decodeIfPresent(Hotkey.self, forKey: .summonHotkey) ?? d.summonHotkey
        dismissMode = try c.decodeIfPresent(DismissMode.self, forKey: .dismissMode) ?? d.dismissMode
        // Merged over the standards rather than replacing them, so a file that names one shortcut
        // still gets all the others — the same forgiveness every other key here gets, and what lets
        // a settings.json written by an older build stay valid as rows are added.
        shortcuts = Settings.standardShortcuts.merging(
            try c.decodeIfPresent([String: String].self, forKey: .shortcuts) ?? [:]
        ) { _, fromFile in fromFile }
        launchAtLogin = try c.decodeIfPresent(Bool.self, forKey: .launchAtLogin) ?? d.launchAtLogin
        showMenuBarIcon = try c.decodeIfPresent(Bool.self, forKey: .showMenuBarIcon) ?? d.showMenuBarIcon
        showDockIcon = try c.decodeIfPresent(Bool.self, forKey: .showDockIcon) ?? d.showDockIcon
        appearance = try c.decodeIfPresent(Appearance.self, forKey: .appearance) ?? d.appearance
        accent = try c.decodeIfPresent(String.self, forKey: .accent) ?? d.accent
        markdownTheme = try c.decodeIfPresent(String.self, forKey: .markdownTheme) ?? d.markdownTheme
        textSize = try c.decodeIfPresent(Double.self, forKey: .textSize) ?? d.textSize
        translucentPanes = try c.decodeIfPresent(Bool.self, forKey: .translucentPanes) ?? d.translucentPanes
        hideFromScreenCapture =
            try c.decodeIfPresent(Bool.self, forKey: .hideFromScreenCapture) ?? d.hideFromScreenCapture

        // Clamp rather than reject: a hand-typed 0 or 9999 should land somewhere sensible.
        textSize = min(max(textSize, Settings.textSizeRange.lowerBound), Settings.textSizeRange.upperBound)
        // 0 would mean "delete immediately, no undo" — the one value this control must never carry.
        recentlyDeletedDays = min(max(recentlyDeletedDays, 1), 365)
        // The accent lands in CSS, so anything that is not a colour has to be caught here rather
        // than silently blanking `--accent` and taking every interactive affordance with it.
        if !Settings.isHexColour(accent) { accent = d.accent }
        // A theme is a bare filename in the themes folder. A path would let a hand-edited settings
        // file reach outside it, which is not what decision 19 offers.
        if markdownTheme.contains("/") || markdownTheme.hasPrefix(".") { markdownTheme = "" }
    }

    static func isHexColour(_ value: String) -> Bool {
        guard value.hasPrefix("#") else { return false }
        let digits = value.dropFirst()
        return (digits.count == 6 || digits.count == 3)
            && digits.allSatisfy(\.isHexDigit)
    }
}
