<p align="center">
  <img src="artifacts/pane-icon.png" alt="Pane app icon" width="120">
</p>

<h1 align="center">Pane</h1>

<p align="center">
  A sheet of glass over whatever you're doing, that you can write on.
</p>

<p align="center">
  <b>A free, open source alternative to Raycast Notes for macOS.</b>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ColeMei/pane?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/built_with-Swift-orange?logo=swift&style=flat-square" alt="Built with Swift">
  <img src="https://img.shields.io/badge/platform-macOS_14+-lightgrey?style=flat-square" alt="Platform: macOS 14+">
  <a href="https://github.com/ColeMei/pane/releases"><img src="https://img.shields.io/github/v/release/ColeMei/pane?style=flat-square" alt="Latest release"></a>
</p>

<p align="center">
  <img src="artifacts/pane-hero.png" alt="The Pane panel floating above a code editor, showing a markdown note rendered live" width="760">
</p>

Press <kbd>⌃⌥Space</kbd> to bring a floating note over your current app and continue where you
left off. Write with live Markdown formatting, switch notes with <kbd>⌘P</kbd>, and dismiss the
panel when you're done. Pane runs independently of Raycast, with unlimited notes and no account
or subscription.

<p align="center">
  <a href="https://github.com/ColeMei/pane/releases/latest"><b>Download for macOS</b></a>
  · <a href="#install">Installation instructions</a>
</p>

## Install

```bash
brew install --cask ColeMei/pane/pane
```

