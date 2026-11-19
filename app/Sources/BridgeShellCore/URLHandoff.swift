// lfcp-bridge:// (A§1, A§4.1): the shell hands every such URL to the host as openURL, and logs
// only that it did. The URL is never written anywhere by the shell: the base link carries its
// secret in the fragment.
//
// A URL goes to a host that said hello (it reads its stdin then). Until then — the host starting,
// restarting, or one that exits before its hello — the URL waits, and the next host gets it.

import Foundation

public final class URLHandoff {
  public static let scheme = "lfcp-bridge"
  /// URLs kept while no host is ready.
  public static let maxPending = 8

  private let send: (ShellCommand) -> String?
  private let log: ShellLog
  private var pending: [URL] = []
  /// The current host said hello and has not exited since.
  private var ready = false
  /// How many URLs were written to a ready host.
  public private(set) var forwarded = 0
  public var waiting: Int { pending.count }

  /// send: the supervisor's send (nil when no host runs or its stdin did not take the line).
  public init(send: @escaping (ShellCommand) -> String?, log: ShellLog) {
    self.send = send
    self.log = log
  }

  public func open(_ urls: [URL]) {
    for url in urls {
      guard url.scheme?.lowercased() == URLHandoff.scheme else {
        log.info("url: ignored (not \(URLHandoff.scheme))")
        continue
      }
      if ready, send(.openURL(url.absoluteString)) != nil {
        forwarded += 1
        log.info("url: handed to the host")
      } else if pending.count < URLHandoff.maxPending {
        pending.append(url)
        log.info("url: kept until the host is ready")
      } else {
        log.info("url: dropped (\(URLHandoff.maxPending) already waiting)")
      }
    }
  }

  /// The host's events: its hello makes it ready and hands over what waited.
  public func hostEvent(_ event: HostEvent) {
    guard case .hello = event else { return }
    ready = true
    flush()
  }

  /// The supervisor's phases: every change, .running included, ends readiness; only a hello that
  /// comes after it sets it again (a late hello of an exited host must not open the next one).
  public func hostPhase(_ phase: HostSupervisor.Phase) {
    ready = false
  }

  private func flush() {
    guard !pending.isEmpty else { return }
    let waiting = pending
    pending = []
    open(waiting)
  }
}
