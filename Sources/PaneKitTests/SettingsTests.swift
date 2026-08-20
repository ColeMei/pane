import Foundation
import PaneKit

func runSettingsTests() {
    Check.suite("Menu key equivalents") {

        func check(_ binding: String, _ key: String, _ modifiers: Set<Settings.Modifier>) {
            let combo = Settings.menuKeyEquivalent(for: binding)
            Check.equal(combo?.key, key)
            Check.equal(combo?.modifiers, modifiers)
        }

        // The File menu reads these from the same table the Shortcuts tab records into, so a
        // rebound New Note moves the menu's key with it. They used to be literals in AppDelegate,
        // which made ⌘N and ⌘P the two rebindable actions that could not be rebound.
        Check.test("plain command") { check("Mod-n", "n", [.command]) }
        Check.test("shift and command") { check("Shift-Mod-p", "p", [.command, .shift]) }
        Check.test("control alone") { check("Ctrl-x", "x", [.control]) }
        Check.test("option and command") { check("Alt-Mod-,", ",", [.option, .command]) }
        Check.test("punctuation key") { check("Shift-Mod-/", "/", [.command, .shift]) }
        Check.test("bracket key") { check("Mod-[", "[", [.command]) }

        // Anything it cannot express returns nil, and the item drops its key rather than
        // advertising one that is not what the editor is bound to.
        Check.test("named keys are declined") {
            Check.equal(Settings.menuKeyEquivalent(for: "Mod-Enter") == nil, true)
        }
        Check.test("an empty binding is declined") {
            Check.equal(Settings.menuKeyEquivalent(for: "") == nil, true)
        }
        Check.test("an unknown modifier is declined") {
            Check.equal(Settings.menuKeyEquivalent(for: "Hyper-n") == nil, true)
        }

        // Every shipped default has to survive the round trip, or a menu item silently loses its key.
        Check.test("every shipped binding is expressible") {
            for action in Settings.shortcutActions {
                Check.equal(
                    Settings.menuKeyEquivalent(for: action.standard) != nil,
                    true,
                    "\(action.key) → \(action.standard)"
                )
            }
        }
    }
}
