import Foundation
import PaneKit

func runMarkdownExportTests() {
    Check.suite("Markdown export") {

        Check.test("headings need their space, so a hashtag stays a hashtag") {
            Check.equal(MarkdownExport.body(from: "# Standup"), "<h1>Standup</h1>")
            Check.equal(MarkdownExport.body(from: "### Notes"), "<h3>Notes</h3>")
            Check.equal(MarkdownExport.body(from: "#hashtag"), "<p>#hashtag</p>")
        }

        Check.test("emphasis, strike and inline code") {
            Check.equal(
                MarkdownExport.body(from: "**bold** and *italic* and ~~gone~~"),
                "<p><strong>bold</strong> and <em>italic</em> and <s>gone</s></p>"
            )
        }

        Check.test("a code span suppresses the markup inside it") {
            // The whole reason someone reaches for backticks around markup.
            Check.equal(
                MarkdownExport.body(from: "use `**not bold**` here"),
                "<p>use <code>**not bold**</code> here</p>"
            )
        }

        Check.test("links") {
            Check.equal(
                MarkdownExport.body(from: "see [the brief](https://example.com/a?b=1&c=2)"),
                "<p>see <a href=\"https://example.com/a?b=1&amp;c=2\">the brief</a></p>"
            )
        }

        Check.test("HTML in the note is text, not markup") {
            // A note is a text file. If someone writes a tag in it, it is a tag they typed.
            Check.equal(
                MarkdownExport.body(from: "<script>alert(1)</script>"),
                "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"
            )
        }

        Check.test("a fenced block keeps its content verbatim and drops the language word") {
            // Decision 34: the language word changes nothing, because there is no highlighter.
            let html = MarkdownExport.body(from: "```python\nx = 1 < 2\n```")
            Check.equal(html, "<pre><code>x = 1 &lt; 2</code></pre>")
        }

        Check.test("unordered and ordered lists") {
            Check.equal(
                MarkdownExport.body(from: "- one\n- two"),
                "<ul><li>one</li><li>two</li></ul>"
            )
            Check.equal(
                MarkdownExport.body(from: "1. one\n2. two"),
                "<ol><li>one</li><li>two</li></ol>"
            )
        }

        Check.test("nested lists come from indentation") {
            let html = MarkdownExport.body(from: "- one\n  - deeper\n- two")
            Check.equal(html, "<ul><li>one<ul><li>deeper</li></ul></li><li>two</li></ul>")
        }

        Check.test("task checkboxes render both states and lose their brackets") {
            let html = MarkdownExport.body(from: "- [x] done\n- [ ] not done")
            Check.equal(
                html,
                "<ul><li class=\"task\"><input type=\"checkbox\" checked disabled>done</li>"
                    + "<li class=\"task\"><input type=\"checkbox\" disabled>not done</li></ul>"
            )
        }

        Check.test("blockquotes nest other blocks") {
            Check.equal(
                MarkdownExport.body(from: "> ## Quoted\n> - a"),
                "<blockquote><h2>Quoted</h2>\n<ul><li>a</li></ul></blockquote>"
            )
        }

        Check.test("thematic breaks") {
            Check.equal(MarkdownExport.body(from: "---"), "<hr>")
            Check.equal(MarkdownExport.body(from: "***"), "<hr>")
            Check.equal(MarkdownExport.body(from: "- - -"), "<hr>")
        }

        Check.test("the document is self-contained and carries no external reference") {
            let html = MarkdownExport.html(from: "# Standup\n", title: "Standup", accent: "#c98a1f")
            Check.expect(html.hasPrefix("<!DOCTYPE html>"))
            Check.expect(html.contains("<title>Standup</title>"))
            Check.expect(html.contains("<h1>Standup</h1>"))
            Check.expect(!html.contains("http://"), "no external stylesheet, font or script")
            Check.expect(!html.contains("<link"), "no external stylesheet")
        }

        Check.test("a junk accent cannot escape into the stylesheet") {
            // The accent is interpolated into a <style> block, so it is validated for the same
            // reason Settings validates it on the way in.
            let html = MarkdownExport.html(
                from: "# x\n", title: "x", accent: "red; } body { display: none"
            )
            Check.expect(!html.contains("display: none"), "an invalid accent must fall back")
            Check.expect(html.contains("--accent: #c98a1f"))
        }

        Check.test("a title with markup in it is escaped in the <title>") {
            let html = MarkdownExport.html(from: "x", title: "a <b> & c", accent: "#c98a1f")
            Check.expect(html.contains("<title>a &lt;b&gt; &amp; c</title>"))
        }
    }
}
