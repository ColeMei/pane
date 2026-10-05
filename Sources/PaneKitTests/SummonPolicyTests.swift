import PaneKit

func runSummonPolicyTests() {
    Check.suite("Global summon hotkey") {
        Check.test("an unfocused pane is summoned instead of dismissed") {
            for pinned in [false, true] {
                for mode in [Settings.DismissMode.sameHotkeyToggles, .escapeOnly] {
                    Check.equal(SummonPolicy.shouldDismiss(
                        isSummoned: true, isKeyWindow: false,
                        isPinned: pinned, dismissMode: mode
                    ), false)
                }
            }
        }

        Check.test("Esc only never dismisses on the global hotkey") {
            for pinned in [false, true] {
                Check.equal(SummonPolicy.shouldDismiss(
                    isSummoned: true, isKeyWindow: true,
                    isPinned: pinned, dismissMode: .escapeOnly
                ), false)
            }
        }

        Check.test("a pinned pane stays open when it has focus") {
            Check.equal(SummonPolicy.shouldDismiss(
                isSummoned: true, isKeyWindow: true,
                isPinned: true, dismissMode: .sameHotkeyToggles
            ), false)
        }

        Check.test("the toggle mode dismisses a focused, unpinned pane") {
            Check.equal(SummonPolicy.shouldDismiss(
                isSummoned: true, isKeyWindow: true,
                isPinned: false, dismissMode: .sameHotkeyToggles
            ), true)
        }

        Check.test("a parked pane is summoned even if key status has not caught up") {
            Check.equal(SummonPolicy.shouldDismiss(
                isSummoned: false, isKeyWindow: true,
                isPinned: false, dismissMode: .sameHotkeyToggles
            ), false)
        }
    }
}
