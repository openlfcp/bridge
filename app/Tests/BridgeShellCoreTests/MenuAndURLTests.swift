import XCTest

@testable import BridgeShellCore

final class MenuModelTests: XCTestCase {
  private func titles(_ s: ShellState) -> [String] {
    MenuModel.items(s).map { $0.isSeparator ? "—" : $0.title }
  }

  func testTheSkeletonOfUM2() {
    var s = ShellState()
    s.apply(.status(state: .running, reason: nil, sections: []))
    s.loginItem = .enabled
    XCTAssertEqual(
      titles(s),
      [
        "LFCP Bridge · Up to date", "—", "Pause syncing", "Paste connection link…", "Check…",
        "Export diagnostics…", "Settings", "Check for Updates…", "Disconnect from Obsidian…",
        "Uninstall…", "Quit LFCP Bridge",
      ])
    let settings = MenuModel.items(s).first { $0.title == "Settings" }
    XCTAssertEqual(
      settings?.children.map { "\($0.title) \($0.checked)" },
      ["Install updates automatically true", "Start at login true"])
    XCTAssertEqual(MenuModel.icon(s), .normal)
  }

  func testOnlyTheWorkingActionsAreEnabled() {
    var s = ShellState()
    s.apply(.status(state: .running, reason: nil, sections: []))
    let enabled = MenuModel.items(s).filter { $0.enabled }.map { $0.title }
    XCTAssertEqual(enabled, ["Pause syncing", "Settings", "Quit LFCP Bridge"])
  }

  func testPausedShowsResumeAndTheStoppedIcon() {
    var s = ShellState()
    s.apply(.status(state: .paused, reason: nil, sections: []))
    let pause = MenuModel.items(s).first { $0.action == .resume }
    XCTAssertEqual(pause?.title, "Resume syncing")
    XCTAssertEqual(pause?.enabled, true)
    XCTAssertEqual(MenuModel.icon(s), .stopped)
    XCTAssertEqual(MenuModel.headline(s), "Paused")
  }

  func testNoPauseWithoutARunningHost() {
    var s = ShellState()
    XCTAssertEqual(MenuModel.headline(s), "Starting…")
    XCTAssertEqual(MenuModel.items(s).first { $0.action == .pause }?.enabled, false)
    s.reconnecting = true
    XCTAssertEqual(MenuModel.headline(s), "Reconnecting…")
    s.apply(.status(state: .unavailable, reason: "start_failed", sections: []))
    XCTAssertEqual(MenuModel.headline(s), "Not running")
    XCTAssertEqual(MenuModel.icon(s), .attention)
  }

  func testSectionRowsQuestionsAndAttention() {
    var s = ShellState()
    s.apply(
      .status(
        state: .running, reason: nil,
        sections: [
          SectionStatus(bindingId: "w", title: "Work", state: "active"),
          SectionStatus(bindingId: "h", title: "Home", state: "active"),
          SectionStatus(bindingId: "b", title: "Book club", state: "active"),
          SectionStatus(bindingId: "n", title: "New", state: "pending_dry_run"),
        ]))
    s.apply(.question(questionId: "q1", bindingId: "h", kind: "guard_mass_unlink", resolved: false))
    s.apply(.needsAttention(bindingId: "b", code: "safe_mode"))
    XCTAssertEqual(
      Array(titles(s)[2...5]),
      ["Work · Up to date", "Home · Needs your answer", "Book club · Needs attention", "New · Setting up"])
    XCTAssertEqual(MenuModel.icon(s), .attention)
    XCTAssertEqual(MenuModel.headline(s), "Needs attention")
    s.apply(.question(questionId: "q1", bindingId: "h", kind: "guard_mass_unlink", resolved: true))
    s.apply(.needsAttention(bindingId: "b", code: nil))
    XCTAssertEqual(MenuModel.icon(s), .normal)
    XCTAssertEqual(MenuModel.headline(s), "Up to date")
  }

  func testRequiresApprovalAddsTheLoginItemsEntry() {
    var s = ShellState()
    s.apply(.status(state: .running, reason: nil, sections: []))
    s.loginItem = .requiresApproval
    let item = MenuModel.items(s).first { $0.action == .openLoginItems }
    XCTAssertEqual(item?.title, "Allow LFCP Bridge to start at login…")
    XCTAssertEqual(item?.enabled, true)
    XCTAssertEqual(MenuModel.icon(s), .attention)
  }
}

final class URLHandoffTests: XCTestCase {
  let secret = "lfcp-bridge://connect?c=1#k=VERY-SECRET-KEY"
  var launcher: FakeLauncher!
  var scheduler: FakeScheduler!
  var log: RecordingLog!
  var supervisor: HostSupervisor!
  var handoff: URLHandoff!

  /// Wired as AppDelegate wires them.
  override func setUp() {
    launcher = FakeLauncher()
    scheduler = FakeScheduler()
    log = RecordingLog()
    supervisor = HostSupervisor(launcher: launcher, scheduler: scheduler, log: log)
    handoff = URLHandoff(send: { [unowned self] in self.supervisor.send($0) }, log: log)
    supervisor.onEvent = { [unowned self] in self.handoff.hostEvent($0) }
    supervisor.onPhase = { [unowned self] in self.handoff.hostPhase($0) }
  }

