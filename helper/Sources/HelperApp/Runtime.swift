import AppKit
import Darwin
import Foundation
#if SWIFT_PACKAGE
import HelperCore
#endif

/// One JSON object per line on stdout; safe from any thread.
final class LineWriter {
    private let lock = NSLock()
    func emit(_ j: JSON) {
        let line = j.serialized() + "\n"
        lock.lock()
        FileHandle.standardOutput.write(line.data(using: .utf8)!)
        lock.unlock()
    }
}

func logErr(_ s: String) {
    FileHandle.standardError.write(("[helper] " + s + "\n").data(using: .utf8)!)
}

@_silgen_name("proc_pidpath")
private func c_proc_pidpath(_ pid: Int32, _ buf: UnsafeMutableRawPointer, _ size: UInt32) -> Int32

/// Who we are, for `ready` and `status` (TCC attributes access to the responsible process, R-001 §2).
func processInfoJSON(hostPid: Int32?) -> [String: JSON] {
    var buf = [CChar](repeating: 0, count: 4096)
    let n = c_proc_pidpath(getppid(), &buf, UInt32(buf.count))
    #if arch(arm64)
    let arch = "arm64"
    #else
    let arch = "x86_64"
    #endif
    return [
        "pid": .int(Int(getpid())), "ppid": .int(Int(getppid())),
        "parentPath": .string(n > 0 ? String(cString: buf) : ""),
        "hostPid": hostPid.map { .int(Int($0)) } ?? .null,
        "bundleId": .str(Bundle.main.bundleIdentifier),
        "executable": .string(CommandLine.arguments[0]),
        "macOS": .string(ProcessInfo.processInfo.operatingSystemVersionString),
        "arch": .string(arch),
    ]
}

/// Exits when the host process ends: `open -n` does not make the helper its child (D-010 r4 §8.2).
final class HostWatch {
    private var source: DispatchSourceProcess?

    init?(pid: Int32, onExit: @escaping () -> Void) {
        guard pid > 0 else { return nil }
        if kill(pid, 0) != 0 && errno == ESRCH {
            onExit()
            return nil
        }
        let s = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        s.setEventHandler(handler: onExit)
        s.resume()
        source = s
    }
}

/// wake / sleep from NSWorkspace (the host reconnects and re-checks after wake, D-010 r4 §2.2).
final class SystemEvents {
    private var tokens: [NSObjectProtocol] = []

    init(_ emit: @escaping (String) -> Void) {
        let nc = NSWorkspace.shared.notificationCenter
        tokens.append(nc.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: nil) { _ in emit("wake") })
        tokens.append(nc.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: nil) { _ in emit("sleep") })
    }

    deinit { tokens.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) } }
}
