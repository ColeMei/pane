import Foundation
import PaneKit

func runMarkdownDocumentTests() {
    Check.suite("Reading a note") {

        // MARK: - Trailing newline

        Check.test("normalises to exactly one trailing newline") {
            Check.equal(MarkdownDocument.normalizeTrailingNewline("# Title"), "# Title\n")
            Check.equal(MarkdownDocument.normalizeTrailingNewline("# Title\n"), "# Title\n")
            Check.equal(MarkdownDocument.normalizeTrailingNewline("# Title\n\n\n"), "# Title\n")
            Check.equal(MarkdownDocument.normalizeTrailingNewline("# Title\r\n"), "# Title\n")
        }

        Check.test("an empty file stays empty rather than becoming a blank line") {
            Check.equal(MarkdownDocument.normalizeTrailingNewline(""), "")
            Check.equal(MarkdownDocument.normalizeTrailingNewline("\n\n"), "")
        }

        Check.test("is idempotent, which stops it generating a phantom diff on every open") {
            let once = MarkdownDocument.normalizeTrailingNewline("a\nb\n\n\n")
            Check.equal(MarkdownDocument.normalizeTrailingNewline(once), once)
        }

        Check.test("leaves interior CRLF alone — rewriting them would be a whole-file diff") {
            let normalised = MarkdownDocument.normalizeTrailingNewline("# Title\r\n\r\nBody\r\n\r\n\r\n")
            Check.equal(normalised, "# Title\r\n\r\nBody\n")
        }

        // MARK: - Title

        Check.test("the title is the first line, with its heading markers stripped") {
            Check.equal(MarkdownDocument.title(of: "# Standup Thursday\nbody\n"), "Standup Thursday")
            Check.equal(MarkdownDocument.title(of: "### Deep heading\n"), "Deep heading")
            Check.equal(MarkdownDocument.title(of: "## Closed form ##\n"), "Closed form")
            Check.equal(MarkdownDocument.title(of: "Just text\n"), "Just text")
        }

        Check.test("skips leading blank lines") {
            Check.equal(MarkdownDocument.title(of: "\n\n   \n# Real title\n"), "Real title")
        }

        Check.test("#hashtag is not a heading") {
            Check.equal(MarkdownDocument.title(of: "#todo pick up milk\n"), "#todo pick up milk")
        }

        Check.test("strips inline emphasis so a row reads as prose") {
            Check.equal(MarkdownDocument.title(of: "# **Bold** and _italic_\n"), "Bold and italic")
            Check.equal(MarkdownDocument.title(of: "`git diff --stat`\n"), "git diff --stat")
            Check.equal(MarkdownDocument.title(of: "~~struck~~ through\n"), "struck through")
        }

        Check.test("links collapse to their label, not their URL") {
            Check.equal(
                MarkdownDocument.title(of: "See [the manual](https://example.com/x) today\n"),
                "See the manual today"
            )
            Check.equal(MarkdownDocument.title(of: "![alt text](a.png)\n"), "alt text")
        }

        Check.test("keeps escaped punctuation the user deliberately escaped") {
            Check.equal(MarkdownDocument.title(of: #"a \*literal\* star"#), "a *literal* star")
        }

        Check.test("an empty document has no title and no preview") {
            Check.equal(MarkdownDocument.title(of: ""), "")
            Check.equal(MarkdownDocument.bodyPreview(of: ""), "")
            Check.equal(MarkdownDocument.bodyPreview(of: "# Only a title\n"), "")
        }

        // MARK: - Preview

        Check.test("the preview is the first line of body, never a character count") {
            let note = """
                # Pre-confrimation Preparing

                Before your meeting you should prepare the following:

                1. **A written thesis overview** outlining your proposed project structure.
                """
            Check.equal(
                MarkdownDocument.bodyPreview(of: note),
                "Before your meeting you should prepare the following:"
            )
        }

        Check.test("list markers and checkboxes are stripped from the preview") {
            Check.equal(
                MarkdownDocument.bodyPreview(of: "# T\n- [x] review FSEvents debounce PR\n"),
                "review FSEvents debounce PR"
            )
            Check.equal(
                MarkdownDocument.bodyPreview(of: "# T\n- [ ] ask Marta about the eviction case\n"),
                "ask Marta about the eviction case"
            )
            Check.equal(MarkdownDocument.bodyPreview(of: "# T\n1. First item\n"), "First item")
            Check.equal(MarkdownDocument.bodyPreview(of: "# T\n> quoted line\n"), "quoted line")
        }

        Check.test("a horizontal rule is not a bullet") {
            Check.equal(MarkdownDocument.bodyPreview(of: "# T\n---\ntext\n"), "---")
        }

        Check.test("title and preview together match reading them separately") {
            let note = "# Server IPs + ports\nprod    10.0.4.12\nstaging 10.0.7.3\n"
            let s = MarkdownDocument.summary(of: note)
            Check.equal(s.title, MarkdownDocument.title(of: note))
            Check.equal(s.preview, MarkdownDocument.bodyPreview(of: note))
            Check.equal(s.title, "Server IPs + ports")
            Check.equal(s.preview, "prod    10.0.4.12")
        }

        Check.test("two notes named the same stay distinguishable by their preview line") {
            // The brief's motivating case: a vault with two notes both called "8-11 - 2".
            let a = "8-11 - 2\nethics application — outstanding items for Friday\n"
            let b = "8-11 - 2\npanel growth rules, first sketch\n"
            Check.equal(MarkdownDocument.title(of: a), MarkdownDocument.title(of: b))
            Check.notEqual(MarkdownDocument.bodyPreview(of: a), MarkdownDocument.bodyPreview(of: b))
        }
    }
}
