import AppKit
import PaneKit

/// The About tab — what you are running, and whether it is the latest.
///
/// Not in the design record: frames 2c and 3a–3c draw four tabs and this is a fifth. It is here
/// because the app had no route to its own version at all, which for an unsigned build distributed
/// as a zip and a cask is a real gap: "which one am I on" had no answer inside the app.
///
/// **This is Pane's only network call**, and the shape of it is deliberate. Decision 7 says no
/// server, no account, no protocol, and telemetry is on the not-doing list; a version check is
/// none of those, but it is the first time the app talks to anything, so it happens **only when
/// this button is pressed**. Nothing fires on launch, nothing is scheduled, nothing is sent but the
/// request itself. Decision 9 is untouched: an outgoing HTTPS request needs no entitlement and no
/// privacy permission, so `Info.plist` gains nothing.
///
/// It also does not download, install, or open anything. Pane is unsigned (decision 9), so an
/// auto-updater would need a signing story the project does not have — and the install path is a
/// Homebrew cask, which already knows how to upgrade. The button's whole job is to answer the
/// question; `brew upgrade --cask pane` or the Releases link does the rest.
@MainActor
final class AboutSettingsViewController: NSViewController {

    private static let releasesAPI =
        URL(string: "https://api.github.com/repos/ColeMei/pane/releases/latest")!
    private static let releasesPage = URL(string: "https://github.com/ColeMei/pane/releases")!
    private static let repository = URL(string: "https://github.com/ColeMei/pane")!

    private var status: NSTextField!
    private var checkButton: NSButton!

    /// `CFBundleShortVersionString`, which `build-app.sh` writes from the tag.
    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
    }

    init() {
        super.init(nibName: nil, bundle: nil)
        title = "About"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let icon = NSImageView(image: NSApp.applicationIconImage)
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 72).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 72).isActive = true

        let name = NSTextField(labelWithString: "Pane")
        name.font = .systemFont(ofSize: 15, weight: .semibold)

        // The version and nothing else. A build number is ours rather than the reader's — it says
        // nothing they can act on, and the release it belongs to is the thing they would quote.
        let versionLabel = NSTextField(labelWithString: "Version \(version)")
        versionLabel.font = .systemFont(ofSize: 12)
        versionLabel.textColor = .secondaryLabelColor

        checkButton = SettingsForm.push(
            "Check for Updates", target: self, action: #selector(checkForUpdates)
        )

        // Empty until the button is pressed, and it takes no height while it is — decision 76's
        // rule met by a layout: a line that is not saying anything should not be reserving space
        // for the moment it might.
        status = NSTextField(labelWithString: "")
        status.font = .systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        status.alignment = .center

        let links = NSStackView(views: [
            link("GitHub", to: Self.repository),
            link("Releases", to: Self.releasesPage),
        ])
        links.orientation = .horizontal
        links.spacing = 18

        let stack = NSStackView(views: [icon, name, versionLabel, checkButton, status, links])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.setCustomSpacing(4, after: name)
        stack.setCustomSpacing(18, after: versionLabel)
        stack.setCustomSpacing(20, after: status)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView()
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 28),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -24),
            stack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            // Every tab is the same width, or `NSTabViewController` resizes the *window* on the way
            // in and out of this one. It was 380 and did exactly that.
            container.widthAnchor.constraint(equalToConstant: SettingsForm.contentWidth),
        ])
        // Same rule as every other tab: pin to the top and hug vertically, or `NSTabViewController`
        // stretches this one to the tallest tab and the stack scatters.
        container.setContentHuggingPriority(.required, for: .vertical)
        view = container
    }

    func settingsChanged(_ new: Settings) {}

    private func link(_ title: String, to url: URL) -> NSButton {
        let button = NSButton(title: title, target: self, action: #selector(openLink(_:)))
        button.isBordered = false
        button.bezelStyle = .inline
        button.contentTintColor = .linkColor
        button.font = .systemFont(ofSize: 12)
        button.identifier = NSUserInterfaceItemIdentifier(url.absoluteString)
        return button
    }

    @objc private func openLink(_ sender: NSButton) {
        guard let raw = sender.identifier?.rawValue, let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func checkForUpdates() {
        checkButton.isEnabled = false
        status.stringValue = "Checking…"

        var request = URLRequest(url: Self.releasesAPI)
        request.timeoutInterval = 10
        // GitHub's API refuses a request with no User-Agent. It carries the version rather than
        // anything about the machine, because the version is the only thing the request is about.
        request.setValue("Pane/\(version)", forHTTPHeaderField: "User-Agent")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")

        let current = version
        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            let tag = data.flatMap {
                (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any]
            }?["tag_name"] as? String

            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.checkButton.isEnabled = true

                    guard error == nil, let tag else {
                        // Named as what happened, not explained (decision 76). "Could not check" is
                        // the fact; whether it was DNS, a rate limit or a captive portal is not
                        // something the reader can act on differently.
                        self.status.stringValue = "Could not check for updates"
                        return
                    }

                    switch ReleaseCheck.status(current: current, latest: tag) {
                    case .behind(let latest):
                        // Named, and nothing more. Pressing "check" is a request to be told, not a
                        // request to open a browser — the Releases link below is right there, and
                        // launching one unasked is the app doing something you did not press.
                        self.status.stringValue = "\(latest) is available"
                    case .current:
                        self.status.stringValue = "Pane is up to date"
                    case .unknown:
                        self.status.stringValue = "Could not check for updates"
                    }
                }
            }
        }.resume()
    }
}
