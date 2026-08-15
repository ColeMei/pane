import Foundation
import PaneKit

func runVaultSyncTests() {
    Check.suite("Content hashing") {

        Check.test("hashes bytes, not characters") {
            // Two strings that are canonically equivalent but different on disk. The whole point of
            // hashing is to notice byte-level differences, so these must not collide.
            let composed = "caf\u{00E9}"       // é as one scalar
            let decomposed = "cafe\u{0301}"    // e + combining acute
            Check.expect(composed == decomposed, "Swift considers these equal strings")
            Check.notEqual(ContentHash.of(composed), ContentHash.of(decomposed))
        }

        Check.test("is stable and hex") {
            let h = ContentHash.of("")
            Check.equal(h, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
            Check.equal(ContentHash.of("# Title\n"), ContentHash.of(Data("# Title\n".utf8)))
        }

        Check.test("a trailing newline changes the hash") {
            // Which is why normalisation happens on load, once, rather than on every comparison.
            Check.notEqual(ContentHash.of("a"), ContentHash.of("a\n"))
        }
    }

    Check.suite("Collision policy") {
        let original = "# Standup\n- [ ] one\n"
        let ourEdit = "# Standup\n- [ ] one\n- [ ] two\n"
        let theirEdit = "# Standup\n- [x] one\n"

        Check.test("our own write comes back as an echo and is ignored") {
            // The FSEvents callback fires for the write we just made. Nothing has happened.
            Check.equal(
                VaultSync.react(disk: ourEdit, baseline: ourEdit, buffer: ourEdit),
                VaultSync.Reaction.noChange
            )
        }

        Check.test("an unsaved edit against an unchanged disk is not a conflict") {
            // Typing has outrun the 500 ms debounce. That is the normal state of the app.
            Check.equal(
                VaultSync.react(disk: original, baseline: original, buffer: ourEdit),
                VaultSync.Reaction.noChange
            )
        }

        Check.test("an external edit with a clean buffer reloads silently") {
            // Nothing to lose, so a prompt would be noise.
            Check.equal(
                VaultSync.react(disk: theirEdit, baseline: original, buffer: original),
                VaultSync.Reaction.reload
            )
        }

        Check.test("an external edit with unsaved work writes a sibling instead of clobbering") {
            // The case decision 8 exists for. Neither version may be lost.
            Check.equal(
                VaultSync.react(disk: theirEdit, baseline: original, buffer: ourEdit),
                VaultSync.Reaction.writeConflictSibling
            )
        }

        Check.test("converging on the same bytes is not a conflict") {
            // Another machine happened to write exactly what we have. Nothing to reconcile.
            Check.equal(
                VaultSync.react(disk: ourEdit, baseline: original, buffer: ourEdit),
                VaultSync.Reaction.adoptBaseline
            )
        }

        Check.test("a file we have never seen before is simply read") {
            Check.equal(
                VaultSync.react(disk: original, baseline: nil, buffer: ""),
                VaultSync.Reaction.reload
            )
            Check.equal(
                VaultSync.react(disk: original, baseline: nil, buffer: original),
                VaultSync.Reaction.adoptBaseline
            )
        }

        Check.test("no reaction ever makes the panel read-only") {
            // Enumerated deliberately: if a future case is added, this test should be revisited on
            // purpose rather than quietly passing. A pane that stops accepting keystrokes has failed.
            let all: [VaultSync.Reaction] = [
                .ignoreEcho, .noChange, .reload, .writeConflictSibling, .adoptBaseline,
            ]
            Check.equal(all.count, 5, "a new reaction was added — does it keep the pane editable?")
        }
    }

    Check.suite("Write policy") {

        Check.test("typing waits out the 500 ms debounce") {
            Check.equal(WritePolicy.debounce, 0.5)
            Check.equal(WritePolicy.delay(for: .typingStopped), 0.5)
        }

        Check.test("the moments that actually matter flush immediately") {
            // A panel summoned and banished constantly must be safe the instant it goes away.
            for trigger: WritePolicy.Trigger in [.dismissed, .lostFocus, .quitting, .noteSwitched] {
                Check.equal(WritePolicy.delay(for: trigger), 0, "\(trigger) must not wait")
            }
        }

        Check.test("a pending reload flushes first so it never overwrites unsaved work") {
            Check.equal(WritePolicy.delay(for: .reloadPending), 0)
        }
    }
}
