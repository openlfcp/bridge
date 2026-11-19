// Spike S-5 (T§4, PLAN §E-003): the test side. Reads the probe app's window and presses its button
// through AXUIElement — no hooks in the app. Prints one JSON object to stdout.
//
//   s5-ax check [<bundle-id>]
//       AXIsProcessTrusted() (never prompts) and, with a bundle id, a real AX call (AXWindows) against
//       that running app: -25211 kAXErrorAPIDisabled when untrusted.
//   s5-ax drive <bundle-id> <expected-code> <events.jsonl> [--menu]
//       Finds the running app, reads the label `s5-code`, presses the button `s5-confirm`, re-reads
//       `s5-status`, and waits for the app's own "pressed" record. With --menu also opens the status
//       item through AXExtrasMenuBar and presses its menu item (informational).
//       Exit 0 only when the code matches, the press succeeded, the label changed and the app
//       recorded the press.
import AppKit
import ApplicationServices

var out: [String: Any] = [:]

func emit(_ code: Int32) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(code)
}

func attr(_ el: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
  var v: CFTypeRef?
  let e = AXUIElementCopyAttributeValue(el, name as CFString, &v)
  return (e, v)
}

func str(_ el: AXUIElement, _ name: String) -> String? {
  let (e, v) = attr(el, name)
  return e == .success ? v as? String : nil
}

func children(_ el: AXUIElement) -> [AXUIElement] {
  let (e, v) = attr(el, kAXChildrenAttribute)
  return e == .success ? (v as? [AXUIElement]) ?? [] : []
}

/// Depth-first search under `root` for an element whose AXIdentifier is `id`.
func find(_ root: AXUIElement, id: String, depth: Int = 0) -> AXUIElement? {
  if str(root, "AXIdentifier") == id { return root }
  if depth > 12 { return nil }
  for c in children(root) { if let f = find(c, id: id, depth: depth + 1) { return f } }
  return nil
}

func describe(_ el: AXUIElement) -> [String: Any] {
  var d: [String: Any] = [:]
  for a in [kAXRoleAttribute, kAXTitleAttribute, kAXValueAttribute, "AXIdentifier"] {
    if let s = str(el, a) { d[a] = s }
  }
  return d
}

func processChain() -> [[String: Any]] {
  var chain: [[String: Any]] = []
  var pid = getpid()
  for _ in 0..<12 {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { break }
    var buf = [CChar](repeating: 0, count: 4096)
    let n = proc_pidpath(pid, &buf, UInt32(buf.count))
    chain.append(["pid": Int(pid), "path": n > 0 ? String(cString: buf) : "?"])
    let ppid = info.kp_eproc.e_ppid
    if ppid <= 1 || ppid == pid { if ppid == 1 { chain.append(["pid": 1, "path": "/sbin/launchd"]) }; break }
    pid = ppid
  }
  return chain
}

let argv = CommandLine.arguments
guard argv.count >= 2 else {
  out["error"] = "usage: s5-ax check [<bundle-id>] | drive <bundle-id> <code> <events.jsonl> [--menu]"
  emit(2)
}

out["trusted"] = AXIsProcessTrusted()
out["chain"] = processChain()

if argv[1] == "check" {
  if argv.count >= 3, let app = NSRunningApplication.runningApplications(withBundleIdentifier: argv[2]).first {
    let el = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(el, 3)
    out["windowsAXError"] = attr(el, kAXWindowsAttribute).0.rawValue  // -25211 = kAXErrorAPIDisabled
  }
  emit(0)
}

guard argv[1] == "drive", argv.count >= 5 else { out["error"] = "bad arguments"; emit(2) }
let bundleId = argv[2], expected = argv[3], eventsPath = argv[4]
let withMenu = argv.contains("--menu")

func pressedEvents(source: String) -> Int {
  guard let text = try? String(contentsOfFile: eventsPath, encoding: .utf8) else { return 0 }
  return text.split(separator: "\n").filter {
    $0.contains("\"event\":\"pressed\"") && $0.contains("\"source\":\"\(source)\"")
  }.count
}

