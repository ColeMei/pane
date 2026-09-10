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
///
/// **Rewritten for decision 129**, against a 460×460 first-run pane rather than a 692-wide one, and
/// with the fold treated as part of the design: at 460 the note is 924pt and the pane shows ~370 of
/// it, so everything load-bearing — all four keys and the ⇧⌘/ tip — is on the first screen, and the
/// cut lands on an unticked checkbox, which is a more specific invitation to scroll than a sentence
/// severed mid-clause. **⌘K is named**, which the first version never did despite it carrying
/// fifteen actions. **The vault path is not named**: `~/Documents/Pane` is true only until someone
/// moves their vault, after which the note is a lie sitting in their own folder — "a folder you own"
/// plus ⌘K → Reveal in Finder is true permanently and teaches a key on the way past.
public enum WelcomeNote {

    public static let text = """
        # Welcome to Pane

        This is a note. Press **⌃⌥Space** to put Pane away. Press it again and Pane comes right back.

        ## Start with three keys

        - **⌘N** New note
        - **⌘P** Find a note
        - **⌘K** Everything else

        Pane starts at a fixed size. Press **⇧⌘/** if you'd rather have it grow with your notes.

        ## Just write

        Markdown formats as you type.

        Try **bold**, *italic*, `code`, a heading, a list, or a checkbox.

        - [ ] Tick this box
        - [x] This one's done

        The markdown for the line you're editing stays visible, so you can always see what you're \
        writing.

        > Every note is a plain `.md` file in a folder you own. No database. No account. Nothing to \
        sign into.

        You can find them anytime with **⌘K → Reveal in Finder**.

        That's enough to get started.

        Feel free to delete this note. Pane won't bring it back.

        """
}
