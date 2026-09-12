import Foundation
import PaneKit

func runLinkTargetTests() {
    Check.suite("Link target") {

        // The three forms the report named, and the one it did not think to.
        Check.test("an ordinary link opens as itself") {
            Check.equal(LinkTarget.resolve("https://example.com/one")?.absoluteString, "https://example.com/one")
            Check.equal(LinkTarget.resolve("http://example.com")?.absoluteString, "http://example.com")
        }

        // The form a scheme allowlist rejects if it runs before normalisation, and the reason the
        // two steps are ordered rather than merged.
        Check.test("a www link is given the scheme it means") {
            Check.equal(LinkTarget.resolve("www.anthropic.com")?.absoluteString, "https://www.anthropic.com")
            Check.equal(LinkTarget.resolve("WWW.Anthropic.com")?.absoluteString, "https://WWW.Anthropic.com")
            Check.equal(LinkTarget.resolve("www.example.com/a/b?c=d")?.absoluteString,
                        "https://www.example.com/a/b?c=d")
        }

        // Pane's parser linkifies these; Raycast's does not. Decision 121 already gives them the
        // accent, so leaving them inert would ship a link that does nothing.
        Check.test("a bare address becomes mailto") {
            Check.equal(LinkTarget.resolve("a@b.com")?.absoluteString, "mailto:a@b.com")
            Check.equal(LinkTarget.resolve("mailto:a@b.com")?.absoluteString, "mailto:a@b.com")
        }

        // Every one of these resolves to a real handler on this machine — TextEdit, Reminders,
        // Finder — which is why the allowlist is not theoretical.
        Check.test("a scheme that launches something else is declined") {
            Check.equal(LinkTarget.resolve("file:///etc/passwd") == nil, true)
            Check.equal(LinkTarget.resolve("x-apple-reminderkit://x") == nil, true)
            Check.equal(LinkTarget.resolve("ftp://example.com") == nil, true)
            Check.equal(LinkTarget.resolve("javascript:alert(1)") == nil, true)
            Check.equal(LinkTarget.resolve("data:text/html,<script>") == nil, true)
        }

        // The known gap, asserted rather than left to be rediscovered: it renders as a link and
        // does not open.
        Check.test("xmpp renders as a link and is not one of the three") {
            Check.equal(LinkTarget.resolve("xmpp:a@b.com") == nil, true)
        }

        Check.test("a scheme is matched however it is cased") {
            Check.equal(LinkTarget.resolve("HTTPS://example.com")?.scheme?.lowercased(), "https")
            Check.equal(LinkTarget.resolve("HtTp://example.com")?.scheme?.lowercased(), "http")
            Check.equal(LinkTarget.resolve("FILE:///etc/passwd") == nil, true)
        }

        // Scheme-less and not one of the two forms that imply one. A bare host never reaches here
        // from the parser, but nothing about this function should depend on that.
        Check.test("scheme-less text that means nothing is declined") {
            Check.equal(LinkTarget.resolve("example.com") == nil, true)
            Check.equal(LinkTarget.resolve("//evil.com") == nil, true)
            Check.equal(LinkTarget.resolve("nonsense") == nil, true)
            Check.equal(LinkTarget.resolve("") == nil, true)
            Check.equal(LinkTarget.resolve("   ") == nil, true)
        }

        Check.test("surrounding whitespace is not part of the link") {
            Check.equal(LinkTarget.resolve("  https://example.com  ")?.absoluteString, "https://example.com")
            Check.equal(LinkTarget.resolve("\nwww.example.com\n")?.absoluteString, "https://www.example.com")
        }

        Check.test("a space inside it means it is not a URL") {
            Check.equal(LinkTarget.resolve("https://example.com/a b") == nil, true)
            Check.equal(LinkTarget.resolve("www.example.com two") == nil, true)
        }

        // `isBareEmail` decides which of the two scheme-less normalisations applies, so the line
        // between a host and an address is load-bearing rather than cosmetic.
        Check.test("an address is told apart from a host") {
            Check.equal(LinkTarget.resolve("a@b@c.com") == nil, true)
            Check.equal(LinkTarget.resolve("@b.com") == nil, true)
            Check.equal(LinkTarget.resolve("a@b") == nil, true)
            Check.equal(LinkTarget.resolve("a@b.")  == nil, true)
            Check.equal(LinkTarget.resolve("first.last@sub.example.com")?.absoluteString,
                        "mailto:first.last@sub.example.com")
        }

        // `www.` wins over the address test when a string could be read as either, because the
        // parser only produces the `www.` form for something it parsed as a host.
        Check.test("a www host carrying an at sign is still a host") {
            Check.equal(LinkTarget.resolve("www.example.com/a@b")?.scheme, "https")
        }
    }
}
