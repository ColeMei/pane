import Foundation
import PaneKit

private let utc = TimeZone(identifier: "UTC")!

private func at(_ iso: String) -> Date {
    let f = ISO8601DateFormatter()
    f.timeZone = utc
    return f.date(from: iso)!
}

func runNoteFilenameTests() {
    Check.suite("Frozen filenames") {

        Check.test("matches the shape the brief specifies") {
            Check.equal(
                NoteFilename.candidate(
                    title: "first few words and then some more",
                    date: at("2026-08-11T14:53:00Z"),
                    timeZone: utc
                ),
                "2026-08-11-1453-first-few-words-and-then-some.md"
            )
        }

        Check.test("takes at most six words") {
            Check.equal(
                NoteFilename.slug(from: "one two three four five six seven eight"),
                "one-two-three-four-five-six"
            )
        }

        Check.test("folds diacritics so Finder shows one name, not two lookalikes") {
            Check.equal(NoteFilename.slug(from: "Café notes"), "cafe-notes")
            Check.equal(NoteFilename.slug(from: "Café notes"), NoteFilename.slug(from: "Cafe notes"))
        }

        Check.test("keeps non-Latin letters rather than mangling them") {
            Check.equal(NoteFilename.slug(from: "会议 notes"), "会议-notes")

            // Greek keeps its letters and loses its accents. The exact final-sigma form is the
            // platform's business, so assert the properties that matter rather than a literal.
            let greek = NoteFilename.slug(from: "Σημειώσεις")
            Check.notEqual(greek, NoteFilename.fallbackSlug)
            Check.expect(!greek.contains("ώ"), "accent survived: \(greek)")
            Check.equal(greek, greek.lowercased())
        }

        Check.test("falls back rather than producing an empty or punctuation-only name") {
            Check.equal(NoteFilename.slug(from: ""), NoteFilename.fallbackSlug)
            Check.equal(NoteFilename.slug(from: "   "), NoteFilename.fallbackSlug)
            Check.equal(NoteFilename.slug(from: "🎉🎉🎉"), NoteFilename.fallbackSlug)
            Check.equal(NoteFilename.slug(from: "!?!?!"), NoteFilename.fallbackSlug)
        }

        Check.test("normalises to NFC so the bytes on disk are deterministic") {
            // Swift compares these two titles as EQUAL — canonical equivalence — but they encode to
            // different UTF-8. APFS finds either; git, rsync and Syncthing see two files. That is
            // the duplicate churn decision 2 exists to prevent.
            let composed = "\u{D55C}\u{AD6D}\u{C5B4}"                       // 한국어, NFC
            let decomposed = "\u{1112}\u{1161}\u{11AB}\u{1100}\u{116E}\u{11A8}\u{110B}\u{1165}"

            let a = NoteFilename.slug(from: composed)
            let b = NoteFilename.slug(from: decomposed)
            Check.equal(a, b)
            Check.equal(
                Array(a.utf8), Array(b.utf8),
                "slugs must agree byte-for-byte, not merely compare equal"
            )
        }

        Check.test("truncates a single very long word instead of giving up on it") {
            Check.equal(
                NoteFilename.slug(from: String(repeating: "a", count: 200)).count,
                NoteFilename.maxSlugLength
            )
        }

        Check.test("never emits a trailing hyphen") {
            let slug = NoteFilename.slug(from: "a b c d e \(String(repeating: "z", count: 60))")
            Check.expect(!slug.hasSuffix("-"), "got \(slug)")
        }

        Check.test("disambiguates two notes started in the same minute") {
            let d = at("2026-08-11T14:53:00Z")
            let first = NoteFilename.unique(title: "Standup", date: d, existing: [], timeZone: utc)
            Check.equal(first, "2026-08-11-1453-standup.md")

            let second = NoteFilename.unique(title: "Standup", date: d, existing: [first], timeZone: utc)
            Check.equal(second, "2026-08-11-1453-standup-2.md")

            let third = NoteFilename.unique(
                title: "Standup", date: d, existing: [first, second], timeZone: utc
            )
            Check.equal(third, "2026-08-11-1453-standup-3.md")
        }

        Check.test("treats the vault as case-insensitive, because the volume usually is") {
            Check.equal(
                NoteFilename.unique(
                    title: "Standup",
                    date: at("2026-08-11T14:53:00Z"),
                    existing: ["2026-08-11-1453-STANDUP.MD"],
                    timeZone: utc
                ),
                "2026-08-11-1453-standup-2.md"
            )
        }

        Check.test("conflict siblings sit beside the original as ordinary notes") {
            let name = NoteFilename.conflictSibling(
                for: "2026-08-11-1453-standup.md",
                date: at("2026-08-14T09:07:00Z"),
                timeZone: utc
            )
            Check.equal(name, "2026-08-11-1453-standup-conflict-2026-08-14-0907.md")
            Check.expect(NoteFilename.isNoteFile(name), "conflict sibling must show in the switcher")
        }

        Check.test("skips dot-files, which keeps iCloud placeholder stubs out of the listing") {
            Check.expect(NoteFilename.isNoteFile("2026-08-11-1453-standup.md"))
            Check.expect(!NoteFilename.isNoteFile(".2026-08-11-1453-standup.md.icloud"))
            Check.expect(!NoteFilename.isNoteFile(".DS_Store"))
            Check.expect(!NoteFilename.isNoteFile("notes.txt"))
            Check.expect(NoteFilename.isNoteFile("Upper.MD"))
        }
    }
}
