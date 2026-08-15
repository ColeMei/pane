import Foundation

/// Markdown to a self-contained HTML file — design frame 2a's Export… row.
///
/// Deliberately narrow: it renders **exactly the constructs v0.1's live preview renders** and
/// nothing else. That is not a shortcut, it is the specification. An exporter that understood more
/// markdown than the editor does would produce a file that disagrees with what the pane showed you,
/// and an exporter that understood less would silently drop text. The list is the same one in the
/// README: headings, bold/italic/strike, inline code and code blocks, nested ordered and unordered
/// lists, task checkboxes, links, rules, blockquotes.
///
/// No dependency, for decision 4's reason one level down — the whole app is a Swift shell and one
/// web bundle, and a markdown library would be a third thing to keep in step with the other two.
public enum MarkdownExport {

    // MARK: - Document

    /// One file, no external references — decision 3's "files you own" applied to what leaves.
    ///
    /// A stylesheet link or a webfont would make the export depend on something the user cannot see
    /// and cannot carry with it, which is the opposite of the thing being exported.
    public static func html(from markdown: String, title: String, accent: String) -> String {
        let heading = title.isEmpty ? "Note" : title
        return """
        <!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>\(escape(heading))</title>
        <style>
        :root { --accent: \(MarkdownExport.safeAccent(accent)); --ink: #1d1d1f; --muted: #6e6e73;
                --rule: rgba(0,0,0,.1); --fill: rgba(0,0,0,.045); --bg: #fff; }
        @media (prefers-color-scheme: dark) {
          :root { --ink: #f2f2f5; --muted: #a0a0a6; --rule: rgba(255,255,255,.14);
                  --fill: rgba(255,255,255,.07); --bg: #1a1a1c; }
        }
        body { margin: 0; padding: 48px 24px; background: var(--bg); color: var(--ink);
               font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
        main { max-width: 34em; margin: 0 auto; }
        h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 .5em; }
        h1 { font-size: 1.7em; margin-top: 0; }
        h2 { font-size: 1.35em; }
        h3 { font-size: 1.15em; }
        p, ul, ol, blockquote, pre { margin: 0 0 1em; }
        a { color: var(--accent); }
        code { background: var(--fill); border-radius: 4px; padding: .1em .3em;
               font: .88em/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
        pre { background: var(--fill); border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
        pre code { background: none; padding: 0; }
        blockquote { border-left: 3px solid var(--accent); margin-left: 0; padding-left: 1em;
                     color: var(--muted); }
        hr { border: 0; border-top: 1px solid var(--rule); margin: 2em 0; }
        ul, ol { padding-left: 1.4em; }
        li::marker { color: var(--accent); }
        li.task { list-style: none; margin-left: -1.4em; }
        li.task input { margin-right: .5em; }
        </style>
        </head>
        <body>
        <main>
        \(body(from: markdown))
        </main>
        </body>
        </html>
        """
    }

    /// The accent lands inside a `<style>` block, so anything that is not a colour has to be caught
    /// here — the same argument `Settings` makes for validating it on the way in.
    private static func safeAccent(_ value: String) -> String {
        Settings.isHexColour(value) ? value : "#c98a1f"
    }

    // MARK: - Blocks

    public static func body(from markdown: String) -> String {
        render(lines: markdown.components(separatedBy: "\n"))
    }

    private static func render(lines: [String]) -> String {
        var out: [String] = []
        var i = 0

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                i += 1
                continue
            }

