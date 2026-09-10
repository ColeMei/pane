import Foundation
import PaneKit

/// The welcome note is the only documentation most people will read, and it is the one string in the
/// product that is also a *specimen* — it has to be markdown worth rendering, not prose about
/// markdown. These cases guard the two ways it has gone wrong: naming something that stops being
/// true, and losing a construct it exists to demonstrate.
func runWelcomeNoteTests() {
    Check.suite("Welcome note") {
        let text = WelcomeNote.text

        Check.test("teaches every key a new user needs, ⌘K included") {
            // ⌘K was absent from the first version for ten releases while carrying fifteen actions.
            for key in ["⌃⌥Space", "⌘N", "⌘P", "⌘K", "⇧⌘/"] {
                Check.expect(text.contains(key), "the note never mentions \(key)")
            }
        }

        Check.test("names no vault path") {
            // `~/Documents/Pane` is true only until someone moves their vault, after which the note
            // is a lie sitting in the user's own folder — and it is never rewritten, because it is an
            // ordinary note they own. Decision 129.
            for path in ["~/Documents", "Documents/Pane", "/Users/"] {
                Check.expect(!text.contains(path), "the note hardcodes \(path)")
            }
        }

        Check.test("is a specimen of the constructs it claims to render") {
            // Each of these is demonstrated rather than described. A checkbox that lost its brackets
            // in an edit renders as an ordinary bullet, which is exactly the section failing silently.
            let required: [(String, String)] = [
                ("# ", "a heading"),
                ("- [ ] ", "an unticked checkbox"),
                ("- [x] ", "a ticked checkbox"),
                ("**", "bold"),
                ("*italic*", "italic"),
                ("`code`", "inline code"),
                ("> ", "a blockquote"),
            ]
            for (needle, what) in required {
                Check.expect(text.contains(needle), "the note demonstrates no \(what)")
            }
        }

        Check.test("every list uses one marker") {
            // Decision 59: a new bullet takes the marker the list above is using. A note that mixes
            // `*` and `-` is teaching the opposite of what the editor does.
            let starred = text.split(separator: "\n").filter { $0.hasPrefix("* ") }
            Check.expect(starred.isEmpty, "mixes `*` bullets with `-`: \(starred)")
        }

        Check.test("its title is the one the filename will be slugged from") {
            Check.equal(MarkdownDocument.title(of: text), "Welcome to Pane")
        }

        Check.test("ends with exactly one trailing newline") {
            // Decision 10's promise applies to the note Pane writes itself, first of all.
            Check.expect(text.hasSuffix("\n"), "no trailing newline")
            Check.expect(!text.hasSuffix("\n\n"), "more than one trailing newline")
        }

        Check.test("stays short enough to finish") {
            // The brief's own constraint. 138 words at the rewrite; this is a ceiling with room, not
            // a pin — it exists so the note cannot drift into a manual unnoticed.
            let words = text.split(whereSeparator: { $0.isWhitespace }).count
            Check.expect(words < 200, "the welcome note has grown to \(words) words")
        }
    }
}
