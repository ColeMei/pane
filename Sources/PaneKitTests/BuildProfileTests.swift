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
            // Added by decision 133, and the reason is this test rather than the bug: it asserted
            // "the two profiles share nothing" over the two paths that existed when it was written,
            // so a third path could be added without it — and was. Every location the profile knows
            // about has to differ, which is what the loop below enforces going forward.
            Check.expect(
                BuildProfile.release.iCloudVaultPath != BuildProfile.scratch.iCloudVaultPath,
                "both profiles resolved to the same iCloud Drive vault"
            )
        }

        // Written as a sweep rather than as three named assertions on purpose. A path added to
        // `BuildProfile` and not to this list is the shape of the fault decision 133 fixed, so the
        // list is the thing to keep honest — and a `switch` over both cases is what makes forgetting
        // one a compile error rather than a silent pass.
        Check.test("every location a profile names differs between the two") {
            let release: [(String, String)] = [
                ("support directory", BuildProfile.release.supportDirectoryName),
                ("default vault", BuildProfile.release.defaultVaultPath),
                ("iCloud vault", BuildProfile.release.iCloudVaultPath),
            ]
            let scratch: [(String, String)] = [
                ("support directory", BuildProfile.scratch.supportDirectoryName),
                ("default vault", BuildProfile.scratch.defaultVaultPath),
                ("iCloud vault", BuildProfile.scratch.iCloudVaultPath),
            ]
            for (r, s) in zip(release, scratch) {
                Check.expect(r.1 != s.1, "\(r.0) is the same folder in both builds: \(r.1)")
            }
        }

        // The Sync radio's iCloud side was a literal in the Storage tab, so pressing iCloud Drive in
        // a scratch build offered to move scratch notes into the folder the daily build keeps real
        // ones in. Decision 30's move *skips a name that exists on both sides*, so the failure mode
        // was a silent merge, not an error.
        Check.test("a scratch build's iCloud vault is not the release build's") {
            Check.expect(
                !BuildProfile.scratch.iCloudVaultPath.hasSuffix("/Pane"),
                "got \(BuildProfile.scratch.iCloudVaultPath), which is the daily vault"
            )
            Check.expect(
                BuildProfile.release.iCloudVaultPath.hasSuffix("/Pane"),
                "the release build must keep the folder people already have their notes in"
            )
            // Both still inside the same iCloud container, so the two Macs can share one account.
            for path in [BuildProfile.release.iCloudVaultPath, BuildProfile.scratch.iCloudVaultPath] {
                Check.expect(
                    path.contains("Library/Mobile Documents/com~apple~CloudDocs/"),
                    "not in iCloud Drive at all: \(path)"
                )
            }
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
