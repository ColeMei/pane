// swift-tools-version:6.0
import PackageDescription

// Pane is built with SwiftPM rather than an Xcode project: the app is a single executable plus a
// web bundle, and `swift build` works with only the Command Line Tools installed. `Scripts/build-app.sh`
// assembles the .app around the binary.
//
// The split is deliberate. PaneKit holds everything that is pure Foundation — filenames, hashing,
// the write model, the vault watcher, state persistence, geometry arithmetic, switcher ordering — so
// it can be unit-tested without a window server. Pane holds only what genuinely needs AppKit, WebKit
// or Carbon.
let package = Package(
    name: "Pane",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Pane", targets: ["Pane"]),
        .library(name: "PaneKit", targets: ["PaneKit"]),
    ],
    targets: [
        .target(name: "PaneKit"),
        .executableTarget(name: "Pane", dependencies: ["PaneKit"]),

        // Not a .testTarget: neither XCTest nor swift-testing ships with the Command Line Tools, so
        // `swift test` cannot run without Xcode installed. The suite is an executable instead —
        // `Scripts/test.sh` — which runs anywhere `swift build` does.
        .executableTarget(name: "PaneKitTests", dependencies: ["PaneKit"]),
    ]
)
