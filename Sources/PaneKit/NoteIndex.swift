import Foundation

/// One note, as the switcher needs to know it.
public struct NoteRecord: Equatable, Sendable {
    public var filename: String
    public var modified: Date
    public var title: String
    public var preview: String
    /// Full text, for body search. `nil` when the note could not be read without blocking — an
    /// evicted note is excluded from full-text search rather than being downloaded to serve a
    /// keystroke (decision 13).
    public var text: String?
    public var availability: NoteAvailability

    public init(
        filename: String,
        modified: Date,
        title: String,
        preview: String,
        text: String?,
        availability: NoteAvailability = .available
    ) {
        self.filename = filename
        self.modified = modified
        self.title = title
        self.preview = preview
        self.text = text
        self.availability = availability
    }
}

/// A switcher row, in the exact shape the web layer's `NoteSummary` expects.
///
/// `Codable` because it crosses the bridge as JSON. Ordering, banding and time formatting are all
/// decided here, in Swift, where they are tested — the web layer draws what it is given (decision 4).
public struct SwitcherRow: Codable, Equatable, Sendable {
    public struct Match: Codable, Equatable, Sendable {
        public var pre: String
        public var hit: String
        public var post: String
    }

    public var filename: String
    public var title: String
    public var time: String
    public var preview: String
    public var band: String?
    public var pinned: Bool?
    public var current: Bool?
    public var match: Match?

    /// Public because the Recently Deleted list is built in the app target rather than here — it is
    /// the same row drawn by the same switcher, just sourced from the holding folder (decision 20).
    /// The four optionals default to nil so that caller states its four fields and no more.
    public init(
        filename: String,
        title: String,
        time: String,
        preview: String,
        band: String? = nil,
        pinned: Bool? = nil,
        current: Bool? = nil,
        match: Match? = nil
    ) {
        self.filename = filename
        self.title = title
        self.time = time
        self.preview = preview
        self.band = band
        self.pinned = pinned
        self.current = current
        self.match = match
    }
}

/// Everything the ⌘P switcher does to a vault: keeps a cheap index of it, orders it, and answers
/// queries against it.
///
/// The index exists because the switcher's job is 200 notes (decision 23) and full-text search needs
/// their text. Re-reading 200 files per keystroke would be absurd, so files are read once and
/// re-read only when their size or modification date moves. That check is a `stat`, not a read.
public final class NoteIndex {

    /// Cached per note, so `refresh` can skip files that have not moved.
    private struct Entry {
        var record: NoteRecord
        var size: Int
        var modified: Date
    }

    private var entries: [String: Entry] = [:]

    public init() {}

    public var records: [NoteRecord] { entries.values.map(\.record) }

    public func record(_ filename: String) -> NoteRecord? { entries[filename]?.record }

    public var filenames: Set<String> { Set(entries.keys) }

    /// Rebuilds the index from the vault, reading only what changed.
    ///
    /// Never throws for a single unreadable note: one bad file must not empty the switcher. An
    /// evicted note keeps its row — it has a name, a date, and a title from the last time it was
    /// readable — it simply drops out of full-text search until it is downloaded.
    @discardableResult
    public func refresh(vault: URL) throws -> Set<String> {
        let urls = try VaultIO.listNotes(in: vault)
        var present = Set<String>()

        for url in urls {
            let filename = url.lastPathComponent
            present.insert(filename)

            let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            let size = values?.fileSize ?? 0
            let modified = values?.contentModificationDate ?? Date.distantPast

            if let existing = entries[filename],
               existing.size == size,
               existing.modified == modified {
                continue
            }

            let availability = VaultIO.availability(of: url)
            var text: String?
            if availability == .available {
                text = try? VaultIO.loadText(url).text
            } else if let cached = entries[filename]?.record.text {
                // Evicted now, but we have read it before. Keeping the text means the note stays
                // searchable rather than silently dropping out of results mid-session.
                text = cached
            }

            let summary = text.map(MarkdownDocument.summary(of:)) ?? (title: "", preview: "")
            entries[filename] = Entry(
                record: NoteRecord(
                    filename: filename,
                    modified: modified,
                    title: summary.title,
                    preview: summary.preview,
                    text: text,
                    availability: availability
                ),
                size: size,
                modified: modified
            )
        }

        entries = entries.filter { present.contains($0.key) }
        return present
    }

