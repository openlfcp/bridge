// Spike S-5 (T§4, PLAN §E-003): a throwaway menu-bar app with one window — a label with a code and a
// button — and a status item with a small menu. No test hooks: a test reads and presses it only through
// the Accessibility API. Every press is appended to <state>/events.jsonl so the driver can tell an AX
// press that really reached the app from one that only returned success.
//
// Usage: S5Probe.app/Contents/MacOS/S5Probe <code> <state-dir>   (normally via `open … --args`)
import AppKit

let args = CommandLine.arguments
let code = args.count > 1 ? args[1] : "NO-CODE"
let stateDir = URL(fileURLWithPath: args.count > 2 ? args[2] : NSTemporaryDirectory())
try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)

func record(_ event: String, _ extra: [String: Any] = [:]) {
  var obj: [String: Any] = ["event": event, "pid": getpid(), "ts": Date().timeIntervalSince1970]
  for (k, v) in extra { obj[k] = v }
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
  let url = stateDir.appendingPathComponent("events.jsonl")
  if let h = try? FileHandle(forWritingTo: url) {
    h.seekToEndOfFile(); h.write(data); h.write(Data("\n".utf8)); h.closeFile()
  } else {
    try? (data + Data("\n".utf8)).write(to: url)
  }
}

final class Delegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var label: NSTextField!
  var status: NSTextField!
  var statusItem: NSStatusItem!
  var presses = 0

  func applicationDidFinishLaunching(_ note: Notification) {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 360, height: 160),
      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "S5 Probe"
    window.isReleasedWhenClosed = false

    label = NSTextField(labelWithString: code)
    label.setAccessibilityIdentifier("s5-code")
    label.font = .monospacedSystemFont(ofSize: 22, weight: .semibold)
    label.frame = NSRect(x: 20, y: 100, width: 320, height: 32)

    status = NSTextField(labelWithString: "presses: 0")
    status.setAccessibilityIdentifier("s5-status")
    status.frame = NSRect(x: 20, y: 70, width: 320, height: 22)

    let button = NSButton(title: "Confirm", target: self, action: #selector(confirm))
    button.setAccessibilityIdentifier("s5-confirm")
    button.frame = NSRect(x: 20, y: 20, width: 120, height: 32)

    for v in [label!, status!, button] { window.contentView!.addSubview(v) }
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.button?.title = "S5"
    statusItem.button?.setAccessibilityIdentifier("s5-status-item")
    let menu = NSMenu()
    let item = NSMenuItem(title: "Mark from menu", action: #selector(markFromMenu), keyEquivalent: "")
    item.target = self
    menu.addItem(item)
    statusItem.menu = menu

    record("launched", ["code": code])
  }

  @objc func confirm() {
    presses += 1
    status.stringValue = "presses: \(presses)"
    record("pressed", ["source": "button", "presses": presses])
  }

  @objc func markFromMenu() {
    record("pressed", ["source": "menu"])
  }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)  // LSUIElement as well; a menu-bar app like the 0.6 shell
app.run()
