import AppKit
import WebKit

/*
 The editor's test harness: the real bundle, in a real WKWebView, driven from a JS file.

 Why not a browser or a mocked tree. The browser harness cannot measure layout — serving
 `Editor/dist` over a static server renders the pane about 2px tall, so every height is garbage —
 and a mocked syntax tree would not catch the bugs these tests exist for, which are all about what
 the *real* parser does with a real selection. So: a real window, offscreen, at the pane's own
 width.

 The JS file must export `run(view, bar, doc)` and return `{ checked, failures }`, and may add a
 `note` to print. Exit status is 0 when `failures` is empty, 1 otherwise, so this behaves like any
 other test command.
*/

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
    FileHandle.standardError.write(Data("usage: editor-probe <index.html> <test.js> [width]\n".utf8))
    exit(2)
}
// Optional, because one suite's subject is the pane being *narrow*: the ⌘K panel drops its shortcut
// chips below 420 so the labels fit, and that rule reads the viewport — which is the pane. Every
// other suite wants the width users have and leaves this off.
let paneWidth = arguments.count >= 4 ? Double(arguments[3]) ?? 460 : 460
let html = URL(fileURLWithPath: arguments[1])
let testFile = URL(fileURLWithPath: arguments[2])
guard let testSource = try? String(contentsOf: testFile, encoding: .utf8) else {
    FileHandle.standardError.write(Data("cannot read \(testFile.path)\n".utf8))
    exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Offscreen, and 460 wide by default because that is `PanePanel.defaultWidth` — layout has to match
// the pane.
let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: paneWidth, height: 600),
    styleMask: [.borderless], backing: .buffered, defer: false)
let web = WKWebView(frame: window.contentLayoutRect)
window.contentView = web
window.setFrameOrigin(CGPoint(x: -30_000, y: -30_000))
window.orderFront(nil)

// `PROBE_SCALE=1` renders as a 1x display does, whatever this Mac's screen is: a hairline that is
// whole at 2x can floor to a different width at 1x (205's checkbox, LAB 2026-10-09). WebKit SPI,
// measured on home 2026-10-23: `devicePixelRatio` and the snapshot's pixels both follow it.
if let scale = Double(ProcessInfo.processInfo.environment["PROBE_SCALE"] ?? "") {
    let sel = NSSelectorFromString("_setOverrideDeviceScaleFactor:")
    guard web.responds(to: sel) else {
        FileHandle.standardError.write(Data("editor-probe: this WebKit cannot override the scale\n".utf8))
        exit(2)
    }
    typealias SetScale = @convention(c) (AnyObject, Selector, CGFloat) -> Void
    unsafeBitCast(web.method(for: sel), to: SetScale.self)(web, sel, CGFloat(scale))
}

/// `await webkit.messageHandlers.probeShot.postMessage({x, y, width, height})`, in CSS pixels:
/// the rendered pixels of that rectangle as `{width, height, rgba}`, `rgba` base64, at the device
/// scale. So a suite can assert what was painted rather than what the style says.
final class Shot: NSObject, WKScriptMessageHandlerWithReply {
    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], let web = message.webView,
              let x = body["x"] as? Double, let y = body["y"] as? Double,
              let w = body["width"] as? Double, let h = body["height"] as? Double else { return (nil, "bad rectangle") }
        let config = WKSnapshotConfiguration()
        config.rect = CGRect(x: x, y: y, width: w, height: h)
        guard let image = try? await web.takeSnapshot(configuration: config),
              let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return (nil, "no snapshot") }
        let pw = cg.width, ph = cg.height
        var data = [UInt8](repeating: 0, count: pw * ph * 4)
        let ctx = CGContext(data: &data, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: pw * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: pw, height: ph))
        return (["width": pw, "height": ph, "rgba": Data(data).base64EncodedString()], nil)
    }
}
let shot = Shot()
web.configuration.userContentController.addScriptMessageHandler(shot, contentWorld: .page, name: "probeShot")

// Never let a hung page hold the build. The gesture replay runs thousands of cells and sets its own.
let timeout = Double(ProcessInfo.processInfo.environment["PROBE_TIMEOUT"] ?? "") ?? 60
DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
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
        // Awaited, so a suite can wait on a real timer — the tooltip delay cannot be asserted any
        // other way. `await` on a plain object is the object, so every synchronous suite is
        // unaffected.
        return JSON.stringify(await module.run(view, bar, document));
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
            // A line the suite wants read that is not a failure: what it set aside, and why.
            if let note = result["note"] as? String { print("— \(note)") }

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
