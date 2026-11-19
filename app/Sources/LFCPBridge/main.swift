// LFCP Bridge.app: an accessory app (LSUIElement), only the status item.

import AppKit
import BridgeShellCore

// The host's support.sock asks who its peer is (PeerCredentials.swift): answered, no app started.
if CommandLine.arguments.dropFirst().first == "--peer-uid" {
  exit(PeerCredentials.main())
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
