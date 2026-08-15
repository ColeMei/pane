import AppKit
import PaneKit

/// Design frame 3b — the Appearance tab.
///
/// Decision 19 is what makes the theme row worth building: **a theme is a CSS file in a folder.** The
/// dropdown lists whatever is in the themes folder, so Typora-style theming arrives with no new UI
/// and no new code whenever somebody drops a stylesheet in there. That is the entire mechanism.
@MainActor
final class AppearanceSettingsViewController: NSViewController {

    private let settings: SettingsStore

    private var appearanceControl: NSSegmentedControl!
    private var swatches: [AccentSwatchButton] = []
    private var themePopUp: NSPopUpButton!
    private var sizeField: NSTextField!

    init(settings: SettingsStore) {
        self.settings = settings
        super.init(nibName: nil, bundle: nil)
        title = "Appearance"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    private static let appearances: [Settings.Appearance] = [.system, .light, .dark]

    override func loadView() {
        let form = SettingsForm(labelWidth: 150)
        let current = settings.value

        // ---- light / dark ------------------------------------------------------------------
        appearanceControl = NSSegmentedControl(
            labels: ["System", "Light", "Dark"],
            trackingMode: .selectOne,
            target: self,
            action: #selector(appearanceChanged)
        )
        appearanceControl.selectedSegment =
            Self.appearances.firstIndex(of: current.appearance) ?? 0
        form.row("Appearance", appearanceControl)

        // ---- accent ------------------------------------------------------------------------
        swatches = Settings.accentOptions.map { option in
            let swatch = AccentSwatchButton(hex: option.hex, name: option.name)
            swatch.target = self
            swatch.action = #selector(accentChanged(_:))
            return swatch
        }
        let swatchRow = NSStackView(views: swatches)
        swatchRow.orientation = .horizontal
        swatchRow.spacing = 8
        form.row("Accent", swatchRow)

        form.separator()

        // ---- markdown theme ----------------------------------------------------------------
        themePopUp = SettingsForm.popUp([], target: self, action: #selector(themeChanged))
        let openThemes = NSButton(
            title: "Open Themes Folder…", target: self, action: #selector(openThemesFolder)
        )
        openThemes.isBordered = false
        openThemes.contentTintColor = .controlAccentColor
        openThemes.font = .systemFont(ofSize: 12)

        // Dropdown, then the sentence explaining what a theme is, then the way to add one — frame
        // 3b's order, and the order the question actually arrives in.
        let themeNote = NSTextField(
            wrappingLabelWithString:
                "A theme is a CSS file. Drop one in the themes folder and it appears here."
        )
        themeNote.font = .systemFont(ofSize: 11)
        themeNote.textColor = .secondaryLabelColor
        themeNote.preferredMaxLayoutWidth = 280
        themeNote.setContentCompressionResistancePriority(.required, for: .vertical)

        form.row("Markdown theme", stacked: [themePopUp, themeNote, openThemes])

        form.separator()

        // ---- text size ---------------------------------------------------------------------
        let stepper = NSStepper()
        stepper.minValue = 10
        stepper.maxValue = 32
        stepper.increment = 1
        stepper.valueWraps = false
        stepper.integerValue = Int(current.textSize)
        stepper.target = self
        stepper.action = #selector(textSizeChanged)

        sizeField = NSTextField(labelWithString: "\(Int(current.textSize)) px")
        sizeField.font = .systemFont(ofSize: 13)
        sizeField.alignment = .right
        sizeField.widthAnchor.constraint(equalToConstant: 44).isActive = true

        let sizeRow = NSStackView(views: [
            sizeField, stepper, SettingsForm.note("⌘= / ⌘− in any pane"),
        ])
        sizeRow.orientation = .horizontal
        sizeRow.spacing = 8
        form.row("Text size", sizeRow)

        // ---- material ----------------------------------------------------------------------
        let translucent = SettingsForm.checkbox(
            "Translucent panes", target: self, action: #selector(translucentChanged)
        )
        translucent.state = current.translucentPanes ? .on : .off
        form.row("Material", translucent)

        view = form.makeContentView()
        reloadThemes()
        refresh(current)
    }

    override func viewWillAppear() {
        super.viewWillAppear()
        // Someone may have dropped a CSS file in since the window was last opened, and the folder is
        // the entire interface for adding one.
        reloadThemes()
    }

    func settingsChanged(_ new: Settings) {
        refresh(new)
    }

    private func refresh(_ current: Settings) {
        appearanceControl?.selectedSegment = Self.appearances.firstIndex(of: current.appearance) ?? 0
        for swatch in swatches { swatch.isChosen = swatch.hex == current.accent }
        sizeField?.stringValue = "\(Int(current.textSize)) px"
        selectTheme(current.markdownTheme)
    }

    // MARK: - Themes

    private var themeFiles: [String] = []

    private func reloadThemes() {
        let folder = settings.themesFolder
        themeFiles = ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? [])
            .filter { $0.hasSuffix(".css") && !$0.hasPrefix(".") }
            .sorted()

        themePopUp?.removeAllItems()
        themePopUp?.addItem(withTitle: "Pane Default")
        for file in themeFiles {
            themePopUp?.addItem(withTitle: (file as NSString).deletingPathExtension)
        }
        selectTheme(settings.value.markdownTheme)
    }

    private func selectTheme(_ filename: String) {
        guard let index = themeFiles.firstIndex(of: filename) else {
            themePopUp?.selectItem(at: 0)
            return
        }
        themePopUp?.selectItem(at: index + 1)
    }

    @objc private func openThemesFolder() {
        let folder = settings.themesFolder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        NSWorkspace.shared.open(folder)
    }

    // MARK: - Actions

    @objc private func appearanceChanged(_ sender: NSSegmentedControl) {
        let choice = Self.appearances[sender.selectedSegment]
        settings.update { $0.appearance = choice }
    }

    @objc private func accentChanged(_ sender: AccentSwatchButton) {
        settings.update { $0.accent = sender.hex }
    }

    @objc private func themeChanged(_ sender: NSPopUpButton) {
        let index = sender.indexOfSelectedItem
        let file = index == 0 ? "" : themeFiles[index - 1]
        settings.update { $0.markdownTheme = file }
    }

    @objc private func textSizeChanged(_ sender: NSStepper) {
        settings.update { $0.textSize = Double(sender.integerValue) }
    }

    @objc private func translucentChanged(_ sender: NSButton) {
        settings.update { $0.translucentPanes = sender.state == .on }
    }
}

/// One accent dot, drawn as the design draws it: a filled circle, and a ring around the chosen one.
///
/// A custom button rather than `NSColorWell` because the design offers a fixed set rather than the
/// whole colour space — decision 22 reserves accent for interactive state, and a free-for-all picker
/// invites an accent that fails against the pane's material.
@MainActor
final class AccentSwatchButton: NSButton {

