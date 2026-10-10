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

    // MARK: - When to look, and when to say something

    /// How long between checks. A day, and the unit is the day rather than the launch.
    ///
    /// Pane is an app you leave running for weeks — it is summoned, not launched — so "once per
    /// launch" would be once per reboot on some machines and forty times a day on others. A release
    /// happens at most a few times a month here, so a day is already far more often than there is
    /// anything to find.
    public static let checkInterval: TimeInterval = 24 * 60 * 60

    /// Whether to make the request at all.
    ///
    /// `enabled` is the user's setting and comes first: switched off means no request, not a
    /// request whose answer is discarded — the setting is about the network call, not about the
    /// notice.
    ///
    /// Called on **summon**, never on launch and never on a timer. That is the whole of decision
    /// 94's amendment: a summon is a keypress, so there is a person at the keyboard when the answer
    /// arrives, and nothing happens on a machine nobody is sitting at.
    public static func shouldCheck(
        enabled: Bool,
        lastChecked: Date?,
        now: Date = Date(),
        interval: TimeInterval = ReleaseCheck.checkInterval
    ) -> Bool {
        guard enabled else { return false }
        guard let lastChecked else { return true }
        // A clock that has gone backwards — a timezone change, a manual set, a restore — reads as a
        // negative interval and would otherwise wait however long it takes to catch up.
        let elapsed = now.timeIntervalSince(lastChecked)
        return elapsed >= interval || elapsed < 0
    }

    // MARK: - What a check leaves behind

    /// What a check's answer leaves in `state.json`: the newer version it found, or nil for none.
    ///
    /// **One rule for both callers.** The summon check and the About button ask the same question
    /// of the same endpoint, and their answers used to land in different places — the button said
    /// "v0.6.6 is available" in its own window and the menu bar never heard about it. Both now go
    /// through here.
    ///
    /// `.unknown` keeps what was there. A check that could not reach the network is not news that
    /// the update went away — a captive portal must not silently retract the notice.
    public static func remembered(after status: Status, previously: String?) -> String? {
        switch status {
        case .behind(let latest): return latest
        case .current: return nil
        case .unknown: return previously
        }
    }

    /// The newer version still waiting, or nil — what the toast names, the menu item names and the
    /// icon's dot stands for.
    ///
    /// **Re-compared against the running build, never trusted as stored.** On the first launch of
    /// v0.6.6 the file still says `v0.6.6`; this answers nil, so upgrading clears every notice at
    /// once rather than at the next check. There is no dismissed or read flag anywhere: the notice
    /// is derived from the comparison, so it cannot go stale and it cannot be lost.
    ///
    /// **The toast repeats, once a day, until the upgrade** (amending decision 136's "once per
    /// version"). Once per version was too easy to miss for good: one toast, perhaps into a pane
    /// that was closing, and with the menu bar icon switched off nothing else ever said it again.
    /// The toast follows the daily summon check and nothing else, so `checkInterval` is what keeps
    /// it to once a day; switching the check off in Settings switches the toast off with it.
    public static func pending(remembered: String?, running: String) -> String? {
        guard let remembered,
              case .behind(let version) = status(current: running, latest: remembered)
        else { return nil }
        return version
    }

    // MARK: - Where to send somebody

    /// The release page for one tag, or nil when the tag is not plainly a version.
    ///
    /// "Update to v0.6.6…" opens the page for v0.6.6 — its notes and its download — rather than the
    /// list of every release. The tag arrives over the network, so it is only put into a URL when it
    /// reads as a version and holds nothing but the characters a version is made of; anything else
    /// falls back to the list, which is still the right place, just one click further away.
    public static func releasePage(tag: String, in releases: URL) -> URL? {
        let allowed = CharacterSet(charactersIn:
            "0123456789.-+abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
        guard parse(tag) != nil,
              tag.unicodeScalars.allSatisfy { allowed.contains($0) },
              !tag.contains("..")
        else { return nil }
        return releases.appendingPathComponent("tag").appendingPathComponent(tag)
    }
}
