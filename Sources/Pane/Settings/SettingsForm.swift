import AppKit

/// Builds the right-aligned label / left-aligned control layout every Settings tab uses.
///
/// Design frames 2c and 3a–3c are all the same form: a fixed-width label column, right-aligned,
/// against a control column that starts where the labels end. That is `NSGridView`'s exact shape, so
/// this is a thin wrapper rather than a layout engine — its whole job is to keep four tabs from each
/// inventing their own spacing.
///
/// Colours and fonts come from AppKit rather than from `tokens.css`. The design's greys (#3a3a3e,
/// #86868b) *are* macOS's own label colours sampled out of a mockup, and hard-coding them would mean
/// a settings window that ignores Increase Contrast and gets dark mode wrong by hand.
@MainActor
final class SettingsForm {

    /// The width every tab is, and the padding around the content in it.
    ///
    /// The frames are 540 wide inside the window chrome. It is a constant here rather than a literal
    /// per tab because `NSTabViewController` sizes the window to whichever tab is showing, so a tab
    /// that disagrees makes the *window* change width as you switch tabs — which is what the About
    /// tab did at 380, snapping the window narrower and back.
    static let contentWidth: CGFloat = 540
    static let contentInset: CGFloat = 24

    let grid: NSGridView
    private let labelWidth: CGFloat

    /// - Parameter labelWidth: 170 in frame 2c, 150 in 3a–3c. Passed in rather than shared, because
    ///   the widest label differs per tab and a single value would leave two tabs visibly loose.
    init(labelWidth: CGFloat) {
        self.labelWidth = labelWidth
        grid = NSGridView(numberOfColumns: 2, rows: 0)
        grid.translatesAutoresizingMaskIntoConstraints = false
        grid.columnSpacing = 12
        grid.rowSpacing = 10
        grid.column(at: 0).xPlacement = .trailing
        grid.column(at: 0).width = labelWidth
        grid.column(at: 1).xPlacement = .leading
    }

    // MARK: - Rows

    /// A labelled row. `controls` are stacked vertically when there is more than one, which is how
    /// the design draws radio groups and a control with a note under it.
    @discardableResult
    func row(_ label: String, _ controls: NSView...) -> NSGridRow {
        addRow(label, Array(controls))
    }

    @discardableResult
    func row(_ label: String, stacked controls: [NSView]) -> NSGridRow {
        addRow(label, controls)
    }

    private func addRow(_ label: String, _ controls: [NSView]) -> NSGridRow {
        let content: NSView
        if controls.count == 1 {
            content = controls[0]
        } else {
            let stack = NSStackView(views: controls)
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 6
            // The grid hugs its content at required priority so the tab view cannot stretch it (see
            // `makeContentView`). Required hugging also outranks the default 750 compression
            // resistance of everything inside, so without this the grid squeezes a two-radio row
            // until the radios overlap and drops the third view in a stack entirely.
            stack.setContentCompressionResistancePriority(.required, for: .vertical)
            for control in controls {
                control.setContentCompressionResistancePriority(.required, for: .vertical)
            }
            content = stack
        }

        let row = grid.addRow(with: [Self.label(label), content])
        // Labels sit on the first line of a multi-line control rather than in the middle of it,
        // which is what "Sync:" against a three-row radio group needs.
        row.cell(at: 0).yPlacement = controls.count > 1 ? .top : .center
        return row
    }

    /// A note under the previous row, aligned with the controls rather than with the labels.
    func hint(_ text: String, width: CGFloat = 280) {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = .systemFont(ofSize: 11)
        field.textColor = .secondaryLabelColor
        field.preferredMaxLayoutWidth = width
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        // Vertically it must not compress at all — a two-line note squeezed to one line loses its
        // second line rather than truncating it.
        field.setContentCompressionResistancePriority(.required, for: .vertical)

        let row = grid.addRow(with: [NSGridCell.emptyContentView, field])
        row.topPadding = -4
    }

