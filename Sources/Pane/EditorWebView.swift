import AppKit
import Foundation
import PaneKit
import WebKit

/// Everything the web layer can tell Swift.
///
/// Mirrors `OutboundMessage` in `Editor/src/main.ts` exactly. Decoded into a Swift enum at the
/// boundary rather than passed around as a dictionary, so a message the web layer stops sending
/// becomes a compile error here instead of a silent no-op at runtime.
enum PaneMessage {
    case ready
    case edited(text: String, caret: Int)
    case caret(caret: Int, scrollLine: Int)
    case requestNotes(query: String)
    case openNote(filename: String)
    case createNote(title: String)
    case togglePin(filename: String?)
    case deleteNote(filename: String)
    case close
    case contentHeight(CGFloat)
    case switcherOpen(Bool)
    /// ⌘K opened or closed. Carries the panel's measured height, because how tall it is depends on
    /// how many rows survived the filter — and the pane has to grow to hold it.
    case actionsOpen(open: Bool, height: CGFloat)
    case revealInFinder
    case openSettings
    /// Where the window may be dragged from, in CSS pixels with a top-left origin. Sent by the web
    /// layer because only it knows where its own buttons ended up.
    case dragRegions(titleBar: CGRect, exclusions: [CGRect])
    /// The format bar's heading button was pressed. Carries the button's rect (CSS pixels, top-left
    /// origin) and the caret's current heading level, so the menu can tick it.
    case headingMenu(button: CGRect, level: Int?)

    init?(body: Any) {
        guard let dict = body as? [String: Any], let type = dict["type"] as? String else { return nil }

        func string(_ key: String) -> String { dict[key] as? String ?? "" }
        func number(_ key: String) -> Double { (dict[key] as? NSNumber)?.doubleValue ?? 0 }

        switch type {
        case "ready":
            self = .ready
        case "edited":
            self = .edited(text: string("text"), caret: Int(number("caret")))
        case "caret":
            self = .caret(caret: Int(number("caret")), scrollLine: Int(number("scrollLine")))
        case "requestNotes":
            self = .requestNotes(query: string("query"))
        case "openNote":
            self = .openNote(filename: string("filename"))
        case "createNote":
            self = .createNote(title: string("title"))
        case "togglePin":
            self = .togglePin(filename: dict["filename"] as? String)
        case "deleteNote":
            self = .deleteNote(filename: string("filename"))
        case "close":
            self = .close
        case "contentHeight":
            self = .contentHeight(CGFloat(number("height")))
        case "switcherOpen":
            self = .switcherOpen(dict["open"] as? Bool ?? false)
        case "actionsOpen":
            self = .actionsOpen(
                open: dict["open"] as? Bool ?? false,
                height: CGFloat(number("height"))
            )
        case "revealInFinder":
            self = .revealInFinder
        case "openSettings":
            self = .openSettings
        case "dragRegions":
            self = .dragRegions(
                titleBar: Self.rect(dict["titleBar"]),
                exclusions: (dict["exclusions"] as? [Any] ?? []).map(Self.rect)
            )
        case "headingMenu":
            self = .headingMenu(
                button: Self.rect(dict["button"]),
                level: (dict["level"] as? NSNumber)?.intValue
            )
        default:
            return nil
        }
    }

    private static func rect(_ any: Any?) -> CGRect {
        guard let r = any as? [String: Any] else { return .zero }
        return CGRect(
            x: (r["x"] as? NSNumber)?.doubleValue ?? 0,
            y: (r["y"] as? NSNumber)?.doubleValue ?? 0,
            width: (r["width"] as? NSNumber)?.doubleValue ?? 0,
            height: (r["height"] as? NSNumber)?.doubleValue ?? 0
        )
    }
}

@MainActor
protocol EditorWebViewDelegate: AnyObject {
    func editor(_ editor: EditorWebView, didReceive message: PaneMessage)
}

/// The pane's web view, and the Swift half of decision 4's bridge.
///
/// One `WKScriptMessageHandler` inbound, `evaluateJavaScript` outbound. No Node, no server, no custom
/// scheme — the whole editor is a single self-contained HTML file, which is also why it can be loaded
/// straight off disk with no network entitlement and no loading state to design.
@MainActor
final class EditorWebView: NSView {

    weak var delegate: (any EditorWebViewDelegate)?

    let webView: WKWebView
    private let material = NSVisualEffectView()
    private let dragOverlay = DragOverlayView()
    private let bridge = MessageBridge()

