import Foundation

/// Builds the frozen filename a note carries for life: `2026-08-11-1453-first-few-words.md`.
///
/// The name is derived once, at creation, from whatever the note's first line happens to be at that
/// moment — and then never again. Editing the title does not rename the file. That is decision 2:
/// a rename can reach iCloud Drive or Syncthing as a delete plus a create, which is the single
/// largest generator of duplicate and conflicted copies, so a vault whose names never churn is a
/// vault whose sync stays boring.
public enum NoteFilename {
    /// Longest slug we will produce, counted in *characters*, not bytes.
    ///
    /// The filesystem limit is 255 **bytes**, so the two units only coincide for ASCII. The worst
    /// realistic case is 48 CJK characters at 3 bytes each — 144 bytes, plus the 15-byte timestamp,
    /// a `-99` suffix and `.md`, which lands near 165. Comfortably clear, but by arithmetic rather
    /// than by construction: raising this constant past ~75 would need a byte-aware cap.
    public static let maxSlugLength = 48

    /// Words taken from the title. "first few words", literally.
    public static let maxSlugWords = 6

    /// Used when a note has no usable title — an empty note, or one whose first line is entirely
    /// emoji or punctuation. Better a boring name than a name made of percent-escapes.
    public static let fallbackSlug = "untitled"

    public static let fileExtension = "md"

    /// The timestamp half of the name, in the local time zone. Local rather than UTC because the
    /// name is a human landmark ("the note I made at 14:53"), not a sortable key for machines.
    public static func timestampComponent(_ date: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return String(
            format: "%04d-%02d-%02d-%02d%02d",
            c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0
        )
    }

