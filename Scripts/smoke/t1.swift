// T1, driven — decision 143.
//
// Drives the *debug* build (build/Pane.app, decision 99) through the accessibility API and the
// event tap, and reads every result off the file, never the screen. What it covers is the part of
// T1 that a file can verify: the write model, the filename rules, external edits, undo, the keys
// that write bytes. What it does not cover stays by hand: the typing script, anything about
// timing, colour, hover or Spaces, and every item that needs a second Mac.
//
// Run:  swift Scripts/smoke/t1.swift            # every item
//       swift Scripts/smoke/t1.swift caret fence  # by name
//
// Needs: the debug build running (Scripts/build-app.sh --debug && open build/Pane.app), the
// terminal trusted for Accessibility, and nothing else claiming the debug hotkey. Notes it makes
// are moved to ~/.trash-t1-<date> at the end (--keep leaves them).
//
// The traps this is written around are all in LAB.md: the pane is AXSystemDialog and is found by
// subrole; a synthetic key goes to whatever is frontmost, so the pane is checked to be up before
// every burst; the first burst after ⌘N is dropped, so a Backspace warms it up; characters post
// slower than 45 ms apart or they are lost; a posted mouse event must carry no modifier flags.

import Cocoa
import ApplicationServices

// MARK: - Result

struct Check {
    let item: String
    let name: String
    let pass: Bool
    let detail: String
}

var checks: [Check] = []
func check(_ item: String, _ name: String, _ pass: Bool, _ detail: String = "") {
    checks.append(Check(item: item, name: name, pass: pass, detail: detail))
    print("  \(pass ? "✓" : "✗") \(name)\(detail.isEmpty ? "" : "  — \(detail)")")
}

// MARK: - The app

let debugApp = "/Users/colemei/01.code/apps/mydeveloper/pane/build/Pane.app"
let support = NSHomeDirectory() + "/Library/Application Support/Pane (Debug)"
let settings = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: support + "/settings.json"))) as! [String: Any]
let vault = NSString(string: (settings["vaultPath"] as? String) ?? "~/Pane-scratch").expandingTildeInPath
let recentlyDeleted = support + "/Recently Deleted"

guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleURL?.path == debugApp }) else {
    print("The debug build is not running: Scripts/build-app.sh --debug && open build/Pane.app"); exit(2)
}
let pid = app.processIdentifier
guard AXIsProcessTrusted() else { print("This terminal is not trusted for Accessibility."); exit(2) }

var hotkeyFlags: CGEventFlags = []
do {
    let spec = ((settings["summonHotkey"] as? String) ?? "control+option+space").lowercased()
    if spec.contains("control") || spec.contains("ctrl") { hotkeyFlags.insert(.maskControl) }
    if spec.contains("option") || spec.contains("alt") { hotkeyFlags.insert(.maskAlternate) }
    if spec.contains("shift") { hotkeyFlags.insert(.maskShift) }
    if spec.contains("command") || spec.contains("cmd") { hotkeyFlags.insert(.maskCommand) }
    guard spec.hasSuffix("space") else { print("This driver only knows how to post a …+space hotkey; the debug build has \(spec)."); exit(2) }
}

// MARK: - Windows and keys

func sleepMs(_ ms: Int) { usleep(UInt32(ms) * 1000) }

/// The pane at a real origin, on *this* Space: layer 3, wider than 300, not parked. All three, or
/// the badge matches. On-screen windows only — `.optionAll` listed a pane on another Space as up,
/// and every keystroke then went to the terminal (LAB, 2026-09-17).
func paneUp() -> Bool {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
    return list.contains { w in
        guard (w[kCGWindowOwnerPID as String] as? Int32) == pid, (w[kCGWindowLayer as String] as? Int) == 3,
              let b = w[kCGWindowBounds as String] as? [String: Any],
              let width = b["Width"] as? Double, let x = b["X"] as? Double else { return false }
        return width > 300 && x > -10000
    }
}

let source = CGEventSource(stateID: .hidSystemState)

