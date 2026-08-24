import Foundation

/// Comparing the running version against the latest published one.
///
/// Pure arithmetic on version strings, here rather than in the About tab for the layout rule's
/// reason: this is the part that can be wrong, and it can be wrong quietly — a comparison that says
/// "up to date" when it is not is worse than no check at all, and there is no way to see it by
/// looking at the window.
public enum ReleaseCheck {

    public enum Status: Equatable, Sendable {
        /// A newer release exists. Carries the version to name in the button's answer.
        case behind(String)
        /// Nothing newer. Also what a *newer* local build reports — a development build ahead of
        /// the last tag is not "behind", and telling somebody to downgrade would be nonsense.
        case current
        /// One of the two versions could not be read as a version at all.
        case unknown
    }

    /// `v0.5.1` and `0.5.1` are the same version.
    ///
    /// GitHub's `tag_name` carries the `v` because the tags do; `CFBundleShortVersionString` does
    /// not, because Info.plist wants a bare number. Neither is wrong and both arrive here.
    public static func parse(_ version: String) -> [Int]? {
        let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = trimmed.hasPrefix("v") ? String(trimmed.dropFirst()) : trimmed
        guard !body.isEmpty else { return nil }

        var parts: [Int] = []
        for component in body.split(separator: ".", omittingEmptySubsequences: false) {
            // A suffix like `-beta.1` ends the numeric part; everything after it is ignored rather
            // than refused, so a pre-release tag still compares on its numbers.
            let digits = component.prefix { $0.isNumber }
            guard !digits.isEmpty, let value = Int(digits) else { return parts.isEmpty ? nil : parts }
            parts.append(value)
            if digits.count != component.count { break }
        }
        return parts.isEmpty ? nil : parts
    }

    public static func status(current: String, latest: String) -> Status {
        guard let mine = parse(current), let theirs = parse(latest) else { return .unknown }

        // Compared component by component, padding the shorter with zeros, so `0.5` and `0.5.0` are
        // the same version and `0.10.0` is newer than `0.9.0` — which a string comparison would get
        // backwards, and which this project will reach the moment it ships a tenth minor release.
        for index in 0..<max(mine.count, theirs.count) {
            let a = index < mine.count ? mine[index] : 0
            let b = index < theirs.count ? theirs[index] : 0
            if a < b { return .behind(latest) }
            if a > b { return .current }
        }
        return .current
    }
}
