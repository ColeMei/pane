import Foundation

/// A global hotkey, expressed the way a human would type it into a settings file.
///
/// Decision 12 ships v0.1 with no recorder UI and one promise instead: "anyone who wants a different
/// combo can edit one line." That only holds if the line is legible, so the stored form is
/// `"control+option+space"` rather than a pair of integers nobody can guess. The Carbon key code and
/// modifier mask are derived from it at registration time.
///
/// Deliberately Foundation-only — no `import Carbon` — so this stays testable in PaneKit. The
/// constants below are the `kVK_*` and modifier values, which are fixed ABI and have not changed
/// since Carbon shipped.
public struct Hotkey: Codable, Equatable, Sendable, CustomStringConvertible {

    /// The design's default: ⌃⌥Space.
    ///
    /// ⌥Space is almost always taken (Alfred, input-method switchers) and chorded letters like ⌃⌥⌘N
    /// are somebody's muscle memory already. ⌃⌥Space is rarely claimed and works one-handed. It also
    /// satisfies decision 12's hard constraint: it is *not* ⌥N, Raycast Notes' binding — colliding
    /// with the tool Pane replaces would make the first run look broken to exactly the person most
    /// likely to try it.
    public static let defaultSummon = Hotkey(keyCode: KeyCode.space, modifiers: [.control, .option])

    public struct Modifiers: OptionSet, Codable, Equatable, Sendable {
        public let rawValue: UInt32
        public init(rawValue: UInt32) { self.rawValue = rawValue }

        /// Carbon `EventModifiers` bits, as `RegisterEventHotKey` wants them.
        public static let command = Modifiers(rawValue: 0x0100)
        public static let shift   = Modifiers(rawValue: 0x0200)
        public static let option  = Modifiers(rawValue: 0x0800)
        public static let control = Modifiers(rawValue: 0x1000)
    }

    public var keyCode: UInt32
    public var modifiers: Modifiers

    public init(keyCode: UInt32, modifiers: Modifiers) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }

    // MARK: - Parsing

    public enum ParseError: Error, Equatable, CustomStringConvertible {
        case empty
        case unknownToken(String)
        case noKey
        case multipleKeys(String, String)
        case modifiersOnly

        public var description: String {
            switch self {
            case .empty:
                return "the hotkey is blank"
            case .unknownToken(let t):
                return "\"\(t)\" is not a key or modifier Pane recognises"
            case .noKey, .modifiersOnly:
                return "a hotkey needs a key, not just modifiers"
            case .multipleKeys(let a, let b):
                return "a hotkey takes one key, but got both \"\(a)\" and \"\(b)\""
            }
        }
    }

    /// Parses `"control+option+space"`, `"⌃⌥Space"`, `"ctrl opt space"` and friends.
    ///
    /// Separators are `+`, `-`, whitespace, or nothing at all when the modifiers are symbols. Case
    /// and order are irrelevant. A settings file is edited by hand, so it should forgive the shapes
    /// a hand actually types.
    public static func parse(_ input: String) throws -> Hotkey {
        var mods: Modifiers = []
        var key: (name: String, code: UInt32)?

        for token in tokenize(input) {
            if let m = Self.modifierNames[token] {
                mods.insert(m)
            } else if let code = KeyCode.named[token] {
                if let existing = key { throw ParseError.multipleKeys(existing.name, token) }
                key = (token, code)
            } else {
                throw ParseError.unknownToken(token)
            }
        }

        guard let key else {
            throw mods.isEmpty ? ParseError.empty : ParseError.modifiersOnly
        }
        return Hotkey(keyCode: key.code, modifiers: mods)
    }

    /// Splits on separators, then peels leading modifier *symbols* off a token like `⌃⌥Space`.
    private static func tokenize(_ input: String) -> [String] {
        let separators = CharacterSet(charactersIn: "+- \t").union(.whitespacesAndNewlines)
        let rough = input.components(separatedBy: separators).filter { !$0.isEmpty }

        var out: [String] = []
        for piece in rough {
            var rest = Substring(piece)
            while let first = rest.first, symbolModifiers.keys.contains(String(first)) {
                out.append(String(first))
                rest = rest.dropFirst()
            }
            if !rest.isEmpty { out.append(rest.lowercased()) }
        }
        return out
    }

    private static let symbolModifiers: [String: Modifiers] = [
        "⌘": .command, "⇧": .shift, "⌥": .option, "⌃": .control,
    ]

    private static let modifierNames: [String: Modifiers] = {
        var m: [String: Modifiers] = [
            "cmd": .command, "command": .command, "meta": .command,
            "shift": .shift,
            "opt": .option, "option": .option, "alt": .option,
            "ctrl": .control, "control": .control,
        ]
        for (symbol, mod) in symbolModifiers { m[symbol] = mod }
        return m
    }()

    // MARK: - Display

    /// The canonical written form, which is what gets saved back to the settings file.
    public var settingsString: String {
        var parts: [String] = []
        if modifiers.contains(.control) { parts.append("control") }
        if modifiers.contains(.option)  { parts.append("option") }
        if modifiers.contains(.shift)   { parts.append("shift") }
        if modifiers.contains(.command) { parts.append("command") }
        parts.append(KeyCode.name(for: keyCode) ?? "key\(keyCode)")
        return parts.joined(separator: "+")
    }

    /// The symbol form the UI shows: `⌃⌥Space`. Modifier order follows Apple's convention
    /// (control, option, shift, command), which is the order every other Mac app displays.
    public var displayString: String {
        var s = ""
        if modifiers.contains(.control) { s += "⌃" }
        if modifiers.contains(.option)  { s += "⌥" }
        if modifiers.contains(.shift)   { s += "⇧" }
        if modifiers.contains(.command) { s += "⌘" }
        return s + (KeyCode.displayName(for: keyCode) ?? "?")
    }

    public var description: String { displayString }

    // MARK: - Codable

    /// Encoded as its string form so state and settings files stay hand-editable. An unparseable
    /// value falls back to the default rather than throwing: a typo in a settings file should cost
    /// the user their custom hotkey, not the ability to launch the app.
    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = (try? Hotkey.parse(raw)) ?? .defaultSummon
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(settingsString)
    }
}

