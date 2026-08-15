import Foundation

/// Whether the vault may be created, and what to do when it is not there.
///
/// This is decision 13, and its whole point is one distinction: a vault that has never existed and a
/// vault that has been destroyed look identical on disk, and Pane must not treat them the same. The
/// first gets a folder and a welcome note. The second gets asked, because silently recreating it
/// produces an empty panel that is indistinguishable from every note being gone — which is the worst
/// bug this product could have.
///
/// The two are told apart by `AppState.vaultEverCreated`, a flag set once and never cleared. It lives
/// in Application Support, not in the vault, so deleting the vault cannot also delete the evidence
/// that it used to be there.
public enum VaultLifecycle {

    public enum Situation: Equatable, Sendable {
        /// The folder is there. Nothing to do.
        case ready
        /// Never created one. Make it, with a welcome note.
        case firstLaunch
        /// We made one before and it is gone. Ask — never recreate.
        case vaultMissing(URL)
        /// The path exists but is a file, not a directory. Also an ask, for the same reason.
        case pathIsNotADirectory(URL)
    }

    public static func situation(
        vault: URL,
        everCreated: Bool,
        fileManager: FileManager = .default
    ) -> Situation {
        var isDirectory: ObjCBool = false
        if fileManager.fileExists(atPath: vault.path, isDirectory: &isDirectory) {
            return isDirectory.boolValue ? .ready : .pathIsNotADirectory(vault)
        }
        return everCreated ? .vaultMissing(vault) : .firstLaunch
    }

    /// Creates the vault folder and drops the welcome note in it.
    ///
    /// - Returns: the welcome note's filename, so the first summon can open it.
    @discardableResult
    public static func create(
        vault: URL,
        now: Date = Date(),
        fileManager: FileManager = .default
    ) throws -> String {
        try fileManager.createDirectory(at: vault, withIntermediateDirectories: true)

        // Honour a vault that already has notes in it — someone pointing Pane at an existing folder
        // of markdown should not get a welcome note they did not ask for.
        let existing = (try? VaultIO.listNotes(in: vault)) ?? []
        guard existing.isEmpty else { return existing[0].lastPathComponent }

        let text = WelcomeNote.text
        let filename = NoteFilename.unique(
            title: MarkdownDocument.title(of: text),
            date: now,
            existing: []
        )
        try VaultIO.write(text: text, to: vault.appendingPathComponent(filename), expectedHash: nil)
        return filename
    }
}

/// The first thing Pane ever renders, and the only documentation most people will read.
///
/// Three constraints, from the brief: it teaches the hotkey, ⌘P and ⌘N; it demonstrates the live
/// preview by *being* markdown worth rendering; and it is disposable — an ordinary note in an
/// ordinary folder that you can edit or delete without breaking anything.
///
/// So it is short. A welcome note nobody finishes reading has taught nothing, and the product's whole
/// claim is about the first ten seconds.
public enum WelcomeNote {

    public static let text = """
        # Welcome to Pane

        This is a note. It's a markdown file in `~/Documents/Pane` — yours, editable by anything, \
        gone if you delete it.

        ## The three things

        - **⌃⌥Space** summons and dismisses this panel, from anywhere
        - **⌘N** starts a new note
        - **⌘P** finds one you already have

        ## It renders as you type

        Headings, **bold**, *italic*, `code`, and lists all format live. The raw markdown shows on \
        whichever line the caret is on, so nothing is ever hidden from you.

        - [ ] Try ticking this box
        - [x] Then press ⌃⌥Space and come back

        > The file on disk is exactly what you typed. No database, no frontmatter, no sync service.

        ---

        Edit this note, or delete it. Pane will not put it back.

        """
}
