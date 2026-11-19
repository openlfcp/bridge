// LFCP Bridge.app: an accessory app (LSUIElement), only the status item.

import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
