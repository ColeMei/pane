<h1 align="center">Pane</h1>

<p align="center">
  A sheet of glass over whatever you're doing, that you can write on.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ColeMei/pane?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/built_with-Swift-orange?logo=swift&style=flat-square" alt="Built with Swift">
  <img src="https://img.shields.io/badge/platform-macOS_14+-lightgrey?style=flat-square" alt="Platform: macOS 14+">
  <img src="https://img.shields.io/badge/status-pre--alpha-red?style=flat-square" alt="Status: pre-alpha">
</p>

> [!WARNING]
> **Nothing is built yet.** This repo currently holds the product brief and the project skeleton.
> There is no app to download. See [docs/BRIEF.md](docs/BRIEF.md) for what's being built and why.

**Pane** is a hotkey-summoned notes panel for macOS, backed by a folder of markdown files you own.

Press the hotkey and a panel floats in over your work with the caret already in the note you used last.
Type. Press it again and the panel goes away, caret back where it was. No filename, no save dialog, no
app switch. Markdown renders live as you type.

The notes are `.md` files in a flat folder you choose. Not a database, not an account — which means
sync is whatever you already use: point iCloud Drive, Syncthing, or a git repo at the folder.

## Planned for v0.1

- Global hotkey summons and dismisses the panel — **without activating the app** or changing the menu bar
- Floats above other apps, follows the current Space, works over fullscreen apps
- Live markdown rendering, Typora-style: headings, emphasis, code, lists, task checkboxes, links, quotes
- `⌘P` switcher — recency-ordered, fuzzy title match, full-text search
- `⌘N` new note; pin notes to the top of the switcher
- Flat vault of `.md` files, default `~/Documents/Pane`
- External edits picked up automatically; never silently overwrites a file that changed underneath it
- Menu bar item, launch at login

**Not in v0.1:** AI features, mobile, Windows/Linux, any sync server or account, telemetry, images,
wiki links, tags, folders, themes, multiple panes on screen, encryption.

## Design

Swift + AppKit owns the panel, hotkey, menu bar, and file I/O; the editor is CodeMirror 6 in a
`WKWebView`. No Node process, no Rust core, no Electron. The buffer *is* the markdown — live preview is
view-only decoration, so what lands on disk is byte-for-byte what you typed.

## Privacy

Pane requests **no privacy permissions at all**. Global hotkeys go through `RegisterEventHotKey`, which
needs no Accessibility access. No network code ships.

Builds will be **unsigned** (no Apple Developer ID), so the first launch will need the quarantine flag
cleared. That'll be documented here when there's something to download.

## License

MIT
