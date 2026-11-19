// Spike S-1 (A§2.2, PLAN §E-002): a minimal shell for "LFCP Bridge.app", no UI. It proves that the
// Reminders access granted to the app (org.openlfcp.bridge) reaches the helper that node starts
// `direct` — launch chain app → node → helper — when the app is started by `open`, by launchd as
// its SMAppService agent, and by Sparkle after an update. Throwaway: the real shell is E-004.
//
//   LFCP Bridge                  probe: run Resources/node/bin/node Resources/host/bridge.mjs
//                                --self-test --tcc, append the result to probes.jsonl, exit 0
//   LFCP Bridge --register       SMAppService.agent(org.openlfcp.bridge.agent.plist).register()
//   LFCP Bridge --unregister     … .unregister()
//   LFCP Bridge --agent-status   … .status
//   LFCP Bridge --update         Sparkle: check the feed (SUFeedURL), install, relaunch (no UI)
//   LFCP Bridge --version        CFBundleVersion (also proves the frameworks load)
//
// Records go to ~/Library/Application Support/org.openlfcp.bridge.spike-s1/{probes,events}.jsonl,
// one JSON object per line; stdout gets the same line.

import AppKit
import Foundation
import ServiceManagement

setvbuf(stdout, nil, _IOLBF, 0)

let agentPlist = "org.openlfcp.bridge.agent.plist"
let bundle = Bundle.main
let version = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
let env = ProcessInfo.processInfo.environment
let stateDir = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Application Support/org.openlfcp.bridge.spike-s1", isDirectory: true)
try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)

func jsonLine(_ obj: [String: Any]) -> String {
  let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data("{}".utf8)
  return String(decoding: data, as: UTF8.self)
}

func append(_ file: String, _ obj: [String: Any]) {
  let line = jsonLine(obj)
  print(line)
  let url = stateDir.appendingPathComponent(file)
  let data = Data((line + "\n").utf8)
  if let h = try? FileHandle(forWritingTo: url) {
    h.seekToEndOfFile()
    h.write(data)
    try? h.close()
  } else {
    try? data.write(to: url)
  }
}

/** Who started us: launchd runs the agent with LFCP_SPIKE_TRIGGER=launchd (agent plist). */
func base(_ event: String) -> [String: Any] {
  [
    "event": event,
    "version": version,
    "pid": Int(getpid()),
    "ppid": Int(getppid()),
    "time": ISO8601DateFormatter().string(from: Date()),
    "bundlePath": bundle.bundlePath,
    "trigger": env["LFCP_SPIKE_TRIGGER"] ?? "app",
    "xpcServiceName": env["XPC_SERVICE_NAME"] ?? NSNull(),
    "label": env["LFCP_SPIKE_LABEL"] ?? NSNull(),
  ]
}

func event(_ name: String, _ extra: [String: Any] = [:]) {
  append("events.jsonl", base(name).merging(extra) { $1 })
}

func statusName(_ s: SMAppService.Status) -> String {
  switch s {
  case .notRegistered: return "notRegistered"
  case .enabled: return "enabled"
  case .requiresApproval: return "requiresApproval"
  case .notFound: return "notFound"
  @unknown default: return "unknown(\(s.rawValue))"
  }
}

/// node → bridge.mjs --self-test --tcc; the tcc check carries the helper's authorization.
func probe() -> Never {
  let contents = bundle.bundleURL.appendingPathComponent("Contents")
  let p = Process()
  p.executableURL = contents.appendingPathComponent("Resources/node/bin/node")
  p.arguments = [contents.appendingPathComponent("Resources/host/bridge.mjs").path, "--self-test", "--tcc"]
  p.environment = [
    "HOME": NSHomeDirectory(),
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
    "TMPDIR": env["TMPDIR"] ?? NSTemporaryDirectory(),
  ]
  let out = Pipe()
  let err = Pipe()
  p.standardInput = FileHandle.nullDevice
  p.standardOutput = out
  p.standardError = err
  var record = base("probe")
  do {
    try p.run()
    DispatchQueue.global().asyncAfter(deadline: .now() + 120) {
      if p.isRunning { p.terminate() }
    }
    var errData = Data()
    let drained = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      errData = err.fileHandleForReading.readDataToEndOfFile()
      drained.signal()
    }
    let outData = out.fileHandleForReading.readDataToEndOfFile()
    drained.wait()
    p.waitUntilExit()
    let checks: [Any] = String(decoding: outData, as: UTF8.self).split(separator: "\n").map { line in
      (try? JSONSerialization.jsonObject(with: Data(line.utf8))) ?? ["raw": String(line)]
    }
    let tcc = checks.compactMap { $0 as? [String: Any] }.first { $0["check"] as? String == "tcc" }
    record["nodeExit"] = Int(p.terminationStatus)
    record["checks"] = checks
    record["authorization"] = tcc?["authorization"] ?? "none"
    record["lists"] = tcc?["lists"] ?? NSNull()
    record["stderrTail"] = Array(String(decoding: errData, as: UTF8.self).split(separator: "\n").suffix(15).map(String.init))
  } catch {
    record["authorization"] = "none"
    record["error"] = "cannot run node: \(error)"
  }
  append("probes.jsonl", record)
  // Always 0: the agent's KeepAlive {SuccessfulExit:false} must not restart a finished probe.
  exit(0)
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "--version":
  print(version)
  exit(0)

case "--register", "--unregister", "--agent-status":
  let service = SMAppService.agent(plistName: agentPlist)
  var o: [String: Any] = ["before": statusName(service.status)]
  var ok = true
  do {
    if args.first == "--register" { try service.register() }
    if args.first == "--unregister" { try service.unregister() }
  } catch {
    ok = false
    o["error"] = "\(error)"
  }
  o["ok"] = ok
  o["after"] = statusName(service.status)
  event(String(args.first!.dropFirst(2)), o)
  exit(ok ? 0 : 3)

case "--update":
  event("update-start", ["feed": bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String ?? NSNull()])
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let log = stateDir.appendingPathComponent("events.jsonl").path
  DispatchQueue.main.async {
    if let error = LFCPStartUpdate(log, version) {
      event("update-error", ["error": error])
      exit(4)
    }
  }
  DispatchQueue.main.asyncAfter(deadline: .now() + 300) {
    event("update-timeout")
    exit(5)
  }
  app.run()

default:
  // No arguments: `open`, launchd and Sparkle's relaunch. Anything unexpected is recorded, then probed.
  if !args.isEmpty { event("unexpected-args", ["args": args]) }
  probe()
}
