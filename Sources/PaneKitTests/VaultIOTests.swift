import Foundation
import PaneKit

private func vaultDirectory() -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("pane-vault-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

private func at(_ iso: String) -> Date {
    let f = ISO8601DateFormatter()
    f.timeZone = TimeZone(identifier: "UTC")!
    return f.date(from: iso)!
}

func runVaultIOTests() {
    Check.suite("Vault I/O") {

        Check.test("a write round-trips byte-for-byte") {
            // The bar, tested directly: what lands on disk is exactly what was typed.
            let vault = vaultDirectory()
            let url = vault.appendingPathComponent("note.md")
            let text = "# Standup\n\n- [x] review FSEvents debounce PR\n- [ ] ask Marta\n"

            _ = try? VaultIO.write(text: text, to: url, expectedHash: nil)

            let onDisk = (try? Data(contentsOf: url)) ?? Data()
            Check.equal(Array(onDisk), Array(text.utf8), "bytes on disk must equal bytes given")
        }

        Check.test("hostile content survives the round trip unchanged") {
            // Combining marks, emoji, CRLF, a tab, and a lone CR. Every one of these is something a
            // careless read/normalise/write cycle would quietly rewrite.
            let vault = vaultDirectory()
            let url = vault.appendingPathComponent("hostile.md")
            let text = "# Cafe\u{0301} \u{1F600}\r\nline\ttab\rlonely\nend\n"

            _ = try? VaultIO.write(text: text, to: url, expectedHash: nil)
            let onDisk = (try? Data(contentsOf: url)) ?? Data()
            Check.equal(Array(onDisk), Array(text.utf8))
        }

        Check.test("loading normalises the trailing newline but hashes the raw bytes") {
            // Hashing the normalised form instead would make the next conflict check compare a
            // normalised hash against un-normalised disk bytes and write a spurious sibling.
            let vault = vaultDirectory()
            let url = vault.appendingPathComponent("sloppy.md")
            let raw = "# Title\n\n\n\n"
            try? Data(raw.utf8).write(to: url)

            guard let loaded = try? VaultIO.loadText(url) else {
                Check.expect(false, "load failed")
                return
            }
            Check.equal(loaded.text, "# Title\n", "text is normalised for the editor")
            Check.equal(loaded.diskHash, ContentHash.of(raw), "hash tracks what is actually on disk")
            Check.notEqual(loaded.diskHash, ContentHash.of(loaded.text))
        }

        Check.test("a write whose baseline still matches simply lands") {
            let vault = vaultDirectory()
            let url = vault.appendingPathComponent("note.md")
            let first = "# One\n"
            _ = try? VaultIO.write(text: first, to: url, expectedHash: nil)

            let outcome = try? VaultIO.write(
                text: "# Two\n", to: url, expectedHash: ContentHash.of(first)
            )
            Check.equal(outcome, VaultIO.WriteOutcome.written(hash: ContentHash.of("# Two\n")))
            Check.equal(try? String(contentsOf: url, encoding: .utf8), "# Two\n")
        }

        Check.test("a file changed underneath goes to a sibling and the original is untouched") {
            // Decision 8's whole point: neither version may be lost, and the pane keeps typing.
            let vault = vaultDirectory()
            let url = vault.appendingPathComponent("2026-08-11-1453-standup.md")

            let baseline = "# Ours\n"
            _ = try? VaultIO.write(text: baseline, to: url, expectedHash: nil)

            // Somebody else writes.
            let theirs = "# Theirs, from another machine\n"
            try? Data(theirs.utf8).write(to: url)

            // We flush, still believing the baseline.
            let ours = "# Ours, with unsaved edits\n"
            let outcome = try? VaultIO.write(text: ours, to: url, expectedHash: ContentHash.of(baseline))

            guard case .conflicted(let sibling, _)? = outcome else {
                Check.expect(false, "expected a conflict, got \(String(describing: outcome))")
                return
            }

            Check.equal(
                try? String(contentsOf: url, encoding: .utf8), theirs,
                "their file must be left exactly as it was"
            )
            Check.equal(
                try? String(contentsOf: sibling, encoding: .utf8), ours,
                "our text must survive in the sibling"
            )
            Check.expect(
                sibling.lastPathComponent.contains("-conflict-"),
                "got \(sibling.lastPathComponent)"
            )
            Check.expect(
                NoteFilename.isNoteFile(sibling.lastPathComponent),
                "the sibling must be an ordinary note the user can open"
            )
        }

        Check.test("the conflict sibling is named from the original stem") {
            let url = URL(fileURLWithPath: "/tmp/v/2026-08-11-1453-standup.md")
            let sibling = VaultIO.conflictURL(for: url, now: at("2026-08-14T09:07:00Z"))
            Check.equal(sibling.deletingLastPathComponent().path, "/tmp/v")
            Check.expect(
                sibling.lastPathComponent.hasPrefix("2026-08-11-1453-standup-conflict-"),
                "got \(sibling.lastPathComponent)"
            )
        }

        Check.test("listing skips dot-files, write temporaries and non-markdown") {
            let vault = vaultDirectory()
            for name in [
                "2026-08-11-1453-standup.md",
                "2026-08-12-0900-notes.md",
                ".DS_Store",
                ".dat.nosync6FBD.oCYm3U",              // Data.write(.atomic)'s temp file
                ".2026-08-11-1453-standup.md.icloud",  // legacy eviction stub
                "readme.txt",
            ] {
                try? Data("x\n".utf8).write(to: vault.appendingPathComponent(name))
            }

            let notes = ((try? VaultIO.listNotes(in: vault)) ?? []).map(\.lastPathComponent).sorted()
            Check.equal(notes, ["2026-08-11-1453-standup.md", "2026-08-12-0900-notes.md"])
        }

        Check.test("availability reports a real local file as available and an absent one as missing") {
            let vault = vaultDirectory()
            let url = vault.appendingPathComponent("here.md")
            try? Data("hello\n".utf8).write(to: url)

            Check.equal(VaultIO.availability(of: url), NoteAvailability.available)
            Check.equal(
                VaultIO.availability(of: vault.appendingPathComponent("nope.md")),
                NoteAvailability.missing
            )
            Check.equal(VaultIO.availability(of: vault), NoteAvailability.missing, "a directory is not a note")
        }

        Check.test("an empty local file is available, not mistaken for an evicted one") {
            // The dataless heuristic is `size > 0 && allocated == 0`. A genuinely empty note has
            // size 0, so it must not trip it — otherwise every new note would look evicted.
            let vault = vaultDirectory()
            let url = vault.appendingPathComponent("empty.md")
            try? Data().write(to: url)
            Check.equal(VaultIO.availability(of: url), NoteAvailability.available)
        }

        Check.test("reading a normal file never trips the anti-materialisation guard") {
            // The I/O policy is thread-scoped and restored afterwards; a local read must be unaffected.
            let vault = vaultDirectory()
            let url = vault.appendingPathComponent("plain.md")
            let text = "# Plain\nbody\n"
            try? Data(text.utf8).write(to: url)

            let data = try? VaultIO.readWithoutMaterializing(url)
            Check.equal(data.map(Array.init), Array(text.utf8))

            // And a second, ordinary read still works — i.e. the policy was put back.
            Check.equal(try? String(contentsOf: url, encoding: .utf8), text)
        }

        Check.test("materialising an already-present note is a no-op, not an error") {
            let vault = vaultDirectory()
            let url = vault.appendingPathComponent("local.md")
            try? Data("here\n".utf8).write(to: url)

            var threw = false
            do { try VaultIO.materialize(url, timeout: 1) } catch { threw = true }
            Check.expect(!threw, "a local file must not be waited on")
        }

        Check.test("a non-UTF-8 file is refused rather than mangled") {
            let vault = vaultDirectory()
            let url = vault.appendingPathComponent("latin1.md")
            try? Data([0xFF, 0xFE, 0x41, 0x0A]).write(to: url)

            var caught: (any Error)?
            do { _ = try VaultIO.loadText(url) } catch { caught = error }
            Check.expect(caught != nil, "must not silently substitute replacement characters")
        }

        // Decision 10's trailing-newline invariant, on the way out. Normalising only on load looked
        // sufficient for a whole release cycle and was not: the caret sits past the final newline
        // after ⌘↓, so typing at the end of a note saved a file with none at all. Found by running
        // the smoke test against a vault under git, which is exactly what that bar is for.
        Check.test("a write always leaves exactly one trailing newline") {
            let url = vaultDirectory().appendingPathComponent("trailing.md")

            for typed in ["no newline", "one already\n", "three of them\n\n\n"] {
                _ = try? VaultIO.write(text: typed, to: url, expectedHash: nil)
                let raw = (try? String(contentsOf: url, encoding: .utf8)) ?? "<unreadable>"
                Check.expect(
                    raw.hasSuffix("\n") && !raw.hasSuffix("\n\n"),
                    "for \(String(reflecting: typed)) got \(String(reflecting: raw))"
                )
            }
        }

        // The trap in the fix above. `write` returns the hash of the *normalised* bytes, so a caller
        // holding an un-normalised buffer must normalise before comparing — otherwise the two never
        // agree, the dirty check always fires, and the note is rewritten on every debounce forever.
        Check.test("the hash a write returns matches the normalised buffer, not the raw one") {
            let url = vaultDirectory().appendingPathComponent("hash.md")
            let typed = "typed without a trailing newline"

            var written: String?
            if case .written(let hash)? = try? VaultIO.write(
                text: typed, to: url, expectedHash: nil
            ) {
                written = hash
            }

            Check.equal(
                written, ContentHash.of(MarkdownDocument.normalizeTrailingNewline(typed)),
                "normalised buffer must hash to what write stored"
            )
            Check.notEqual(
                written, ContentHash.of(typed),
                "raw buffer must NOT match — this is the comparison that loops if used"
            )
        }
    }
}