            // Fenced code. Decision 34 says the fences are chrome in the editor and the language word
            // changes nothing — so it is not read here either, and there is no highlighter to feed it.
            if trimmed.hasPrefix("```") {
                var content: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    content.append(lines[i])
                    i += 1
                }
                if i < lines.count { i += 1 }  // the closing fence
                out.append("<pre><code>\(escape(content.joined(separator: "\n")))</code></pre>")
                continue
            }

            if isThematicBreak(trimmed) {
                out.append("<hr>")
                i += 1
                continue
            }

            if let (level, text) = heading(trimmed) {
                out.append("<h\(level)>\(inline(text))</h\(level)>")
                i += 1
                continue
            }

            if trimmed.hasPrefix(">") {
                var quoted: [String] = []
                while i < lines.count {
                    let candidate = lines[i].trimmingCharacters(in: .whitespaces)
                    guard candidate.hasPrefix(">") else { break }
                    var stripped = String(candidate.dropFirst())
                    if stripped.hasPrefix(" ") { stripped.removeFirst() }
                    quoted.append(stripped)
                    i += 1
                }
                // Recursive so a quote can hold a list or a heading, which is what the editor shows.
                out.append("<blockquote>\(render(lines: quoted))</blockquote>")
                continue
            }

            if listMarker(line) != nil {
                var block: [String] = []
                while i < lines.count {
                    if listMarker(lines[i]) != nil || isListContinuation(lines[i]) {
                        block.append(lines[i])
                        i += 1
                    } else {
                        break
                    }
                }
                out.append(renderList(block, indent: 0))
                continue
            }

            // A paragraph runs to the next blank line or the next thing that starts a block.
            var paragraph: [String] = []
            while i < lines.count {
                let candidate = lines[i]
                let candidateTrimmed = candidate.trimmingCharacters(in: .whitespaces)
                if candidateTrimmed.isEmpty || candidateTrimmed.hasPrefix("```")
                    || candidateTrimmed.hasPrefix(">") || isThematicBreak(candidateTrimmed)
                    || heading(candidateTrimmed) != nil || listMarker(candidate) != nil
                {
                    break
                }
                paragraph.append(candidateTrimmed)
                i += 1
            }
            if !paragraph.isEmpty {
                out.append("<p>\(inline(paragraph.joined(separator: "\n")))</p>")
            }
        }

        return out.joined(separator: "\n")
    }

    private static func isThematicBreak(_ trimmed: String) -> Bool {
        for marker: Character in ["-", "*", "_"] {
            let stripped = trimmed.filter { !$0.isWhitespace }
            if stripped.count >= 3, stripped.allSatisfy({ $0 == marker }) { return true }
        }
        return false
    }

    private static func heading(_ trimmed: String) -> (level: Int, text: String)? {
        let hashes = trimmed.prefix(while: { $0 == "#" }).count
        guard hashes >= 1, hashes <= 6 else { return nil }
        let rest = trimmed.dropFirst(hashes)
        // `#hashtag` is not a heading. CommonMark wants the space and so does anyone writing prose.
        guard rest.first == " " else { return nil }
        return (hashes, String(rest.dropFirst()))
    }

    // MARK: - Lists

    private struct Marker {
        var indent: Int
        var ordered: Bool
        var content: String
        /// `nil` when the item is not a checkbox.
        var checked: Bool?
    }

    private static func listMarker(_ line: String) -> Marker? {
        let indent = line.prefix(while: { $0 == " " || $0 == "\t" })
            .reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
        let rest = line.drop(while: { $0 == " " || $0 == "\t" })
        guard !rest.isEmpty else { return nil }

        var ordered = false
        var body = Substring("")

        if let first = rest.first, "-*+".contains(first), rest.dropFirst().first == " " {
            body = rest.dropFirst(2)
        } else {
            let digits = rest.prefix(while: \.isNumber)
            let after = rest.dropFirst(digits.count)
            guard !digits.isEmpty, let punct = after.first, punct == "." || punct == ")",
                  after.dropFirst().first == " "
            else {
                return nil
            }
            ordered = true
            body = after.dropFirst(2)
        }

        var checked: Bool?
        let text = String(body)
        if text.hasPrefix("[ ] ") || text.hasPrefix("[] ") {
            checked = false
        } else if text.lowercased().hasPrefix("[x] ") {
            checked = true
        }

        let content = checked == nil
            ? text
            : String(text.drop(while: { $0 != "]" }).dropFirst().drop(while: { $0 == " " }))

        return Marker(indent: indent, ordered: ordered, content: content, checked: checked)
    }

    /// An indented, non-marker line belonging to the item above it.
    private static func isListContinuation(_ line: String) -> Bool {
        guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        return line.hasPrefix("  ") || line.hasPrefix("\t")
    }

    /// Nesting comes from indentation, which is how the editor's own lists behave.
    private static func renderList(_ lines: [String], indent: Int) -> String {
        var items: [(Marker, [String])] = []
        for line in lines {
            if let marker = listMarker(line), marker.indent <= indent + 1 {
                items.append((marker, []))
            } else if !items.isEmpty {
                items[items.count - 1].1.append(line)
            }
        }
        guard let first = items.first?.0 else { return "" }

        let tag = first.ordered ? "ol" : "ul"
        var out = "<\(tag)>"
        for (marker, children) in items {
            let checkbox: String
            switch marker.checked {
            case .some(true):
                checkbox = "<input type=\"checkbox\" checked disabled>"
            case .some(false):
                checkbox = "<input type=\"checkbox\" disabled>"
            case .none:
                checkbox = ""
            }
            let itemClass = marker.checked == nil ? "" : " class=\"task\""

            out += "<li\(itemClass)>\(checkbox)\(inline(marker.content))"
            if !children.isEmpty {
                let nestedIndent = children.compactMap { listMarker($0)?.indent }.min()
                if let nestedIndent {
                    out += renderList(children, indent: nestedIndent)
                }
            }
            out += "</li>"
        }
        return out + "</\(tag)>"
    }

    // MARK: - Inline

    static func escape(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count)
        for character in text {
            switch character {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            default: out.append(character)
            }
        }
        return out
    }

    /// Code spans first, because nothing inside one is markup — which is exactly what someone
    /// writing `**not bold**` in backticks is relying on.
    static func inline(_ text: String) -> String {
        let chars = Array(text)
        var out = ""
        var i = 0

        func closing(_ character: Character, from start: Int, width: Int = 1) -> Int? {
            var j = start
            while j + width <= chars.count {
                if chars[j] == character,
                   width == 1 || (j + 1 < chars.count && chars[j + 1] == character) {
                    return j
                }
                j += 1
            }
            return nil
        }

        while i < chars.count {
            let c = chars[i]

            if c == "`", let close = closing("`", from: i + 1) {
                out += "<code>\(escape(String(chars[(i + 1)..<close])))</code>"
                i = close + 1
                continue
            }

            if c == "[", let closeBracket = closing("]", from: i + 1),
               closeBracket + 1 < chars.count, chars[closeBracket + 1] == "(",
               let closeParen = closing(")", from: closeBracket + 2) {
                let label = String(chars[(i + 1)..<closeBracket])
                let href = String(chars[(closeBracket + 2)..<closeParen])
                out += "<a href=\"\(escape(href))\">\(inline(label))</a>"
                i = closeParen + 1
                continue
            }

            if c == "~", i + 1 < chars.count, chars[i + 1] == "~",
               let close = closing("~", from: i + 2, width: 2) {
                out += "<s>\(inline(String(chars[(i + 2)..<close])))</s>"
                i = close + 2
                continue
            }

            // `**` before `*`, or every strong run opens an emphasis and never closes.
            if c == "*" || c == "_" {
                if i + 1 < chars.count, chars[i + 1] == c, let close = closing(c, from: i + 2, width: 2) {
                    out += "<strong>\(inline(String(chars[(i + 2)..<close])))</strong>"
                    i = close + 2
                    continue
                }
                if let close = closing(c, from: i + 1), close > i + 1 {
                    out += "<em>\(inline(String(chars[(i + 1)..<close])))</em>"
                    i = close + 1
                    continue
                }
            }

            out += escape(String(c))
            i += 1
        }

        return out
    }
}
