import AppKit
import PaneKit

/// The menu bar item, design frame 2d.
///
/// The pinned section is the only part that moves: it is one item per pinned note, and it disappears
/// entirely — along with one of the separators — when nothing is pinned. A menu with an empty region
/// in the middle of it looks broken, and pins are per-machine (decision 11), so an empty section is
/// the normal state on a fresh Mac.
@MainActor
final class MenuBarController: NSObject {

    private let item: NSStatusItem
    private let menu = NSMenu()

    var onShow: (() -> Void)?
    var onNewNote: (() -> Void)?
    var onBrowse: (() -> Void)?
    var onActions: (() -> Void)?
    var onOpenNote: ((String) -> Void)?
    var onSettings: (() -> Void)?
    var onOpenReleases: (() -> Void)?

    /// Supplies the pinned notes as (filename, title) pairs, most recently used first.
    var pinnedNotes: () -> [(filename: String, title: String)] = { [] }

    init(hotkey: Hotkey) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()

        if let button = item.button {
            button.image = Self.statusImage
            button.toolTip = "Pane — \(hotkey.displayString)"
            button.target = self
            button.action = #selector(clicked)
            // Both buttons, or the action fires on the left one only and a right-click does nothing
            // at all — the state of this control before the split, since `item.menu` swallowed both.
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        menu.delegate = self
        // Deliberately **not** `item.menu`: setting it hands AppKit both buttons and the status
        // item's own action is never called. The menu is opened by hand in `showMenu` instead.
        rebuild(hotkey: hotkey)
    }

    /*
     * Left summons, right opens the menu.
     *
     * The convention every menu bar app with one primary action follows, and Pane has exactly one:
     * the icon is a second way to press the hotkey, for the machine where something else has claimed
     * it or the week you have not learned it yet. Before this both buttons opened the menu, so the
     * frequent thing was two clicks away from the icon and the rare thing was one.
     *
     * A control-click is a right-click on macOS and always has been, so it goes to the menu too — a
     * trackpad with secondary click switched off has no other way in.
     */
    @objc private func clicked() {
        let event = NSApp.currentEvent
        let secondary = event?.type == .rightMouseUp
            || event?.modifierFlags.contains(.control) == true
        if secondary { showMenu() } else { onShow?() }
    }

    /// Pops the menu under the item, with the item highlighted as if AppKit had opened it.
    ///
    /// `item.menu` is assigned for the length of one click and taken away again: a status item shows
    /// its menu on press when it has one, and `performClick` is the only call that gets the highlight
    /// and the placement right. Left set, it would take the left button back.
    private func showMenu() {
        item.menu = menu
        item.button?.performClick(nil)
        item.menu = nil
    }

    private var hotkey: Hotkey = .defaultSummon

    /// The newer version, when there is one — the menu item's title and the icon's dot.
    ///
    /// **Derived, never dismissed.** Nothing marks it as read: it is set from a version comparison
    /// and goes away when the running build catches up, so there is no flag here that can be wrong
    /// or stale. That is the difference between this and the toast, which fires once and is gone.
    private var updateAvailable: String?

    /// Tells the item a newer release exists, or that there is not one.
    func setUpdateAvailable(_ version: String?) {
        guard version != updateAvailable else { return }
        updateAvailable = version
        item.button?.image = version == nil ? Self.statusImage : Self.badgedStatusImage
        rebuild(hotkey: hotkey)
    }

