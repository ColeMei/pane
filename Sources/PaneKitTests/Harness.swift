import Foundation

/// A test harness in eighty lines, because the alternative is an Xcode dependency.
///
/// Neither XCTest nor swift-testing ships with the Command Line Tools, and Pane is built with
/// SwiftPM precisely so that a checkout builds without Xcode installed. `swift test` therefore
/// cannot run here at all. So the tests are an ordinary executable — `Scripts/test.sh` — that
/// exits non-zero when something fails. CI needs no toolchain beyond the one that builds the app.
enum Check {
    nonisolated(unsafe) private static var suiteName = ""
    nonisolated(unsafe) private static var testName = ""
    nonisolated(unsafe) private static var failures: [String] = []
    nonisolated(unsafe) private static var assertions = 0
    nonisolated(unsafe) private static var tests = 0

    static func suite(_ name: String, _ body: () -> Void) {
        suiteName = name
        body()
        suiteName = ""
    }

    static func test(_ name: String, _ body: () -> Void) {
        testName = name
        tests += 1
        body()
        testName = ""
    }

    static func expect(
        _ condition: Bool,
        _ detail: @autoclosure () -> String = "",
        file: StaticString = #fileID,
        line: UInt = #line
    ) {
        assertions += 1
        guard !condition else { return }
        record(detail(), file: file, line: line)
    }

    static func equal<T: Equatable>(
        _ actual: T,
        _ expected: T,
        _ label: @autoclosure () -> String = "",
        file: StaticString = #fileID,
        line: UInt = #line
    ) {
        assertions += 1
        guard actual != expected else { return }
        let prefix = label().isEmpty ? "" : label() + ": "
        record("\(prefix)expected \(display(expected)), got \(display(actual))", file: file, line: line)
    }

    static func notEqual<T: Equatable>(
        _ actual: T,
        _ unexpected: T,
        _ label: @autoclosure () -> String = "",
        file: StaticString = #fileID,
        line: UInt = #line
    ) {
        assertions += 1
        guard actual == unexpected else { return }
        let prefix = label().isEmpty ? "" : label() + ": "
        record("\(prefix)expected anything but \(display(unexpected))", file: file, line: line)
    }

    /// Quotes strings and makes whitespace visible, because most of what this suite compares is text
    /// where a trailing newline or a stray space is the entire bug.
    private static func display<T>(_ value: T) -> String {
        guard let s = value as? String else { return "\(value)" }
        let escaped = s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\t", with: "\\t")
        return "\"\(escaped)\""
    }

    private static func record(_ detail: String, file: StaticString, line: UInt) {
        let where_ = "\(file):\(line)"
        let label = [suiteName, testName].filter { !$0.isEmpty }.joined(separator: " › ")
        failures.append("  ✗ \(label)\n    \(where_)\(detail.isEmpty ? "" : "\n    " + detail)")
    }

    /// Prints the summary and returns the process exit code.
    static func finish() -> Int32 {
        if failures.isEmpty {
            print("✓ \(tests) tests, \(assertions) assertions, all passing")
            return 0
        }
        print("\n\(failures.count) failure\(failures.count == 1 ? "" : "s") in \(tests) tests:\n")
        for f in failures { print(f) }
        print("")
        return 1
    }
}
