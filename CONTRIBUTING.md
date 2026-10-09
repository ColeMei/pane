# Contributing

Pane is one person's opinionated app, and it has a narrow idea of what it is. That makes some
contributions very welcome and others a waste of your weekend, so this file exists mostly to tell
the two apart before you write any code.

**Open an issue before a pull request** for anything larger than a typo. Not for ceremony — for the
reason above.

## How issues and pull requests are handled

Issues and pull requests are welcome in English or Mandarin. Code, comments and commit messages are
in English.

Every issue is read, reproduced on a real build, and answered. A bug that reproduces gets a fix and a
test that fails without it. An idea gets a yes, a no with the reason, or a "later".

Pull requests are very welcome, and they are read as the most detailed kind of report. Pane is built
against a set of design notes that live outside this repository, so changes are checked and written
here against those notes. In practice the fix usually lands as its own commit rather than as a merge
of yours. Your report, your approach and anything we take from it are credited in the commit and in
the reply. If you want to help with code, an issue with exact steps, or a test that fails, is often
the quickest way to get something fixed.

## The test for any new feature

*Does it help the first ten seconds after the hotkey?*

Pane is a panel you summon over your work, write in, and dismiss. Its advantage over the
alternatives is that it starts instantly, keeps your notes as files you own, and doesn't ask for
anything. Every feature that makes it more like a full notes app makes it less like the thing
that was wanted.

## Deliberately not in scope

These have been decided against, not overlooked:

- AI anything
- Sync of Pane's own — no server, no account, no protocol. Point the vault at iCloud Drive,
  Syncthing or git and use what you already run.
- Telemetry or analytics of any kind
- Tags, folders, wiki links or backlinks
- Images and attachments
- Encryption
- A merge UI for conflicts — Pane detects a conflict and writes a sibling file; it does not try to
  reconcile one
- Windows, Linux or mobile
- An Xcode project — Pane builds with the Command Line Tools alone, on purpose

Multiple panes on screen at once is **deferred**, not refused: the model supports it and no entry
point is wired, because a second pane is a second `WKWebView` and memory is a shipping constraint.

## Things that are settled

A few more decisions the product depends on, so a pull request does not have to discover them:

- **Filenames settle, then freeze.** A note's file is named from its creation time and its first
  line. The name follows the first line while you are still writing, and freezes once you leave the
  note (dismiss, switch notes, quit) or anything else touches the file. The timestamp never changes.
  The title is the first line of the file.
- **A pin is about the note.** Pinning sorts a note to the top of the list. It does not change how
  the window behaves: a pinned note's pane hides and shows like any other.
- **Summoning does not activate the app.** The pane is a non-activating panel; no app switch, no
  menu bar change. The Settings window is the only thing in Pane that activates.
- **Unsigned, and no privacy permissions requested.** A new `NS*UsageDescription` in
  `Scripts/Info.plist` means a promise broke. The one network request is an update check, on
  summon at most once a day, behind a checkbox.
- **Habit-compatible shortcuts.** Every action Pane shares with Raycast Notes keeps the same key.
- **Conflicts are detected, not merged.** Unsaved edits over a file that changed underneath go to
  a `-conflict-<timestamp>` sibling, and the editor follows them there.

## Bugs are the most useful thing you can send

Nearly every fault in this project has been found by someone using the app and reporting what they
saw, not by reading the code. If something feels wrong, that is worth an issue even if you can't
say why. The bug form asks for the few details that otherwise cost a round trip.

## Working on the code

You need the Command Line Tools with Swift 6.0 or newer, and Node (current LTS) for the editor
bundle. Xcode is not needed.

```bash
Scripts/test.sh                # the PaneKit suite — pure Foundation, runs anywhere
Scripts/test-editor.sh         # the formatting commands, in a real WKWebView
Scripts/test-markdown.sh       # typing markdown, and what it draws
Scripts/test-switcher.sh       # the two overlays, measured as rectangles
Scripts/test-tooltip.sh        # when a control names itself, and after how long
Scripts/test-keyboard.sh       # the keyboard tables, in plain node
Scripts/test-all.sh            # every suite above, against one bundle build
Scripts/build-app.sh --debug   # assemble build/Pane.app
```

**Run every suite after touching anything in `Editor/src`** (`Scripts/test-all.sh` does it in one go).
They ask different questions and each has caught what the others could not. CI runs all of them on
every pull request.
They run inside a real `WKWebView` (`Scripts/editor-probe.swift`) because most editor faults here
are about what is painted, not what the DOM says; `pandoc -f commonmark -t html` is the independent
oracle for what typed bytes mean, except for the three rules Pane reads differently from CommonMark,
which are listed at the top of `Editor/src/dialect.ts`.

Two things about the layout worth knowing:

- **`PaneKit` is every piece of pure Foundation logic** — filenames, document reading, the write
  model, ordering, geometry arithmetic, state — so it is testable without a window server. `Pane`
  is only what genuinely needs AppKit, WebKit or Carbon. Anything testable belongs in PaneKit.
- **The buffer is the markdown.** Live preview is view-only decoration over the real text, so what
  lands on disk is byte-for-byte what was typed. A change that makes the document a richer
  structure than the file is a change to the premise.

`Scripts/build-app.sh --debug` stamps the bundle as a scratch build, which gives it its own
application support directory and a vault default of `~/Pane-scratch` — so a debug session cannot
reach your real notes or settings.

## Commits

One logical change per commit, and a message in the form `type: concise description` where type is
`feat`, `fix`, `refactor`, `docs`, `chore` or `test`.

## License

By contributing you agree that your work is licensed under the MIT License, the same as the rest of
the project.
