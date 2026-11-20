// The L5 smoke's hooks (scripts/app/smoke.sh). Compiled only with -DLFCP_TEST_HOOKS: a release
// build has none of this (E-005 checks for the symbols).
//
// The smoke creates a file in <logs>/test-hooks/; the app polls the directory, removes the file
// and acts:
//   report           write <logs>/test-hooks/report.json (status item, host, URLs, login item)
//   pause, resume    the menu's Pause syncing / Resume syncing
//   shutdown-update  quit with shutdown{reason:update}, as Sparkle's install will (E-056)

#if LFCP_TEST_HOOKS
  import AppKit
  import BridgeShellCore

  enum TestHooks {
    static var timer: Timer?

    static func directory(_ d: AppDelegate) -> URL {
      d.logs.appendingPathComponent("test-hooks", isDirectory: true)
    }

    static func start(_ d: AppDelegate) {
      let dir = directory(d)
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let t = Timer(timeInterval: 0.5, repeats: true) { _ in poll(d, dir) }
      RunLoop.main.add(t, forMode: .common)
      timer = t
      // Over 15 bytes, so a C string in the binary (scripts/app/check-no-test-hooks.sh).
      d.log.info("test hooks: on (L5 smoke build)")
    }

    static func poll(_ d: AppDelegate, _ dir: URL) {
      for name in ["report", "pause", "resume", "shutdown-update"] {
        let file = dir.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: file.path) else { continue }
        try? FileManager.default.removeItem(at: file)
        d.log.info("test hook: \(name)")
        switch name {
        case "report": report(d)
        case "pause": d.perform(.pause)
        case "resume": d.perform(.resume)
        default:
          d.terminateReason = .update
          NSApp.terminate(nil)
        }
      }
    }

    static func report(_ d: AppDelegate) {
      let item = d.statusItem
      let window = item?.button?.window
      let phase: String
      switch d.supervisor.phase {
      case .idle: phase = "idle"
      case .running: phase = "running"
      case .backingOff: phase = "backingOff"
      case .shuttingDown: phase = "shuttingDown"
      case .stopped: phase = "stopped"
      }
      var o: [String: Any] = [
        "pid": Int(getpid()),
        "statusItem": [
          "exists": item != nil,
          "visible": item?.isVisible ?? false,
          "hasImage": item?.button?.image != nil,
          "hasWindow": window != nil,
          "width": Double(window?.frame.width ?? 0),
        ] as [String: Any],
        "menu": MenuModel.items(d.state).filter { !$0.isSeparator }.map { $0.title },
        "icon": MenuModel.icon(d.state).rawValue,
        "host": [
          "phase": phase,
          "pid": d.supervisor.hostPid.map { Int($0) } ?? 0,
          "launches": d.supervisor.launches,
          "hello": d.helloVersion ?? "",
          "state": d.state.host?.rawValue ?? "",
          "reason": d.state.hostReason ?? "",
        ] as [String: Any],
        "replies": ["ok": d.replies.ok, "failed": d.replies.failed] as [String: Int],
        "codeChecks": d.codeChecks,
        "urls": ["forwarded": d.handoff.forwarded, "waiting": d.handoff.waiting] as [String: Int],
        "loginItem": d.loginItemState().rawValue,
      ]
      if let exit = d.hostExit {
        o["shutdown"] = [
          "reason": d.terminateReason.rawValue,
          "hostExit": exit.map { Int($0) as Any } ?? NSNull(),
        ] as [String: Any]
      }
      guard
        let data = try? JSONSerialization.data(
          withJSONObject: o, options: [.prettyPrinted, .sortedKeys])
      else { return }
      try? data.write(to: directory(d).appendingPathComponent("report.json"), options: .atomic)
    }
  }
#endif