    /// Updates one note in place, for the buffer the user is typing into.
    ///
    /// Called after every write so the switcher shows the note as it is now, not as it was when the
    /// index last ran — opening ⌘P immediately after typing a title and seeing the old one is the
    /// kind of small lie that makes a tool feel stale.
    public func update(filename: String, text: String, modified: Date) {
        let summary = MarkdownDocument.summary(of: text)
        entries[filename] = Entry(
            record: NoteRecord(
                filename: filename,
                modified: modified,
                title: summary.title,
                preview: summary.preview,
                text: text,
                availability: .available
            ),
            size: Data(text.utf8).count,
            modified: modified
        )
    }

    public func forget(_ filename: String) {
        entries.removeValue(forKey: filename)
    }

    // MARK: - Rows

    /// The rows the switcher shows, ordered, banded and formatted.
    ///
    /// - Parameters:
    ///   - query: what is in the search field. Empty means "everything, by recency".
    ///   - state: supplies pins and `lastOpened`.
    ///   - current: the note open in this pane, badged rather than hidden.
    ///   - order: which clock counts as "recent" (decision 104). Whichever it picks is the one value
    ///     the rows are sorted by, banded by and labelled with — see `NoteOrdering.activity`.
    public func rows(
        query: String,
        state: AppState,
        current: String?,
        order: Settings.NoteOrder = .modified,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> [SwitcherRow] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)

        let scored: [(record: NoteRecord, activity: Date, pinned: Bool, match: SwitcherRow.Match?, score: Int)]
        if trimmed.isEmpty {
            scored = records.map { record in
                let noteState = state.note(record.filename)
                return (
                    record,
                    NoteOrdering.activity(
                        order,
                        filename: record.filename,
                        modified: record.modified,
                        lastOpened: noteState.lastOpened
                    ),
                    noteState.isPinned,
                    nil,
                    0
                )
            }
        } else {
            scored = records.compactMap { record in
                guard let hit = NoteSearch.match(record: record, query: trimmed) else { return nil }
                let noteState = state.note(record.filename)
                return (
                    record,
                    NoteOrdering.activity(
                        order,
                        filename: record.filename,
                        modified: record.modified,
                        lastOpened: noteState.lastOpened
                    ),
                    noteState.isPinned,
                    hit.snippet,
                    hit.score
                )
            }
        }

        // With a query the order is relevance, then recency. Without one it is pins, then recency.
        let sorted = scored.sorted { a, b in
            if trimmed.isEmpty {
                if a.pinned != b.pinned { return a.pinned }
            } else if a.score != b.score {
                return a.score > b.score
            }
            if a.activity != b.activity { return a.activity > b.activity }
            return a.record.filename > b.record.filename
        }

        // Bands are landmarks for a recency-ordered scroll. A search result list is ordered by
        // relevance, so a "Today" header over it would be describing an order that isn't there —
        // bands are suppressed while searching, and the row's time column carries the date instead.
        let banded = trimmed.isEmpty && sorted.count >= NoteOrdering.groupingThreshold

        return sorted.map { item in
            let band: String? = banded
                ? NoteOrdering.label(
                    for: NoteOrdering.band(
                        modified: item.activity,
                        isPinned: item.pinned,
                        now: now,
                        calendar: calendar
                    ),
                    calendar: calendar,
                    locale: locale
                )
                : nil

            return SwitcherRow(
                filename: item.record.filename,
                title: item.record.title,
                time: NoteOrdering.relativeTime(item.activity, now: now, calendar: calendar, locale: locale),
                preview: item.record.preview,
                band: band,
                pinned: item.pinned ? true : nil,
                current: item.record.filename == current ? true : nil,
                match: item.match
            )
        }
    }
}

/// Matching a query against a note: fuzzy on the title, literal on the body.
///
/// Two different algorithms because they answer two different questions. A title is short and you
/// half-remember it, so subsequence matching with a typo's worth of slack is right. A body is long
/// and you remember an exact phrase from it, so a literal substring — shown as a highlighted
/// snippet — is right. Fuzzy body matching would return everything.
public enum NoteSearch {

    public struct Hit: Equatable, Sendable {
        public var score: Int
        public var snippet: SwitcherRow.Match?
    }

    /// Characters of context either side of a body hit. Enough for the phrase to make sense on a
    /// 460 px row without wrapping to a second line.
    static let snippetLead = 24
    static let snippetTrail = 48

    public static func match(record: NoteRecord, query: String) -> Hit? {
        // A title hit always beats a body hit, and keeps the first-line preview: the row already
        // shows why it matched.
        if let titleScore = fuzzyScore(candidate: record.title, query: query) {
            return Hit(score: 1_000 + titleScore, snippet: nil)
        }

        // Then the filename, so the date-stamped name is searchable ("2026-08" finds August).
        if let nameScore = fuzzyScore(candidate: record.filename, query: query) {
            return Hit(score: 500 + nameScore, snippet: nil)
        }

        guard let text = record.text, let snippet = bodySnippet(text: text, query: query) else {
            return nil
        }
        return Hit(score: snippet.score, snippet: snippet.match)
    }

