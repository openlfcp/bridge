import Foundation
#if SWIFT_PACKAGE
import HelperCore
#endif

// Minimal test harness: XCTest is not available with Command Line Tools only (greywolf),
// so tests are a plain executable that exits non-zero on failure.

struct TestFailure: Error, CustomStringConvertible {
    let description: String
}

var registeredTests: [(String, () throws -> Void)] = []

func test(_ name: String, _ body: @escaping () throws -> Void) { registeredTests.append((name, body)) }

func expect(_ cond: Bool, _ msg: @autoclosure () -> String, file: String = #file, line: Int = #line) throws {
    if !cond { throw TestFailure(description: "\((file as NSString).lastPathComponent):\(line): \(msg())") }
}

func expectEqual<T: Equatable>(_ a: T, _ b: T, _ msg: String = "", file: String = #file, line: Int = #line) throws {
    if a != b { throw TestFailure(description: "\((file as NSString).lastPathComponent):\(line): \(msg) expected \(b), got \(a)") }
}

func runAllTests() -> Int32 {
    var failed = 0
    for (name, body) in registeredTests {
        do {
            try body()
            print("ok   \(name)")
        } catch {
            failed += 1
            print("FAIL \(name): \(error)")
        }
    }
    print("\n\(registeredTests.count - failed)/\(registeredTests.count) passed")
    return failed == 0 ? 0 : 1
}

/// A server on a memory backend plus a collector for emitted events.
final class Rig {
    let backend: MemoryBackend
    let server: Server
    private let lock = NSLock()
    private var _events: [JSON] = []
    private var nextId = 0
    static let zone = TimeZone(identifier: "Europe/Paris")!

    init(authorization: Authorization = .fullAccess, hello: Bool = true) {
        backend = MemoryBackend(authorization: authorization,
                                retry: RetryPolicy(delays: [0, 0, 0, 0], sleep: { _ in }), zone: Rig.zone)
        var sink: ((JSON) -> Void)!
        server = Server(backend: backend, coalesce: 0.05) { e in sink(e) }
        // weak: coalesced events may arrive after the test released the rig.
        sink = { [weak self] e in guard let self = self else { return }; self.lock.lock(); self._events.append(e); self.lock.unlock() }
        if hello { _ = ok(["op": "hello", "allowListTitlePrefixes": ["LFCP · "]]) }
    }

    var events: [JSON] { lock.lock(); defer { lock.unlock() }; return _events }

    /// Sends a request (adds v and id) and returns the full response.
    func send(_ req: [String: JSON]) -> JSON {
        nextId += 1
        var r = req
        if r["v"] == nil { r["v"] = 2 }
        r["id"] = .int(nextId)
        return server.handle(line: JSON.object(r).serialized())
    }

    func ok(_ req: [String: JSON], file: String = #file, line: Int = #line) -> JSON {
        let r = send(req)
        if r["ok"]?.boolValue != true {
            fatalError("\((file as NSString).lastPathComponent):\(line): expected ok for \(req["op"]?.stringValue ?? "?"), got \(r.serialized())")
        }
        return r
    }

    func errorCode(_ req: [String: JSON]) -> String? { send(req)["error"]?["code"]?.stringValue }

    private var keySeq = 0
    func opKey() -> JSON { keySeq += 1; return .string("op-\(keySeq)") }

    /// Creates the bridge list and returns its id.
    func bridgeList(_ title: String = "LFCP · Inbox") -> String {
        ok(["op": "lists.create", "title": .string(title), "opKey": opKey()])["list"]!["id"]!.stringValue!
    }

    /// Creates a reminder through the protocol and returns it as items.get reports it.
    func create(_ list: String, _ set: [String: JSON], url: String = "lfcp://task/T1?s=S&b=b1") -> JSON {
        let r = ok(["op": "items.create", "list": .string(list), "linkUrl": .string(url), "opKey": opKey(),
                    "set": .object(set)])
        return get(r["ref"]!)
    }

    func get(_ ref: JSON) -> JSON { ok(["op": "items.get", "ref": ref])["item"]! }

    func update(_ item: JSON, _ set: [String: JSON]) -> JSON {
        send(["op": "items.update", "ref": item["ref"]!, "set": .object(set), "opKey": opKey(),
              "expect": ["rev": item["rev"]!]])
    }

    func userEdit(_ item: JSON, _ edits: [String: JSON]) -> JSON {
        var req = edits
        req["op"] = "debug.userEdit"
        req["ref"] = item["ref"]!
        return ok(req)["debug"]!["item"]!
    }

    func waitForEvents(_ name: String, count: Int, timeout: TimeInterval = 2) -> [JSON] {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            let hits = events.filter { $0["event"]?.stringValue == name }
            if hits.count >= count { return hits }
            Thread.sleep(forTimeInterval: 0.01)
        }
        return events.filter { $0["event"]?.stringValue == name }
    }
}

/// Local wall time "YYYY-MM-DDTHH:MM" in the rig's zone as an ISO instant.
func instant(_ local: String) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = Rig.zone
    f.dateFormat = "yyyy-MM-dd'T'HH:mm"
    return Timestamps.format(f.date(from: local)!)
}
