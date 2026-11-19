// Launches the host as a child process with pipes: stdin for commands, stdout for events, stderr
// appended to the host's log file. The app gives it the bundled node and bridge.mjs by absolute
// path with a clean environment (A§2.1: no PATH lookup, no NODE_PATH).

import Foundation

public final class ProcessHostLauncher: HostLauncher {
  public struct Config {
    public var executable: URL
    public var arguments: [String]
    public var environment: [String: String]
    /// stderr is appended here (created 0600); nil: discarded.
    public var stderrPath: String?

    public init(executable: URL, arguments: [String], environment: [String: String], stderrPath: String?) {
      self.executable = executable
      self.arguments = arguments
      self.environment = environment
      self.stderrPath = stderrPath
    }

    /// node Resources/host/bridge.mjs run --app, inside the bundle at `bundle`.
    public static func bundled(
      bundle: URL, inherited: [String: String], stderrPath: String?
    ) -> Config {
      let resources = bundle.appendingPathComponent("Contents/Resources", isDirectory: true)
      var env: [String: String] = [
        "HOME": inherited["HOME"] ?? NSHomeDirectory(),
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "TMPDIR": inherited["TMPDIR"] ?? NSTemporaryDirectory(),
        // The host spawns Contents/MacOS/lfcp-reminders-helper from here, `direct` (A§2.2).
        "LFCP_BRIDGE_APP": bundle.path,
      ]
      for key in ["LFCP_BRIDGE_HOME", "LFCP_BRIDGE_LOGS", "LANG"] {
        if let v = inherited[key] { env[key] = v }
      }
      return Config(
        executable: resources.appendingPathComponent("node/bin/node"),
        arguments: [resources.appendingPathComponent("host/bridge.mjs").path, "run", "--app"],
        environment: env,
        stderrPath: stderrPath)
    }
  }

  private let config: Config

  public init(_ config: Config) {
    self.config = config
    // A write to the stdin of a host that just died must not kill the shell.
    signal(SIGPIPE, SIG_IGN)
  }

  public func launch(onLine: @escaping (String) -> Void, onExit: @escaping (Int32) -> Void) throws
    -> HostProcess
  {
    let p = Process()
    p.executableURL = config.executable
    p.arguments = config.arguments
    p.environment = config.environment
    let input = Pipe()
    let output = Pipe()
    p.standardInput = input
    p.standardOutput = output
    p.standardError = stderrHandle()
    let lines = LineBox()
    output.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      if data.isEmpty {
        handle.readabilityHandler = nil
        return
      }
      DispatchQueue.main.async { lines.push(data).forEach(onLine) }
    }
    p.terminationHandler = { proc in
      let status = proc.terminationStatus
      DispatchQueue.main.async { onExit(status) }
    }
    try p.run()
    return Child(process: p, stdin: input.fileHandleForWriting)
  }

  private func stderrHandle() -> FileHandle {
    guard let path = config.stderrPath else { return FileHandle.nullDevice }
    try? FileManager.default.createDirectory(
      atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    let fd = Darwin.open(path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
    return fd < 0 ? FileHandle.nullDevice : FileHandle(fileDescriptor: fd, closeOnDealloc: true)
  }

  /// The LineBuffer of one host, used on the main queue only.
  private final class LineBox {
    var buffer = LineBuffer()
    func push(_ data: Data) -> [String] { buffer.push(data).lines }
  }

  private final class Child: HostProcess {
    let process: Process
    let stdin: FileHandle

    init(process: Process, stdin: FileHandle) {
      self.process = process
      self.stdin = stdin
    }

    var pid: Int32 { process.processIdentifier }

    func send(_ line: String) {
      // write(contentsOf:) throws on EPIPE instead of raising an Objective-C exception.
      try? stdin.write(contentsOf: Data((line + "\n").utf8))
    }

    func terminate() {
      if process.isRunning { process.terminate() }
    }

    func kill() {
      if process.isRunning { _ = Darwin.kill(process.processIdentifier, SIGKILL) }
    }
  }
}