    /// Calls queued before the web layer said `ready`. The bundle loads in a few milliseconds, but
    /// "a few" is not "zero", and the first `loadNote` routinely wins that race on a warm launch.
    private var pendingCalls: [String] = []
    private var isReady = false

    override init(frame frameRect: NSRect) {
        let configuration = WKWebViewConfiguration()

        // Nothing to persist: no cookies, no localStorage, no cache. All state lives in state.json
        // and the vault, and an ephemeral store keeps the footprint honest against the 150 MB bar.
        configuration.websiteDataStore = .nonPersistent()
        configuration.suppressesIncrementalRendering = false

        webView = WKWebView(frame: frameRect, configuration: configuration)
        super.init(frame: frameRect)

        configuration.userContentController.add(bridge, name: "pane")
        bridge.onMessage = { [weak self] message in
            guard let self else { return }
            self.delegate?.editor(self, didReceive: message)
        }

        // The window is a transparent hole; the material is CSS. Without both of these the web view
        // paints an opaque white rectangle over the panel's rounded corners.
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear

        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = false

        #if DEBUG
        webView.isInspectable = true
        #endif

        // The real material, underneath everything.
        //
        // CSS `backdrop-filter` cannot do this job: inside a WKWebView it blurs the *page's* own
        // content, and the desktop behind a transparent window is not page content — so the pane was
        // a flat 88%-alpha rectangle with no blur at all. Only an NSVisualEffectView can sample what
        // is behind the window.
        //
        // `state = .active` is the line that matters. The default, `.followsWindowActiveState`,
        // desaturates the material whenever the owning app is not frontmost — and Pane's whole
        // premise is being usable while another app is frontmost, so the default would make the pane
        // change appearance exactly when it is doing its job.
        material.blendingMode = .behindWindow
        material.state = .active
        material.material = .popover
        material.wantsLayer = true
        material.layer?.cornerRadius = Self.cornerRadius
        material.layer?.masksToBounds = true
        addSubview(material)

        addSubview(webView)
        // Above the web view, and transparent to every click except the ones in the title bar's
        // empty space.
        addSubview(dragOverlay)
    }

    /// Matches `--radius-panel` in `tokens.css`. The web layer still draws the hairline border and
    /// its own rounding; this only stops the material's square corners showing through them.
    static let cornerRadius: CGFloat = 14

    /// Whether Swift draws the material, or the web layer paints a flat background instead.
    var isTranslucent: Bool {
        get { !material.isHidden }
        set { material.isHidden = !newValue }
    }

    /// Both subviews fill the view exactly. Explicit rather than autoresizing masks: this view is
    /// installed as a window's `contentView` at zero size and resized once the window has a frame,
    /// and proportional autoresizing from a zero rect is a coin toss.
    override func layout() {
        super.layout()
        material.frame = bounds
        webView.frame = bounds
        dragOverlay.frame = bounds
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: - Loading

    /// Where the editor bundle lives: inside the app bundle when packaged, and — so that
    /// `swift run Pane` is a usable way to iterate — the repository's `Editor/dist` otherwise.
    static func bundleURL() -> URL? {
        if let resource = Bundle.main.resourceURL {
            let packaged = resource.appendingPathComponent("Editor/index.html")
            if FileManager.default.fileExists(atPath: packaged.path) { return packaged }
        }
        if let override = ProcessInfo.processInfo.environment["PANE_EDITOR_HTML"] {
            return URL(fileURLWithPath: override)
        }
        // Executable at .build/<config>/Pane, so the package root is three levels up.
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        let root = executable.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let development = root.appendingPathComponent("Editor/dist/index.html")
        return FileManager.default.fileExists(atPath: development.path) ? development : nil
    }

    func load() {
        guard let url = Self.bundleURL() else {
            NSLog("Pane: editor bundle not found — run Scripts/build-app.sh")
            return
        }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    // MARK: - Outbound

    func markReady() {
        isReady = true
        let queued = pendingCalls
        pendingCalls.removeAll()
        for call in queued { webView.evaluateJavaScript(call, completionHandler: nil) }
    }

    /// Calls `window.paneHost.<method>(...)`.
    ///
    /// Arguments are JSON-encoded rather than interpolated: a note containing a backtick, a newline
    /// or `</script>` is completely ordinary, and string-concatenating one into a JS expression would
    /// break the editor on exactly the content people write.
    func call(_ method: String, _ arguments: [Any] = []) {
        let encoded = arguments.map(Self.json).joined(separator: ", ")
        let script = "window.paneHost && window.paneHost.\(method)(\(encoded));"

        guard isReady else {
            pendingCalls.append(script)
            return
        }
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    /// Calls `window.paneHost.<method>(...)` with arguments that are already JSON.
    ///
    /// The switcher's rows go through here: they are `Codable` structs encoded once, rather than
    /// being converted to `[String: Any]` first so that `call` can convert them straight back.
    func callJSON(_ method: String, _ jsonArguments: [String]) {
        let script = "window.paneHost && window.paneHost.\(method)(\(jsonArguments.joined(separator: ", ")));"
        guard isReady else {
            pendingCalls.append(script)
            return
        }
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    static func encode<T: Encodable>(_ value: T) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let text = String(data: data, encoding: .utf8)
        else {
            return "null"
        }
        return text
    }

    /// Encodes one argument. `JSONSerialization` needs a container at the top level, so scalars go
    /// through a single-element array and come back out.
    private static func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value], options: []),
              let text = String(data: data, encoding: .utf8),
              text.count >= 2
        else {
            return "null"
        }
        return String(text.dropFirst().dropLast())
    }