func key(_ code: CGKeyCode, _ flags: CGEventFlags = []) {
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)!
        e.flags = flags
        e.post(tap: .cghidEventTap)
    }
    sleepMs(60)
}

enum K {
    static let ret: CGKeyCode = 36, tab: CGKeyCode = 48, delete: CGKeyCode = 51, escape: CGKeyCode = 53
    static let left: CGKeyCode = 123, right: CGKeyCode = 124, down: CGKeyCode = 125, up: CGKeyCode = 126
    static let a: CGKeyCode = 0, b: CGKeyCode = 11, n: CGKeyCode = 45, p: CGKeyCode = 35, k: CGKeyCode = 40
    static let x: CGKeyCode = 7, z: CGKeyCode = 6, space: CGKeyCode = 49
}

func hotkey() { key(K.space, hotkeyFlags) }

func summon() {
    if paneUp() && focusInPane() { return }
    if !paneUp() { hotkey() }
    // Up, then focused: the focus arrives a beat after the window does.
    for _ in 0..<30 { if paneUp() && focusInPane() { sleepMs(150); return }; sleepMs(100) }
    print("!! the pane did not come up with the focus"); exit(2)
}

func dismiss() {
    if !paneUp() { return }
    hotkey()
    for _ in 0..<20 { if !paneUp() { return }; sleepMs(100) }
    print("!! the pane did not park"); exit(2)
}

/// The keyboard focus is in the pane: the system-wide focused element belongs to its pid.
func focusInPane() -> Bool {
    var el: AnyObject?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &el) == .success,
          let e = el else { return false }
    var p: pid_t = 0
    AXUIElementGetPid(e as! AXUIElement, &p)
    return p == pid
}

/// Every burst is preceded by this. A key posted with the pane parked, or up without the focus,
/// lands in another app — and did, once, in the terminal running this driver.
func needPane() {
    for _ in 0..<10 { if paneUp() && focusInPane() { return }; sleepMs(100) }
    print("!! pane not up or not focused before typing"); exit(2)
}

func type(_ text: String) {
    needPane()
    for scalar in text.unicodeScalars {
        var chars = Array(String(scalar).utf16)
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)!
            e.flags = []
            e.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
            e.post(tap: .cghidEventTap)
        }
        sleepMs(55)
    }
}

/// ⌘N, then the warm-up Backspace the first burst after it needs (LAB, 2026-09-01).
func newNote() {
    needPane()
    key(K.n, .maskCommand)
    sleepMs(400)
    key(K.delete)
    sleepMs(200)
}

// MARK: - Accessibility

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func descend(_ el: AXUIElement, role: String, depth: Int = 0) -> AXUIElement? {
    if depth > 8 { return nil }
    if attr(el, kAXRoleAttribute) as? String == role { return el }
    for kid in (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
        if let hit = descend(kid, role: role, depth: depth + 1) { return hit }
    }
    return nil
}