    func rebuild(hotkey: Hotkey) {
        self.hotkey = hotkey
        menu.removeAllItems()

        // The summon item's shortcut goes in AppKit's key column like every other item's.
        //
        // It used to be part of the title — first three spaces and the glyphs, then a right-aligned
        // tab stop — and both landed short of the column ⌘N, ⌘P and ⌘K sit in, because that column
        // is inset from the menu's right edge by an amount an item's own text never reaches; making
        // the item wider widens the menu and takes the column with it. So it is a real key
        // equivalent, and `toggle` ignores a second call within a quarter second: the combination is
        // registered globally with Carbon (decision 9), and while Pane is frontmost — which is only
        // ever the Settings window — both would fire for one press.
        let show = NSMenuItem(title: "Show Pane", action: #selector(showPane), keyEquivalent: "")
        show.target = self
        if let key = hotkey.menuKeyEquivalent {
            show.keyEquivalent = key
            var mask: NSEvent.ModifierFlags = []
            if hotkey.modifiers.contains(.command) { mask.insert(.command) }
            if hotkey.modifiers.contains(.shift) { mask.insert(.shift) }
            if hotkey.modifiers.contains(.option) { mask.insert(.option) }
            if hotkey.modifiers.contains(.control) { mask.insert(.control) }
            show.keyEquivalentModifierMask = mask
        } else {
            show.attributedTitle = Self.title("Show Pane", shortcut: hotkey.displayString)
        }
        menu.addItem(show)

        menu.addItem(action("New Note", key: "n", selector: #selector(newNote)))
        menu.addItem(action("Browse Notes…", key: "p", selector: #selector(browse)))
        // Frame 2a justifies having no ⌘ toolbar button by pointing at "the footer hint and menu
        // bar". This is the menu bar half — without it, and without the footer hint, ⌘K was a panel
        // with no way to find out it existed.
        menu.addItem(action("Actions…", key: "k", selector: #selector(actionPanel)))

        let pinned = pinnedNotes()
        if !pinned.isEmpty {
            menu.addItem(.separator())
            for note in pinned {
                let entry = NSMenuItem(
                    title: note.title.isEmpty ? note.filename : note.title,
                    action: #selector(openPinned(_:)),
                    keyEquivalent: ""
                )
                entry.target = self
                entry.representedObject = note.filename
                entry.image = Self.pinImage
                menu.addItem(entry)
            }
        }

        menu.addItem(.separator())
        // Above Settings, and only while there is one. This is the durable half of decision 136:
        // the toast fires once and is gone, and this waits — in the app-level surface, because
        // updating the app is not something ⌘K does. ⌘K's fifteen rows all act on the note or the
        // pane, and a sixteenth that opened a browser would be the odd one out.
        if let version = updateAvailable {
            let update = NSMenuItem(
                title: "Update to \(version)…",
                action: #selector(openReleases),
                keyEquivalent: ""
            )
            update.target = self
            menu.addItem(update)
        }
        menu.addItem(action("Settings…", key: ",", selector: #selector(settings)))

        let quit = NSMenuItem(title: "Quit Pane", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    private func action(_ title: String, key: String, selector: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        return item
    }

    /// Right-aligned shortcut text in a menu item, for a combination that is not a key equivalent.
    /// "Show Pane" with its hotkey in the column AppKit puts every other item's key equivalent in.
    ///
    /// The shortcut used to be three spaces and the glyphs, so it landed wherever the title happened
    /// to end while ⌘N, ⌘P and ⌘K below it were right-aligned by AppKit — one item out of step in a
    /// six-item menu. A right-aligned tab stop puts it in the same column without making it a real
    /// key equivalent, which is what this must not become: the combination is a Carbon global hotkey
    /// (decision 9), and registering it twice in two systems is two owners for one keypress.
    private static func title(_ text: String, shortcut: String) -> NSAttributedString {
        let style = NSMutableParagraphStyle()
        style.tabStops = [NSTextTab(textAlignment: .right, location: 240)]

        let result = NSMutableAttributedString(
            string: text, attributes: [.paragraphStyle: style]
        )
        result.append(
            NSAttributedString(
                string: "\t\(shortcut)",
                attributes: [
                    .foregroundColor: NSColor.tertiaryLabelColor,
                    .paragraphStyle: style,
                ]
            )
        )
        return result
    }

    /// The menu bar glyph — Pane's own mark, drawn as a template so macOS tints it for the current
    /// menu bar rather than painting a black shape onto a dark background.
    ///
    /// Falls back to an SF Symbol when the resource is absent, which is the case for `swift run Pane`
    /// during development: `NSImage(named:)` reads the app bundle, and there isn't one.
    private static let statusImage: NSImage? = {
        let image = NSImage(named: "MenuBar")
            ?? NSImage(systemSymbolName: "note.text", accessibilityDescription: "Pane")
        image?.isTemplate = true
        image?.accessibilityDescription = "Pane"
        return image
    }()

    /// The same glyph with a dot in its top-right corner, for when a newer release exists.
    ///
    /// **Monochrome, and deliberately.** A coloured badge would mean dropping `isTemplate`, and
    /// template rendering is what makes this icon right in a dark menu bar, in a light one, while
    /// the item is highlighted, and under reduce-transparency — four appearances, none of which a
    /// hand-picked colour survives. A dot in the menu bar's own ink is less loud than an orange one
    /// and is legible in all four, which is the trade this takes.
    ///
    /// The dot is punched out of the glyph rather than painted over it: `.destinationOut` clears a
    /// slightly larger disc first, so the dot keeps its own edge even where the artwork runs under
    /// it. Without the gap, a dot touching the glyph reads as part of the drawing.
    private static let badgedStatusImage: NSImage? = {
        guard let base = statusImage else { return nil }
        let size = base.size
        let image = NSImage(size: size, flipped: false) { rect in
            base.draw(in: rect)

            // Derived from the icon's own height rather than written down, so the badge keeps its
            // proportion if the artwork is ever redrawn at another size (decision 82).
            let diameter = (size.height * 0.34).rounded()
            let gap = max(1, (diameter * 0.34).rounded())
            let dot = NSRect(
                x: size.width - diameter,
                y: size.height - diameter,
                width: diameter,
                height: diameter
            )

            NSGraphicsContext.current?.compositingOperation = .destinationOut
            NSBezierPath(ovalIn: dot.insetBy(dx: -gap, dy: -gap)).fill()
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            NSColor.black.setFill()
            NSBezierPath(ovalIn: dot).fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Pane — update available"
        return image
    }()

    private static let pinImage: NSImage? = {
        let image = NSImage(systemSymbolName: "pin.fill", accessibilityDescription: nil)
        image?.isTemplate = true
        return image
    }()

    // MARK: - Actions

    @objc private func showPane() { onShow?() }
    @objc private func newNote() { onNewNote?() }
    @objc private func browse() { onBrowse?() }
    @objc private func actionPanel() { onActions?() }
    @objc private func settings() { onSettings?() }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func openReleases() { onOpenReleases?() }

    @objc private func openPinned(_ sender: NSMenuItem) {
        guard let filename = sender.representedObject as? String else { return }
        onOpenNote?(filename)
    }
}

extension MenuBarController: NSMenuDelegate {
    /// Rebuilt on open rather than on every pin change, so the pinned section is right without the
    /// menu having to be told each time a note is pinned from inside a pane.
    func menuWillOpen(_ menu: NSMenu) {
        rebuild(hotkey: hotkey)
    }
}
