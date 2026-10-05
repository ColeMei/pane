import PaneKit

func runSummonPolicyTests() {
    Check.suite("Global summon hotkey") {
        Check.test("an unfocused pane is summoned instead of dismissed") {
            for mode in [Settings.DismissMode.sameHotkeyToggles, .escapeOnly] {
                Check.equal(SummonPolicy.shouldDismiss(
                    isSummoned: true, isKeyWindow: false, dismissMode: mode
                ), false)
            }
        }

        Check.test("Esc only never dismisses on the global hotkey") {
            Check.equal(SummonPolicy.shouldDismiss(
                isSummoned: true, isKeyWindow: true,
                dismissMode: .escapeOnly
            ), false)
        }

        Check.test("the toggle mode dismisses a focused pane regardless of pinning") {
            Check.equal(SummonPolicy.shouldDismiss(
                isSummoned: true, isKeyWindow: true,
                dismissMode: .sameHotkeyToggles
            ), true)
        }

        Check.test("a parked pane is summoned even if key status has not caught up") {
            Check.equal(SummonPolicy.shouldDismiss(
                isSummoned: false, isKeyWindow: true,
                dismissMode: .sameHotkeyToggles
            ), false)
        }
    }
}
