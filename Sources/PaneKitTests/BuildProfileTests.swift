import Foundation
import PaneKit

func runBuildProfileTests() {
    Check.suite("Build profile") {

        // The point of these is not that the strings are right — they are two lines of code. It is
        // that the two profiles can never *collide*, because the whole reason this type exists is
        // that they used to share one settings.json and a debug session repointed the daily build's
        // vault with it.
        Check.test("the two profiles share nothing") {
            Check.expect(
                BuildProfile.release.supportDirectoryName
                    != BuildProfile.scratch.supportDirectoryName,
                "both profiles resolved to the same Application Support folder"
            )
            Check.expect(
                BuildProfile.release.defaultVaultPath != BuildProfile.scratch.defaultVaultPath,
                "both profiles resolved to the same default vault"
            )
        }

        // Ad-hoc signing gives every rebuild a new cdhash and TCC keys consent to the binary, so a
        // scratch vault under ~/Documents re-asks for the Documents folder on every build — and
        // while that prompt is up the app reads and writes nothing, which presents as the app
        // ignoring every keystroke rather than as a permission dialog.
        Check.test("the scratch vault is outside ~/Documents") {
            Check.expect(
                !BuildProfile.scratch.defaultVaultPath.hasPrefix("~/Documents"),
                "got \(BuildProfile.scratch.defaultVaultPath)"
            )
        }

        // A test binary, a probe and anything else without the Info.plist key is a release build.
        // This is what keeps the rest of the suite free of any opinion about this machine — see the
        // vault-path assertions in StateTests.
        Check.test("an unstamped bundle is a release build") {
            Check.equal(BuildProfile.current, .release)
            Check.equal(Settings.defaultVaultPath, BuildProfile.release.defaultVaultPath)
        }
    }
}
