import Foundation

/// What one press of the summon hotkey does — decision 180.
///
/// The press reads the focus as well as whether the pane is up. A pane that is up but lost the focus
/// to another app is asking to be typed in again, not hidden. The pin plays no part: it is about the
/// note, not the window.
public enum HotkeyPress: Equatable, Sendable {
    /// Parked: bring it up.
    case summon
    /// Up on another Space (decision 93, the pane kept to its Space): leave it there and come up here.
    case bringHere
    /// Up here without the focus: give the caret back.
    case focus
    /// Up here with the focus, and the hotkey toggles: hide it.
    case dismiss

    public static func resolve(
        isUp: Bool,
        onActiveSpace: Bool,
        hasFocus: Bool,
        dismissMode: Settings.DismissMode
    ) -> HotkeyPress {
        guard isUp else { return .summon }
        guard onActiveSpace else { return .bringHere }
        guard hasFocus, dismissMode == .sameHotkeyToggles else { return .focus }
        return .dismiss
    }
}