    func focusEditor() {
        call("focusEditor")
        // The web view has to be first responder before anything inside it can be, and summoning
        // does not go through a click that would set it.
        window?.makeFirstResponder(webView)
    }

    // MARK: - Dragging

    func setDragRegions(titleBar: CGRect, exclusions: [CGRect]) {
        dragOverlay.setRegions(titleBar: titleBar, exclusions: exclusions, viewHeight: bounds.height)
    }
}

/// Holds the `WKScriptMessageHandler` conformance so the web view does not retain the view that owns
/// it. `WKUserContentController` retains its handlers for the lifetime of the configuration, which
/// makes a direct conformance on `EditorWebView` an unbreakable cycle.
private final class MessageBridge: NSObject, WKScriptMessageHandler {
    @MainActor var onMessage: ((PaneMessage) -> Void)?

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        MainActor.assumeIsolated {
            guard let decoded = PaneMessage(body: message.body) else { return }
            onMessage?(decoded)
        }
    }
}

/// Makes the title bar draggable (rule 3) without stealing any other click.
///
/// `-webkit-app-region: drag` is in the CSS because the design's markup uses it, but it is an
/// Electron/Tauri extension and does nothing in a WKWebView. So the region is reported by the web
/// layer — which is the only place that knows where the buttons ended up after layout — and hit-tested
/// here. Everything outside it returns nil from `hitTest`, so clicks fall straight through to the web
/// view and text selection is untouched.
@MainActor
private final class DragOverlayView: NSView {

    /// Kept in the web layer's own coordinates — **top-left origin, CSS pixels** — and flipped at
    /// hit-test time against the current bounds.
    ///
    /// Flipping when the regions arrive was the obvious version and it is racy: the message is
    /// delivered asynchronously, so a pane that resized between the web layer measuring and Swift
    /// applying (which is exactly what opening the switcher does — the pane grows from note height to
    /// 500 pt) would flip against the wrong height. The draggable strip then lands hundreds of points
    /// down the note, so the title bar stops dragging and a band of body text starts.
    private var draggableTopLeft: [CGRect] = []

    func setRegions(titleBar: CGRect, exclusions: [CGRect], viewHeight: CGFloat) {
        guard !titleBar.isEmpty else {
            draggableTopLeft = []
            return
        }

        // The draggable strip is the title bar with the buttons punched out of it, expressed as the
        // horizontal gaps between them — the bar is one row, so subtracting rectangles reduces to
        // subtracting x-ranges.
        let sorted = exclusions
            .filter { $0.intersects(titleBar) }
            .sorted { $0.minX < $1.minX }

        var spans: [(CGFloat, CGFloat)] = []
        var cursor = titleBar.minX
        for box in sorted {
            if box.minX > cursor { spans.append((cursor, box.minX)) }
            cursor = max(cursor, box.maxX)
        }
        if cursor < titleBar.maxX { spans.append((cursor, titleBar.maxX)) }

        draggableTopLeft = spans.map { span in
            CGRect(x: span.0, y: titleBar.minY, width: span.1 - span.0, height: titleBar.height)
        }
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        let height = bounds.height
        let hit = draggableTopLeft.contains { region in
            let flipped = CGRect(
                x: region.minX,
                y: height - region.maxY,
                width: region.width,
                height: region.height
            )
            return flipped.contains(local)
        }
        return hit ? self : nil
    }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}
