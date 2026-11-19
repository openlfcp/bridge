// The host's supervisor (A§1, PLAN §E-004): starts node + bridge.mjs run --app, reads its events,
// sends its commands, restarts it with a back-off when it exits, and shuts it down with a reason.
// Confined to the main queue: launchers and schedulers call back there.

import Foundation

/// One running host process.
public protocol HostProcess: AnyObject {
  var pid: Int32 { get }
  /// Writes one line and its "\n" to the host's stdin. A host that is gone loses it.
  func send(_ line: String)
  /// SIGTERM.
  func terminate()
  /// SIGKILL.
  func kill()
}

public protocol HostLauncher {
  /// Starts a host. onLine gets each stdout line, onExit the exit status once; both on main.
  func launch(onLine: @escaping (String) -> Void, onExit: @escaping (Int32) -> Void) throws
    -> HostProcess
}

public protocol Cancellable: AnyObject {
  func cancel()
}

public protocol Scheduler: AnyObject {
  /// Monotonic seconds.
  func now() -> TimeInterval
  func after(_ seconds: TimeInterval, _ block: @escaping () -> Void) -> Cancellable
}

public protocol ShellLog: AnyObject {
  /// One line of the shell's log. Never a URL, a path of the person's files or task data.
  func info(_ message: String)
}

/// Restart delays: base, 2×base, 4×base, … up to cap. A host that ran for stableAfter seconds
/// starts the count again.
public struct Backoff: Sendable, Equatable {
  public var base: TimeInterval
  public var cap: TimeInterval
  public var stableAfter: TimeInterval

  public init(base: TimeInterval = 1, cap: TimeInterval = 60, stableAfter: TimeInterval = 60) {
    self.base = base
    self.cap = cap
    self.stableAfter = stableAfter
  }

  public func delay(attempt: Int) -> TimeInterval {
    min(cap, base * pow(2, Double(max(0, attempt - 1))))
  }
}

public final class HostSupervisor {
  public enum Phase: Equatable {
    case idle
    case running(pid: Int32)
    case backingOff(attempt: Int, delay: TimeInterval)
    case shuttingDown(ShutdownReason)
    case stopped
  }

  /// The host's own limit is 60 s (packages/host/src/app/serve.ts); then SIGTERM, then SIGKILL.
  public static let shutdownTimeout: TimeInterval = 70
  public static let killAfter: TimeInterval = 5

  private let launcher: HostLauncher
  private let scheduler: Scheduler
  private let log: ShellLog
  private let backoff: Backoff
  private var process: HostProcess?
  private var launchedAt: TimeInterval = 0
  private var failures = 0
  private var nextId = 0
  private var restartTimer: Cancellable?
  private var shutdownTimers: [Cancellable] = []
  private var shutdownCompletions: [(Int32?) -> Void] = []

  public private(set) var phase: Phase = .idle {
    didSet { if phase != oldValue { onPhase?(phase) } }
  }
  /// How many times a host was launched (or tried).
  public private(set) var launches = 0
  public var onEvent: ((HostEvent) -> Void)?
  public var onPhase: ((Phase) -> Void)?

  public init(launcher: HostLauncher, scheduler: Scheduler, log: ShellLog, backoff: Backoff = Backoff()) {
    self.launcher = launcher
    self.scheduler = scheduler
    self.log = log
    self.backoff = backoff
  }

  public var hostPid: Int32? { process?.pid }

  public func start() {
    guard phase == .idle else { return }
    launch()
  }

  /// Sends a command to a running host; returns its id, or nil when no host runs now.
  @discardableResult
  public func send(_ command: ShellCommand) -> String? {
    guard let p = process, case .running = phase else { return nil }
    return write(command, to: p)
  }

  /// shutdown{reason}: the host finishes what is in flight and exits; no restart after it.
  /// completion gets its exit status, or nil when no host was running.
  public func shutdown(
    _ reason: ShutdownReason, timeout: TimeInterval = HostSupervisor.shutdownTimeout,
    completion: @escaping (Int32?) -> Void
  ) {
    switch phase {
    case .shuttingDown:
      shutdownCompletions.append(completion)
      return
    case .stopped:
      completion(nil)
      return
    default: break
    }
    restartTimer?.cancel()
    restartTimer = nil
    guard let p = process else {
      phase = .stopped
      log.info("host: shutdown (\(reason.rawValue)) with no host running")
      completion(nil)
      return
    }
    shutdownCompletions.append(completion)
    phase = .shuttingDown(reason)
    log.info("host: shutdown (\(reason.rawValue))")
    write(.shutdown(reason), to: p)
    shutdownTimers.append(
      scheduler.after(timeout) { [weak self] in
        guard let self, let p = self.process else { return }
        self.log.info("host: no exit \(Int(timeout)) s after shutdown; SIGTERM")
        p.terminate()
        self.shutdownTimers.append(
          self.scheduler.after(HostSupervisor.killAfter) { [weak self] in
            guard let self, let p = self.process else { return }
            self.log.info("host: SIGKILL")
            p.kill()
          })
      })
  }

  @discardableResult
  private func write(_ command: ShellCommand, to p: HostProcess) -> String {
    nextId += 1
    let id = String(nextId)
    p.send(command.line(id: id))
    return id
  }

  private func launch() {
    restartTimer = nil
    launches += 1
    let generation = launches
    do {
      let p = try launcher.launch(
        onLine: { [weak self] line in self?.received(line, generation: generation) },
        onExit: { [weak self] status in self?.exited(status, generation: generation) })
      process = p
      launchedAt = scheduler.now()
      phase = .running(pid: p.pid)
      log.info("host: started (pid \(p.pid))")
    } catch {
      process = nil
      log.info("host: cannot start: \(error.localizedDescription)")
      scheduleRestart()
    }
  }

  private func received(_ line: String, generation: Int) {
    guard generation == launches else { return }
    guard let event = HostEvent.parse(line) else {
      // The line itself is not logged: it is the host's to log, and may carry data.
      log.info("host: unreadable line (\(line.utf8.count) bytes)")
      return
    }
    onEvent?(event)
  }

  private func exited(_ status: Int32, generation: Int) {
    guard generation == launches else { return }
    process = nil
    if case .shuttingDown = phase {
      shutdownTimers.forEach { $0.cancel() }
      shutdownTimers = []
      phase = .stopped
      log.info("host: exited after shutdown (\(status))")
      let completions = shutdownCompletions
      shutdownCompletions = []
      completions.forEach { $0(status) }
      return
    }
    log.info("host: exited (\(status))")
    if scheduler.now() - launchedAt >= backoff.stableAfter { failures = 0 }
    scheduleRestart()
  }

  private func scheduleRestart() {
    failures += 1
    let delay = backoff.delay(attempt: failures)
    phase = .backingOff(attempt: failures, delay: delay)
    log.info("host: restart in \(Int(delay)) s (attempt \(failures))")
    restartTimer = scheduler.after(delay) { [weak self] in self?.launch() }
  }
}

/// The real scheduler: the main queue, uptime as the clock.
public final class MainQueueScheduler: Scheduler {
  private final class Item: Cancellable {
    let work: DispatchWorkItem
    init(_ work: DispatchWorkItem) { self.work = work }
    func cancel() { work.cancel() }
  }

  public init() {}

  public func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

  public func after(_ seconds: TimeInterval, _ block: @escaping () -> Void) -> Cancellable {
    let work = DispatchWorkItem(block: block)
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    return Item(work)
  }
}
