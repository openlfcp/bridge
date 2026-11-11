import AppKit
import Foundation
#if SWIFT_PACKAGE
import HelperCore
#endif

// lfcp-reminders-helper — the Swift side of the bridge's EventKit transport (D-010 r4 §8).
//   serve [--protocol 2] [--backend eventkit|memory] [--host-pid N]   stdio JSON-lines
//   status                                                             authorization + process info (never prompts)
//   --version
setvbuf(stdout, nil, _IOLBF, 0)

let usage = """
usage: lfcp-reminders-helper serve [--protocol 2] [--backend eventkit|memory] [--host-pid N]
       lfcp-reminders-helper status
       lfcp-reminders-helper --version
"""

var args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "serve"
if !args.isEmpty { args.removeFirst() }

func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: "--\(name)"), i + 1 < args.count else { return nil }
    return args[i + 1]
}

let out = LineWriter()

switch command {
case "--version", "version":
    out.emit(["helperVersion": .string(HelperInfo.version), "protocol": .int(HelperInfo.protocolVersion)])
    exit(0)

case "status":
    let backend = EventKitBackend()
    var o = processInfoJSON(hostPid: nil)
    o["authorization"] = .string(backend.authorization.rawValue)
    o["helperVersion"] = .string(HelperInfo.version)
    out.emit(.object(o))
    exit(0)

case "serve":
    if let p = option("protocol"), Int(p) != HelperInfo.protocolVersion {
        out.emit(["event": "fatal", "error": ["code": "unsupported_protocol", "message": .string("helper speaks protocol \(HelperInfo.protocolVersion)")]])
        exit(2)
    }
    let backendName = option("backend") ?? "eventkit"
    let backend: Backend
    switch backendName {
    case "eventkit": backend = EventKitBackend()
    case "memory": backend = MemoryBackend()
    default:
        out.emit(["event": "fatal", "error": ["code": "invalid", "message": .string("unknown backend \(backendName)")]])
        exit(2)
    }
    let hostPid = option("host-pid").flatMap { Int32($0) }

    // A connection to the window server: TCC prompts and NSWorkspace notifications want an app.
    // LSUIElement keeps it out of the Dock.
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.accessory)

    let server = Server(backend: backend) { out.emit($0) }
    let watch = hostPid.flatMap { HostWatch(pid: $0) { logErr("host exited; stopping"); exit(0) } }
    let system = SystemEvents { server.systemEvent($0) }

    out.emit(server.readyEvent(process: processInfoJSON(hostPid: hostPid)))

    Thread.detachNewThread {
        while let line = readLine(strippingNewline: true) {
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            server.queue.async {
                out.emit(server.respond(line: line))
                if server.shutdownRequested { exit(0) }
            }
        }
        server.queue.async { exit(0) }   // stdin closed: finish queued requests, then exit
    }
    // Keep the watchers alive for the life of the process.
    let keepAlive: [Any?] = [watch, system]
    _ = keepAlive
    RunLoop.main.run()

default:
    FileHandle.standardError.write((usage + "\n").data(using: .utf8)!)
    exit(2)
}