/// Virtual key codes. These are the Carbon `kVK_*` values — hardware positions, not characters, so
/// they are layout-independent and identical on every Mac.
public enum KeyCode {
    public static let space: UInt32 = 49

    static let named: [String: UInt32] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
        "equal": 24, "minus": 27,
        "rightbracket": 30, "leftbracket": 33,
        "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
        "quote": 39, "semicolon": 41, "backslash": 42, "comma": 43, "slash": 44, "period": 47,
        "grave": 50, "backtick": 50,
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53, "esc": 53,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        "home": 115, "pageup": 116, "forwarddelete": 117, "end": 119, "pagedown": 121,
        "left": 123, "right": 124, "down": 125, "up": 126,
    ]

    /// Canonical name for a code, preferring the spelling `settingsString` should emit when several
    /// names map to the same key.
    static func name(for code: UInt32) -> String? {
        let preferred = ["space", "return", "tab", "escape", "delete", "grave"]
        for p in preferred where named[p] == code { return p }
        return named.first { $0.value == code }?.key
    }

    /// The name CodeMirror binds by, which is `KeyboardEvent.key` rather than a hardware position.
    ///
    /// Separate from `displayName` because the two answer different questions: one is what to draw in
    /// a recorder, the other is what to put in a keymap. `⌫` and `"Backspace"` are the same key and
    /// neither string works in the other place.
    public static func bindingName(for code: UInt32) -> String? {
        let special: [UInt32: String] = [
            49: "Space", 36: "Enter", 48: "Tab", 53: "Escape",
            51: "Backspace", 117: "Delete",
            123: "ArrowLeft", 124: "ArrowRight", 125: "ArrowDown", 126: "ArrowUp",
            115: "Home", 119: "End", 116: "PageUp", 121: "PageDown",
            24: "=", 27: "-", 30: "]", 33: "[",
            39: "'", 41: ";", 42: "\\", 43: ",", 44: "/", 47: ".", 50: "`",
        ]
        if let s = special[code] { return s }
        guard let n = name(for: code), n.count == 1 else {
            // Function keys keep their own names; anything else has no keymap spelling.
            return name(for: code).flatMap { $0.hasPrefix("f") ? $0.uppercased() : nil }
        }
        return n
    }

    static func displayName(for code: UInt32) -> String? {
        let symbols: [UInt32: String] = [
            49: "Space", 36: "↩", 48: "⇥", 53: "⎋", 51: "⌫", 117: "⌦",
            123: "←", 124: "→", 125: "↓", 126: "↑",
            115: "↖", 119: "↘", 116: "⇞", 121: "⇟",
        ]
        if let s = symbols[code] { return s }
        guard let n = name(for: code) else { return nil }
        return n.count == 1 ? n.uppercased() : n.capitalized
    }
}