    /// Reduces a title to the slug half of the filename.
    ///
    /// Letters and digits survive — including non-Latin ones, so a note written in Chinese or Greek
    /// keeps a name its author can read. Everything else (marks, punctuation, symbols, emoji) becomes
    /// a word break. Diacritics are folded, so "Café" and "Cafe" produce the same slug rather than
    /// two byte sequences that look identical in Finder and compare unequal on a case-insensitive
    /// volume.
    public static func slug(from title: String) -> String {
        let folded = title
            // NFC first, and this line is load-bearing. Swift compares strings by canonical
            // equivalence, so a composed and a decomposed title look equal in code — but they
            // serialise to *different UTF-8 bytes* on disk. APFS is normalisation-insensitive and
            // finds either; git, rsync, Syncthing and every Linux peer see two different filenames.
            // That is precisely the duplicate churn decision 2 exists to prevent, and text pasted
            // from other apps or typed on iOS arrives decomposed.
            .precomposedStringWithCanonicalMapping
            .folding(options: [.diacriticInsensitive, .widthInsensitive], locale: nil)
            .lowercased()

        var words: [String] = []
        var current = ""
        for scalar in folded.unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) {
                current.unicodeScalars.append(scalar)
            } else if !current.isEmpty {
                words.append(current)
                current = ""
            }
        }
        if !current.isEmpty { words.append(current) }

        guard !words.isEmpty else { return fallbackSlug }

        var slug = ""
        for word in words.prefix(maxSlugWords) {
            let candidate = slug.isEmpty ? word : slug + "-" + word
            if candidate.count > maxSlugLength {
                // Take a partial first word rather than returning "untitled" for a long single-word
                // title, but never leave a dangling hyphen behind.
                if slug.isEmpty { slug = String(word.prefix(maxSlugLength)) }
                break
            }
            slug = candidate
        }

        return slug.isEmpty ? fallbackSlug : slug
    }

    /// The name a new note would take, ignoring collisions.
    public static func candidate(title: String, date: Date, timeZone: TimeZone = .current) -> String {
        "\(timestampComponent(date, timeZone: timeZone))-\(slug(from: title)).\(fileExtension)"
    }

    /// The name a new note actually takes, given the names already in the vault.
    ///
    /// Two notes started in the same minute with the same opening words is rare but not impossible —
    /// a duplicated hotkey press, a paste into two panes. Since the name can never be repaired by a
    /// later rename, the disambiguating suffix has to be applied now.
    ///
    /// - Parameter existing: every filename already present in the vault, compared
    ///   case-insensitively because the default volume is case-insensitive and two names differing
    ///   only in case would collide on disk.
    public static func unique(
        title: String,
        date: Date,
        existing: Set<String>,
        timeZone: TimeZone = .current
    ) -> String {
        unique(
            stem: "\(timestampComponent(date, timeZone: timeZone))-\(slug(from: title))",
            existing: existing
        )
    }

    /// The uniquing on its own, for a stem that already exists.
    ///
    /// Decision 103 renames a young note as its title settles, and it has to keep the *original*
    /// timestamp rather than taking today's — so it cannot go through `unique(title:date:…)`, which
    /// builds a fresh one. One implementation of the `-2` rule rather than two: the second copy of a
    /// naming rule is how decision 100 went wrong.
    public static func unique(stem: String, existing: Set<String>) -> String {
        let taken = Set(existing.map { $0.lowercased() })

        let first = "\(stem).\(fileExtension)"
        if !taken.contains(first.lowercased()) { return first }

        var n = 2
        while true {
            let next = "\(stem)-\(n).\(fileExtension)"
            if !taken.contains(next.lowercased()) { return next }
            n += 1
        }
    }

    /// The sibling a conflicting write lands in: `<stem>-conflict-<timestamp>.md` (decision 8).
    ///
    /// Deliberately a normal note in the same flat vault — it shows up in the switcher, it opens in a
    /// pane, and the user can reconcile it by hand. v0.1 detects the collision and writes this file;
    /// merging it back is a later feature.
    public static func conflictSibling(
        for filename: String,
        date: Date,
        timeZone: TimeZone = .current
    ) -> String {
        let stem = (filename as NSString).deletingPathExtension
        let ext = (filename as NSString).pathExtension
        let suffix = "conflict-\(timestampComponent(date, timeZone: timeZone))"
        return ext.isEmpty ? "\(stem)-\(suffix)" : "\(stem)-\(suffix).\(ext)"
    }

    /// The creation time frozen into the name at `candidate`, or nil if this name did not come from
    /// there.
    ///
    /// Decision 104's "Date created" mode is free because of decision 2: the creation timestamp is
    /// already in the filename and never changes, so it needs no new state in `state.json` and no
    /// reliance on `.creationDate` surviving a trip through iCloud Drive or a restore from backup.
    ///
    /// **Parsed by counting**, which is decision 35's rule and for its reason: decision 2's names are
    /// all hyphens, so splitting on one gets a slug's words confused with the date's fields the
    /// moment a title contains a number. `RecentlyDeleted.parse` does the same for the same reason.
    ///
    /// Returns nil for a file the user named by hand, which the caller is expected to fall back to
    /// the mtime for rather than treat as an error — a vault is allowed to contain such files.
    public static func creationDate(
        from filename: String,
        timeZone: TimeZone = .current
    ) -> Date? {
        let stem = (filename as NSString).deletingPathExtension
        let chars = Array(stem)
        // "2026-08-11-1453" — four, two, two, four, with three hyphens between them.
        guard chars.count >= timestampWidth else { return nil }
        // A slug follows, or the name is the timestamp and nothing else. Anything else in that
        // position means these fifteen characters happened to look like a date.
        if chars.count > timestampWidth, chars[timestampWidth] != "-" { return nil }

        for (index, character) in chars.prefix(timestampWidth).enumerated() {
            let wantsHyphen = index == 4 || index == 7 || index == 10
            if wantsHyphen {
                guard character == "-" else { return nil }
            } else {
                guard character.isASCII, character.isNumber else { return nil }
            }
        }

        func number(_ range: Range<Int>) -> Int? { Int(String(chars[range])) }
        guard let year = number(0..<4), let month = number(5..<7), let day = number(8..<10),
              let hour = number(11..<13), let minute = number(13..<15)
        else { return nil }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = hour
        components.minute = minute
        guard let date = calendar.date(from: components) else { return nil }

        // `date(from:)` *rolls over* rather than refusing: it turns 2026-13-40 into 9 February 2027
        // and hands it back as if nothing happened. So the only way to tell a date from a string that
        // merely has a date's shape is to read the components back and require them to match.
        let round = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        guard round.year == year, round.month == month, round.day == day,
              round.hour == hour, round.minute == minute
        else { return nil }
        return date
    }

    /// The best title a filename alone can offer, for a note whose text cannot be read.
    ///
    /// `slug(from:)` is lossy and this does not pretend otherwise — case, punctuation and every word
    /// past the sixth are gone for good. It exists because the alternative is worse: an evicted note
    /// has no readable first line, so the switcher called it "Untitled" and showed nothing else, and
    /// a mac syncing a vault for the first time is a column of identical Untitled rows. The slug is
    /// a real, human-chosen phrase — `slides-revised` — and reading it beats reading nothing.
    ///
    /// Sentence case rather than Title Case: the slug is lowercased on the way in, so per-word
    /// capitals would be invented rather than restored. Capitalising the first character is enough
    /// to read as a title without claiming to be the one that was typed.
    ///
    /// Returns nil when the name carries no phrase to show — a bare timestamp, or the `untitled`
    /// slug a nameless note takes, both of which the caller already renders as "Untitled".
    public static func title(from filename: String) -> String? {
        var stem = (filename as NSString).deletingPathExtension

        // Drop the timestamp half only when it really is one, using the same counting parse as
        // `creationDate(from:)` rather than a second, looser rule (decision 35).
        if creationDate(from: filename) != nil {
            stem = String(stem.dropFirst(timestampWidth))
            if stem.first == "-" { stem = String(stem.dropFirst()) }
        }

        let words = stem.split(separator: "-").map(String.init)
        guard !words.isEmpty else { return nil }
        // A one-word `untitled` is the fallback slug, not a title. `untitled-draft` is a title.
        if words.count == 1, words[0] == fallbackSlug { return nil }

        let phrase = words.joined(separator: " ")
        guard let first = phrase.first else { return nil }
        return first.uppercased() + phrase.dropFirst()
    }

    /// Characters in the timestamp half — `2026-08-11-1453`. Counted, never split (see above).
    public static let timestampWidth = 15

    /// Whether a filename is one Pane will show in the switcher.
    ///
    /// Dot-files are skipped, which also skips the `.filename.md.icloud` placeholder stubs that
    /// appear beside evicted notes — those are not notes, and treating one as an empty note is the
    /// bug decision 13 exists to prevent.
    public static func isNoteFile(_ filename: String) -> Bool {
        guard !filename.hasPrefix(".") else { return false }
        return (filename as NSString).pathExtension.lowercased() == fileExtension
    }
}