func paneElement() -> AXUIElement? {
    let ax = AXUIElementCreateApplication(pid)
    for w in (attr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? [] where attr(w, kAXSubroleAttribute) as? String == "AXSystemDialog" {
        return w
    }
    return nil
}

func textArea() -> AXUIElement {
    guard let pane = paneElement(), let area = descend(pane, role: "AXTextArea") else { print("!! no text area"); exit(2) }
    return area
}

/// The rendered text — hidden markers absent, revealed ones present (LAB, 2026-09-16).
func renderedText() -> String { attr(textArea(), kAXValueAttribute) as? String ?? "" }

/// Sets the buffer through CodeMirror: the file appears under decision 103's slug a moment later.
func setText(_ text: String) {
    AXUIElementSetAttributeValue(textArea(), kAXValueAttribute as CFString, text as CFTypeRef)
}

func caretOffset() -> Int? {
    guard let v = attr(textArea(), kAXSelectedTextRangeAttribute) else { return nil }
    var range = CFRange()
    guard AXValueGetValue(v as! AXValue, .cfRange, &range) else { return nil }
    return range.location
}

// MARK: - The vault

let fm = FileManager.default
func notes() -> [String] {
    ((try? fm.contentsOfDirectory(atPath: vault)) ?? []).filter { $0.hasSuffix(".md") }.sorted()
}
func read(_ name: String) -> String? { try? String(contentsOfFile: vault + "/" + name, encoding: .utf8) }
func write(_ name: String, _ text: String) {
    // Atomic, as another editor would: a temp file and a rename, so the watcher sees one event.
    let tmp = vault + "/." + name + ".tmp"
    try! text.write(toFile: tmp, atomically: false, encoding: .utf8)
    _ = try? fm.removeItem(atPath: vault + "/" + name)
    try! fm.moveItem(atPath: tmp, toPath: vault + "/" + name)
}
func waitFor(_ what: String, timeoutMs: Int = 3000, _ pred: () -> Bool) -> Bool {
    let steps = timeoutMs / 100
    for _ in 0..<steps { if pred() { return true }; sleepMs(100) }
    return pred()
}
/// The one note whose name carries this slug fragment; nil when there are none or several.
func note(matching fragment: String) -> String? {
    let hits = notes().filter { $0.contains(fragment) }
    return hits.count == 1 ? hits[0] : nil
}
func timestamp(_ name: String) -> String { String(name.prefix(15)) }

var made: Set<String> = []
func track(_ name: String?) { if let n = name { made.insert(n) } }

/// A fresh note whose first line is unique to this run and item. Returns its filename once it exists.
func freshNote(_ item: String, body: String = "") -> String? {
    summon(); newNote()
    let stamp = String(Int(Date().timeIntervalSince1970) % 100000)
    let title = "T1 \(item) \(stamp)"
    type(title + (body.isEmpty ? "" : "\n" + body))
    let slug = "t1-\(item.lowercased())-\(stamp)"
    guard waitFor("note file", { note(matching: slug) != nil }) else { return nil }
    let name = note(matching: slug)
    track(name)
    return name
}

func settle() { sleepMs(900) }

// MARK: - Items

func itemNewNoteWritesNothing() {
    let item = "newnote"
    summon()
    let before = notes()
    newNote()
    dismiss(); settle()
    check(item, "⌘N then dismiss leaves no file", notes() == before, "\(notes().count) notes before and after")
    summon(); newNote(); type("   "); dismiss(); settle()
    check(item, "⌘N and only spaces leaves no file", notes() == before)
}

func itemCaretRoundTrip() {
    let item = "caret"
    guard let name = freshNote(item, body: "second line of the note") else { return check(item, "the note appeared", false) }
    key(K.up, .maskCommand)                       // document start
    for _ in 0..<4 { key(K.right) }               // offset 4, inside the title
    let offset = caretOffset()
    dismiss(); settle()
    let onDisk = read(name) ?? ""
    check(item, "the text is on disk after dismiss", onDisk.hasPrefix("T1 caret") && onDisk.hasSuffix("second line of the note\n"), String(onDisk.prefix(30)).replacingOccurrences(of: "\n", with: "⏎"))
    summon(); sleepMs(300)
    check(item, "the caret is where it was", caretOffset() == offset, "\(String(describing: offset)) → \(String(describing: caretOffset()))")
    let state = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: support + "/state.json"))) as! [String: Any]
    let recorded = ((state["notes"] as? [String: Any])?[name] as? [String: Any])?["caretOffset"] as? Int
    check(item, "state.json records the same caret", recorded == offset, "recorded \(String(describing: recorded))")
}

