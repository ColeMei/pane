import Foundation
import PaneKit

func runReleaseCheckTests() {
    Check.suite("Release check") {

        Check.test("a tag and a bundle version are the same version") {
            Check.equal(ReleaseCheck.parse("v0.5.1") ?? [], [0, 5, 1])
            Check.equal(ReleaseCheck.parse("0.5.1") ?? [], [0, 5, 1])
        }

        Check.test("nonsense is declined rather than guessed at") {
            Check.equal(ReleaseCheck.parse("") == nil, true)
            Check.equal(ReleaseCheck.parse("v") == nil, true)
            Check.equal(ReleaseCheck.parse("nightly") == nil, true)
        }

        Check.test("a newer release is behind") {
            Check.equal(ReleaseCheck.status(current: "0.5.1", latest: "v0.5.2"), .behind("v0.5.2"))
            Check.equal(ReleaseCheck.status(current: "0.5.1", latest: "v0.6.0"), .behind("v0.6.0"))
            Check.equal(ReleaseCheck.status(current: "0.5.1", latest: "v1.0.0"), .behind("v1.0.0"))
        }

        Check.test("the same version is current") {
            Check.equal(ReleaseCheck.status(current: "0.5.1", latest: "v0.5.1"), .current)
        }

        // A local build ahead of the last tag is the normal state on this machine. Telling the
        // author to downgrade would be nonsense, so ahead reads as current rather than behind.
        Check.test("a build ahead of the tag is not behind") {
            Check.equal(ReleaseCheck.status(current: "0.6.0", latest: "v0.5.1"), .current)
        }

        // The one a string comparison gets backwards, and the one this project reaches the
        // moment it ships a tenth minor release.
        Check.test("ten is greater than nine") {
            Check.equal(ReleaseCheck.status(current: "0.9.0", latest: "v0.10.0"), .behind("v0.10.0"))
            Check.equal(ReleaseCheck.status(current: "0.10.0", latest: "v0.9.0"), .current)
        }

        Check.test("a missing component counts as zero") {
            Check.equal(ReleaseCheck.status(current: "0.5", latest: "v0.5.0"), .current)
            Check.equal(ReleaseCheck.status(current: "0.5", latest: "v0.5.1"), .behind("v0.5.1"))
        }

        Check.test("a pre-release tag compares on its numbers") {
            Check.equal(ReleaseCheck.status(current: "0.5.1", latest: "v0.6.0-beta.1"), .behind("v0.6.0-beta.1"))
        }

        Check.test("an unreadable version answers unknown rather than up to date") {
            Check.equal(ReleaseCheck.status(current: "0.5.1", latest: "nightly"), .unknown)
            Check.equal(ReleaseCheck.status(current: "", latest: "v0.5.2"), .unknown)
        }

        // ---- when to look (decision 136) ----------------------------------------------------

        Check.test("the setting is a switch on the request, not on the notice") {
            let now = Date()
            Check.equal(
                ReleaseCheck.shouldCheck(enabled: false, lastChecked: nil, now: now), false)
            Check.equal(
                ReleaseCheck.shouldCheck(
                    enabled: false, lastChecked: now.addingTimeInterval(-100_000), now: now),
                false)
        }

        Check.test("a machine that has never checked checks") {
            Check.equal(ReleaseCheck.shouldCheck(enabled: true, lastChecked: nil), true)
        }

        Check.test("a day apart checks, an hour apart does not") {
            let now = Date()
            let interval = ReleaseCheck.checkInterval
            Check.equal(
                ReleaseCheck.shouldCheck(
                    enabled: true, lastChecked: now.addingTimeInterval(-3600), now: now),
                false)
            Check.equal(
                ReleaseCheck.shouldCheck(
                    enabled: true, lastChecked: now.addingTimeInterval(-interval), now: now),
                true)
            Check.equal(
                ReleaseCheck.shouldCheck(
                    enabled: true, lastChecked: now.addingTimeInterval(-interval - 1), now: now),
                true)
        }

        // A clock that moved backwards would otherwise leave the check stranded for however long it
        // takes the wall clock to catch up — a fortnight, if somebody set the date forward and back.
        Check.test("a clock that went backwards checks rather than waiting it out") {
            let now = Date()
            Check.equal(
                ReleaseCheck.shouldCheck(
                    enabled: true, lastChecked: now.addingTimeInterval(3600), now: now),
                true)
        }

        // ---- when to say something ----------------------------------------------------------

        Check.test("being behind a version nobody has been told about announces it") {
            Check.equal(
                ReleaseCheck.announcement(status: .behind("v0.6.6"), announced: nil), "v0.6.6")
            Check.equal(
                ReleaseCheck.announcement(status: .behind("v0.6.6"), announced: "v0.6.5"), "v0.6.6")
        }

        // The whole of "once per version". Without this the toast fires on every check, which on a
        // user who does not upgrade is once a day forever — the nagging this is built to avoid.
        Check.test("the same version is announced once and then never again") {
            Check.equal(
                ReleaseCheck.announcement(status: .behind("v0.6.6"), announced: "v0.6.6") == nil,
                true)
        }

        Check.test("being current or unsure says nothing at all") {
            Check.equal(ReleaseCheck.announcement(status: .current, announced: nil) == nil, true)
            Check.equal(ReleaseCheck.announcement(status: .unknown, announced: nil) == nil, true)
            // Including when a check that used to find something now cannot reach the network: a
            // failed request is not news, and must not clear or re-fire the last thing found.
            Check.equal(
                ReleaseCheck.announcement(status: .unknown, announced: "v0.6.6") == nil, true)
        }
    }
}
