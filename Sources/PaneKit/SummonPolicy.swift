import Foundation

/// The global hotkey dismisses only a pane that already has the keyboard focus.
/// A pane behind another window, or on another Space, needs summoning instead.
public enum SummonPolicy {
    public static func shouldDismiss(
        isSummoned: Bool,
        isKeyWindow: Bool,
        isPinned: Bool,
        dismissMode: Settings.DismissMode
    ) -> Bool {
        isSummoned && isKeyWindow && !isPinned && dismissMode == .sameHotkeyToggles
    }
}
