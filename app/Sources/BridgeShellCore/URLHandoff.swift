// lfcp-bridge:// (A§1, A§4.1): the shell hands every such URL to the host as openURL, and logs
// only that it did. The URL is never written anywhere by the shell: the base link carries its
// secret in the fragment.

import Foundation

public final class URLHandoff {
  public static let scheme = "lfcp-bridge"
  /// URLs kept while no host runs (it is starting or restarting).
  public static let maxPending = 8

  private let send: (ShellCommand) -> String?
  private let log: ShellLog
  private var pending: [URL] = []
  /// How many URLs reached a running host.
  public private(set) var forwarded = 0
  public var waiting: Int { pending.count }

  /// send: the supervisor's send (nil when no host runs).
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
      if send(.openURL(url.absoluteString)) != nil {
        forwarded += 1
        log.info("url: handed to the host")
      } else if pending.count < URLHandoff.maxPending {
        pending.append(url)
        log.info("url: kept until the host runs")
      } else {
        log.info("url: dropped (\(URLHandoff.maxPending) already waiting)")
      }
    }
  }

  /// The host is up (its hello): hand over what waited.
  public func flush() {
    guard !pending.isEmpty else { return }
    let waiting = pending
    pending = []
    open(waiting)
  }
}
