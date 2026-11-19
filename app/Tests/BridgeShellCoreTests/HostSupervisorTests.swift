import XCTest

@testable import BridgeShellCore

final class HostSupervisorTests: XCTestCase {
  var launcher: FakeLauncher!
  var scheduler: FakeScheduler!
  var log: RecordingLog!
  var supervisor: HostSupervisor!
  var events: [HostEvent] = []

  override func setUp() {
    launcher = FakeLauncher()
    scheduler = FakeScheduler()
    log = RecordingLog()
    events = []
    supervisor = HostSupervisor(launcher: launcher, scheduler: scheduler, log: log)
    supervisor.onEvent = { [unowned self] in self.events.append($0) }
  }

  func testStartsTheHostAndForwardsItsEvents() {
    supervisor.start()
    XCTAssertEqual(launcher.hosts.count, 1)
    XCTAssertEqual(supervisor.phase, .running(pid: 1000))
    launcher.last.emit(#"{"v":1,"type":"hello","version":"0.6.0","pid":1000}"#)
    let garbage = "garbage with a secret lfcp-bridge://x#k=s"
    launcher.last.emit(garbage)
    launcher.last.emit(#"{"v":1,"type":"status","state":"running","sections":[]}"#)
    XCTAssertEqual(
      events, [.hello(version: "0.6.0", pid: 1000), .status(state: .running, reason: nil, sections: [])])
    XCTAssertTrue(
      log.lines.contains("host: unreadable line (\(garbage.utf8.count) bytes)"), "\(log.lines)")
    XCTAssertFalse(log.lines.joined().contains("lfcp-bridge://"))
  }

  func testSendNumbersCommandsAndNeedsARunningHost() {
    XCTAssertNil(supervisor.send(.pause))
    supervisor.start()
    XCTAssertEqual(supervisor.send(.pause), "1")
    XCTAssertEqual(supervisor.send(.resume), "2")
    XCTAssertEqual(launcher.last.commands.map { $0["cmd"] as? String }, ["pause", "resume"])
    XCTAssertEqual(launcher.last.commands.map { $0["id"] as? String }, ["1", "2"])
  }

  func testRestartsWithABackoffThatDoublesUpToTheCap() {
    supervisor.start()
    var delays: [TimeInterval] = []
    for _ in 0..<8 {
      launcher.last.onExit(1)
      guard case .backingOff(_, let delay) = supervisor.phase else {
        return XCTFail("not backing off: \(supervisor.phase)")
      }
      delays.append(delay)
      XCTAssertNil(supervisor.send(.pause), "no host while backing off")
      scheduler.advance(delay)
      XCTAssertEqual(supervisor.phase, .running(pid: launcher.last.pid))
    }
    XCTAssertEqual(delays, [1, 2, 4, 8, 16, 32, 60, 60])
    XCTAssertEqual(launcher.hosts.count, 9)
  }

  func testAHostThatRanLongEnoughStartsTheCountAgain() {
    supervisor.start()
    launcher.last.onExit(1)
    scheduler.advance(1)
    launcher.last.onExit(1)
    XCTAssertEqual(scheduler.pending, [2])
    scheduler.advance(2)
    scheduler.advance(61)
    launcher.last.onExit(1)
    XCTAssertEqual(supervisor.phase, .backingOff(attempt: 1, delay: 1))
  }

  func testALaunchThatThrowsIsRetried() {
    launcher.failNext = 2
    supervisor.start()
    XCTAssertEqual(supervisor.phase, .backingOff(attempt: 1, delay: 1))
    scheduler.advance(1)
    XCTAssertEqual(supervisor.phase, .backingOff(attempt: 2, delay: 2))
    scheduler.advance(2)
    XCTAssertEqual(supervisor.phase, .running(pid: 1000))
    XCTAssertEqual(supervisor.launches, 3)
  }

  func testShutdownUpdateSendsTheReasonAndDoesNotRestart() {
    supervisor.start()
    let host = launcher.last
    var result: Int32?? = nil
    supervisor.shutdown(.update) { result = .some($0) }
    XCTAssertEqual(host.commands.last?["cmd"] as? String, "shutdown")
    XCTAssertEqual(host.commands.last?["reason"] as? String, "update")
    XCTAssertEqual(supervisor.phase, .shuttingDown(.update))
    XCTAssertNil(supervisor.send(.pause), "nothing new after shutdown")
    host.onExit(0)
    XCTAssertEqual(result, .some(0))
    XCTAssertEqual(supervisor.phase, .stopped)
    scheduler.advance(600)
    XCTAssertEqual(launcher.hosts.count, 1, "no restart after shutdown")
    XCTAssertEqual(host.terminated, 0)
  }

  func testShutdownEscalatesToSigtermThenSigkill() {
    supervisor.start()
    let host = launcher.last
    var result: Int32?? = nil
    supervisor.shutdown(.quit) { result = .some($0) }
    scheduler.advance(HostSupervisor.shutdownTimeout - 1)
    XCTAssertEqual(host.terminated, 0)
    scheduler.advance(1)
    XCTAssertEqual(host.terminated, 1)
    XCTAssertEqual(host.killed, 0)
    scheduler.advance(HostSupervisor.killAfter)
    XCTAssertEqual(host.killed, 1)
    host.onExit(9)
    XCTAssertEqual(result, .some(9))
  }

  func testShutdownWhileBackingOffCancelsTheRestart() {
    supervisor.start()
    launcher.last.onExit(1)
    var result: Int32?? = nil
    supervisor.shutdown(.logout) { result = .some($0) }
    XCTAssertEqual(result, .some(nil))
    XCTAssertEqual(supervisor.phase, .stopped)
    scheduler.advance(600)
    XCTAssertEqual(launcher.hosts.count, 1)
  }

  func testASecondShutdownWaitsForTheFirst() {
    supervisor.start()
    var calls: [Int32?] = []
    supervisor.shutdown(.update) { calls.append($0) }
    supervisor.shutdown(.quit) { calls.append($0) }
    XCTAssertEqual(launcher.last.commands.filter { $0["cmd"] as? String == "shutdown" }.count, 1)
    launcher.last.onExit(0)
    XCTAssertEqual(calls, [0, 0])
  }

  func testLinesAndExitsOfAnOldHostAreIgnored() {
    supervisor.start()
    let old = launcher.last
    old.onExit(1)
    scheduler.advance(1)
    old.emit(#"{"v":1,"type":"hello","version":"old","pid":1}"#)
    old.onExit(1)
    XCTAssertEqual(events, [])
    XCTAssertEqual(supervisor.phase, .running(pid: launcher.last.pid))
  }
}
