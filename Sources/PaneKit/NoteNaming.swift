import Foundation

/// Decision 103: a note's filename follows its first line until the note is left.
///
/// This narrows decision 2 rather than reversing it. Decision 2 exists so that a vault's names do
/// not churn *during sync* — a rename can reach iCloud Drive or Syncthing as a delete plus a create,
/// which is the largest single generator of duplicate copies. Every rename this file decides on
/// happens inside the first minutes of a note's life, while the note is on screen and before the
/// provider has done much with it. The alternative, measured in the real vault, is worse: 8 of the
/// 12 notes in it carried a filename that disagreed with their title, because decision 2 froze the
/// name at the first 500 ms typing pause and a note titled while thinking got named after the
/// thought.
///
/// **The timestamp never changes.** It is the creation time, and that is decision 2's real content —
/// only the slug moves.
///
/// Pure, and separate from the code that moves files, because the interesting part is the decision
/// and the decision is the part with edge cases.
public enum NoteNaming {

    /// The name this note should now carry, or nil for "leave it alone".
    ///
    /// - Parameters:
    ///   - filename: the name the note has now. A name Pane did not produce is left alone entirely —
    ///     the user chose it, and choosing one is exactly what freezes it.
    ///   - title: the note's first line, by `MarkdownDocument.title(of:)`'s rules.
    ///   - existing: every filename in the vault, including this one. Compared case-insensitively,
    ///     because the default volume is.
    public static func rename(
        current filename: String,
        title: String,
        existing: Set<String>,
        timeZone: TimeZone = .current
    ) -> String? {
        // Only a name Pane froze can be followed. A hand-named file — or one whose fifteen leading
        // characters only look like a date — belongs to whoever named it.
        guard NoteFilename.creationDate(from: filename, timeZone: timeZone) != nil else { return nil }

        let stem = (filename as NSString).deletingPathExtension
        let chars = Array(stem)
        guard chars.count >= NoteFilename.timestampWidth else { return nil }
        let timestamp = String(chars.prefix(NoteFilename.timestampWidth))

        let slug = NoteFilename.slug(from: title)

        // Never degrade a real name to `untitled`. A first line is empty for a keystroke at a time
        // while it is being rewritten — selecting it and typing over it empties it — and a rename to
        // `untitled` in that window would be permanent as far as the user is concerned, because the
        // *next* keystroke renames again and leaves the untitled file behind under a third name.
        guard slug != NoteFilename.fallbackSlug else { return nil }

        // Its own name must not count as a collision, or a note called `…-standup-2.md` would be
        // renamed to `…-standup-3.md` on the next keystroke, then `-4`, for as long as it was typed in.
        let others = Set(existing.filter { $0.lowercased() != filename.lowercased() })
        let candidate = NoteFilename.unique(stem: "\(timestamp)-\(slug)", existing: others)

        return candidate == filename ? nil : candidate
    }
}
