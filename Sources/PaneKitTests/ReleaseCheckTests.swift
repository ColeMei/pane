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
    }
}
