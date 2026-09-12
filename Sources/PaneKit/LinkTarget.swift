import Foundation

/// What a ⌘-clicked link in a note is allowed to open — decision 138.
///
/// Here rather than beside `NSWorkspace.shared.open` for `ReleaseCheck`'s reason: this is the part
/// that can be wrong quietly. Everything else about the gesture is visible the moment you try it,
/// but a rule that opens one scheme too many is invisible until a note contains one, and by then it
/// has already launched something.
///
/// And notes *do* contain them. Every other `NSWorkspace.open` in Pane names a URL Pane itself
/// built — the releases page, the themes folder, a file in the vault. This one opens a string a
/// person pasted, which makes it the first place where the **note** chooses what the app launches.
/// Measured on this machine: `file:///etc/passwd` resolves to TextEdit, `x-apple-reminderkit://`
/// to Reminders, `ftp://` to Finder. None of those is a link anybody meant to follow.
///
/// So: **normalise, then allow.** In that order, because the order is the whole subtlety — see
/// `resolve`.
public enum LinkTarget {

    /// The three schemes a note may open, after normalisation.
    ///
    /// `http` and `https` are the request. `mailto` is here because Pane's parser linkifies a bare
    /// email address (`@lezer/markdown`'s autolink extension covers `www.`, `http://`, `https://`,
    /// `mailto:`, `xmpp:` *and* addresses), and decision 121 gives every one of those the accent.
    /// An address in a note therefore already looks like a link, and a thing that looks like a link
    /// and does nothing is exactly what issues #1 and #2 were both about.
    ///
    /// **`xmpp:` is deliberately not here**, and this is the one gap the rule leaves: it renders as
    /// a link and will not open. Judged rare enough to accept, and recorded so it is not reported
    /// later as a regression.
    public static let allowedSchemes: Set<String> = ["http", "https", "mailto"]

    /// Turn the text of a link node into a URL worth opening, or decline.
    ///
    /// **Normalise before you allow.** A scheme allowlist applied to the raw text rejects
    /// `www.anthropic.com`, which carries no scheme at all — measured: `URL(string:)` accepts it,
    /// reports `scheme == nil`, and resolves to no handler, so opening it silently does nothing.
    /// Checking first and normalising afterwards would therefore have failed the single form the
    /// request was reported against.
    ///
    /// What to prepend is not a guess. Raycast Notes was driven for this (its links carry a real
    /// `AXURL`): `www.example.com` has an href of `https://www.example.com/`. The same reading
    /// settles email — it does not linkify addresses at all, so it has no vote, and Pane's parser
    /// differs there.
    ///
    /// The gate is the *parser*, never a regex over prose. This is only ever called with the text
    /// of a node the grammar already decided was a link, which is what keeps the normalisation
    /// narrow: a bare `example.com` never arrives here, because GFM does not linkify one.
    public static func resolve(_ raw: String) -> URL? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        // A URL with a space in it is not one. `URL(string:)` agrees, but failing here keeps the
        // reason readable rather than arriving as a nil from three lines down.
        guard !text.contains(where: { $0 == " " || $0 == "\n" || $0 == "\t" }) else { return nil }

        let normalised = normalise(text)
        guard let url = URL(string: normalised), let scheme = url.scheme?.lowercased() else {
            return nil
        }
        guard allowedSchemes.contains(scheme) else { return nil }
        return url
    }

    /// Give a scheme-less link the one its form implies, and leave everything else exactly as typed.
    static func normalise(_ text: String) -> String {
        guard scheme(of: text) == nil else { return text }
        if text.lowercased().hasPrefix("www.") { return "https://" + text }
        if isBareEmail(text) { return "mailto:" + text }
        // Anything else scheme-less falls through unchanged and is declined by the allowlist, which
        // is the right answer for `//evil.com` and for a bare word alike.
        return text
    }

    /// The scheme a string actually carries, by RFC 3986's spelling of one.
    ///
    /// Read here rather than off `URL(string:).scheme` so the answer is predictable and testable.
    /// Foundation's parse is not wrong, but it is not the thing being decided: `example.com:8080`
    /// is a syntactically valid scheme of `example.com`, and which component that lands in should
    /// be this file's choice rather than a side effect.
    static func scheme(of text: String) -> String? {
        guard let colon = text.firstIndex(of: ":") else { return nil }
        let candidate = text[text.startIndex..<colon]
        guard let first = candidate.first, first.isLetter else { return nil }
        let legal = candidate.allSatisfy { $0.isLetter || $0.isNumber || "+-.".contains($0) }
        return legal ? candidate.lowercased() : nil
    }

    /// `a@b.com` — one `@`, something either side, and a dot in the domain.
    ///
    /// Deliberately looser than the grammar that produced it and deliberately not an RFC 5322
    /// parser: the parser has already decided this is an address, and all this has to do is tell it
    /// apart from the other scheme-less form, which is a host.
    static func isBareEmail(_ text: String) -> Bool {
        let parts = text.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty else { return false }
        let domain = parts[1]
        return domain.contains(".") && !domain.hasPrefix(".") && !domain.hasSuffix(".")
    }
}
