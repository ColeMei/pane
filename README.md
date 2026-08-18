<h1 align="center">Pane</h1>

<p align="center">
  A sheet of glass over whatever you're doing, that you can write on.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ColeMei/pane?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/built_with-Swift-orange?logo=swift&style=flat-square" alt="Built with Swift">
  <img src="https://img.shields.io/badge/platform-macOS_14+-lightgrey?style=flat-square" alt="Platform: macOS 14+">
  <a href="https://github.com/ColeMei/pane/releases"><img src="https://img.shields.io/github/v/release/ColeMei/pane?style=flat-square" alt="Latest release"></a>
</p>

**Pane** is a hotkey-summoned notes panel for macOS, backed by a folder of markdown files you own.

Press <kbd>⌃⌥Space</kbd> and a panel floats in over your work with the caret already in the note you
used last. Type. Press it again and it goes away, caret back where it was. No filename, no save
dialog, **no app switch** — summoning Pane doesn't activate it or change your menu bar.

The notes are `.md` files in a flat folder you choose. Not a database, not an account — which means
sync is whatever you already use: point iCloud Drive, Syncthing, or a git repo at the folder.

## Install

```bash
brew install --cask ColeMei/pane/pane
```

Or download the `.zip` from the [latest release](https://github.com/ColeMei/pane/releases) and drag
`Pane.app` to `/Applications`.

> [!IMPORTANT]
> **macOS will say Pane "is damaged and can't be opened". It isn't.**
>
> That is what Gatekeeper says about any unsigned app, and right-click → Open no longer gets past
> it. Pane has no Apple Developer ID behind it. Clear the quarantine flag once and it launches
> normally from then on:
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/Pane.app
> ```
>
> Or skip the flag at install time:
>
> ```bash
> brew install --cask --no-quarantine ColeMei/pane/pane
> ```

## What it does

- **<kbd>⌃⌥Space</kbd>** summons and dismisses the panel — without activating the app or changing
  the menu bar. It floats above other apps, follows you between Spaces, and works over fullscreen
  apps.
- **Live markdown**, Typora-style: headings, bold/italic/strike, underline, highlight, inline code
  and code blocks, nested lists, task checkboxes, links, rules, blockquotes. Raw syntax shows only
  where the caret is, so the rest of the note stays rendered while you type.
- **<kbd>⌘P</kbd>** switcher — recency-ordered with bands, fuzzy title match, full-text search. No
  results? <kbd>⏎</kbd> makes a note titled with what you typed.
- **<kbd>⌘K</kbd>** action panel for everything else, so the title bar stays at three icons — find in
  note, copy as markdown, reveal in Finder, export to HTML, hide from screen capture, and the notes
  you deleted.
- **<kbd>⌘N</kbd>** new note. Pin notes to the top of the switcher.
- **Deleted notes are recoverable**, for as long as you choose. They wait outside your vault so they
  don't sync back, and nothing about them lives in a database — the folder *is* the record.
- Height follows the note; dragging it switches that off and holds the height you chose (<kbd>⇧⌘/</kbd>
  turns it back on). Word count in the footer, format bar behind `Aa`.
- Menu bar item, launch at login, light and dark.
- External edits picked up automatically. **Pane never silently overwrites a file that changed
  underneath it** — it writes your version to a sibling and tells you where it went.

## Your notes

Plain `.md` files in a flat folder, `~/Documents/Pane` by default.

Filenames are frozen at creation — `2026-08-11-1453-first-few-words.md` — and the title is just the
first line of the file. Editing the title never renames the file, because renames are the single
biggest source of duplicate and conflicted copies in iCloud Drive and Syncthing.

Nothing Pane needs is stored in your notes. Caret positions, pins, window geometry and recency all
live in `~/Library/Application Support/Pane/state.json`, outside the vault, never synced. There is
no frontmatter and no database. What is in the file is what you typed, byte for byte.

## Settings

<kbd>⌘,</kbd> from any pane, or the menu bar item. Four tabs: the hotkey recorder and launch
options, where the vault lives, appearance and themes, and a rebindable shortcut table.

Everything is also plain JSON in `~/Library/Application Support/Pane/settings.json`, which Pane
watches and re-reads live — so editing it by hand, over SSH, or from a dotfiles repo works and takes
effect immediately.

A **markdown theme is just a CSS file**: drop one in
`~/Library/Application Support/Pane/Themes` and it appears in the Appearance tab. Two ship with the
app — Reading, a roomier serif, and Compact — to copy and edit rather than to start from nothing.

## Privacy

Pane requests **no privacy permissions at all**. The global hotkey goes through
`RegisterEventHotKey`, which needs no Accessibility access, and no network code ships. There is no
telemetry, no account, and no server.

Builds are unsigned, which is the honest trade for that: see the install note above.

## Building from source

Pane is a SwiftPM package plus a web bundle. There is no Xcode project, on purpose — everything here
builds with the Command Line Tools alone.

```bash
Scripts/test.sh                # run the PaneKit suite
Scripts/build-app.sh --debug   # assemble build/Pane.app
```

`swift test` does not work, and neither does `xcodebuild`: XCTest doesn't ship with the Command Line
Tools, so the test suite is an ordinary executable target instead. A fresh checkout tests with
nothing but the toolchain that builds it.

Swift + AppKit owns the panel, hotkey, menu bar and file I/O; the editor is CodeMirror 6 in a
`WKWebView`. No Node process, no Rust core, no Electron. The buffer *is* the markdown — live preview
is view-only decoration, so what lands on disk is byte-for-byte what you typed.

Every non-obvious choice here has a reason, and most of them are written down in the commit that
made them — including the ones that turned out wrong and were reversed. `git log` is the decision
record.

## License

MIT
