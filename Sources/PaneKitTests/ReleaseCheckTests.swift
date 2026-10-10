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

        // ---- what a check leaves behind ----------------------------------------------------

        Check.test("a check that finds a newer version remembers it") {
            Check.equal(ReleaseCheck.remembered(after: .behind("v0.6.6"), previously: nil), "v0.6.6")
            Check.equal(
                ReleaseCheck.remembered(after: .behind("v0.6.7"), previously: "v0.6.6"), "v0.6.7")
        }

        Check.test("a check that finds nothing newer forgets") {
            Check.equal(ReleaseCheck.remembered(after: .current, previously: "v0.6.6") == nil, true)
        }

        // A failed request is not news. Clearing here would let a captive portal retract the notice.
        Check.test("a check that could not answer keeps what was there") {
            Check.equal(ReleaseCheck.remembered(after: .unknown, previously: "v0.6.6"), "v0.6.6")
            Check.equal(ReleaseCheck.remembered(after: .unknown, previously: nil) == nil, true)
        }

        // ---- what is still waiting ----------------------------------------------------------

        // The whole of "once a day until the upgrade": the same remembered version is pending on
        // every check for as long as the running build is behind it — nothing marks it as told.
        Check.test("a remembered newer version stays pending until the upgrade") {
            Check.equal(ReleaseCheck.pending(remembered: "v0.6.6", running: "0.6.5"), "v0.6.6")
            Check.equal(ReleaseCheck.pending(remembered: "v0.6.6", running: "0.6.5"), "v0.6.6")
        }

        // The first launch after upgrading still has the old answer on disk. It must read as
        // nothing, at once, not at the next check a day later.
        Check.test("upgrading clears it without waiting for a check") {
            Check.equal(ReleaseCheck.pending(remembered: "v0.6.6", running: "0.6.6") == nil, true)
            Check.equal(ReleaseCheck.pending(remembered: "v0.6.6", running: "0.7.0") == nil, true)
        }

        Check.test("nothing remembered, or nothing readable, is nothing pending") {
            Check.equal(ReleaseCheck.pending(remembered: nil, running: "0.6.5") == nil, true)
            Check.equal(ReleaseCheck.pending(remembered: "nightly", running: "0.6.5") == nil, true)
        }

        // ---- where to send somebody ---------------------------------------------------------

        let releases = URL(string: "https://github.com/ColeMei/pane/releases")!

        Check.test("a version tag opens its own release page") {
            Check.equal(
                ReleaseCheck.releasePage(tag: "v0.7.3", in: releases)?.absoluteString,
                "https://github.com/ColeMei/pane/releases/tag/v0.7.3")
            Check.equal(
                ReleaseCheck.releasePage(tag: "v0.8.0-beta.1", in: releases)?.absoluteString,
                "https://github.com/ColeMei/pane/releases/tag/v0.8.0-beta.1")
        }

        // The tag comes off the network. Anything that is not plainly a version stays out of the
        // URL, and the caller opens the list instead.
        Check.test("a tag that is not plainly a version is not put into a URL") {
            Check.equal(ReleaseCheck.releasePage(tag: "nightly", in: releases) == nil, true)
            Check.equal(ReleaseCheck.releasePage(tag: "v1/../../../evil", in: releases) == nil, true)
            Check.equal(ReleaseCheck.releasePage(tag: "v1..2", in: releases) == nil, true)
            Check.equal(ReleaseCheck.releasePage(tag: "v1.0?x=1", in: releases) == nil, true)
            Check.equal(ReleaseCheck.releasePage(tag: "v1.0 ", in: releases) == nil, true)
        }

        // ---- when installing does not work --------------------------------------------------

        Check.test("a failed install sends the reader to the release page") {
            for code in [1000, 1002, 1003, 1005, 2001, 3000, 3001, 3002, 4000, 4005, 4012] {
                Check.equal(ReleaseCheck.fallsBackToReleasePage(sparkleErrorCode: code), true)
            }
        }

        // Nothing failed in these: opening a browser would be acting on a press nobody made.
        Check.test("up to date, cancelled or later opens nothing") {
            for code in [1001, 4007, 4008] {
                Check.equal(ReleaseCheck.fallsBackToReleasePage(sparkleErrorCode: code), false)
            }
        }
    }
}
