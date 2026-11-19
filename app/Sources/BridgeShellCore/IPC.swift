// The shell ↔ host channel, version 1 (docs/reference/app-ipc-v1.md; the host side is
// packages/host/src/app/ipc.ts). stdio, one JSON object per line, UTF-8, "\n" at the end, at most
// IPC.maxLine bytes. The shell writes commands to the host's stdin and reads events and replies
// from its stdout.

import Foundation

public enum IPC {
  public static let version = 1
  /// The longest line either side accepts (bytes, without the "\n").
  public static let maxLine = 64 * 1024
}

public enum ShutdownReason: String, Sendable, CaseIterable {
  case update, quit, logout
}

/// What the shell asks of the host.
public enum ShellCommand: Equatable, Sendable {
  case pause
  case resume
  case answer(questionId: String, choice: String)
  case export(path: String)
  case remove(bindingId: String, ack: Bool)
  case shutdown(ShutdownReason)
  /// A lfcp-bridge:// URL, handed over as it came. It may carry a link secret: never log it.
  case openURL(String)

  public var name: String {
    switch self {
    case .pause: return "pause"
    case .resume: return "resume"
    case .answer: return "answer"
    case .export: return "export"
    case .remove: return "remove"
    case .shutdown: return "shutdown"
    case .openURL: return "openURL"
    }
  }

  /// The command as one line (without the "\n").
  public func line(id: String) -> String {
    var o: [String: Any] = ["v": IPC.version, "id": id, "cmd": name]
    switch self {
    case .pause, .resume: break
    case .answer(let q, let c):
      o["questionId"] = q
      o["choice"] = c
    case .export(let path): o["path"] = path
    case .remove(let b, let ack):
      o["bindingId"] = b
      o["ack"] = ack
    case .shutdown(let r): o["reason"] = r.rawValue
    case .openURL(let url): o["url"] = url
    }
    // Only strings, an Int and a Bool: serialization cannot fail.
    let data = (try? JSONSerialization.data(
      withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
    return String(decoding: data, as: UTF8.self)
  }
}

public enum HostState: String, Sendable {
  case starting, running, paused, unavailable, stopping
}

public struct SectionStatus: Equatable, Sendable {
  public let bindingId: String
  public let title: String
  public let state: String

  public init(bindingId: String, title: String, state: String) {
    self.bindingId = bindingId
    self.title = title
    self.state = state
  }
}

/// What the host tells the shell.
public enum HostEvent: Equatable, Sendable {
  case hello(version: String, pid: Int)
  case status(state: HostState, reason: String?, sections: [SectionStatus])
  case question(questionId: String, bindingId: String, kind: String, resolved: Bool)
  /// code nil: the binding no longer needs attention.
  case needsAttention(bindingId: String, code: String?)
  /// id nil: the host could not read the line far enough to know its id.
  case reply(id: String?, ok: Bool, errorCode: String?)
  /// A v1 line of a type (or a status state) this shell does not know: a newer host.
  case unknown(type: String)

  /// Reads one line; nil when it is not a v1 event line.
  public static func parse(_ line: String) -> HostEvent? {
    guard let data = line.data(using: .utf8),
      let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let v = o["v"] as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID(),
      v.intValue == IPC.version,
      let type = o["type"] as? String
    else { return nil }
    let str = { (k: String) in o[k] as? String }
    switch type {
    case "hello":
      guard let version = str("version"), let pid = o["pid"] as? Int else { return nil }
      return .hello(version: version, pid: pid)
    case "status":
      guard let raw = str("state") else { return nil }
      guard let state = HostState(rawValue: raw) else { return .unknown(type: "status") }
      let sections = (o["sections"] as? [[String: Any]] ?? []).compactMap { s -> SectionStatus? in
        guard let b = s["bindingId"] as? String, let st = s["state"] as? String else { return nil }
        return SectionStatus(bindingId: b, title: s["title"] as? String ?? "", state: st)
      }
      return .status(state: state, reason: str("reason"), sections: sections)
    case "question":
      guard let q = str("questionId"), let b = str("bindingId"), let k = str("kind") else {
        return nil
      }
      return .question(questionId: q, bindingId: b, kind: k, resolved: o["resolved"] as? Bool ?? false)
    case "needsAttention":
      guard let b = str("bindingId") else { return nil }
      return .needsAttention(bindingId: b, code: str("code"))
    case "reply":
      guard let ok = o["ok"] as? Bool else { return nil }
      let error = o["error"] as? [String: Any]
      return .reply(id: str("id"), ok: ok, errorCode: error?["code"] as? String)
    default:
      return .unknown(type: type)
    }
  }
}

/// Splits the host's stdout into lines. A line longer than IPC.maxLine is dropped up to its "\n".
public struct LineBuffer {
  private var buffer = Data()
  private var skipping = false

  public init() {}

  /// The complete lines in what has come so far, and how many overlong lines were dropped.
  public mutating func push(_ chunk: Data) -> (lines: [String], overlong: Int) {
    buffer.append(chunk)
    var lines: [String] = []
    var overlong = 0
    while let nl = buffer.firstIndex(of: 0x0A) {
      let lineData = buffer.subdata(in: buffer.startIndex..<nl)
      buffer = buffer.subdata(in: buffer.index(after: nl)..<buffer.endIndex)
      if skipping {
        skipping = false
        continue
      }
      var s = String(decoding: lineData, as: UTF8.self)
      if s.hasSuffix("\r") { s.removeLast() }
      if !s.trimmingCharacters(in: .whitespaces).isEmpty { lines.append(s) }
    }
    if buffer.count > IPC.maxLine {
      if !skipping { overlong += 1 }
      skipping = true
      buffer = Data()
    }
    return (lines, overlong)
  }
}
