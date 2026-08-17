import Foundation
import PaneKit

private let utc = TimeZone(identifier: "UTC")!

private func tempDirectory(_ label: String) -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("pane-\(label)-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

private func at(_ iso: String) -> Date {
    let f = ISO8601DateFormatter()
    f.timeZone = utc
    return f.date(from: iso)!
}

private func write(_ text: String, _ name: String, into dir: URL) {
    try? text.data(using: .utf8)!.write(to: dir.appendingPathComponent(name))
}

private func names(in dir: URL) -> Set<String> {
    Set((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
}

func runRecentlyDeletedTests() {
    Check.suite("Recently Deleted") {

        Check.test("deleting moves the note out of the vault, not into the Trash") {
            let vault = tempDirectory("vault")
            let store = tempDirectory("deleted")
            write("# Standup\n", "2026-08-11-1453-standup.md", into: vault)

            let record = try? RecentlyDeleted.accept(
                "2026-08-11-1453-standup.md",
                from: vault, into: store,
                at: at("2026-08-16T01:45:30Z"), timeZone: utc
            )

            Check.equal(record?.originalName, "2026-08-11-1453-standup.md")
            Check.equal(names(in: vault), [], "the note must leave the vault")
            Check.equal(
                names(in: store),
                ["20260816-014530--2026-08-11-1453-standup.md"],
                "and land under a timestamped name"
            )
        }

        Check.test("the deletion date survives in the filename, with no index to drift") {
            let name = RecentlyDeleted.storedName(
                original: "2026-08-11-1453-standup.md",
                deletedAt: at("2026-08-16T01:45:30Z"),
                timeZone: utc
            )
            let parsed = RecentlyDeleted.parse(storedName: name, timeZone: utc)

            Check.equal(parsed?.originalName, "2026-08-11-1453-standup.md")
            Check.equal(parsed?.deletedAt, at("2026-08-16T01:45:30Z"))
        }

        Check.test("a note name full of hyphens still parses, because the prefix is fixed-width") {
            // Decision 2's filenames are nothing but hyphens. A parser that searched for a separator
            // rather than counting characters would pick one of these instead of the real one.
            let original = "2026-08-11-1453-a-b-c-d-e-f.md"
            let name = RecentlyDeleted.storedName(
                original: original, deletedAt: at("2026-08-16T01:45:30Z"), timeZone: utc
            )
            Check.equal(RecentlyDeleted.parse(storedName: name, timeZone: utc)?.originalName, original)
        }

        Check.test("two deletes of the same note in the same second do not collide") {
            let vault = tempDirectory("vault")
            let store = tempDirectory("deleted")
            let moment = at("2026-08-16T01:45:30Z")

            write("first\n", "2026-08-11-1453-standup.md", into: vault)
            _ = try? RecentlyDeleted.accept(
                "2026-08-11-1453-standup.md", from: vault, into: store, at: moment, timeZone: utc
            )
            write("second\n", "2026-08-11-1453-standup.md", into: vault)
            _ = try? RecentlyDeleted.accept(
                "2026-08-11-1453-standup.md", from: vault, into: store, at: moment, timeZone: utc
            )

            Check.equal(names(in: store).count, 2, "neither copy may overwrite the other")
            Check.equal(RecentlyDeleted.list(in: store, timeZone: utc).count, 2)
        }

        Check.test("listing is newest first and ignores files it did not put there") {
            let store = tempDirectory("deleted")
            write("a\n", "20260810-090000--2026-08-01-1000-older.md", into: store)
            write("b\n", "20260816-014530--2026-08-11-1453-newer.md", into: store)
            // Something the user dropped in by hand. Not ours, not listed, and — below — not purged.
            write("c\n", "notes-backup.md", into: store)

            let listed = RecentlyDeleted.list(in: store, timeZone: utc)

            Check.equal(listed.count, 2)
            Check.equal(listed.first?.originalName, "2026-08-11-1453-newer.md", "newest first")
            Check.equal(listed.last?.originalName, "2026-08-01-1000-older.md")
        }

        Check.test("restoring puts the note back under its original name") {
            let vault = tempDirectory("vault")
            let store = tempDirectory("deleted")
            write("# Standup\n", "20260816-014530--2026-08-11-1453-standup.md", into: store)

            let restored = try? RecentlyDeleted.restore(
                "20260816-014530--2026-08-11-1453-standup.md",
                from: store, into: vault, timeZone: utc
            )

            Check.equal(restored, "2026-08-11-1453-standup.md")
            Check.equal(names(in: vault), ["2026-08-11-1453-standup.md"])
            Check.equal(names(in: store), [], "and stops being deleted")
        }

        Check.test("restoring onto a taken name uniques rather than clobbering") {
            let vault = tempDirectory("vault")
            let store = tempDirectory("deleted")
            write("the new one\n", "2026-08-11-1453-standup.md", into: vault)
            write("the old one\n", "20260816-014530--2026-08-11-1453-standup.md", into: store)

            let restored = try? RecentlyDeleted.restore(
                "20260816-014530--2026-08-11-1453-standup.md",
                from: store, into: vault, timeZone: utc
            )

            Check.equal(restored, "2026-08-11-1453-standup-2.md")
            let survivor = try? String(
                contentsOf: vault.appendingPathComponent("2026-08-11-1453-standup.md"),
                encoding: .utf8
            )
            Check.equal(survivor, "the new one\n", "the note already in the vault must be untouched")
        }

        Check.test("purge counts from the delete, and only past the retention") {
            let store = tempDirectory("deleted")
            write("a\n", "20260716-014530--2026-01-01-0900-ancient.md", into: store)   // 31 days
            write("b\n", "20260810-014530--2026-01-01-0900-recent.md", into: store)    // 6 days

            let removed = RecentlyDeleted.purge(
                in: store, keepingDays: 30, now: at("2026-08-16T01:45:30Z"), timeZone: utc
            )

            Check.equal(removed, ["20260716-014530--2026-01-01-0900-ancient.md"])
            Check.equal(names(in: store), ["20260810-014530--2026-01-01-0900-recent.md"])
        }

        Check.test("purge never touches a file it did not put there") {
            let store = tempDirectory("deleted")
            write("c\n", "notes-backup.md", into: store)

            _ = RecentlyDeleted.purge(
                in: store, keepingDays: 1, now: at("2030-01-01T00:00:00Z"), timeZone: utc
            )

            Check.equal(names(in: store), ["notes-backup.md"])
        }

        Check.test("forget removes one note and leaves the rest") {
            let store = tempDirectory("deleted")
            write("a\n", "20260816-014530--2026-01-01-0900-secret.md", into: store)
            write("b\n", "20260816-014531--2026-01-02-0900-keep.md", into: store)

            try? RecentlyDeleted.forget("20260816-014530--2026-01-01-0900-secret.md", from: store)

            Check.equal(names(in: store), ["20260816-014531--2026-01-02-0900-keep.md"])
        }

        Check.test("forget refuses a name it did not put there") {
            let store = tempDirectory("deleted")
            write("c\n", "notes-backup.md", into: store)

            var threw = false
            do { try RecentlyDeleted.forget("notes-backup.md", from: store) } catch { threw = true }

            Check.equal(threw, true, "an unparseable name must not be unlinked")
            Check.equal(names(in: store), ["notes-backup.md"])
        }

        Check.test("forget on a missing note throws rather than succeeding quietly") {
            let store = tempDirectory("deleted")

            var threw = false
            do {
                try RecentlyDeleted.forget("20260816-014530--2026-01-01-0900-gone.md", from: store)
            } catch { threw = true }

            Check.equal(threw, true)
        }

        Check.test("a malformed name is not a deleted note") {
            for bad in [
                "2026-08-11-1453-standup.md",          // an ordinary note, no prefix
                "20260816014530--note.md",             // no hyphen in the stamp
                "20260816-0145aa--note.md",            // not all digits
                "20260816-014530-note.md",             // one separator hyphen, not two
                "20260816-014530--",                   // prefix and nothing after it
            ] {
                Check.equal(
                    RecentlyDeleted.parse(storedName: bad, timeZone: utc) == nil, true,
                    "\(bad) must not parse"
                )
            }
        }
    }
}
