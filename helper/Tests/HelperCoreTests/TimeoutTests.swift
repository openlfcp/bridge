import Foundation
#if SWIFT_PACKAGE
import HelperCore
#endif

// A store operation that never returns (R-001 live run 2: an EventKit fetch on a list with a
// repeating reminder hung, and every later request waited behind it on the serial queue).
func registerTimeoutTests() {
    test("an operation past its deadline answers eventkit_timeout; the next request is answered") {
        let rig = Rig(hello: false, opTimeout: 0.3)
        let t0 = Date()
        let r = rig.respond(["op": "debug.hang", "seconds": 5])
        try expectEqual(r["error"]?["code"]?.stringValue, "eventkit_timeout")
        try expectEqual(r["id"], .int(1), "the answer is for the request that hung")
        try expectEqual(r["error"]?["retryable"]?.boolValue, false, "a write that hung has an unknown outcome")
        try expect(Date().timeIntervalSince(t0) < 2, "answered at the deadline, not when the operation ends")
        let t1 = Date()
        let lists = rig.respond(["op": "lists.list"])
        try expectEqual(lists["ok"]?.boolValue, true, "the queue goes on")
        try expect(Date().timeIntervalSince(t1) < 1, "the next request does not wait for the stuck one")
        try expect(rig.events.contains { $0["event"]?.stringValue == "stalled" && $0["op"]?.stringValue == "debug.hang" },
                   "a stalled event tells the host (it restarts the helper)")
    }

    test("an operation within its deadline is answered as before") {
        let rig = Rig(opTimeout: 2)
        let r = rig.respond(["op": "debug.hang", "seconds": 0.05])
        try expectEqual(r["ok"]?.boolValue, true)
        try expect(!rig.events.contains { $0["event"]?.stringValue == "stalled" }, "no stalled event")
    }
}