func itemPartialTitleRename() {
    let item = "rename"
    summon(); newNote()
    let stamp = String(Int(Date().timeIntervalSince1970) % 100000)
    type("Quarterly \(stamp)")
    guard waitFor("partial", { note(matching: "quarterly-\(stamp)") != nil }), let first = note(matching: "quarterly-\(stamp)") else {
        return check(item, "the file appears under the partial title", false)
    }
    check(item, "the file appears under the partial title", true, first)
    type(" budget review")
    let renamed = waitFor("rename") { note(matching: "quarterly-\(stamp)-budget-review") != nil && !notes().contains(first) }
    let second = note(matching: "quarterly-\(stamp)-budget-review")
    track(second)
    check(item, "it renames as the title is finished, with nothing left behind", renamed, second ?? "no file")
    check(item, "the timestamp does not move", second.map(timestamp) == timestamp(first))
    // Leave the note and come back: the name holds now (103).
    dismiss(); settle(); summon(); sleepMs(300)
    key(K.up, .maskCommand); key(K.right, .maskCommand); type(" X")
    settle()
    check(item, "after leaving the note the name holds", note(matching: "quarterly-\(stamp)-budget-review") == second && !notes().contains { $0.contains("budget-review-x") })
    check(item, "…and the edit is in the file", (second.flatMap(read) ?? "").hasPrefix("Quarterly \(stamp) budget review X"))
}

func itemExternalEdit() {
    let item = "external"
    guard let name = freshNote(item, body: "original body") else { return check(item, "the note appeared", false) }
    settle()   // let the debounce flush: this half is about a *settled* note
    let title = (read(name) ?? "").split(separator: "\n").first.map(String.init) ?? ""
    write(name, title + "\nreplaced by another editor\n")
    let arrived = waitFor("arrival", { renderedText().contains("replaced by another editor") })
    check(item, "an external write arrives in the open pane", arrived)
    // Editing the first line after an external write must not rename (103: the name froze).
    summon(); key(K.up, .maskCommand); key(K.right, .maskCommand); type(" Z")
    settle()
    // Same timestamp *and* this item's slug: other notes made in the same minute share the prefix.
    let siblings = notes().filter { $0.hasPrefix(timestamp(name)) && $0.contains("t1-external") }
    check(item, "the name is frozen after an external write, and nothing else appeared", siblings == [name], siblings.joined(separator: ", "))
    check(item, "…and the edit landed in the file", (read(name) ?? "").contains(" Z\n"))
}

/// Decision 8 and 74: an external write *inside* the debounce makes a `-conflict-` sibling with our
/// text, leaves the original holding theirs, and the buffer follows into the sibling.
func itemConflictSibling() {
    let item = "conflict"
    guard let name = freshNote(item, body: "ours") else { return check(item, "the note appeared", false) }
    settle()
    let title = (read(name) ?? "").split(separator: "\n").first.map(String.init) ?? ""
    type(" typed")                                  // unsaved, inside the debounce
    write(name, title + "\ntheirs\n")             // the other writer wins the file
    settle()
    let siblings = notes().filter { $0.hasPrefix(timestamp(name)) && $0.contains("t1-conflict") && $0 != name }
    let sibling = siblings.first { $0.contains("-conflict-") }
    for s in siblings { track(s) }
    check(item, "a conflict sibling is written", sibling != nil, siblings.joined(separator: ", "))
    check(item, "the original keeps their text", (read(name) ?? "").contains("theirs") && !(read(name) ?? "").contains("typed"))
    check(item, "the sibling carries ours", (sibling.flatMap(read) ?? "").contains("ours typed"))
    summon(); type(" more"); settle()
    check(item, "the buffer follows into the sibling (74)", (sibling.flatMap(read) ?? "").contains("typed more") && !(read(name) ?? "").contains("more"))
}

func itemFinderRenameFollowed() {
    let item = "finderrename"
    guard let name = freshNote(item, body: "body") else { return check(item, "the note appeared", false) }
    let renamed = timestamp(name) + "-moved-by-finder.md"
    try! fm.moveItem(atPath: vault + "/" + name, toPath: vault + "/" + renamed)
    made.remove(name); made.insert(renamed)
    sleepMs(1200)
    summon(); key(K.down, .maskCommand); type(" tail")
    settle()
    let hits = notes().filter { $0.hasPrefix(timestamp(name)) && ($0.contains("moved-by-finder") || $0.contains("t1-finderrename")) }
    check(item, "the pane follows a Finder rename, with no duplicate", hits == [renamed], hits.joined(separator: ", "))
    check(item, "the next keystroke lands in the renamed file", (read(renamed) ?? "").contains("body tail"))
}

