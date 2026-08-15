import AppKit

// `.accessory`, not `.regular`: no Dock icon, no menu bar, no ⌘Tab entry. Measured on this machine —
// an accessory app can still own a key window, which is the whole trick that lets a panel take the
// caret without the app ever becoming frontmost.
//
// The delegate is held in a local that lives for the process: `NSApplication.delegate` is weak.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
