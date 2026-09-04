# Contributing

Pane is one person's opinionated app, and it has a narrow idea of what it is. That makes some
contributions very welcome and others a waste of your weekend, so this file exists mostly to tell
the two apart before you write any code.

**Open an issue before a pull request** for anything larger than a typo. Not for ceremony — for the
reason above.

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

## Bugs are the most useful thing you can send

Nearly every fault in this project has been found by someone using the app and reporting what they
saw, not by reading the code. If something feels wrong, that is worth an issue even if you can't
say why. The bug form asks for the few details that otherwise cost a round trip.

## Working on the code

```bash
Scripts/test.sh                # the PaneKit suite — pure Foundation, runs anywhere
Scripts/test-editor.sh         # the formatting commands, in a real WKWebView
Scripts/test-markdown.sh       # typing markdown, and what it draws
Scripts/test-switcher.sh       # the two overlays, measured as rectangles
Scripts/test-tooltip.sh        # when a control names itself, and after how long
Scripts/build-app.sh --debug   # assemble build/Pane.app
```

**Run all four editor suites after touching anything in `Editor/src`.** They ask different
questions and each has caught what the others could not. CI runs all five on every pull request.

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
