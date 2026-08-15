import Foundation

/// Reading a note's text the way the UI needs it: a title for the switcher row, a first line of body
/// for the row beneath it, and one canonical trailing newline.
///
/// Nothing here rewrites the middle of a document. The byte-for-byte bar (decision 10) means the only
/// transformation Pane is allowed to apply to a file it did not just receive from the editor is the
/// trailing-newline normalisation below — and that one is applied on *load*, so a file that arrives
/// with zero or three trailing newlines is corrected once and never generates a phantom diff again.
public enum MarkdownDocument {

    // MARK: - Normalisation

    /// Exactly one trailing newline, applied when a file is read.
    ///
    /// Interior bytes are untouched, including CRLF line endings: a file authored on Windows keeps
    /// its `\r\n` runs, because rewriting them would put a whole-file diff in front of the user the
    /// first time they open the note, which is precisely what the byte-for-byte bar forbids.
    /// Works in unicode scalars rather than characters on purpose: Swift treats `\r\n` as a *single*
    /// `Character`, so a character-level `hasSuffix("\n")` returns false for a CRLF file and the
    /// normalisation would silently append a second newline to every Windows-authored note.
    public static func normalizeTrailingNewline(_ text: String) -> String {
        let scalars = text.unicodeScalars
        var end = scalars.endIndex
        while end > scalars.startIndex {
            let prev = scalars.index(before: end)
            guard scalars[prev] == "\n" || scalars[prev] == "\r" else { break }
            end = prev
        }
        guard end > scalars.startIndex else { return "" }
        return String(String.UnicodeScalarView(scalars[scalars.startIndex..<end])) + "\n"
    }

    // MARK: - Title and preview

    /// The note's title: its first non-blank line, stripped of the markdown that decorates it.
    ///
    /// The title is a *view* of the first line, never a stored field — editing it changes the file
    /// and nothing else, and in particular never renames the file (decision 2).
    public static func title(of text: String) -> String {
        guard let line = firstNonBlankLine(of: text, startingAfter: nil) else { return "" }
        return displayText(of: line.content)
    }

    /// The first line of body text — what the switcher shows under the title.
    ///
    /// The design is explicit that this row is *time · first line of body*, never a character count:
    /// a vault with two notes both called "8-11 - 2" is only navigable if the second line says what
    /// is actually in them.
    public static func bodyPreview(of text: String) -> String {
        guard let title = firstNonBlankLine(of: text, startingAfter: nil) else { return "" }
        guard let body = firstNonBlankLine(of: text, startingAfter: title.endIndex) else { return "" }
        return displayText(of: body.content)
    }

    /// Title and preview in one pass, for the switcher building 200+ rows.
    public static func summary(of text: String) -> (title: String, preview: String) {
        guard let titleLine = firstNonBlankLine(of: text, startingAfter: nil) else { return ("", "") }
        let title = displayText(of: titleLine.content)
        guard let bodyLine = firstNonBlankLine(of: text, startingAfter: titleLine.endIndex) else {
            return (title, "")
        }
        return (title, displayText(of: bodyLine.content))
    }

    // MARK: - Internals

    private struct Line {
        let content: Substring
        let endIndex: String.Index
    }

    /// Scans forward for the next line with something on it. Stops at the first hit rather than
    /// splitting the whole document — a 3,000-word note should not be fully tokenised to draw one
    /// switcher row.
    private static func firstNonBlankLine(of text: String, startingAfter: String.Index?) -> Line? {
        var i = startingAfter ?? text.startIndex
        while i < text.endIndex {
            // `isNewline` rather than a literal "\n": it matches the single `\r\n` grapheme a CRLF
            // file produces, which a search for "\n" would walk straight past.
            let lineEnd = text[i...].firstIndex(where: \.isNewline) ?? text.endIndex
            let raw = text[i..<lineEnd]
            let next = lineEnd < text.endIndex ? text.index(after: lineEnd) : text.endIndex
            if !raw.allSatisfy({ $0.isWhitespace }) {
                return Line(content: raw, endIndex: next)
            }
            if next == i { break }
            i = next
        }
        return nil
    }