    /// The hairline the design puts between groups of settings.
    func separator() {
        let line = NSBox()
        line.boxType = .separator
        let row = grid.addRow(with: [NSGridCell.emptyContentView, line])
        row.topPadding = 4
        row.bottomPadding = 4
        // Spans both columns: the design's rule runs the full width of the sheet, not just the
        // control column.
        row.mergeCells(in: NSRange(location: 0, length: 2))
    }

    // MARK: - Controls

    static func label(_ text: String) -> NSTextField {
        let field = NSTextField(labelWithString: text.isEmpty ? "" : "\(text):")
        field.font = .systemFont(ofSize: 13)
        field.alignment = .right
        return field
    }

    static func note(_ text: String) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: 13)
        field.textColor = .secondaryLabelColor
        return field
    }

    static func checkbox(_ title: String, target: AnyObject, action: Selector) -> NSButton {
        let button = NSButton(checkboxWithTitle: title, target: target, action: action)
        button.font = .systemFont(ofSize: 13)
        return button
    }

    static func radio(_ title: String, target: AnyObject, action: Selector, tag: Int) -> NSButton {
        let button = NSButton(radioButtonWithTitle: title, target: target, action: action)
        button.font = .systemFont(ofSize: 13)
        button.tag = tag
        return button
    }

    static func popUp(_ titles: [String], target: AnyObject, action: Selector) -> NSPopUpButton {
        let popUp = NSPopUpButton(frame: .zero, pullsDown: false)
        popUp.addItems(withTitles: titles)
        popUp.target = target
        popUp.action = action
        popUp.font = .systemFont(ofSize: 13)
        return popUp
    }

    static func push(_ title: String, target: AnyObject, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: target, action: action)
        button.bezelStyle = .rounded
        button.font = .systemFont(ofSize: 13)
        return button
    }

    /// A path shown the way the design draws it — monospaced, in a recessed field, not editable.
    ///
    /// Not an `NSTextField` the user can type into: the vault has to exist, and the way to say that
    /// is a Change… button and an open panel rather than validating a hand-typed path on every
    /// keystroke.
    static func pathField(_ path: String) -> NSTextField {
        let field = NSTextField(labelWithString: path)
        field.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
        field.textColor = .secondaryLabelColor
        field.lineBreakMode = .byTruncatingMiddle
        field.drawsBackground = true
        field.backgroundColor = .textBackgroundColor
        field.isBordered = true
        field.bezelStyle = .roundedBezel
        field.isBezeled = true
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    // MARK: - Assembly

    /// Wraps the grid in a view with the padding the frames use, ready to be a tab's content.
    func makeContentView() -> NSView {
        let container = NSView()
        container.addSubview(grid)

        // `NSTabViewController` sizes its container to the *tallest* tab and stretches the others to
        // match. An equal-height constraint to the container — at any priority the grid is willing to
        // satisfy — passes that extra height straight into `NSGridView`'s row distribution, which
        // spreads a four-row form over 500 points and parks each label miles from its control.
        //
        // So the grid is pinned to the top only, and told to hug its content at required priority.
        // The container is then free to be taller than the form without any of that height reaching
        // the rows.
        grid.setContentHuggingPriority(.required, for: .vertical)

        NSLayoutConstraint.activate([
            grid.topAnchor.constraint(equalTo: container.topAnchor, constant: 20),
            grid.leadingAnchor.constraint(
                equalTo: container.leadingAnchor, constant: Self.contentInset
            ),
            grid.trailingAnchor.constraint(
                lessThanOrEqualTo: container.trailingAnchor, constant: -Self.contentInset
            ),
            container.bottomAnchor.constraint(greaterThanOrEqualTo: grid.bottomAnchor, constant: 24),
            container.widthAnchor.constraint(equalToConstant: Self.contentWidth),
        ])
        return container
    }
}