    // MARK: - Fuzzy title matching

    /// Subsequence match with a score, or nil when the query's characters do not appear in order.
    ///
    /// Scoring rewards the two things that separate a match you meant from one you didn't: characters
    /// that land consecutively, and characters that land at the start of a word. "wknotes" should
    /// find "Weekly notes" ahead of a note that merely contains those letters scattered through it.
    public static func fuzzyScore(candidate: String, query: String) -> Int? {
        let haystack = Array(candidate.lowercased())
        let needle = Array(query.lowercased().filter { !$0.isWhitespace })
        guard !needle.isEmpty else { return 0 }
        guard !haystack.isEmpty else { return nil }

        var score = 0
        var h = 0
        var lastMatch = -2

        for c in needle {
            var found = false
            while h < haystack.count {
                if haystack[h] == c {
                    score += 1
                    if h == lastMatch + 1 { score += 4 }               // consecutive run
                    if h == 0 || !haystack[h - 1].isLetter && !haystack[h - 1].isNumber {
                        score += 3                                      // start of a word
                    }
                    lastMatch = h
                    h += 1
                    found = true
                    break
                }
                h += 1
            }
            if !found { return nil }
        }

        // A short title that matched is a better answer than a long one that also did.
        return score + max(0, 20 - haystack.count / 4)
    }

    // MARK: - Body matching

    struct BodyHit {
        var score: Int
        var match: SwitcherRow.Match
    }

    /// Literal, case-insensitive, and returned as the three pieces the row highlights.
    ///
    /// Works in `Character`s rather than UTF-16 so an emoji or a combining accent before the hit
    /// cannot split the snippet mid-grapheme and hand the web layer a broken string.
    static func bodySnippet(text: String, query: String) -> BodyHit? {
        let needle = query.lowercased()
        guard !needle.isEmpty else { return nil }

        let chars = Array(text)
        let lower = Array(text.lowercased())
        // Lowercasing can change length (ß → ss, İ → i̇), which would misalign every index below.
        guard lower.count == chars.count else { return caseInsensitiveFallback(text: text, query: query) }

        let pattern = Array(needle)
        guard pattern.count <= chars.count else { return nil }

        var start: Int?
        for i in 0...(chars.count - pattern.count) {
            if Array(lower[i..<(i + pattern.count)]) == pattern {
                start = i
                break
            }
        }
        guard let start else { return nil }

        let end = start + pattern.count
        let preStart = max(0, start - snippetLead)
        let postEnd = min(chars.count, end + snippetTrail)

        var pre = String(chars[preStart..<start])
        var post = String(chars[end..<postEnd])

        // Collapse the newlines a snippet spanning a paragraph break would otherwise carry into a
        // single-line row.
        pre = collapseWhitespace(pre)
        post = collapseWhitespace(post)

        if preStart > 0 { pre = "…" + pre }
        if postEnd < chars.count { post += "…" }

        // Earlier hits score higher: the phrase you remember is usually near the top of the note.
        return BodyHit(
            score: max(1, 200 - start / 20),
            match: SwitcherRow.Match(pre: pre, hit: String(chars[start..<end]), post: post)
        )
    }

    /// For the rare strings whose lowercasing changes their length, fall back to Foundation's own
    /// search and rebuild the snippet from ranges rather than from indices.
    private static func caseInsensitiveFallback(text: String, query: String) -> BodyHit? {
        guard let range = text.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) else {
            return nil
        }
        let preStart = text.index(range.lowerBound, offsetBy: -snippetLead, limitedBy: text.startIndex)
            ?? text.startIndex
        let postEnd = text.index(range.upperBound, offsetBy: snippetTrail, limitedBy: text.endIndex)
            ?? text.endIndex

        var pre = collapseWhitespace(String(text[preStart..<range.lowerBound]))
        var post = collapseWhitespace(String(text[range.upperBound..<postEnd]))
        if preStart != text.startIndex { pre = "…" + pre }
        if postEnd != text.endIndex { post += "…" }

        return BodyHit(
            score: 100,
            match: SwitcherRow.Match(pre: pre, hit: String(text[range]), post: post)
        )
    }

    static func collapseWhitespace(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        var lastWasSpace = false
        for c in s {
            if c.isWhitespace {
                if !lastWasSpace { out.append(" ") }
                lastWasSpace = true
            } else {
                out.append(c)
                lastWasSpace = false
            }
        }
        return out
    }
}