Or download the `.dmg` from the [latest release](https://github.com/ColeMei/pane/releases/latest), open it,
and drag `Pane.app` onto the `Applications` folder beside it.

> [!IMPORTANT]
> **macOS may block Pane on first launch.**
>
> Pane is not signed with an Apple Developer ID or notarized by Apple. Depending on your macOS
> version, Gatekeeper may report that the app is damaged or that its developer cannot be verified.
> If you installed Pane from this repository's releases or Homebrew cask, you can clear its
> quarantine flag once:
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

## Coming from Raycast Notes

Pane is built around familiar Raycast Notes habits: summon a floating note, start typing, and use
keyboard shortcuts to switch notes and run actions. It is a standalone app, so Raycast is not required.

|                | Raycast Notes                    | Pane                                                     |
| -------------- | -------------------------------- | -------------------------------------------------------- |
| Notes          | 5 on the free plan, unlimited on Pro | Unlimited                                              |
| Where they live| Raycast's own storage            | `.md` files in a folder you pick                          |
| Sync           | Cloud Sync, on Pro               | Sync the notes folder between Macs with iCloud Drive or a tool such as Syncthing |
| Cost           | Free tier + Pro subscription     | Free, MIT, no account                                     |
| App            | Part of Raycast                  | Standalone macOS app; no Raycast required                 |

Pane does not provide its own cloud service or an iPhone or iPad app. Folder sync carries your
notes between Macs; local settings and window state stay on each Mac.

Raycast plan details: [pricing](https://www.raycast.com/pricing) and
[Raycast Notes](https://www.raycast.com/core-features/notes), checked September 7, 2026.

*Not affiliated with or endorsed by Raycast Technologies.*

## What it does

<p align="center">
  <img src="artifacts/pane-switcher.png" alt="The note switcher, showing notes grouped into recency bands" width="46%">
  <img src="artifacts/pane-actions.png" alt="The action panel, listing actions with their keyboard shortcuts" width="46%">
</p>

- **Pick up where you left off.** Summon the panel over your current app with a global hotkey.
  Pane remembers your last note and each note's caret position.
- **Write with structure.** Live Markdown keeps headings, lists and code blocks readable while
  you edit. Raw syntax appears on the caret's line while the rest of the note stays rendered.
- **Stay in one panel.** <kbd>⌘P</kbd> switches notes with recency groups, fuzzy title matching and
  full text search. No results? <kbd>⏎</kbd> creates a note with your query as its title.
  <kbd>⌘K</kbd> brings up actions for find, export, reveal in Finder, file renaming, screen capture
  privacy and recently deleted notes.
- **A window that follows your writing.** Height grows with the note until you resize it manually.
  Float over fullscreen apps, follow Spaces, and choose light or dark appearance.
- **Fits your routine.** Access Pane from the menu bar or launch it at login.
- External edits are picked up automatically. If a file changes before Pane saves, it preserves
  the pending edit in a separate conflict file instead of silently overwriting the external change.
- **Deleted notes are recoverable** for as long as you choose, and they wait outside your vault so
  they don't sync back.

## Your notes

Notes are plain Markdown files in a folder you choose, `~/Documents/Pane` by default, with no
added frontmatter or notes database. A note's title is its first line. You can edit the files in
other apps, and Pane picks up those changes automatically.

Caret positions, pins and window geometry live in `~/Library/Application Support/Pane/`, outside
the vault, never synced.

<details>
<summary>File naming and sync details</summary>

While a new note is open, its filename follows the title, for example
`2026-08-11-1453-first-few-words.md`. Once you leave the note, automatic renaming stops; the
timestamp stays fixed. This limits filename changes that sync tools need to reconcile.
Use **Rename File…** in <kbd>⌘K</kbd> whenever you want to rename it yourself.

To sync notes between Macs, choose a folder managed by iCloud Drive or your preferred sync tool
on each Mac. Pane reads and writes the files; the tool handles transferring them.
Pane normalizes trailing newlines when saving, so files are not guaranteed to be byte identical
to text entered or edited elsewhere.

</details>

## Settings

<p align="center">
  <img src="artifacts/pane-settings.png" alt="The Appearance tab of the Settings window" width="46%">
  <img src="artifacts/pane-dark.png" alt="The same note in dark mode" width="46%">
</p>

<kbd>⌘,</kbd> from any pane. Hotkey recorder, vault location, what "recent" means in the switcher,
accent, text size, translucency, and shortcut recorders for navigation and panel actions.
Additional editor shortcut overrides are available in `settings.json`.

It's all plain JSON in `settings.json`, which Pane watches and re-reads live — so editing it by
hand, over SSH, or from a dotfiles repo works immediately.

## Themes

A **theme is just a CSS file**. Drop one in `~/Library/Application Support/Pane/Themes` and it
appears in the Appearance tab. A few of Pane's own variables cover most of what people want to
change, so a usable theme can be four lines:

```css
:root {
  --font-ui: "iA Writer Quattro", Georgia, serif;  /* the note's text */
  --font-mono: "JetBrains Mono", monospace;        /* code and fences */
  --text-size: 16px;                               /* also on ⌘= / ⌘− / ⌘0 */
  --accent: #4a7fb5;                               /* markers, links, the caret */
}
```

Anything else in the file is ordinary CSS against the editor's own classes, and it wins — a theme's
`body` rule overrides Pane's. Themes live outside your notes folder, so they never sync with it.

## Privacy

Pane requests **no privacy permissions at all** — the global hotkey needs no Accessibility access.
No telemetry, no account, no server. The only network call it ever makes is checking for a new
release, and only when you press the button.

## Build from source

A SwiftPM package plus a web bundle. No Xcode project, on purpose — everything builds with the
Command Line Tools alone.

```bash
Scripts/test.sh                # the PaneKit suite — pure Foundation, runs anywhere
Scripts/test-editor.sh         # the formatting commands, in a real WKWebView
Scripts/test-markdown.sh       # typing markdown, and what it draws
Scripts/test-switcher.sh       # the two overlays, measured as rectangles
Scripts/test-tooltip.sh        # when a control names itself, and after how long
Scripts/build-app.sh --debug   # assemble build/Pane.app
```

Swift + AppKit owns the panel, hotkey and file I/O; the editor is CodeMirror 6 in a `WKWebView`.
No Node process, no Rust core, no Electron. The buffer *is* the Markdown source. Live preview
changes its presentation without converting notes to a separate rich text format.

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest, including what Pane deliberately won't do.

## License

MIT

## Acknowledgement

Special thanks to [linux.do](https://linux.do)
