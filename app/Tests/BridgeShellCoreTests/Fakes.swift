import Foundation

@testable import BridgeShellCore

final class RecordingLog: ShellLog {
  var lines: [String] = []
  func info(_ message: String) { lines.append(message) }
}

/// Time moves only when the test says so.
final class FakeScheduler: Scheduler {
  final class Timer: Cancellable {
    let at: TimeInterval
    let block: () -> Void
    var cancelled = false
    init(at: TimeInterval, block: @escaping () -> Void) {
      self.at = at
      self.block = block
    }
    func cancel() { cancelled = true }
  }

  var time: TimeInterval = 0
  var timers: [Timer] = []

  func now() -> TimeInterval { time }

  func after(_ seconds: TimeInterval, _ block: @escaping () -> Void) -> Cancellable {
    let t = Timer(at: time + seconds, block: block)
    timers.append(t)
    return t
  }

  /// Pending delays from now, in order.
  var pending: [TimeInterval] {
    timers.filter { !$0.cancelled }.map { $0.at - time }.sorted()
  }

  func advance(_ seconds: TimeInterval) {
    let end = time + seconds
    while let next = timers.filter({ !$0.cancelled && $0.at <= end }).min(by: { $0.at < $1.at }) {
      time = next.at
      next.cancelled = true
      next.block()
    }
    time = end
  }
}

/// A host in memory: the test plays its stdout and its exit.
final class FakeHost: HostProcess {
  let pid: Int32
  var sent: [String] = []
  var terminated = 0
  var killed = 0
  let onLine: (String) -> Void
  let onExit: (Int32) -> Void

  init(pid: Int32, onLine: @escaping (String) -> Void, onExit: @escaping (Int32) -> Void) {
    self.pid = pid
    self.onLine = onLine
    self.onExit = onExit
  }

  /// The host's stdin is closed: writes fail.
  var stdinClosed = false
  func send(_ line: String) -> Bool {
    if stdinClosed { return false }
    sent.append(line)
    return true
  }
  func terminate() { terminated += 1 }
  func kill() { killed += 1 }

  /// The host writes one event line.
  func emit(_ json: String) { onLine(json) }

  /// The commands it got, decoded.
  var commands: [[String: Any]] {
    sent.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
  }
}

struct LaunchError: Error {}

final class FakeLauncher: HostLauncher {
  var hosts: [FakeHost] = []
  /// Launches that throw, from the first.
  var failNext = 0

  func launch(onLine: @escaping (String) -> Void, onExit: @escaping (Int32) -> Void) throws
    -> HostProcess
  {
    if failNext > 0 {
      failNext -= 1
      throw LaunchError()
    }
    let h = FakeHost(pid: Int32(1000 + hosts.count), onLine: onLine, onExit: onExit)
    hosts.append(h)
    return h
  }

  var last: FakeHost { hosts[hosts.count - 1] }
}
