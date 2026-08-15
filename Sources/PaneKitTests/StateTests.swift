import Foundation
import PaneKit

private func at(_ iso: String) -> Date {
    let f = ISO8601DateFormatter()
    f.timeZone = TimeZone(identifier: "UTC")!
    return f.date(from: iso)!
}

/// The error `Hotkey.parse` threw, or nil if it succeeded.
private func parseError(_ input: String) -> Hotkey.ParseError? {
    do {
        _ = try Hotkey.parse(input)
        return nil
    } catch let error as Hotkey.ParseError {
        return error
    } catch {
        return nil
    }
}

private func temporaryDirectory() -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("pane-tests-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

func runStateTests() {
    Check.suite("Hotkey") {

        Check.test("the default is the design's ⌃⌥Space, and is not Raycast's ⌥N") {
            let h = Hotkey.defaultSummon
            Check.equal(h.displayString, "⌃⌥Space")
            Check.equal(h.settingsString, "control+option+space")
            Check.equal(h.keyCode, 49)

            // Decision 12's hard constraint.
            let raycastNotes = Hotkey(keyCode: 45, modifiers: [.option])
            Check.notEqual(h, raycastNotes)
        }

        Check.test("parses the shapes a hand actually types") {
            let expected = Hotkey.defaultSummon
            for spelling in [
                "control+option+space",
                "ctrl+opt+space",
                "Control-Option-Space",
                "control option space",
                "⌃⌥Space",
                "⌃⌥space",
                "option+control+space",
            ] {
                Check.equal(try? Hotkey.parse(spelling), expected, "parsing \(spelling)")
            }
        }

        Check.test("round-trips through its own written form") {
            for combo in ["command+shift+p", "⌃⌥⇧⌘k", "option+f5", "control+grave", "⌘return"] {
                guard let parsed = try? Hotkey.parse(combo) else {
                    Check.expect(false, "failed to parse \(combo)")
                    continue
                }
                Check.equal(try? Hotkey.parse(parsed.settingsString), parsed, "round trip \(combo)")
            }
        }

        Check.test("displays modifiers in Apple's order regardless of input order") {
            let h = try? Hotkey.parse("command+shift+option+control+k")
            Check.equal(h?.displayString, "⌃⌥⇧⌘K")
        }

        Check.test("rejects nonsense with a message that says what is wrong") {
            Check.equal(parseError(""), Hotkey.ParseError.empty)
            Check.equal(parseError("control+option"), Hotkey.ParseError.modifiersOnly)
            Check.equal(parseError("control+banana"), Hotkey.ParseError.unknownToken("banana"))
            Check.equal(parseError("control+a+b"), Hotkey.ParseError.multipleKeys("a", "b"))
        }

        Check.test("a typo in the settings file costs the hotkey, not the launch") {
            let json = Data(#"{"summonHotkey":"control+bananana+space"}"#.utf8)
            let settings = try? JSONDecoder().decode(Settings.self, from: json)
            Check.equal(settings?.summonHotkey, Hotkey.defaultSummon)
        }
    }

    Check.suite("Settings") {

        Check.test("defaults match the brief and the design") {
            let s = Settings()
            Check.equal(s.vaultPath, "~/Documents/Pane")
            Check.equal(s.summonHotkey, Hotkey.defaultSummon)
            Check.equal(s.dismissMode, Settings.DismissMode.sameHotkeyToggles)
            Check.equal(s.recentlyDeletedDays, 30)
            Check.expect(!s.showDockIcon, "Pane lives in the menu bar")
            Check.expect(s.showMenuBarIcon)
            Check.equal(s.appearance, Settings.Appearance.system)
            Check.equal(s.accent, "#c98a1f")
            Check.equal(s.markdownTheme, "")
            Check.expect(s.translucentPanes)
        }

        Check.test("expands the tilde when resolving the vault") {
            let s = Settings()
            Check.expect(!s.vaultURL.path.contains("~"), "got \(s.vaultURL.path)")
            Check.expect(s.vaultURL.path.hasSuffix("/Documents/Pane"), "got \(s.vaultURL.path)")
        }

        Check.test("a settings file with one key keeps every other default") {
            let json = Data(#"{"vaultPath":"~/Notes"}"#.utf8)
            let s = try? JSONDecoder().decode(Settings.self, from: json)
            Check.equal(s?.vaultPath, "~/Notes")
            Check.equal(s?.summonHotkey, Hotkey.defaultSummon)
            Check.equal(s?.textSize, 15)
        }

        Check.test("clamps hand-typed nonsense into a usable range") {
            let big = try? JSONDecoder().decode(Settings.self, from: Data(#"{"textSize":9999}"#.utf8))
            Check.equal(big?.textSize, 32)
            let small = try? JSONDecoder().decode(Settings.self, from: Data(#"{"textSize":1}"#.utf8))
            Check.equal(small?.textSize, 10)
            let zeroDays = try? JSONDecoder().decode(
                Settings.self, from: Data(#"{"recentlyDeletedDays":0}"#.utf8)
            )
            Check.equal(zeroDays?.recentlyDeletedDays, 1, "0 days would mean delete with no undo")
        }

        Check.test("an accent that is not a colour falls back rather than blanking the CSS") {
            // `##"…"##`, because `"#` inside a `#"…"#` literal closes it — and every hex here has one.
            let bads = [
                ##"{"accent":"rebeccapurple"}"##,
                ##"{"accent":"#12345"}"##,
                ##"{"accent":""}"##,
            ]
            for bad in bads {
                let s = try? JSONDecoder().decode(Settings.self, from: Data(bad.utf8))
                Check.equal(s?.accent, "#c98a1f", "for \(bad)")
            }
            let short = try? JSONDecoder().decode(
                Settings.self, from: Data(##"{"accent":"#abc"}"##.utf8)
            )
            Check.equal(short?.accent, "#abc", "three-digit hex is a colour")
        }

        Check.test("a markdown theme is a bare filename, never a path out of the folder") {
            for escape in [#"{"markdownTheme":"../../etc/passwd"}"#, #"{"markdownTheme":".hidden"}"#] {
                let s = try? JSONDecoder().decode(Settings.self, from: Data(escape.utf8))
                Check.equal(s?.markdownTheme, "", "for \(escape)")
            }
            let ok = try? JSONDecoder().decode(
                Settings.self, from: Data(#"{"markdownTheme":"solarized.css"}"#.utf8)
            )
            Check.equal(ok?.markdownTheme, "solarized.css")
        }
    }

    Check.suite("App state") {

        Check.test("caret offsets are restored exactly, not reset to the end") {
            var s = AppState()
            s.recordCaret("note.md", offset: 412, scrollLine: 20)
            Check.equal(s.note("note.md").caretOffset, 412)
            Check.equal(s.note("note.md").scrollLine, 20)
        }

        Check.test("negative offsets from a bad bridge message are clamped, not stored") {
            var s = AppState()
            s.recordCaret("note.md", offset: -5, anchor: -9, scrollLine: -1)
            Check.equal(s.note("note.md").caretOffset, 0)
            Check.equal(s.note("note.md").selectionAnchor, 0)
            Check.equal(s.note("note.md").scrollLine, 0)
        }

        Check.test("the last-used note is the most recently opened one") {
            var s = AppState()
            s.recordOpen("a.md", at: at("2026-08-14T10:00:00Z"))
            s.recordOpen("b.md", at: at("2026-08-14T12:00:00Z"))
            s.recordOpen("c.md", at: at("2026-08-14T11:00:00Z"))
            Check.equal(s.lastUsedFilename, "b.md")
        }

        Check.test("an untouched vault has no last-used note")  {
            Check.expect(AppState().lastUsedFilename == nil)
        }

        Check.test("pins toggle and survive in state, never in the file") {
            var s = AppState()
            Check.equal(s.togglePin("a.md"), true)
            Check.equal(s.togglePin("b.md"), true)
            Check.equal(s.togglePin("a.md"), false)
            Check.equal(s.pinnedFilenames, ["b.md"])
        }

        Check.test("last activity is the later of the file's date and ours") {
            let opened = at("2026-08-14T12:00:00Z")
            let edited = at("2026-08-14T15:00:00Z")
            var s = AppState()
            s.recordOpen("a.md", at: opened)
            Check.equal(s.note("a.md").lastActivity(modified: edited), edited)
            Check.equal(s.note("a.md").lastActivity(modified: at("2026-08-01T00:00:00Z")), opened)
        }

        Check.test("forgetting deleted notes also clears panes pointing at them") {
            var s = AppState()
            s.togglePin("gone.md")
            s.togglePin("kept.md")
            s.panes = [PaneState(noteFilename: "gone.md"), PaneState(noteFilename: "kept.md")]

            s.forgetNotes(missingFrom: ["kept.md"])
            Check.equal(s.pinnedFilenames, ["kept.md"])
            Check.expect(s.panes[0].noteFilename == nil, "orphaned pane must let go of the note")
            Check.equal(s.panes[1].noteFilename, "kept.md")
        }
    }

    Check.suite("State on disk") {

        Check.test("a missing file is first launch, not an error") {
            let store = JSONFileStore<AppState>(url: temporaryDirectory().appendingPathComponent("state.json"))
            let (value, outcome) = store.load(default: AppState())
            Check.equal(outcome, JSONFileStore<AppState>.Outcome.fresh)
            Check.expect(value.notes.isEmpty)
        }

        Check.test("saves and loads a round trip") {
            let store = JSONFileStore<AppState>(url: temporaryDirectory().appendingPathComponent("state.json"))
            var state = AppState()
            state.recordCaret("a.md", offset: 99)
            state.recordOpen("a.md", at: at("2026-08-14T12:00:00Z"))
            state.togglePin("a.md")
            state.panes = [PaneState(noteFilename: "a.md", frames: [
                "built-in": StoredFrame(x: 100, y: 200, width: 692, height: 400),
            ])]

            try? store.save(state)
            let (loaded, outcome) = store.load(default: AppState())
            Check.equal(outcome, JSONFileStore<AppState>.Outcome.loaded)
            Check.equal(loaded, state)
            Check.equal(loaded.panes.first?.frames["built-in"]?.rect.width, 692)
        }

        Check.test("state.json is readable by a human who opens it") {
            let store = JSONFileStore<Settings>(url: temporaryDirectory().appendingPathComponent("settings.json"))
            try? store.save(Settings())
            let text = (try? String(contentsOf: store.url, encoding: .utf8)) ?? ""
            Check.expect(text.contains("\n"), "must be pretty-printed")
            Check.expect(
                text.contains("\"summonHotkey\" : \"control+option+space\""),
                "the hotkey must be legible and editable, got:\n\(text)"
            )
            Check.expect(!text.contains("\\/"), "slashes must not be escaped")
        }

        Check.test("a damaged file is moved aside, never overwritten in place") {
            let dir = temporaryDirectory()
            let url = dir.appendingPathComponent("state.json")
            try? Data("{ this is not json".utf8).write(to: url)

            let store = JSONFileStore<AppState>(url: url)
            let (value, outcome) = store.load(default: AppState())

            Check.expect(value.notes.isEmpty, "falls back to defaults")
            switch outcome {
            case .recovered(let backup, _):
                Check.expect(
                    FileManager.default.fileExists(atPath: backup.path),
                    "the original bytes must survive at \(backup.path)"
                )
                Check.expect(
                    !FileManager.default.fileExists(atPath: url.path),
                    "the damaged file must be moved, not left to be clobbered"
                )
            default:
                Check.expect(false, "expected .recovered, got \(outcome)")
            }
        }

        Check.test("an empty file is treated as damage, not as an empty vault") {
            // This is what a crash mid-write looks like — and what an iCloud placeholder looks like.
            let dir = temporaryDirectory()
            let url = dir.appendingPathComponent("state.json")
            try? Data().write(to: url)

            let (_, outcome) = JSONFileStore<AppState>(url: url).load(default: AppState())
            if case .recovered = outcome {} else {
                Check.expect(false, "expected .recovered, got \(outcome)")
            }
        }

        Check.test("a state file from a newer build keeps the fields this build understands") {
            let dir = temporaryDirectory()
            let url = dir.appendingPathComponent("state.json")
            let future = """
                {
                  "schemaVersion" : 99,
                  "notes" : { "a.md" : { "caretOffset" : 7, "isPinned" : true, "somethingNew" : 1 } },
                  "panes" : [],
                  "unknownTopLevel" : { "x" : 1 }
                }
                """
            try? Data(future.utf8).write(to: url)

            let (loaded, outcome) = JSONFileStore<AppState>(url: url).load(default: AppState())
            Check.equal(outcome, JSONFileStore<AppState>.Outcome.loaded)
            Check.equal(loaded.note("a.md").caretOffset, 7)
            Check.expect(loaded.note("a.md").isPinned)
        }
    }
}