    /// Strips the markdown that would otherwise leak into a plain-text row: heading hashes, list
    /// bullets and numbers, task checkboxes, blockquote arrows, and inline emphasis/code markers.
    ///
    /// This is presentation only. It never touches the buffer, and the stripped form is never
    /// written anywhere — the file keeps every character the user typed.
    static func displayText(of line: Substring) -> String {
        var s = Substring(line)

        // Leading block markers, in the order they can legally nest: `> ` quotes, then a list
        // marker, then a task checkbox.
        while s.first == ">" {
            s = s.dropFirst()
            s = dropLeadingSpaces(s)
        }

        s = dropLeadingSpaces(s)

        if s.first == "#" {
            let hashes = s.prefix(while: { $0 == "#" })
            // ATX headings need whitespace after the hashes; `#hashtag` is not a heading.
            let rest = s.dropFirst(hashes.count)
            if hashes.count <= 6, rest.first == " " || rest.isEmpty {
                s = dropLeadingSpaces(rest)
                while s.last == "#" { s = s.dropLast() }   // closed ATX form: `## Title ##`
                s = dropTrailingSpaces(s)
            }
        } else if let marker = leadingListMarker(s) {
            s = dropLeadingSpaces(s.dropFirst(marker))
            // Task list checkbox, checked or not.
            if s.first == "[", s.count >= 3 {
                let box = s.prefix(3)
                let inner = box[box.index(after: box.startIndex)]
                if box.last == "]", inner == " " || inner == "x" || inner == "X" {
                    s = dropLeadingSpaces(s.dropFirst(3))
                }
            }
        }

        return stripInlineMarkers(String(s))
    }

    private static func dropLeadingSpaces(_ s: Substring) -> Substring {
        var s = s
        while s.first == " " || s.first == "\t" { s = s.dropFirst() }
        return s
    }

    private static func dropTrailingSpaces(_ s: Substring) -> Substring {
        var s = s
        while s.last == " " || s.last == "\t" { s = s.dropLast() }
        return s
    }

    /// Length of a leading `- `, `* `, `+ ` or `1. ` / `1) ` marker, or nil if there isn't one.
    private static func leadingListMarker(_ s: Substring) -> Int? {
        if let f = s.first, f == "-" || f == "*" || f == "+" {
            let rest = s.dropFirst()
            if rest.first == " " || rest.isEmpty {
                // A line of only dashes is a horizontal rule, not a bullet.
                return s.allSatisfy({ $0 == f || $0 == " " }) ? nil : 1
            }
            return nil
        }
        let digits = s.prefix(while: \.isNumber)
        if !digits.isEmpty, digits.count <= 9 {
            let after = s.dropFirst(digits.count)
            if let d = after.first, d == "." || d == ")" {
                let rest = after.dropFirst()
                if rest.first == " " || rest.isEmpty { return digits.count + 1 }
            }
        }
        return nil
    }

    /// Removes emphasis, strike, inline-code and link syntax so a row reads as prose.
    ///
    /// Character-level rather than a full parse: this runs once per note per switcher open, and a
    /// row that keeps a stray asterisk is a cosmetic miss, whereas a parser on the hot path is a
    /// hitch in the one interaction the product is built around.
    private static func stripInlineMarkers(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)

        let chars = Array(s)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            switch c {
            case "\\" where i + 1 < chars.count:
                // Escaped punctuation: keep the character, drop the backslash.
                out.append(chars[i + 1])
                i += 2
                continue
            case "*", "_", "`", "~":
                // Runs of emphasis markers vanish entirely.
                while i < chars.count, chars[i] == c { i += 1 }
                continue
            case "[":
                // `[label](target)` and `![alt](target)` collapse to the label.
                if let close = matchingBracket(chars, from: i) {
                    let label = String(chars[(i + 1)..<close])
                    var j = close + 1
                    if j < chars.count, chars[j] == "(" {
                        var depth = 1
                        j += 1
                        while j < chars.count, depth > 0 {
                            if chars[j] == "(" { depth += 1 }
                            if chars[j] == ")" { depth -= 1 }
                            j += 1
                        }
                        if out.hasSuffix("!") { out.removeLast() }
                        out.append(stripInlineMarkers(label))
                        i = j
                        continue
                    }
                }
                out.append(c)
                i += 1
            default:
                out.append(c)
                i += 1
            }
        }

        return out.trimmingCharacters(in: .whitespaces)
    }

    private static func matchingBracket(_ chars: [Character], from start: Int) -> Int? {
        var depth = 0
        var i = start
        while i < chars.count {
            if chars[i] == "[" { depth += 1 }
            if chars[i] == "]" {
                depth -= 1
                if depth == 0 { return i }
            }
            i += 1
        }
        return nil
    }
}