func itemUndoOnFreshNote() {
    let item = "undo"
    guard let name = freshNote(item, body: "keep me") else { return check(item, "the note appeared", false) }
    dismiss(); settle(); summon(); sleepMs(300)
    key(K.z, .maskCommand); settle()
    check(item, "⌘Z on a freshly opened note changes nothing", (read(name) ?? "").contains("keep me"))
    type(" more"); settle()
    key(K.z, .maskCommand); settle()
    check(item, "⌘Z undoes typing", !(read(name) ?? "").contains(" more"))
    key(K.z, [.maskCommand, .maskShift]); settle()
    check(item, "⇧⌘Z redoes it", (read(name) ?? "").contains(" more"))
}

func itemRenumberOnDelete() {
    let item = "renumber"
    guard let name = freshNote(item) else { return check(item, "the note appeared", false) }
    // ⏎ continues the list itself; typing the number would be escaped (135), which is right.
    type("\n\n1. alpha"); key(K.ret); type("beta"); key(K.ret); type("gamma")
    settle()
    guard (read(name) ?? "").contains("1. alpha\n2. beta\n3. gamma") else { return check(item, "the list was written", false, read(name) ?? "") }
    // Delete the first item: caret to its line end, select to line start, ⌫ twice (text, then the marker's ⏎).
    key(K.up); key(K.up); key(K.right, .maskCommand)
    key(K.left, [.maskCommand, .maskShift]); key(K.delete); key(K.delete)
    settle()
    check(item, "deleting the first item renumbers the rest from 1", (read(name) ?? "").contains("1. beta\n2. gamma"), (read(name) ?? "").split(separator: "\n").suffix(3).joined(separator: "⏎"))
    key(K.z, .maskCommand); settle()
    check(item, "one ⌘Z brings the item and the numbering back together", (read(name) ?? "").contains("1. alpha\n2. beta\n3. gamma"))
}

func itemEscapedMarker() {
    let item = "escape"
    guard let name = freshNote(item) else { return check(item, "the note appeared", false) }
    type("\n\n1. ")
    type("1. three dollars")
    settle()
    check(item, "a marker typed into an empty item is escaped (135)", (read(name) ?? "").contains("1. 1\\. three dollars"), (read(name) ?? "").split(separator: "\n").last.map(String.init) ?? "")
}

func itemFenceClose() {
    let item = "fence"
    guard let name = freshNote(item) else { return check(item, "the note appeared", false) }
    type("\n\n```python"); key(K.ret); type("print(1)")
    settle()
    check(item, "⏎ on an opening fence writes the closing one (108)", (read(name) ?? "").hasSuffix("```python\nprint(1)\n```\n"), (read(name) ?? "").split(separator: "\n").suffix(3).joined(separator: "⏎"))
}

func itemShiftEnterNested() {
    let item = "softbreak"
    guard let name = freshNote(item) else { return check(item, "the note appeared", false) }
    type("\n\n- one"); key(K.ret); key(K.tab); type("two"); key(K.ret, .maskShift); type("under")
    settle()
    check(item, "⇧⏎ in a nested item lands under the item's text (108)", (read(name) ?? "").hasSuffix("- one\n  - two\n    under\n"), (read(name) ?? "").split(separator: "\n").suffix(3).joined(separator: "⏎"))
}

/// Decision 145 put the marker's space in a box of its own. The one thing no suite can see is
/// WebKit's own insertion into contenteditable after a real keystroke — `min-width` against `width`
/// on the marker box once turned `- ` + `a` into `-a` (LAB) — so this types for real and reads bytes.
func itemMarkerOnlyThenType() {
    let item = "markeronly"
    // One note a marker: ⏎ ⏎ out of one list and into the next raced the renumbering filter.
    for marker in ["- ", "1. ", "10. "] {
        guard let name = freshNote(item) else { return check(item, "the note appeared", false) }
        type("\n\n" + marker); sleepMs(400); type("a")
        settle()
        let last = (read(name) ?? "").split(separator: "\n").last.map(String.init) ?? ""
        check(item, "a character typed after `\(marker)` lands after the space (145)", last == marker + "a", last)
    }
}

