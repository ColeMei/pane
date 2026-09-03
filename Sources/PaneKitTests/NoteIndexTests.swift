import Foundation
import PaneKit

private func indexVault() -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("pane-index-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

/// Eviction cannot be staged on a temporary directory — a dataless file needs a real file provider —
/// so the tests below stage it in the one place the index actually asks about it. Everything else is
/// a real file on a real disk: the point of the exercise is the cache key, not the syscall.
private func stagedAvailability(evicted: Set<String>) -> (URL) -> NoteAvailability {
    { url in
        guard evicted.contains(url.lastPathComponent) else { return VaultIO.availability(of: url) }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        return .evicted(logicalSize: size)
    }
}

private func row(_ index: NoteIndex, _ filename: String) -> NoteRecord? {
    index.record(filename)
}

func runNoteIndexTests() {
    Check.suite("Note index") {

        Check.test("a note re-reads when iCloud finishes downloading it") {
            // The v0.6.3 bug. A dataless file reports its real size and its real mtime, so
            // materialising it moves neither half of the old size-and-mtime cache key: a note
            // indexed mid-download stayed titleless and unsearchable until the app was restarted.
            let vault = indexVault()
            let name = "2026-09-02-1432-slides-revised.md"
            try? Data("Slides Revised\n\nfirst body line\n".utf8)
                .write(to: vault.appendingPathComponent(name))

            let index = NoteIndex()
            _ = try? index.refresh(vault: vault, availabilityOf: stagedAvailability(evicted: [name]))
            Check.equal(row(index, name)?.availability, .evicted(logicalSize: 32), "staged as evicted")
            Check.equal(row(index, name)?.text == nil, true, "an evicted note has no body to search")

            // iCloud downloads it. Not one byte of the file changes.
            _ = try? index.refresh(vault: vault, availabilityOf: stagedAvailability(evicted: []))

            Check.equal(row(index, name)?.title, "Slides Revised", "the real title arrives")
            Check.equal(row(index, name)?.preview, "first body line")
            Check.equal(row(index, name)?.availability, .available)
            Check.expect(row(index, name)?.text != nil, "and the body is searchable again")
        }

        Check.test("an unchanged available note is not re-read") {
            // The early-out still has to earn its keep: 200 notes per keystroke is why it exists.
            let vault = indexVault()
            let url = vault.appendingPathComponent("2026-09-02-1432-stable.md")
            try? Data("Stable\n".utf8).write(to: url)

            var probes = 0
            let counting: (URL) -> NoteAvailability = { u in
                probes += 1
                return VaultIO.availability(of: u)
            }

            // Pinned rather than read back: the filesystem stores nanoseconds and `setAttributes`
            // rounds, so restoring an mtime the OS chose does not reproduce it.
            let frozen = Date(timeIntervalSince1970: 1_788_000_000)
            try? FileManager.default.setAttributes([.modificationDate: frozen], ofItemAtPath: url.path)

            let index = NoteIndex()
            _ = try? index.refresh(vault: vault, availabilityOf: counting)
            // Swap in bytes the index must not notice: same length, same mtime, so a re-read would
            // show up as a changed title.
            try? Data("Edited\n".utf8).write(to: url)
            try? FileManager.default.setAttributes([.modificationDate: frozen], ofItemAtPath: url.path)

            _ = try? index.refresh(vault: vault, availabilityOf: counting)

            Check.equal(row(index, "2026-09-02-1432-stable.md")?.title, "Stable", "cached, not re-read")
            Check.equal(probes, 2, "one availability stat per note per refresh, and no file read")
        }

        Check.test("an evicted note we have never read is titled from its filename") {
            // Better a name the user chose than a column of identical "Untitled" rows on a mac that
            // is syncing the vault for the first time.
            let vault = indexVault()
            let name = "2026-09-02-1432-slides-revised.md"
            try? Data("Slides Revised\n".utf8).write(to: vault.appendingPathComponent(name))

            let index = NoteIndex()
            _ = try? index.refresh(vault: vault, availabilityOf: stagedAvailability(evicted: [name]))

            Check.equal(row(index, name)?.title, "Slides revised")
            Check.equal(row(index, name)?.preview, "", "there is no body to preview, and none is invented")
        }

        Check.test("text read before an eviction outlives it") {
            // Decision 13's existing promise, kept: a note read this session stays searchable even
            // after iCloud takes its bytes back.
            let vault = indexVault()
            let name = "2026-09-02-1432-notes.md"
            try? Data("Real Title\n\nbody text\n".utf8).write(to: vault.appendingPathComponent(name))

            let index = NoteIndex()
            _ = try? index.refresh(vault: vault, availabilityOf: stagedAvailability(evicted: []))
            _ = try? index.refresh(vault: vault, availabilityOf: stagedAvailability(evicted: [name]))

            Check.equal(row(index, name)?.title, "Real Title", "the title survives the eviction")
            Check.expect(row(index, name)?.text != nil, "and so does the body")
        }
    }
}