  private func hello(_ h: FakeHost) { h.emit(#"{"v":1,"type":"hello","version":"t","pid":1}"#) }
  private func urls(_ h: FakeHost) -> [String] {
    h.commands.filter { $0["cmd"] as? String == "openURL" }.compactMap { $0["url"] as? String }
  }
  private var logText: String { log.lines.joined(separator: "\n") }

  func testHandsTheURLToAHostThatSaidHelloAndLogsNoURL() {
    supervisor.start()
    hello(launcher.last)
    handoff.open([URL(string: secret)!])
    XCTAssertEqual(urls(launcher.last), [secret])
    XCTAssertEqual(handoff.forwarded, 1)
    XCTAssertTrue(log.lines.contains("url: handed to the host"))
    XCTAssertFalse(logText.contains("SECRET"))
    XCTAssertFalse(logText.contains("lfcp-bridge://"))
  }

  func testWaitsForHelloNotForTheSpawn() {
    handoff.open([URL(string: secret)!])
    supervisor.start()
    XCTAssertEqual(urls(launcher.last), [], "running is not ready: no hello yet")
    XCTAssertEqual(handoff.waiting, 1)
    hello(launcher.last)
    XCTAssertEqual(urls(launcher.last), [secret])
    XCTAssertEqual(handoff.waiting, 0)
  }

  func testAHostThatExitsBeforeHelloDoesNotTakeTheURL() {
    handoff.open([URL(string: secret)!])
    supervisor.start()
    let first = launcher.last
    first.onExit(3)  // e.g. run.lock held, before its hello
    scheduler.advance(1)
    let second = launcher.last
    XCTAssertFalse(first === second)
    XCTAssertEqual(urls(first), [])
    XCTAssertEqual(handoff.waiting, 1)
    hello(second)
    XCTAssertEqual(urls(second), [secret])
    XCTAssertEqual(handoff.forwarded, 1)
  }

  func testALateHelloOfAnExitedHostDoesNotOpenTheNextOne() {
    supervisor.start()
    let first = launcher.last
    first.onExit(1)
    hello(first)  // delivered after its exit, before the next launch
    scheduler.advance(1)
    let second = launcher.last
    XCTAssertFalse(first === second)
    handoff.open([URL(string: secret)!])
    XCTAssertEqual(urls(second), [], "no openURL before the second host's own hello")
    XCTAssertEqual(handoff.waiting, 1)
    hello(second)
    XCTAssertEqual(urls(second), [secret])
    XCTAssertEqual(handoff.waiting, 0)
  }

  func testAHostThatExitedAfterHelloIsNotReadyAnyMore() {
    supervisor.start()
    hello(launcher.last)
    launcher.last.onExit(1)
    handoff.open([URL(string: secret)!])
    XCTAssertEqual(handoff.waiting, 1)
    scheduler.advance(1)
    hello(launcher.last)
    XCTAssertEqual(urls(launcher.last), [secret])
  }

  func testAWriteThatFailsKeepsTheURL() {
    supervisor.start()
    hello(launcher.last)
    launcher.last.stdinClosed = true
    handoff.open([URL(string: secret)!])
    XCTAssertEqual(handoff.forwarded, 0)
    XCTAssertEqual(handoff.waiting, 1)
    XCTAssertTrue(log.lines.contains("host: openURL not written (stdin closed)"), "\(log.lines)")
    XCTAssertFalse(logText.contains("SECRET"))
  }

  func testIgnoresOtherSchemesAndBoundsTheWait() {
    handoff.open([URL(string: "https://example.org/#k=VERY-SECRET-KEY")!])
    XCTAssertEqual(handoff.waiting, 0)
    for _ in 0..<(URLHandoff.maxPending + 2) { handoff.open([URL(string: secret)!]) }
    XCTAssertEqual(handoff.waiting, URLHandoff.maxPending)
    XCTAssertFalse(logText.contains("SECRET"))
  }
}

/// The real launcher against a fake host: a shell script that speaks a little of v1.
final class ProcessHostLauncherTests: XCTestCase {
  func testPipesBothWaysAndReportsTheExit() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let got = dir.appendingPathComponent("got.txt")
    let script = """
      printf '%s\\n' '{"v":1,"type":"hello","version":"fake","pid":'$$'}'
      echo "fake host on stderr" >&2
      IFS= read -r line
      printf '%s\\n' "$line" > "\(got.path)"
      printf '%s\\n' '{"v":1,"type":"reply","id":"1","ok":true}'
      exit 3
      """
    let launcher = ProcessHostLauncher(
      .init(
        executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", script],
        environment: ["PATH": "/usr/bin:/bin"],
        stderrPath: dir.appendingPathComponent("logs/host.log").path))
    let scheduler = MainQueueScheduler()
    let log = RecordingLog()
    let supervisor = HostSupervisor(launcher: launcher, scheduler: scheduler, log: log)
    var events: [HostEvent] = []
    let hello = expectation(description: "hello")
    let replied = expectation(description: "reply")
    let exited = expectation(description: "exit")
    supervisor.onEvent = { e in
      events.append(e)
      if case .hello = e { hello.fulfill() }
      if case .reply = e { replied.fulfill() }
    }
    supervisor.onPhase = { p in
      if case .backingOff = p { exited.fulfill() }
    }
    supervisor.start()
    wait(for: [hello], timeout: 10)
    XCTAssertNotNil(supervisor.send(.shutdown(.update)))
    wait(for: [replied, exited], timeout: 10)
    XCTAssertEqual(
      try String(contentsOf: got, encoding: .utf8),
      #"{"cmd":"shutdown","id":"1","reason":"update","v":1}"# + "\n")
    XCTAssertTrue(log.lines.contains("host: exited (3)"), "\(log.lines)")
    XCTAssertEqual(
      try String(contentsOf: dir.appendingPathComponent("logs/host.log"), encoding: .utf8),
      "fake host on stderr\n")
    supervisor.shutdown(.quit) { _ in }
  }
}