func itemDeleteIntoRecentlyDeleted() {
    let item = "ctrlx"
    guard let name = freshNote(item, body: "settled body") else { return check(item, "the note appeared", false) }
    settle()
    let before = (try? fm.contentsOfDirectory(atPath: recentlyDeleted)) ?? []
    type(" RACE"); key(K.x, .maskControl)        // inside the debounce
    settle()
    let after = (try? fm.contentsOfDirectory(atPath: recentlyDeleted)) ?? []
    let moved = Set(after).subtracting(before).first { $0.hasSuffix(".md") }
    made.remove(name)
    check(item, "⌃X removes the note from the vault", !notes().contains(name))
    check(item, "…into Recently Deleted", moved != nil, moved ?? "nothing new")
    let kept = moved.flatMap { try? String(contentsOfFile: recentlyDeleted + "/" + $0, encoding: .utf8) } ?? ""
    check(item, "carrying the last half-second (56)", kept.contains("settled body RACE"))
    if let m = moved { _ = try? fm.removeItem(atPath: recentlyDeleted + "/" + m) }
}

func itemBoldWritesMarkers() {
    let item = "bold"
    guard let name = freshNote(item, body: "word") else { return check(item, "the note appeared", false) }
    key(K.left, [.maskCommand, .maskShift])       // select the word
    key(K.b, .maskCommand); settle()
    check(item, "⌘B on a selection writes **word**", (read(name) ?? "").hasSuffix("**word**\n"), (read(name) ?? "").split(separator: "\n").last.map(String.init) ?? "")
    key(K.b, .maskCommand); settle()
    check(item, "⌘B again takes them off (64)", (read(name) ?? "").hasSuffix("\nword\n"))
}

// MARK: - Run

let items: [(String, () -> Void)] = [
    ("newnote", itemNewNoteWritesNothing),
    ("caret", itemCaretRoundTrip),
    ("rename", itemPartialTitleRename),
    ("external", itemExternalEdit),
    ("conflict", itemConflictSibling),
    ("finderrename", itemFinderRenameFollowed),
    ("undo", itemUndoOnFreshNote),
    ("renumber", itemRenumberOnDelete),
    ("escape", itemEscapedMarker),
    ("fence", itemFenceClose),
    ("softbreak", itemShiftEnterNested),
    ("markeronly", itemMarkerOnlyThenType),
    ("ctrlx", itemDeleteIntoRecentlyDeleted),
    ("bold", itemBoldWritesMarkers),
]

let args = Array(CommandLine.arguments.dropFirst())
let keep = args.contains("--keep")
let wanted = args.filter { !$0.hasPrefix("--") }
print("T1 driver → \(debugApp)\n  vault \(vault)\n")
for (name, run) in items where wanted.isEmpty || wanted.contains(name) {
    print("• \(name)")
    run()
}

// Leave the pane on a note that will survive the cleanup, then move this run's notes out.
if !keep && !made.isEmpty {
    summon(); newNote(); type("T1 run finished"); settle(); dismiss()
    let day = { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f.string(from: Date()) }()
    let trash = NSHomeDirectory() + "/.trash-t1-" + day
    try? fm.createDirectory(atPath: trash, withIntermediateDirectories: true)
    for name in made where fm.fileExists(atPath: vault + "/" + name) {
        try? fm.moveItem(atPath: vault + "/" + name, toPath: trash + "/" + name)
    }
    print("\nmoved \(made.count) notes to \(trash)")
    sleepMs(1500)   // let the watcher digest the moves before asking for the pane
}
if !paneUp() { hotkey(); sleepMs(800) }   // developing mode: leave the build up for a hand pass

let failed = checks.filter { !$0.pass }
print("\n\(failed.isEmpty ? "✓" : "✗") \(checks.count) checks, \(failed.count) failing")
for f in failed { print("  ✗ \(f.item): \(f.name)  \(f.detail)") }
exit(failed.isEmpty ? 0 : 1)
