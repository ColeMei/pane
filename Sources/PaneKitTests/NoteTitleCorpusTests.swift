import Foundation
import PaneKit

/// The corpus the title bar is held to as well.
///
/// `Editor/src/note-title.ts` is a port of `MarkdownDocument.title(of:)` — the title bar needs the
/// answer on every keystroke and cannot afford a bridge round trip for it (decision 54) — so the
/// rules genuinely live in two places. This table is run against both: here, and through a
/// WKWebView probe against the TypeScript. Two names for one note is the bug it exists to catch.
let noteTitleCorpus: [(String, String)] = [
            ("Standup notes", "Standup notes"),
            ("# Heading", "Heading"),
            ("## Closed ##", "Closed"),
            ("#hashtag", "#hashtag"),
            ("**A research plan**", "A research plan"),
            ("*italic* and `code`", "italic and code"),
            ("~~struck~~", "struck"),
            ("- bullet item", "bullet item"),
            ("1. numbered item", "numbered item"),
            ("- [ ] a task", "a task"),
            ("- [x] done task", "done task"),
            ("> quoted line", "quoted line"),
            (">> double quoted", "double quoted"),
            ("> - quoted bullet", "quoted bullet"),
            ("\n\n  \nAfter blank lines", "After blank lines"),
            ("[Link label](https://example.com)", "Link label"),
            ("![alt text](image.png)", "alt text"),
            ("escaped \\*not emphasis\\*", "escaped *not emphasis*"),
            ("---", "---"),
            ("", ""),
]

func runNoteTitleCorpusTests() {
    Check.suite("Title, shared with the web layer") {
        for (input, expected) in noteTitleCorpus {
            Check.test("title of \(input.debugDescription)") {
                Check.equal(MarkdownDocument.title(of: input), expected)
            }
        }
    }
}