func waitFor(_ seconds: Double, _ cond: () -> Bool) -> Bool {
  let end = Date().addingTimeInterval(seconds)
  while Date() < end {
    if cond() { return true }
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
  }
  return cond()
}

guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
  out["error"] = "app \(bundleId) is not running"; emit(1)
}
out["appPid"] = Int(running.processIdentifier)
let app = AXUIElementCreateApplication(running.processIdentifier)
AXUIElementSetMessagingTimeout(app, 3)

// Windows can take a moment to appear in the AX tree after launch.
var windows: [AXUIElement] = []
var lastErr: AXError = .success
_ = waitFor(10) {
  let (e, v) = attr(app, kAXWindowsAttribute)
  lastErr = e
  windows = e == .success ? (v as? [AXUIElement]) ?? [] : []
  return !windows.isEmpty
}
out["windowsAXError"] = lastErr.rawValue
out["windows"] = windows.map(describe)
guard let window = windows.first(where: { str($0, kAXTitleAttribute) == "S5 Probe" }) ?? windows.first else {
  out["error"] = "no AX windows (AXError \(lastErr.rawValue))"; emit(1)
}

// 1. Read the code.
guard let label = find(window, id: "s5-code") else { out["error"] = "label s5-code not found"; emit(1) }
let read = str(label, kAXValueAttribute)
out["label"] = describe(label)
out["readCode"] = read as Any
out["readOk"] = read == expected

// 2. Press the button.
guard let button = find(window, id: "s5-confirm"), let statusLabel = find(window, id: "s5-status") else {
  out["error"] = "button s5-confirm or label s5-status not found"; emit(1)
}
out["button"] = describe(button)
var actions: CFArray?
AXUIElementCopyActionNames(button, &actions)
out["buttonActions"] = (actions as? [String]) ?? []
let before = pressedEvents(source: "button")
let pressErr = AXUIElementPerformAction(button, kAXPressAction as CFString)
out["pressAXError"] = pressErr.rawValue
let recorded = waitFor(5) { pressedEvents(source: "button") > before }
var statusAfter: String?
_ = waitFor(3) { statusAfter = str(statusLabel, kAXValueAttribute); return statusAfter == "presses: \(before + 1)" }
out["statusAfter"] = statusAfter as Any
out["pressRecordedByApp"] = recorded
out["pressOk"] = pressErr == .success && recorded && statusAfter == "presses: \(before + 1)"

// 3. Informational: the status item's menu through AXExtrasMenuBar (a menu-bar app has no main menu).
if withMenu {
  var menu: [String: Any] = [:]
  let (e, v) = attr(app, "AXExtrasMenuBar")
  menu["extrasMenuBarAXError"] = e.rawValue
  if e == .success, let bar = v.map({ $0 as! AXUIElement }) {
    let items = children(bar)
    menu["items"] = items.map(describe)
    if let item = items.first {
      let before = pressedEvents(source: "menu")
      menu["openAXError"] = AXUIElementPerformAction(item, kAXPressAction as CFString).rawValue
      var menuItem: AXUIElement?
      _ = waitFor(3) {
        for m in children(item) { for mi in children(m) where str(mi, kAXTitleAttribute) == "Mark from menu" { menuItem = mi } }
        return menuItem != nil
      }
      if let mi = menuItem {
        menu["menuItem"] = describe(mi)
        menu["pressAXError"] = AXUIElementPerformAction(mi, kAXPressAction as CFString).rawValue
        menu["recordedByApp"] = waitFor(5) { pressedEvents(source: "menu") > before }
      } else {
        menu["error"] = "menu item not found after opening"
        AXUIElementPerformAction(item, kAXCancelAction as CFString)
      }
    }
  }
  out["menu"] = menu
}

out["pass"] = (out["readOk"] as? Bool ?? false) && (out["pressOk"] as? Bool ?? false)
emit((out["pass"] as? Bool ?? false) ? 0 : 1)