    let hex: String

    var isChosen = false {
        didSet { needsDisplay = true }
    }

    init(hex: String, name: String) {
        self.hex = hex
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        isBordered = false
        title = ""
        setButtonType(.momentaryChange)
        toolTip = name
        setAccessibilityLabel(name)
        widthAnchor.constraint(equalToConstant: 22).isActive = true
        heightAnchor.constraint(equalToConstant: 22).isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func draw(_ dirtyRect: NSRect) {
        let colour = NSColor(hex: hex) ?? .controlAccentColor
        let dot = bounds.insetBy(dx: 3, dy: 3)

        colour.setFill()
        NSBezierPath(ovalIn: dot).fill()

        guard isChosen else { return }
        // A gap between the dot and the ring, so the ring reads as selection rather than as a border
        // the swatch always had.
        colour.setStroke()
        let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: 0.75, dy: 0.75))
        ring.lineWidth = 1.5
        ring.stroke()
    }
}

extension NSColor {
    /// `#rgb` or `#rrggbb`, which is what `Settings.accent` holds because the value's other consumer
    /// is CSS.
    convenience init?(hex: String) {
        var digits = Substring(hex)
        guard digits.first == "#" else { return nil }
        digits = digits.dropFirst()

        if digits.count == 3 {
            digits = Substring(digits.flatMap { [$0, $0] })
        }
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }

        self.init(
            srgbRed: CGFloat((value >> 16) & 0xff) / 255,
            green: CGFloat((value >> 8) & 0xff) / 255,
            blue: CGFloat(value & 0xff) / 255,
            alpha: 1
        )
    }
}
