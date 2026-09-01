import AppKit
import WebKit

/*
 The editor's test harness: the real bundle, in a real WKWebView, driven from a JS file.

 Why not a browser or a mocked tree. The browser harness cannot measure layout — serving
 `Editor/dist` over a static server renders the pane about 2px tall, so every height is garbage —
 and a mocked syntax tree would not catch the bugs these tests exist for, which are all about what
 the *real* parser does with a real selection. So: a real window, offscreen, at the pane's own
 width.

 The JS file must export `run(view, bar, doc)` and return `{ checked, failures }`. Exit status is
 0 when `failures` is empty, 1 otherwise, so this behaves like any other test command.
*/

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
    FileHandle.standardError.write(Data("usage: editor-probe <index.html> <test.js>\n".utf8))
    exit(2)
}
let html = URL(fileURLWithPath: arguments[1])
let testFile = URL(fileURLWithPath: arguments[2])
guard let testSource = try? String(contentsOf: testFile, encoding: .utf8) else {
    FileHandle.standardError.write(Data("cannot read \(testFile.path)\n".utf8))
    exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Offscreen, and 692 wide because that is `PanePanel.defaultWidth` — layout has to match the pane.
let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 692, height: 600),
    styleMask: [.borderless], backing: .buffered, defer: false)
let web = WKWebView(frame: window.contentLayoutRect)
window.contentView = web
window.setFrameOrigin(CGPoint(x: -30_000, y: -30_000))
window.orderFront(nil)

// Never let a hung page hold the build.
DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
    FileHandle.standardError.write(Data("editor-probe: timed out\n".utf8))
    exit(2)
}

final class Runner: NSObject, WKNavigationDelegate {
    let source: String
    init(source: String) { self.source = source }

    func webView(_ web: WKWebView, didFinish _: WKNavigation!) {
        Task { @MainActor in
            // The window never becomes key, so `requestAnimationFrame` never fires here — wait on a
            // timer instead, or this hangs until the watchdog above.
            try? await Task.sleep(nanoseconds: 400_000_000)
            await run(web)
        }
    }

    func run(_ web: WKWebView) async {
        // The editor view hangs off `.cm-content` under a minified property name that is not stable
        // across CodeMirror versions, so it is discovered rather than assumed.
        let script = """
        const module = await import("data:text/javascript;base64," + "\(Data(source.utf8).base64EncodedString())");
        const content = document.querySelector(".cm-content");
        const key = Object.keys(content).find((k) => content[k] && content[k].view);
        const view = content[key].view;
        const bar = document.getElementById("format-bar");
        return JSON.stringify(module.run(view, bar, document));
        """
        do {
            let raw = try await web.callAsyncJavaScript(script, contentWorld: .page)
            guard let text = raw as? String,
                  let data = text.data(using: .utf8),
                  let result = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                print("editor-probe: unreadable result")
                exit(2)
            }
            let checked = (result["checked"] as? NSNumber)?.intValue ?? 0
            let failures = result["failures"] as? [[String: Any]] ?? []
            // A suite that returns `mode: "report"` is an instrument rather than a gate: it prints
            // what diverged and exits 0, because a divergence nobody has decided to fix yet must not
            // block a tag. `commands.test.js` returns no mode and is unaffected.
            let reporting = (result["mode"] as? String) == "report"

            if failures.isEmpty {
                print("✓ \(checked) editor assertions, all passing")
                exit(0)
            }
            for failure in failures {
                print("✗ \(failure["case"] ?? "?")")
                print("    want \(String(describing: failure["want"] ?? ""))")
                print("    got  \(String(describing: failure["got"] ?? ""))")
            }
            print("\(reporting ? "—" : "✗") \(failures.count) of \(checked) assertions diverged")
            exit(reporting ? 0 : 1)
        } catch {
            print("editor-probe: \(error)")
            exit(2)
        }
    }
}

let runner = Runner(source: testSource)
web.navigationDelegate = runner
web.loadFileURL(html, allowingReadAccessTo: html.deletingLastPathComponent())
app.run()
