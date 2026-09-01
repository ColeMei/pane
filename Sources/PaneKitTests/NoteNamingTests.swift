import Foundation
import PaneKit

private let utc = TimeZone(identifier: "UTC")!

/// The cases here are written from the report, not from the code — decision 84. The report is
/// "8 of the 12 notes in the real vault have a filename that disagrees with their title", and the
/// mechanism behind it is a note titled while thinking getting named after the thought.
func runNoteNamingTests() {
    Check.suite("Filenames follow the title") {

        let name = "2026-08-11-1453-first-few.md"

        func rename(
            _ filename: String, _ title: String, existing: Set<String> = []
        ) -> String? {
            NoteNaming.rename(
                current: filename,
                title: title,
                existing: existing.union([filename]),
                timeZone: utc
            )
        }

        Check.test("the slug follows the first line") {
            Check.equal(rename(name, "Standup notes"), "2026-08-11-1453-standup-notes.md")
        }

        Check.test("the timestamp never moves — it is decision 2's real content") {
            let moved = rename(name, "Something else entirely")!
            Check.equal(String(moved.prefix(NoteFilename.timestampWidth)), "2026-08-11-1453")
        }

        Check.test("an unchanged slug is not a rename") {
            Check.equal(rename(name, "First few"), nil)
            // Same slug by a different route: punctuation and case are not part of a slug.
            Check.equal(rename(name, "First, Few!"), nil)
        }

        // The one that would be permanent as far as the user is concerned. A first line is empty for
        // a keystroke at a time while it is being rewritten — select it, type over it — and a rename
        // to `untitled` inside that window leaves an `untitled` file behind under a third name once
        // the next keystroke renames again.
        Check.test("a name is never degraded to untitled") {
            Check.equal(rename(name, ""), nil)
            Check.equal(rename(name, "   \n\n"), nil)
            // Emoji and punctuation produce no slug either, and must not produce a rename.
            Check.equal(rename(name, "!!! ***"), nil)
            Check.equal(rename(name, "\u{1F600}\u{1F602}"), nil)
        }

        Check.test("an untitled note gets its name the moment it has a title") {
            Check.equal(
                rename("2026-08-11-1453-untitled.md", "Groceries"),
                "2026-08-11-1453-groceries.md"
            )
        }

        Check.test("a collision takes the -2 suffix, from the one implementation of that rule") {
            Check.equal(
                rename(name, "Standup", existing: ["2026-08-11-1453-standup.md"]),
                "2026-08-11-1453-standup-2.md"
            )
            Check.equal(
                rename(
                    name, "Standup",
                    existing: ["2026-08-11-1453-standup.md", "2026-08-11-1453-standup-2.md"]
                ),
                "2026-08-11-1453-standup-3.md"
            )
        }

        // Without excluding the file from its own collision check, a note already carrying `-2` gets
        // renamed to `-3` on the next keystroke, then `-4`, for as long as it is typed in.
        Check.test("a note does not collide with itself") {
            Check.equal(
                NoteNaming.rename(
                    current: "2026-08-11-1453-standup-2.md",
                    title: "Standup",
                    existing: ["2026-08-11-1453-standup.md", "2026-08-11-1453-standup-2.md"],
                    timeZone: utc
                ),
                nil
            )
        }

        Check.test("a hand-named file is left alone entirely") {
            Check.equal(rename("shopping.md", "Groceries"), nil)
            // Fifteen leading characters that only look like a date.
            Check.equal(rename("2026-13-40-1453-x.md", "Groceries"), nil)
            Check.equal(rename("notes-2026-08-11.md", "Groceries"), nil)
        }

        Check.test("a CJK title keeps a name its author can read") {
            Check.equal(
                rename(name, "\u{4f1a}\u{8bae}\u{7eaa}\u{8981}"),
                "2026-08-11-1453-\u{4f1a}\u{8bae}\u{7eaa}\u{8981}.md"
            )
        }

        Check.test("the 48-character cap and the six-word cut still apply") {
            let long = "alpha beta gamma delta epsilon zeta eta theta iota kappa"
            let moved = rename(name, long)!
            let slug = String(
                moved.dropFirst(NoteFilename.timestampWidth + 1).dropLast(".md".count)
            )
            Check.equal(slug.split(separator: "-").count, NoteFilename.maxSlugWords)
            Check.expect(slug.count <= NoteFilename.maxSlugLength, "got \(slug.count): \(slug)")
        }

        Check.test("case-insensitive collisions count, because the volume is") {
            Check.equal(
                rename(name, "Standup", existing: ["2026-08-11-1453-STANDUP.md"]),
                "2026-08-11-1453-standup-2.md"
            )
        }

        // Round trip against the writer: the name this produces must be one `creationDate` still
        // reads, or the note stops being sortable by creation the moment it is renamed.
        Check.test("a renamed note keeps a creation date the parser can read") {
            let moved = rename(name, "Standup notes")!
            Check.equal(
                NoteFilename.creationDate(from: moved, timeZone: utc),
                NoteFilename.creationDate(from: name, timeZone: utc)
            )
        }
    }

    Check.suite("Following an external rename") {

        let open = "2026-08-11-1453-standup.md"
        let hash = ContentHash.of("# Standup\n")

        Check.test("one file with our bytes, and the original gone, is the note") {
            Check.equal(
                VaultSync.renameTarget(
                    of: open,
                    originalIsMissing: true,
                    candidates: ["standup-final.md": hash],
                    baselineHash: hash
                ),
                "standup-final.md"
            )
        }

        // The bug this fixes: the rename was ignored, the pane kept pointing at the dead name, and
        // `VaultIO.write`'s `case .missing: break` wrote the old name back — leaving both files.
        Check.test("the original still being there is not a rename") {
            Check.equal(
                VaultSync.renameTarget(
                    of: open,
                    originalIsMissing: false,
                    candidates: ["standup-final.md": hash],
                    baselineHash: hash
                ),
                nil
            )
        }

        Check.test("two identical files is a copy, and a copy is not followed") {
            Check.equal(
                VaultSync.renameTarget(
                    of: open,
                    originalIsMissing: true,
                    candidates: ["standup-final.md": hash, "standup-copy.md": hash],
                    baselineHash: hash
                ),
                nil
            )
        }

        Check.test("a file with different bytes is somebody else's note") {
            Check.equal(
                VaultSync.renameTarget(
                    of: open,
                    originalIsMissing: true,
                    candidates: ["other.md": ContentHash.of("# Other\n")],
                    baselineHash: hash
                ),
                nil
            )
        }

        Check.test("a burst with nothing in it follows nothing") {
            Check.equal(
                VaultSync.renameTarget(
                    of: open, originalIsMissing: true, candidates: [:], baselineHash: hash
                ),
                nil
            )
        }

        // A rename *and* an edit is not a rename we can prove, so it is not one we follow.
        Check.test("renamed and edited elsewhere is left alone") {
            Check.equal(
                VaultSync.renameTarget(
                    of: open,
                    originalIsMissing: true,
                    candidates: ["standup-final.md": ContentHash.of("# Standup\nmore\n")],
                    baselineHash: hash
                ),
                nil
            )
        }
    }
}
